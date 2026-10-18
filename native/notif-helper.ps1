# Notification helper for the Desk Panel.
# Reads the Windows notification center through the official UserNotificationListener API
# (already authorised on this machine: RequestAccessAsync -> Allowed) and writes a small JSON
# for the Electron main process to poll. Read-only. No network. Nothing leaves this machine.
#
# WeChat is NOT handled here: Weixin 4.x never posts Windows toasts (it draws its own Qt popup
# showing no text at all), so there is nothing to read. That module is paused on purpose.
#
# ASCII only: Windows PowerShell 5.1 reads non-BOM files as ANSI and chokes on Chinese here.

param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [Parameter(Mandatory = $true)][string]$PidFile,
  [int]$ParentPid = 0,
  [int]$MaxItems = 60
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Write-Json($path, $text) {
  $tmp = "$path.tmp"
  [System.IO.File]::WriteAllText($tmp, $text, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $path -Force -ErrorAction SilentlyContinue
}

try { [System.IO.File]::WriteAllText($PidFile, "$PID", (New-Object System.Text.UTF8Encoding($false))) } catch { }
Write-Json $OutFile '{"ok":false,"reason":"starting","items":[]}'

# ---------- Await helpers for WinRT async ----------
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$ext = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskOp = ($ext | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($op, $type, $ms = 6000) {
  $task = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait($ms)) { throw "timeout" }
  return $task.Result
}

$listenerType = [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI, ContentType = WindowsRuntime]
$statusType = [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus, Windows.UI, ContentType = WindowsRuntime]
$kindsType = [Windows.UI.Notifications.NotificationKinds, Windows.UI, ContentType = WindowsRuntime]
$userNotifType = [Windows.UI.Notifications.UserNotification, Windows.UI, ContentType = WindowsRuntime]
$listType = [System.Collections.Generic.IReadOnlyList``1].MakeGenericType($userNotifType)
$knownBindings = [Windows.UI.Notifications.KnownNotificationBindings, Windows.UI, ContentType = WindowsRuntime]

$status = 'Unknown'
try {
  $listener = $listenerType::Current
  $status = [string](Await ($listener.RequestAccessAsync()) $statusType)
} catch {
  $status = 'Error: ' + $_.Exception.Message
}

$seen = @{}          # id -> $true, keeps insertion order-ish for dedupe
$items = New-Object System.Collections.ArrayList
# First poll only marks what is already in the center as 'seen': those are old notifications
# from before the panel started, and we do not want them showing up on every launch.
$baseline = $true

while ($true) {
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }

  $fresh = New-Object System.Collections.ArrayList

  if ($status -eq 'Allowed') {
    try {
      $toast = [Enum]::Parse($kindsType, 'Toast')
      $list = Await ($listener.GetNotificationsAsync($toast)) $listType
      foreach ($n in $list) {
        $id = ''
        try { $id = 'n' + $n.Id + '-' + $n.CreationTime.ToUnixTimeSeconds() } catch { $id = '' }
        if (-not $id) { continue }
        if ($seen.ContainsKey($id)) { continue }

        $appName = ''
        $aumid = ''
        try { $aumid = [string]$n.AppInfo.AppUserModelId } catch { }
        try { $appName = [string]$n.AppInfo.DisplayInfo.DisplayName } catch { }
        if (-not $appName) { $appName = $aumid }
        if (-not $appName) { $appName = '系统通知' }

        $title = ''
        $body = ''
        try {
          $binding = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
          $lines = New-Object System.Collections.ArrayList
          foreach ($el in $binding.GetTextElements()) {
            $t = [string]$el.Text
            if ($null -ne $t) { [void]$lines.Add($t) }
          }
          if ($lines.Count -ge 1) { $title = [string]$lines[0] }
          if ($lines.Count -ge 2) {
            $rest = @()
            for ($i = 1; $i -lt $lines.Count; $i++) { $rest += [string]$lines[$i] }
            $body = ($rest -join ' ')
          }
        } catch { }

        $when = 0
        try { $when = $n.CreationTime.ToUnixTimeMilliseconds() } catch { $when = 0 }

        # QQ puts a bare "." in the first text slot; treat punctuation-only titles as empty
        # so the panel can show the app name instead of a useless dot.
        if ($title -match '^[\s\.\-_·。…,，、:：\|]+$') { $title = '' }
        if (-not $title -and -not $body) { continue }

        $obj = [ordered]@{
          id    = $id
          app   = $appName
          title = $title
          body  = $body
          ts    = $when
          kind  = 'system'
        }
        $seen[$id] = $true
        if ($baseline) { continue }
        [void]$items.Insert(0, [pscustomobject]$obj)
        [void]$fresh.Add($obj)
      }
      $baseline = $false
    } catch {
      # transient WinRT hiccup: keep going
    }
  }

  while ($items.Count -gt $MaxItems) { $items.RemoveAt($items.Count - 1) }

  $payload = [ordered]@{
    ok     = $true
    access = $status
    seq    = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    items  = @($items)
  }
  $json = $payload | ConvertTo-Json -Depth 5 -Compress
  Write-Json $OutFile $json

  Start-Sleep -Milliseconds 900
}

try { Remove-Item $OutFile -Force -ErrorAction SilentlyContinue } catch { }
try { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue } catch { }
