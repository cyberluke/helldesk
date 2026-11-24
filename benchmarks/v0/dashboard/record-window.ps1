# Record the BrowserOS Neo window with ffmpeg gdigrab, then crop it to the
# dashboard page content (no browser chrome / personal tabs).
#
# The BrowserOS tab must already be open and active. The agent drives the
# dashboard via the browseros MCP while this script runs in the background.
param(
  [int]$Seconds = 40,
  [string]$OutDir = "",
  [int]$PageCropX = 490,
  [int]$PageCropY = 112,
  [switch]$KeepRaw
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $OutDir) { $OutDir = Join-Path $repo '.local\benchmark\v0\dashboard\capture' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BrowserOSWin32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$proc = Get-Process chrome -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -like 'BrowserOS neo*' } |
  Select-Object -First 1
if (-not $proc) { throw "BrowserOS neo window not found" }
$h = $proc.MainWindowHandle
[BrowserOSWin32]::ShowWindow($h, 9) | Out-Null
[BrowserOSWin32]::SetForegroundWindow($h) | Out-Null
$HWND_TOPMOST = [IntPtr]::new(-1)
$HWND_NOTOPMOST = [IntPtr]::new(-2)
$SWP_FLAGS = 0x0001 -bor 0x0002 -bor 0x0040
# Keep the agent browser above the user's other windows for the capture; the
# screen-region grab otherwise records whatever is in front (e.g. ChatGPT).
[BrowserOSWin32]::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_FLAGS) | Out-Null
Start-Sleep -Milliseconds 400

$rect = New-Object BrowserOSWin32+RECT
[BrowserOSWin32]::GetWindowRect($h, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 800 -or $height -lt 600) { throw "unexpected BrowserOS window size ${width}x${height}" }

$ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$raw = Join-Path $OutDir "browseros-raw-$stamp.mp4"
$out = Join-Path $OutDir "dashboard-demo-$stamp.mp4"

try {
  # Record at 20 fps, scale to an even height for x264.
  & $ffmpeg -hide_banner -loglevel warning -f gdigrab -draw_mouse 0 -framerate 20 `
    -offset_x $rect.Left -offset_y $rect.Top -video_size "${width}x${height}" -i desktop `
    -t $Seconds -vf "scale=1920:-2" -c:v libx264 -crf 20 -preset veryfast -pix_fmt yuv420p -y $raw
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg recording failed" }

  # Page-only crop: remove the BrowserOS sidebar and browser toolbar. Use
  # relative expressions so the crop survives different window sizes.
  $cropExpr = "crop=trunc((iw-${PageCropX})/2)*2:trunc((ih-${PageCropY})/2)*2:${PageCropX}:${PageCropY}"
  & $ffmpeg -hide_banner -loglevel error -i $raw `
    -vf $cropExpr `
    -c:v libx264 -crf 20 -preset veryfast -pix_fmt yuv420p -y $out
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg crop failed" }
} finally {
  [BrowserOSWin32]::SetWindowPos($h, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP_FLAGS) | Out-Null
}

if (-not $KeepRaw) { Remove-Item $raw -Force -ErrorAction SilentlyContinue }
Write-Output "VIDEO=$out"
