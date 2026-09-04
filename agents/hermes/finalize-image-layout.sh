#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

sandbox_root="${1:-/sandbox}"
case "$sandbox_root" in
  /*) ;;
  *)
    echo "ERROR: Hermes image layout root must be absolute: $sandbox_root" >&2
    exit 1
    ;;
esac
if [ "$sandbox_root" = "/" ]; then
  echo "ERROR: Hermes image layout root must not be /" >&2
  exit 1
fi

sandbox_root="${sandbox_root%/}"
config_dir="$sandbox_root/.hermes"
data_dir="$sandbox_root/.hermes-data"
openclaw_dir="$sandbox_root/.openclaw"

if [ -e "$openclaw_dir" ] || [ -L "$openclaw_dir" ]; then
  echo "ERROR: Hermes base image contains retired OpenClaw state: $openclaw_dir" >&2
  exit 1
fi

mkdir -p "$config_dir"
if [ -L "$data_dir" ]; then
  echo "ERROR: refusing legacy layout cleanup because $data_dir is a symlink" >&2
  exit 1
fi

if [ -d "$data_dir" ]; then
  legacy_link="$(find "$data_dir" -type l -print -quit)"
  if [ -n "$legacy_link" ]; then
    echo "ERROR: refusing legacy layout cleanup because $legacy_link is a symlink" >&2
    exit 1
  fi
  for entry in "$data_dir"/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="$(basename "$entry")"
    target="$config_dir/$name"
    if [ -L "$target" ]; then
      rm -f "$target"
    fi
    if [ -d "$entry" ]; then
      mkdir -p "$target"
      cp -a "$entry"/. "$target"/
    elif [ ! -e "$target" ]; then
      cp -a "$entry" "$target"
    fi
  done

  data_real="$(readlink -f "$data_dir" 2>/dev/null || printf '%s' "$data_dir")"
  while :; do
    replaced_marker="$(mktemp)"
    rm -f "$replaced_marker"
    find "$config_dir" -type l -print | while IFS= read -r link; do
      raw_target="$(readlink "$link" 2>/dev/null || true)"
      resolved_target="$(readlink -f "$link" 2>/dev/null || true)"
      legacy_target=0
      case "$raw_target" in "$data_real"/* | "$data_dir"/*) legacy_target=1 ;; esac
      case "$resolved_target" in "$data_real"/* | "$data_dir"/*) legacy_target=1 ;; esac
      if [ "$legacy_target" -eq 1 ]; then
        copy_target="$resolved_target"
        if [ -z "$copy_target" ] || { [ ! -e "$copy_target" ] && [ ! -L "$copy_target" ]; }; then
          copy_target="$raw_target"
        fi
        if [ -d "$copy_target" ] && [ ! -L "$copy_target" ]; then
          rm -f "$link"
          mkdir -p "$link"
          cp -a "$copy_target"/. "$link"/
        elif [ -e "$copy_target" ] || [ -L "$copy_target" ]; then
          rm -f "$link"
          cp -a "$copy_target" "$link"
        else
          echo "ERROR: legacy symlink target missing: $link -> ${raw_target:-$resolved_target}" >&2
          exit 1
        fi
        : >"$replaced_marker"
      fi
    done
    if [ ! -e "$replaced_marker" ]; then
      rm -f "$replaced_marker"
      break
    fi
    rm -f "$replaced_marker"
  done
  rm -rf "$data_dir"
fi
