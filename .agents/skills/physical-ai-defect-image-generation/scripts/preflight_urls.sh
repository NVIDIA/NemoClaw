#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Preflight check for the DIG URL artifacts each flow needs.
# Usage: preflight_urls.sh <flow> <usecase> [variant]
#   flow:    0 | 1 | finetune
#   usecase: pcb | metal_surface | glass | <custom>
#   variant: real-alignment (optional; Day 1 PCBA real-photo alignment adds
#            datasets/pcb/assets).
#
# Environment:
#   DIG_URL_ROOT                defaults to s3://osmo-workflows/dig
#   USE_PRETRAINED_CHECKPOINT   defaults to true; set false to skip model/<usecase>
#   USE_USD2ROI_DAY1            defaults to false; true is equivalent to variant=real-alignment

set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <flow:0|1|finetune> <usecase:pcb|metal_surface|glass|...> [variant:real-alignment]" >&2
  exit 2
fi

case "${1,,}" in
  0|day0) flow=0 ;;
  1|day1) flow=1 ;;
  finetune) flow=finetune ;;
  *) flow=$1 ;;
esac
usecase=$2
variant=${3:-}
dig_root=${DIG_URL_ROOT:-s3://osmo-workflows/dig}
dig_root=${dig_root%/}
use_pretrained=${USE_PRETRAINED_CHECKPOINT:-true}
use_usd2roi_day1=${USE_USD2ROI_DAY1:-false}

is_truthy() {
  case "${1,,}" in
    true|1|yes|y) return 0 ;;
    *) return 1 ;;
  esac
}

required=()
case "$flow:$usecase" in
  0:pcb)
    required+=(
      "$dig_root/models/pretrained"
      "$dig_root/datasets/pcb/raw"
      "$dig_root/datasets/pcb/assets"
    )
    if is_truthy "$use_pretrained"; then
      required+=("$dig_root/models/pcb")
    fi
    ;;
  1:*)
    required+=(
      "$dig_root/models/pretrained"
      "$dig_root/datasets/$usecase/raw"
    )
    if is_truthy "$use_pretrained"; then
      required+=("$dig_root/models/$usecase")
    fi
    if [[ "${variant,,}" == "c" || "${variant,,}" == "real-alignment" ]] || is_truthy "$use_usd2roi_day1"; then
      required+=(
        "$dig_root/datasets/pcb/assets"
      )
    fi
    ;;
  finetune:*)
    required+=(
      "$dig_root/models/pretrained"
      "$dig_root/datasets/$usecase/raw"
    )
    ;;
  *)
    echo "unsupported flow:usecase combination: $flow:$usecase" >&2
    exit 2
    ;;
esac

stdout=$(mktemp)
stderr=$(mktemp)
trap 'rm -f "$stdout" "$stderr"' EXIT

missing=()
for url in "${required[@]}"; do
  : > "$stdout"
  : > "$stderr"
  if osmo data list --no-pager "$url" >"$stdout" 2>"$stderr"; then
    if [[ -s "$stdout" ]] && ! grep -Eiq 'no (files|objects|entries)|not found|does not exist|not exist|total 0' "$stdout" "$stderr"; then
      echo "OK: $url"
      continue
    fi
  fi
  missing+=("$url")
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing URL artifacts for flow=$flow usecase=$usecase:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  echo "Submit the relevant setup/setup_<case>.yaml + setup/setup_pretrained.yaml, or upload artifacts under DIG_URL_ROOT; see references/setup.md." >&2
  exit 1
fi

echo "OK: all ${#required[@]} required URL artifacts are present for flow=$flow usecase=$usecase."
