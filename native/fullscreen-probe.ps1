# 全屏探测脚本（由主程序启动，长期运行）
# 职责：每 0.5 秒算出“当前前台窗口是不是全屏”，把结果写进一个小文本文件。
#
# 为什么写文件而不是打印到控制台：
# 这台机器上“管道(stdout)抓子进程输出”会被系统拦住，父进程收不到任何东西。
# 写文件最稳，任何环境都不会失效。
#
# 输出格式（一行，空格分隔）：
#   full hwnd left top right bottom screenW screenH

param(
  [string]$OutFile = "$env:TEMP\deskpanel-fs.txt"
)

$cs = @"
using System;
using System.Runtime.InteropServices;
public class FGProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
}
"@

try {
  Add-Type -TypeDefinition $cs -ErrorAction Stop
} catch {
  # 编译失败就把原因写进结果文件，父进程会把它当成错误日志显示出来
  $msg = "ERR " + $_.Exception.Message
  try { [System.IO.File]::WriteAllText($OutFile, $msg) } catch { }
  try { Set-Content -LiteralPath (Join-Path $env:TEMP 'dp-probe-err.txt') -Value $msg -Encoding UTF8 -Force } catch { }
  exit 1
}

# 屏幕尺寸：优先用 WinForms 取（不编译、更可靠），拿不到再退回 GetSystemMetrics。
# 注意要和窗口坐标用同一套“缩放后”的坐标系，所以本进程保持默认的 DPI 不感知。
$sw = 0
$sh = 0
try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  $sb = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $sw = $sb.Width
  $sh = $sb.Height
} catch { }
if (-not $sw -or -not $sh) {
  $sw = [FGProbe]::GetSystemMetrics(0)
  $sh = [FGProbe]::GetSystemMetrics(1)
}

while ($true) {
  $h = [FGProbe]::GetForegroundWindow()
  $r = New-Object FGProbe+RECT
  $ok = [FGProbe]::GetWindowRect($h, [ref]$r)
  if ($ok) {
    $w = $r.R - $r.L
    $ht = $r.B - $r.T
    $full = 0
    if ($h -ne [FGProbe]::GetDesktopWindow() -and $h -ne [FGProbe]::GetShellWindow()) {
      if ($r.L -le 1 -and $r.T -le 1 -and $w -ge ($sw - 2) -and $ht -ge ($sh - 2)) { $full = 1 }
    }
    $line = "{0} {1} {2} {3} {4} {5} {6} {7} v2" -f $full, $h.ToInt64(), $r.L, $r.T, $r.R, $r.B, $sw, $sh
  } else {
    $line = "0 0 0 0 0 0 {0} {1} v2-noRect" -f $sw, $sh
  }

  # 先写临时文件再改名：避免父进程读到“写了一半”的内容
  $tmp = "$OutFile.tmp"
  try {
    [System.IO.File]::WriteAllText($tmp, $line)
    Move-Item -LiteralPath $tmp -Destination $OutFile -Force
  } catch { }

  Start-Sleep -Milliseconds 500
}
