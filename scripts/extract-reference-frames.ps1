param(
  [string]$InputFile = "references/unveil-scroll.mp4",
  [string]$OutputDir = "references/video-frames",
  [double]$FramesPerSecond = 2
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  throw "ffmpeg is required. Install it from https://ffmpeg.org/download.html"
}

if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) {
  throw "ffprobe is required and is normally included with ffmpeg."
}

if (-not (Test-Path -LiteralPath $InputFile)) {
  throw "Input video not found: $InputFile"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

& ffprobe -v error `
  -show_entries "format=duration:stream=width,height,r_frame_rate,avg_frame_rate" `
  -of "default=noprint_wrappers=1" `
  $InputFile | Set-Content -Path (Join-Path $OutputDir "metadata.txt")

$filter = "fps=$FramesPerSecond,scale='min(1600,iw)':-2:flags=lanczos"
$outputPattern = Join-Path $OutputDir "frame-%04d.jpg"

& ffmpeg -hide_banner -loglevel error -y `
  -i $InputFile `
  -vf $filter `
  -q:v 2 `
  $outputPattern

$count = (Get-ChildItem -Path $OutputDir -Filter "frame-*.jpg").Count
Write-Host "Extracted $count frames to $OutputDir"
