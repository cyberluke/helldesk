# Assemble the M4 dashboard video from BrowserOS page captures.
# Each page capture is held for 6s with a 0.5s crossfade.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$media = Join-Path $repo 'benchmarks\v0\dashboard\media'
$out = Join-Path $media 'dashboard-demo.mp4'
$ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source

$images = @(
  'dashboard-overview.png',
  'dashboard-kanban.png',
  'dashboard-verified.png',
  'dashboard-transcript.png',
  'dashboard-diff.png',
  'dashboard-observability.png'
) | ForEach-Object { Join-Path $media $_ }
foreach ($image in $images) {
  if (-not (Test-Path $image)) { throw "missing capture: $image" }
}

$args = @()
foreach ($image in $images) {
  $args += @('-loop', '1', '-t', '6', '-i', $image)
}
$filter = @()
for ($i = 0; $i -lt $images.Count; $i++) {
  $filter += "[${i}:v]scale=1920:1080,setsar=1,format=yuv420p[v${i}]"
}
$last = 'v0'
for ($i = 1; $i -lt $images.Count; $i++) {
  $offset = [double]($i * 6 - $i * 0.5)
  $filter += "[$last][v$i]xfade=transition=fade:duration=0.5:offset=$offset[x$i]"
  $last = "x$i"
}
$filterStr = $filter -join ';'
& $ffmpeg -hide_banner -loglevel warning @args -filter_complex $filterStr -map "[$last]" -r 30 -c:v libx264 -crf 20 -preset veryfast -pix_fmt yuv420p -y $out
if ($LASTEXITCODE -ne 0) { throw "ffmpeg assembly failed" }
Write-Output "VIDEO=$out"
