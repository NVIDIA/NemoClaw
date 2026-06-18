#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: stage_run_artifacts.sh --storage-url <url> --dataset <name> --run-id <id> --video <stem> [--run-local-dir <path>] [--input-local-video <path>]

Copies the full workflow output tree and co-locates the input video under a
workspace-local run folder so artifacts are agent-accessible.
EOF
  exit 2
}

storage_url=""
dataset=""
run_id=""
video=""
run_local_dir=""
input_local_video=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --storage-url)
      [[ $# -ge 2 ]] || usage
      storage_url="$2"
      shift 2
      ;;
    --dataset)
      [[ $# -ge 2 ]] || usage
      dataset="$2"
      shift 2
      ;;
    --run-id)
      [[ $# -ge 2 ]] || usage
      run_id="$2"
      shift 2
      ;;
    --video)
      [[ $# -ge 2 ]] || usage
      video="$2"
      shift 2
      ;;
    --run-local-dir)
      [[ $# -ge 2 ]] || usage
      run_local_dir="$2"
      shift 2
      ;;
    --input-local-video)
      [[ $# -ge 2 ]] || usage
      input_local_video="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n "${storage_url}" && -n "${dataset}" && -n "${run_id}" && -n "${video}" ]] || usage

root="$(git rev-parse --show-toplevel)"
if [[ -z "${run_local_dir}" ]]; then
  run_local_dir="${root}/media/vda/runs/${run_id}"
fi
mkdir -p "${run_local_dir}/input"

storage_root="${storage_url%/}"
run_output_url="${storage_root}/datasets/${dataset}-outputs/${run_id}/"
input_dataset_url="${storage_root}/datasets/${dataset}/${video}.mp4"

echo "Staging workflow outputs to ${run_local_dir}"
osmo data download "${run_output_url}" "${run_local_dir}/"

if [[ -n "${input_local_video}" ]]; then
  if [[ ! -f "${input_local_video}" ]]; then
    echo "ERROR: input-local-video not found: ${input_local_video}" >&2
    exit 1
  fi
  cp -f "${input_local_video}" "${run_local_dir}/input/${video}.mp4"
else
  osmo data download "${input_dataset_url}" "${run_local_dir}/input/"
fi

augmented_dir="${run_local_dir}/outputs/augmented/${video}_aug0"
augmented_video="$(if [[ -d "${augmented_dir}" ]]; then
  find "${augmented_dir}" -type f -name '*.mp4' | sort | head -n 1
fi)"

echo "LOCAL_RUN_DIR=${run_local_dir}"
echo "LOCAL_INPUT_VIDEO=${run_local_dir}/input/${video}.mp4"
echo "LOCAL_AUGMENTED_VIDEO=${augmented_video}"
echo "LOCAL_MANIFEST=${run_local_dir}/setup_b0/configs/manifest.yaml"
echo "LOCAL_AUG_LABEL_DIR=${run_local_dir}/outputs/pseudo_labeled_augmented/${video}_aug0"
echo "LOCAL_ORIG_LABEL_DIR=${run_local_dir}/outputs/pseudo_labeled/${video}"
