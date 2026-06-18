#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: render_side_by_side.sh --run-local-dir <path> --dataset <name> --video <stem> [--aug-index <n>]

Renders a side-by-side MP4 from local staged input and augmented output videos.
EOF
  exit 2
}

run_local_dir=""
dataset=""
video=""
aug_index="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-local-dir)
      [[ $# -ge 2 ]] || usage
      run_local_dir="$2"
      shift 2
      ;;
    --dataset)
      [[ $# -ge 2 ]] || usage
      dataset="$2"
      shift 2
      ;;
    --video)
      [[ $# -ge 2 ]] || usage
      video="$2"
      shift 2
      ;;
    --aug-index)
      [[ $# -ge 2 ]] || usage
      aug_index="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n "${run_local_dir}" && -n "${dataset}" && -n "${video}" ]] || usage

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg not found in PATH." >&2
  exit 1
fi

input_video="${run_local_dir}/input/${video}.mp4"
if [[ ! -f "${input_video}" ]]; then
  echo "ERROR: input video not found: ${input_video}" >&2
  exit 1
fi

augmented_dir="${run_local_dir}/outputs/augmented/${video}_aug${aug_index}"
if [[ ! -d "${augmented_dir}" ]]; then
  echo "ERROR: augmented output dir not found: ${augmented_dir}" >&2
  exit 1
fi

augmented_video="$(find "${augmented_dir}" -type f -name '*.mp4' | sort | head -n 1)"
if [[ -z "${augmented_video}" ]]; then
  echo "ERROR: no augmented mp4 found in ${augmented_dir}" >&2
  exit 1
fi

display_dir="${run_local_dir}/display"
mkdir -p "${display_dir}"
compare_video="${display_dir}/${dataset}_${video}_aug${aug_index}_compare.mp4"

ffmpeg -y \
  -i "${input_video}" \
  -i "${augmented_video}" \
  -filter_complex "[0:v]scale=-2:720,setsar=1[left];[1:v]scale=-2:720,setsar=1[right];[left][right]hstack=inputs=2:shortest=1[v]" \
  -map "[v]" -an -c:v libx264 -preset veryfast -crf 20 \
  "${compare_video}"

echo "COMPARE_VIDEO=${compare_video}"
echo "INPUT_VIDEO=${input_video}"
echo "AUGMENTED_VIDEO=${augmented_video}"
