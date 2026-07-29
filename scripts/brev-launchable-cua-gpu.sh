#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Versioned GPU-backed Brev Launchable bootstrap for CUA qualification.
#
# Required Launchable variables:
#   NEMOCLAW_REF  Exact lowercase 40-hex NemoClaw candidate commit.
#   NEMOCLAW_CUA_GPU_PROBE_IMAGE
#                  Exact nvidia/cuda@sha256:... image used to prove GPU access.
#
# The Brev image owns GPU hardware, driver, and NVIDIA Container Toolkit
# provisioning. This script verifies those prerequisites, installs the exact
# NemoClaw candidate through the reviewed bootstrap, and records only
# content-free component identities for the qualification runner.

set -euo pipefail

readonly CUA_LAUNCHABLE_VERSION="1.0.0"
readonly CUA_SENTINEL="/var/run/nemoclaw-cua-launchable-ready"
readonly IDENTITY_FILE="/var/lib/nemoclaw/cua-launchable-identity.json"
BASE_DIR="$(mktemp -d)"
readonly BASE_DIR
BASE_SCRIPT="${BASE_DIR}/nemoclaw-brev-launchable-base.sh"
readonly BASE_SCRIPT
trap 'rm -rf "$BASE_DIR"' EXIT

fail() {
  printf 'brev-launchable-cua-gpu: %s\n' "$1" >&2
  exit 1
}

[[ "${NEMOCLAW_REF:-}" =~ ^[0-9a-f]{40}$ ]] \
  || fail "NEMOCLAW_REF must be an exact lowercase 40-hex commit"
[[ "${NEMOCLAW_CUA_GPU_PROBE_IMAGE:-}" =~ ^nvidia/cuda@sha256:[0-9a-f]{64}$ ]] \
  || fail "NEMOCLAW_CUA_GPU_PROBE_IMAGE must be an exact nvidia/cuda@sha256 digest"
[[ -f "$0" ]] || fail "the Launchable startup script must be a regular file"

command -v nvidia-smi >/dev/null 2>&1 \
  || fail "the selected Brev Launchable image does not expose nvidia-smi"
command -v nvidia-ctk >/dev/null 2>&1 \
  || fail "the selected Brev Launchable image does not include NVIDIA Container Toolkit"
command -v curl >/dev/null 2>&1 || fail "the selected Brev Launchable image does not include curl"
command -v git >/dev/null 2>&1 || fail "the selected Brev Launchable image does not include git"

base_url="https://raw.githubusercontent.com/NVIDIA/NemoClaw/${NEMOCLAW_REF}/scripts/brev-launchable-ci-cpu.sh"
curl -fsSL "$base_url" -o "$BASE_SCRIPT"
chmod 0700 "$BASE_SCRIPT"

launchable_digest="$(sha256sum "$0" | awk '{print $1}')"
target_user="${SUDO_USER:-$(id -un)}"
target_home="$(getent passwd "$target_user" | cut -d: -f6)"
clone_dir="${NEMOCLAW_CLONE_DIR:-${target_home}/NemoClaw}"
[[ ! -e "$clone_dir" && ! -L "$clone_dir" ]] \
  || fail "the fresh Launchable clone path already exists"
git clone --filter=blob:none --no-checkout \
  "https://github.com/NVIDIA/NemoClaw.git" "$clone_dir"
git -C "$clone_dir" fetch --depth 1 origin "$NEMOCLAW_REF"
git -C "$clone_dir" checkout --detach "$NEMOCLAW_REF"
cmp -s "$BASE_SCRIPT" "$clone_dir/scripts/brev-launchable-ci-cpu.sh" \
  || fail "downloaded base bootstrap does not match the exact candidate checkout"

NEMOCLAW_REF="$NEMOCLAW_REF" bash "$BASE_SCRIPT"
sudo rm -f /var/run/nemoclaw-launchable-ready

sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
sg docker -c "docker run --rm --gpus all '$NEMOCLAW_CUA_GPU_PROBE_IMAGE' nvidia-smi"

gpu_names="$(nvidia-smi --query-gpu=name --format=csv,noheader | tr -d '\r')"
gpu_count="$(printf '%s\n' "$gpu_names" | awk 'NF { count++ } END { print count + 0 }')"
gpu_model="$(printf '%s\n' "$gpu_names" | sort -u | paste -sd ';' -)"
driver_version="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n 1 | tr -d '\r')"
cuda_version="$(
  nvidia-smi \
    | sed -n 's/.*CUDA Version: \([0-9][0-9.]*\).*/\1/p' \
    | head -n 1
)"
toolkit_version="$(nvidia-ctk --version | head -n 1)"

[[ "$gpu_count" =~ ^[1-9][0-9]*$ && -n "$gpu_model" && -n "$driver_version" &&
  -n "$cuda_version" && -n "$toolkit_version" ]] \
  || fail "GPU identity discovery returned an incomplete record"

sudo install -d -m 0755 "$(dirname "$IDENTITY_FILE")"
jq -n \
  --arg schemaVersion "1.0.0" \
  --arg launchableVersion "$CUA_LAUNCHABLE_VERSION" \
  --arg launchableDigest "sha256:${launchable_digest}" \
  --arg nemoclawCommit "$NEMOCLAW_REF" \
  --argjson gpuCount "$gpu_count" \
  --arg gpuModel "$gpu_model" \
  --arg driverVersion "$driver_version" \
  --arg cudaVersion "$cuda_version" \
  --arg toolkitVersion "$toolkit_version" \
  --arg probeImageDigest "${NEMOCLAW_CUA_GPU_PROBE_IMAGE#nvidia/cuda@}" \
  '{
    schemaVersion: $schemaVersion,
    kind: "cua-launchable-identity",
    launchableVersion: $launchableVersion,
    launchableDigest: $launchableDigest,
    nemoclawCommit: $nemoclawCommit,
    gpu: {
      count: $gpuCount,
      model: $gpuModel,
      driverVersion: $driverVersion,
      cudaVersion: $cudaVersion,
      containerToolkitVersion: $toolkitVersion,
      probeImageDigest: $probeImageDigest
    }
  }' \
  | sudo tee "$IDENTITY_FILE" >/dev/null
sudo chmod 0644 "$IDENTITY_FILE"
sudo touch "$CUA_SENTINEL"

printf 'brev-launchable-cua-gpu: ready (version %s, candidate %s)\n' \
  "$CUA_LAUNCHABLE_VERSION" "$NEMOCLAW_REF"
