#!/usr/bin/env bash
set -euo pipefail

INPUT_FILE="${1:-references/unveil-scroll.mp4}"
OUTPUT_DIR="${2:-references/video-frames}"
FPS="${3:-2}"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required. Install it from https://ffmpeg.org/download.html" >&2
  exit 1
fi

if ! command -v ffprobe >/dev/null 2>&1; then
  echo "ffprobe is required and is normally included with ffmpeg." >&2
  exit 1
fi

if [ ! -f "$INPUT_FILE" ]; then
  echo "Input video not found: $INPUT_FILE" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

ffprobe -v error \
  -show_entries format=duration:stream=width,height,r_frame_rate,avg_frame_rate \
  -of default=noprint_wrappers=1 \
  "$INPUT_FILE" > "$OUTPUT_DIR/metadata.txt"

ffmpeg -hide_banner -loglevel error -y \
  -i "$INPUT_FILE" \
  -vf "fps=${FPS},scale='min(1600,iw)':-2:flags=lanczos" \
  -q:v 2 \
  "$OUTPUT_DIR/frame-%04d.jpg"

COUNT=$(find "$OUTPUT_DIR" -maxdepth 1 -name 'frame-*.jpg' | wc -l | tr -d ' ')
echo "Extracted $COUNT frames to $OUTPUT_DIR"
