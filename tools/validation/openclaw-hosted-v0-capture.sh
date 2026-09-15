#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
umask 077

readonly expected_gate="issue-11810"
readonly expected_revision="f47724f29838fe08898993fad1c8c6b7fcb3e080"
readonly expected_manifest_sha="35c28e708e5a89a77a52fd91cbd587c1c39621014bed096464c36bbc37409b9b"
readonly expected_overlay_sha="71d23276a2472d50a8a6304e93d5e0330b1022052c839dfe53a55057089b9110"
if [[ "${NEMOCLAW_RUN_LIVE_HOSTED_PARITY:-}" != "$expected_gate" ]]; then
  printf 'set NEMOCLAW_RUN_LIVE_HOSTED_PARITY=issue-11810 to acknowledge the live run\n' >&2
  exit 2
fi
if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'v0 capture requires Linux\n' >&2
  exit 1
fi
: "${NEMOCLAW_V0_WORKTREE:?set NEMOCLAW_V0_WORKTREE to the absolute pinned v0 checkout}"
: "${NEMOCLAW_V0_CAPTURE_DIR:?set NEMOCLAW_V0_CAPTURE_DIR to an absolute owned empty directory}"
: "${NVIDIA_INFERENCE_API_KEY:?supply the dedicated credential in the environment}"
[[ "$NEMOCLAW_V0_WORKTREE" == /* ]] || { printf 'NEMOCLAW_V0_WORKTREE must be absolute\n' >&2; exit 1; }
[[ "$NEMOCLAW_V0_CAPTURE_DIR" == /* ]] || { printf 'NEMOCLAW_V0_CAPTURE_DIR must be absolute\n' >&2; exit 1; }
[[ -d "$NEMOCLAW_V0_CAPTURE_DIR" ]] || { printf 'capture directory must already exist\n' >&2; exit 1; }
[[ "$(stat -c '%a' "$NEMOCLAW_V0_CAPTURE_DIR")" == "700" ]] || {
  printf 'capture directory permissions must be 700\n' >&2
  exit 1
}
[[ -z "$(find "$NEMOCLAW_V0_CAPTURE_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
  printf 'capture directory must be empty\n' >&2
  exit 1
}
NEMOCLAW_V0_CAPTURE_DIR="$(cd "$NEMOCLAW_V0_CAPTURE_DIR" && pwd -P)"
export NEMOCLAW_V0_CAPTURE_DIR

tools_dir="$(cd "$(dirname "$0")" && pwd -P)"
readonly tools_dir
readonly patch_file="${tools_dir}/openclaw-hosted-v0-capture.patch"
[[ "$(sha256sum "$patch_file" | cut -d ' ' -f 1)" == "$expected_overlay_sha" ]] || {
  printf 'reviewed v0 validation overlay hash mismatch\n' >&2
  exit 1
}
cd "$NEMOCLAW_V0_WORKTREE"
[[ "$(git rev-parse HEAD)" == "$expected_revision" ]] || { printf 'v0 checkout is not at the pinned revision\n' >&2; exit 1; }
[[ -z "$(git status --short)" ]] || { printf 'v0 checkout must be clean\n' >&2; exit 1; }
[[ -x node_modules/.bin/vitest ]] || {
  printf 'prepare the pinned v0 checkout with npm run dev:setup before capture\n' >&2
  exit 1
}
[[ "$(sha256sum test/e2e/manifests/openclaw-nvidia.yaml | cut -d ' ' -f 1)" == "$expected_manifest_sha" ]] || {
  printf 'pinned v0 manifest hash mismatch\n' >&2
  exit 1
}
git apply --check "$patch_file"
git apply "$patch_file"
restore_overlay() {
  local status=$?
  trap - EXIT
  if ! git apply --reverse "$patch_file"; then
    printf 'failed to remove the validation overlay from the v0 checkout\n' >&2
    status=1
  fi
  exit "$status"
}
trap restore_overlay EXIT

export E2E_ARTIFACT_DIR="${NEMOCLAW_V0_CAPTURE_DIR}/artifacts"
export NEMOCLAW_11810_CAPTURE_DIR="$NEMOCLAW_V0_CAPTURE_DIR"
export NEMOCLAW_E2E_EXPECTED_SHA="$expected_revision"
export NEMOCLAW_GATEWAY_RUNTIME=docker
export NEMOCLAW_RUN_LIVE_E2E=1
export TARGET_ID=ubuntu-repo-cloud-openclaw
npm run test:live-e2e -- \
  test/e2e/live/registry-targets.test.ts \
  -t '^ubuntu-repo-cloud-openclaw:' \
  --silent=false --reporter=default
node "${tools_dir}/openclaw-hosted-v0-proof.mjs" "$NEMOCLAW_V0_CAPTURE_DIR"

printf 'v0 export: %s\n' "${NEMOCLAW_V0_CAPTURE_DIR}/v0-export.yaml"
printf 'v0 proof: %s\n' "${NEMOCLAW_V0_CAPTURE_DIR}/v0-proof.json"
