# =====================================================================
#  SMTC 小助手（QQ 音乐控制用）
#
#  为什么需要它：Electron/网页层不会说 Windows 的 WinRT 语言，
#  而这个 PowerShell 脚本可以，所以由它去问系统"现在放的是什么歌"，
#  并把播放/暂停/上一首/下一首/拖进度这些命令转达给播放器。
#
#  通信方式：
#     · 状态：每 ~700ms 写一次 JSON 到 -OutFile（先写临时文件再改名，避免读到半截）
#     · 命令：主程序把 {"seq":1,"action":"playpause"} 写进 -CmdFile，本脚本读走就删
#     · 封面：歌变了才去取一次，写到 -CoverFile
#
#  只用微软官方接口（GlobalSystemMediaTransportControlsSessionManager），
#  不注入、不抓包、不碰播放器进程。
# =====================================================================
param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [Parameter(Mandatory = $true)][string]$CmdFile,
  [Parameter(Mandatory = $true)][string]$CoverFile,
  [string]$CoverExe = '',
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Continue'

function Write-Utf8($path, $text) {
  $tmp = "$path.tmp"
  [System.IO.File]::WriteAllText($tmp, $text, (New-Object System.Text.UTF8Encoding($false)))
  if (Test-Path $path) { Remove-Item $path -Force -ErrorAction SilentlyContinue }
  Move-Item -LiteralPath $tmp -Destination $path -Force -ErrorAction SilentlyContinue
}

function Write-State($json) { Write-Utf8 $OutFile $json }

# 排查用：往 $OutFile.trace 追加一行（正常运行时也会写，文件很小）
function Trace-Line($msg) {
  try {
    $line = (Get-Date).ToString('HH:mm:ss') + ' ' + $msg + "`r`n"
    [System.IO.File]::AppendAllText("$OutFile.trace", $line, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

Write-State '{"ok":false,"reason":"starting"}'
# 把自己的进程号写出来：主程序重启小助手时先按这个号杀掉旧的，
# 否则旧进程还在写同一个 JSON，界面会看到两首歌的状态来回跳。
try { [System.IO.File]::WriteAllText("$OutFile.pid", "$PID", (New-Object System.Text.UTF8Encoding($false))) } catch { }
# 音量：Windows 自带的 Core Audio（就是「音量合成器」里每根滑杆背后的接口）。
# 把 AudioVol.cs 编进本进程，之后读/写都只是毫秒级调用，不用每次开新进程。
$script:audioOk = $false
$script:volProc = ''
$script:audioErr = ''
# 注意：不要用 Add-Type 现场编译（在 VBS→cmd 这条启动链里会报「客户端没有所需的特权」），
# 改成加载预先用 csc 编好的 AudioVol.dll。
try {
  $dll = Join-Path $PSScriptRoot 'AudioVol.dll'
  if (Test-Path $dll) {
    [void][System.Reflection.Assembly]::LoadFrom($dll)
  } else {
    Add-Type -Path (Join-Path $PSScriptRoot 'AudioVol.cs') -ErrorAction Stop
  }
  $script:audioOk = $true
} catch {
  $script:audioOk = $false
  $script:audioErr = $_.Exception.Message
}
Trace-Line("audio ok=$script:audioOk root=$PSScriptRoot err=$script:audioErr")

# ---------- WinRT 的"等一下结果"适配 ----------
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $asTaskMethods = [System.WindowsRuntimeSystemExtensions].GetMethods()
  $asTaskOp = ($asTaskMethods | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $asTaskAction = ($asTaskMethods | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
  })[0]
} catch {
  Write-State ('{"ok":false,"reason":"no-winrt","detail":"' + ($_.Exception.Message -replace '"', "'") + '"}')
  exit 1
}

function Await($op, $type) {
  $t = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $t.Wait(4000)) { throw 'await timeout' }
  return $t.Result
}
function AwaitAction($op) {
  $t = $asTaskAction.Invoke($null, @($op))
  if (-not $t.Wait(4000)) { throw 'await timeout' }
}

$MgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media, ContentType = WindowsRuntime]
$PropsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media, ContentType = WindowsRuntime]
$StreamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]

$mgr = $null
$lastTitle = ''
$lastCoverStamp = ''
$lastStateJson = ''

# 只认 QQ 音乐。系统 SMTC 会把所有会发声的播放器都列出来（抖音、浏览器、B站…），
# 以前用 GetCurrentSession()/第一个会话，抖音一出声控制台就“串台”成抖音的遥控器。
# 这里按进程名过滤：进程/AUMID 里出现 QQMusic 才算数，其它一律忽略。
$script:AllowedApps = @('QQMusic', 'QQMusicAssistant', 'QQMusicPin', 'QQMusicService')

function Test-QQMusicSession($s) {
  if ($null -eq $s) { return $false }
  $aumid = ''
  try { $aumid = [string]$s.SourceAppUserModelId } catch { $aumid = '' }
  if (-not $aumid) { return $false }
  foreach ($allow in $script:AllowedApps) {
    if ($aumid -match ('(?i)' + [regex]::Escape($allow))) { return $true }
  }
  return $false
}

function Get-Session {
  if ($null -eq $global:mgr) {
    $global:mgr = Await ($MgrType::RequestAsync()) $MgrType
  }
  $all = $null
  try { $all = $global:mgr.GetSessions() } catch { $all = $null }
  if ($null -eq $all) { return $null }
  foreach ($s in $all) {
    if (Test-QQMusicSession $s) { return $s }
  }
  # QQ 音乐没开/没放歌：返回空，界面显示“未在播放”，绝不退回到别的播放器
  return $null
}

# ---------- 主循环 ----------
$busyUntil = [DateTime]::MinValue
while ($true) {
  # 父进程没了就退出，绝不留下孤儿进程
  if ($ParentPid -gt 0) {
    $p = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if ($null -eq $p) { break }
  }

  try {
    $session = Get-Session

    # ---- 先处理命令（每 150ms 就会走到这里，响应够快） ----
    if (Test-Path $CmdFile) {
      $raw = ''
      try { $raw = [System.IO.File]::ReadAllText($CmdFile, [System.Text.Encoding]::UTF8) } catch {}
      Remove-Item $CmdFile -Force -ErrorAction SilentlyContinue
      if ($raw) {
        try { $cmd = $raw | ConvertFrom-Json } catch { $cmd = $null }
        if ($cmd -and $session) {
          switch ($cmd.action) {
            'playpause' { Await ($session.TryTogglePlayPauseAsync()) ([bool]) | Out-Null }
            'play' { Await ($session.TryPlayAsync()) ([bool]) | Out-Null }
            'pause' { Await ($session.TryPauseAsync()) ([bool]) | Out-Null }
            'next' { Await ($session.TrySkipNextAsync()) ([bool]) | Out-Null }
            'prev' { Await ($session.TrySkipPreviousAsync()) ([bool]) | Out-Null }
            'seek' {
              $ticks = [int64]([double]$cmd.position * 10000000.0)
              Await ($session.TryChangePlaybackPositionAsync($ticks)) ([bool]) | Out-Null
            }
            # 音量：只改播放器自己的那一档（系统「音量合成器」里的同一根滑杆）
            'volume' {
              if ($script:audioOk -and $script:volProc) {
                [DeskPanelAudio.Api]::SetVolume($script:volProc, [float]$cmd.position) | Out-Null
              }
            }
            'mute' {
              if ($script:audioOk -and $script:volProc) {
                [DeskPanelAudio.Api]::SetMute($script:volProc, ([double]$cmd.position -ge 0.5)) | Out-Null
              }
            }
          }
          # 命令执行完立刻刷新一次状态，界面不用等下一个周期
          $busyUntil = [DateTime]::MinValue
        }
      }
    }

    # ---- 再读状态，最多七成时间在读，省点 CPU ----
    if ([DateTime]::Now -lt $busyUntil) { Start-Sleep -Milliseconds 60; continue }

    if ($null -eq $session) {
      $json = '{"ok":true,"playing":false,"hasSession":false}'
      if ($json -ne $lastStateJson) { Write-State $json; $lastStateJson = $json }
      Start-Sleep -Milliseconds 700
      continue
    }

    $info = Await ($session.TryGetMediaPropertiesAsync()) $PropsType
    $pb = $session.GetPlaybackInfo()
    $tl = $session.GetTimelineProperties()
    $ctrl = $pb.Controls

    $title = [string]$info.Title
    $artist = [string]$info.Artist
    $album = [string]$info.AlbumTitle
    $status = [string]$pb.PlaybackStatus

    # 封面：只有歌换了才去取，避免每 700ms 解一次图。
    # 注意：PowerShell 里 OpenReadAsync() 返回的是 System.__ComObject，
    # 强转 IRandomAccessStream / AsStreamForRead 全部失败，所以这里不自己读流，
    # 而是交给编译好的 SmtcCover.exe（它用 winmd 类型 + 轮询 IAsyncOperation 读字节）。
    $stamp = "$title|$artist"
    if ($stamp -ne $lastTitle) {
      $lastTitle = $stamp
      try {
        $got = $false
        if ($title -and $info.Thumbnail -and $CoverExe -and (Test-Path $CoverExe)) {
          $out = & $CoverExe $CoverFile
          if ((Test-Path $CoverFile) -and ((Get-Item $CoverFile).Length -gt 200)) {
            $lastCoverStamp = (Get-Item $CoverFile).LastWriteTimeUtc.Ticks.ToString()
            $got = $true
          }
        }
        if (-not $got) {
          $lastCoverStamp = ''
          if (Test-Path $CoverFile) { Remove-Item $CoverFile -Force -ErrorAction SilentlyContinue }
        }
      } catch {
        Trace-Line("cover error: $($_.Exception.Message)")
        $lastCoverStamp = ''
      }
    }

    # 播放器自己的音量（0..1，取不到就是 -1）
    $volVal = -1.0
    if ($script:audioOk) {
      try {
        $procName = [System.IO.Path]::GetFileNameWithoutExtension([string]$session.SourceAppUserModelId)
        if ($procName) {
          $script:volProc = $procName
          $volVal = [double][DeskPanelAudio.Api]::GetVolume($procName)
        }
      } catch { $volVal = -1.0 }
    }
    $obj = [ordered]@{
      ok         = $true
      hasSession = $true
      app        = [string]$session.SourceAppUserModelId
      title      = $title
      artist     = $artist
      album      = $album
      status     = $status
      playing    = ($status -eq 'Playing')
      position   = [math]::Round([double]$tl.Position.TotalSeconds, 2)
      duration   = [math]::Round([double]$tl.EndTime.TotalSeconds, 2)
      canPrev    = [bool]$ctrl.IsPreviousEnabled
      canNext    = [bool]$ctrl.IsNextEnabled
      canPlay    = [bool]$ctrl.IsPlayEnabled
      canPause   = [bool]$ctrl.IsPauseEnabled
      canSeek    = [bool]$ctrl.IsPlaybackPositionEnabled
      coverStamp = $lastCoverStamp
      volume     = [math]::Round($volVal, 3)
    }
    $json = ($obj | ConvertTo-Json -Compress)
    if ($json -ne $lastStateJson) {
      Write-State $json
      $lastStateJson = $json
    }
  } catch {
    $msg = $_.Exception.Message -replace '"', "'" -replace "`r", ' ' -replace "`n", ' '
    $json = '{"ok":false,"reason":"error","detail":"' + $msg + '"}'
    Write-State $json
    $global:mgr = $null
    Start-Sleep -Milliseconds 900
  }

  Start-Sleep -Milliseconds 350
}
