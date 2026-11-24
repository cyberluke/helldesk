# Convert the M4 dashboard page-capture MP4 into a GitHub-friendly animated GIF.
# GitHub's documented image/media support includes GIF; WebP is not listed and
# animated WebP is not reliable inline. The MP4 source stays local (MP4 is LFS).
param(
  [string]$Video = (Join-Path $PSScriptRoot 'media\dashboard-demo.mp4'),
  [string]$Output = (Join-Path $PSScriptRoot 'media\dashboard-demo.gif'),
  [int]$Fps = 12,
  [int]$Width = 480
)
$ErrorActionPreference = 'Stop'
$ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $Video)) { throw "missing video: $Video" }
$palette = Join-Path $env:TEMP "helldesk-dashboard-palette-$([guid]::NewGuid().ToString('N')).png"
try {
  & $ffmpeg -hide_banner -loglevel error -i $Video `
    -vf "fps=$Fps,scale=${Width}:-1:flags=lanczos,palettegen=max_colors=256:stats_mode=diff" `
    -y $palette
  if ($LASTEXITCODE -ne 0) { throw "palette generation failed" }
  & $ffmpeg -hide_banner -loglevel error -i $Video -i $palette `
    -lavfi "fps=$Fps,scale=${Width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" `
    -loop 0 -y $Output
  if ($LASTEXITCODE -ne 0) { throw "GIF encoding failed" }
} finally {
  Remove-Item $palette -Force -ErrorAction SilentlyContinue
}
Write-Output "GIF=$Output"
Write-Output "BYTES=$((Get-Item -LiteralPath $Output).Length)"
