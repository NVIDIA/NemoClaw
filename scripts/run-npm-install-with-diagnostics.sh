#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly MAX_EXCERPT_BYTES=3900
readonly MAX_CAPTURE_BYTES=3900

usage() {
  printf 'Usage: %s <root|plugin> <working-directory>\n' "$(basename "$0")" >&2
  exit 2
}

sanitize_diagnostics() {
  awk '
    BEGIN { private_key = 0 }
    {
      line = $0
      lower = tolower(line)
      if (line ~ /-----BEGIN ([A-Z0-9]+ )?PRIVATE[ ]KEY-----/) {
        print "<REDACTED>"
        private_key = 1
        next
      }
      if (private_key) {
        if (line ~ /-----END ([A-Z0-9]+ )?PRIVATE[ ]KEY-----/) private_key = 0
        next
      }
      if (lower ~ /(authorization|proxy-authorization|cookie|set-cookie)[ \t]*[:=]/ ||
          lower ~ /(bearer|basic)[ \t]+[^ \t]/ ||
          lower ~ /(^|[^a-z0-9])[a-z0-9_.-]*(auth|credential|key|pass|passwd|password|secret|token)[a-z0-9_.-]*[ \t]*[:=]/) {
        print "<REDACTED CREDENTIAL LINE>"
        next
      }
      print line
    }
  ' \
    | sed -E \
      -e 's#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]'"'"'"]+#<REDACTED_URL>#g' \
      -e 's#(github_pat_|ghp_|glpat-|gsk_|hf_|nvcf-|nvapi-|pypi-|sk-(ant-|proj-)?|tvly-|xapp-|xox[bpas]-)[A-Za-z0-9_-]{8,}#<REDACTED>#g' \
      -e 's#eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}#<REDACTED>#g' \
      -e 's#[A-Za-z0-9_+/=-]{32,}#<REDACTED>#g' \
    | LC_ALL=C tr -cd '\11\12\15\40-\176'
}

[[ "$#" -eq 2 ]] || usage
readonly stage="$1"
readonly working_directory="$2"
[[ "$stage" == "root" || "$stage" == "plugin" ]] || usage
[[ -d "$working_directory" ]] || {
  printf 'npm install working directory does not exist\n' >&2
  exit 2
}

umask 077
diagnostic_directory="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-npm-install.XXXXXX")"
readonly diagnostic_directory
readonly command_log="$diagnostic_directory/npm-install.log"
readonly redacted_command_log="$diagnostic_directory/npm-install.redacted.log"
trap 'if ! rm -rf -- "$diagnostic_directory"; then printf "npm diagnostic cleanup failed\n" >&2; fi' EXIT

status=0
(
  cd "$working_directory"
  env \
    -u COMPATIBLE_API_KEY \
    -u GH_TOKEN \
    -u GITHUB_TOKEN \
    -u NVIDIA_INFERENCE_API_KEY \
    -u NODE_AUTH_TOKEN \
    -u NPM_CONFIG__AUTH_TOKEN \
    -u NPM_TOKEN \
    NO_COLOR=1 \
    npm_config_color=false \
    npm_config_loglevel=verbose \
    npm_config_logs_max=0 \
    npm install --ignore-scripts 2>&1 \
    | tail -c "$MAX_CAPTURE_BYTES" >"$command_log"
  exit "${PIPESTATUS[0]}"
) || status=$?

if ! sanitize_diagnostics <"$command_log" >"$redacted_command_log"; then
  : >"$redacted_command_log"
  printf 'npm command diagnostic sanitization failed\n' >&2
fi

if [[ "$status" -eq 0 ]]; then
  tail -3 "$redacted_command_log"
  exit 0
fi

printf 'npm install failed during %s dependency installation (exit %s).\n' "$stage" "$status" >&2
printf '%s\n' '--- npm command output ---' >&2
if [[ -s "$redacted_command_log" ]]; then
  tail -c "$MAX_EXCERPT_BYTES" "$redacted_command_log" >&2
else
  printf 'npm command output unavailable\n' >&2
fi

exit "$status"
