#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly MAX_DIAGNOSTIC_BYTES=8192

usage() {
  printf 'Usage: %s <root|plugin> <working-directory>\n' "$(basename "$0")" >&2
  exit 2
}

redact_diagnostics() {
  sed -E \
    -e 's#(https?://)[^/@[:space:]]+(:[^/@[:space:]]*)?@#\1[REDACTED]@#g' \
    -e 's#((authorization|proxy-authorization)[=:][[:space:]]*(Bearer|Basic)?[[:space:]]*)[^[:space:]]+#\1[REDACTED]#Ig' \
    -e 's#(([_-]?auth(token)?|access[_-]?token|api[_-]?key|npm_token|node_auth_token|password|passwd|refresh[_-]?token|secret|token)["'"'"' ]*[=:]["'"'"' ]*)[^[:space:]"'"'"']+#\1[REDACTED]#Ig' \
    -e 's#([?&](access[_-]?token|api[_-]?key|auth|password|secret|token)=)[^&[:space:]]+#\1[REDACTED]#Ig'
}

[[ "$#" -eq 2 ]] || usage
readonly stage="$1"
readonly working_directory="$2"
[[ "$stage" == "root" || "$stage" == "plugin" ]] || usage
[[ -d "$working_directory" ]] || {
  printf 'npm install working directory does not exist: %s\n' "$working_directory" >&2
  exit 2
}

umask 077
diagnostic_directory="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-npm-install.XXXXXX")"
readonly diagnostic_directory
readonly command_log="$diagnostic_directory/npm-install.log"
readonly npm_log_directory="$diagnostic_directory/npm-logs"
trap 'rm -rf "$diagnostic_directory"' EXIT
mkdir -p "$npm_log_directory"

status=0
(
  cd "$working_directory"
  env \
    -u NODE_AUTH_TOKEN \
    -u NPM_TOKEN \
    -u NPM_CONFIG__AUTH_TOKEN \
    -u GITHUB_TOKEN \
    -u GH_TOKEN \
    -u NVIDIA_INFERENCE_API_KEY \
    -u COMPATIBLE_API_KEY \
    NO_COLOR=1 \
    npm_config_color=false \
    npm_config_logs_dir="$npm_log_directory" \
    npm_config_logs_max=1 \
    npm install --ignore-scripts
) >"$command_log" 2>&1 || status=$?

if [[ "$status" -eq 0 ]]; then
  tail -3 "$command_log"
  exit 0
fi

printf 'npm install failed during %s dependency installation (exit %s).\n' "$stage" "$status" >&2
combined_log="$diagnostic_directory/combined.log"
cp "$command_log" "$combined_log"

latest_debug_log=""
for candidate in "$npm_log_directory"/*-debug-0.log; do
  if [[ -f "$candidate" && ! -L "$candidate" ]] \
    && [[ -z "$latest_debug_log" || "$candidate" -nt "$latest_debug_log" ]]; then
    latest_debug_log="$candidate"
  fi
done

if [[ -n "$latest_debug_log" ]]; then
  printf '\n--- npm debug log ---\n' >>"$combined_log"
  cat "$latest_debug_log" >>"$combined_log"
else
  printf '\nnpm debug log unavailable\n' >>"$combined_log"
fi

redact_diagnostics <"$combined_log" | tail -c "$MAX_DIAGNOSTIC_BYTES" >&2
exit "$status"
