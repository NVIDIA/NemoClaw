#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Managed Deep Agents Code launcher for NemoClaw/OpenShell sandboxes.

set -euo pipefail

export HOME=/sandbox
export PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
export DEEPAGENTS_CODE_NO_UPDATE_CHECK=1
export DEEPAGENTS_CODE_AUTO_UPDATE=0
export DEEPAGENTS_CODE_OPENAI_API_KEY="${DEEPAGENTS_CODE_OPENAI_API_KEY:-nemoclaw-managed-inference}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://inference.local/v1}"

run_dcode() {
  exec python3 -m deepagents_code "$@"
}

case "${1:-}" in
  --version | -v | -V | --help | -h)
    run_dcode "$@"
    ;;
esac

unset DEEPAGENTS_CODE_SHELL_ALLOW_LIST

reject_managed_override() {
  local posture="$1"
  local arg="$2"
  printf 'NemoClaw manages Deep Agents Code %s; remove %s and use NemoClaw policy/configuration instead.\n' "$posture" "$arg" >&2
  exit 2
}

if [ "${1:-}" = "mcp" ]; then
  reject_managed_override "MCP posture" "mcp"
fi

for arg in "$@"; do
  case "$arg" in
    --sandbox | --sandbox=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --sandbox-id | --sandbox-id=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --sandbox-snapshot-name | --sandbox-snapshot-name=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --sandbox-setup | --sandbox-setup=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --mcp-config | --mcp-config=* | --trust-project-mcp | --no-mcp=*)
      reject_managed_override "MCP posture" "$arg"
      ;;
    --shell-allow-list | --shell-allow-list=* | -S | -S?*)
      reject_managed_override "shell allow-list posture" "$arg"
      ;;
  esac
done

# Reject empty or whitespace-only non-interactive prompts (#5752). dcode's
# `-n` / `--non-interactive TEXT` takes the prompt as its value; an empty value
# otherwise silently runs a task or drops into the interactive UI instead of
# failing fast, which breaks headless automation that relies on a non-zero exit
# for misuse. Refuse here, before dcode launches, so no LangGraph server, tools,
# or interactive TUI ever start.
reject_empty_non_interactive() {
  printf 'NemoClaw: empty non-interactive prompt for %s; provide prompt text.\n' "$1" >&2
  exit 2
}

prompt_is_blank() {
  case "$1" in
    *[![:space:]]*) return 1 ;;
    *) return 0 ;;
  esac
}

dcode_args=("$@")
arg_index=0
while [ "$arg_index" -lt "${#dcode_args[@]}" ]; do
  current_arg="${dcode_args[arg_index]}"
  case "$current_arg" in
    -n | --non-interactive)
      # Prompt is the next token. Validate it, then skip past it so a value
      # that happens to look like a flag is not re-examined as one.
      value_index=$((arg_index + 1))
      if [ "$value_index" -lt "${#dcode_args[@]}" ]; then
        if prompt_is_blank "${dcode_args[value_index]}"; then
          reject_empty_non_interactive "$current_arg"
        fi
      fi
      arg_index=$((value_index + 1))
      continue
      ;;
    --non-interactive=*)
      if prompt_is_blank "${current_arg#--non-interactive=}"; then
        reject_empty_non_interactive "--non-interactive"
      fi
      ;;
    -n?*)
      if prompt_is_blank "${current_arg#-n}"; then
        reject_empty_non_interactive "-n"
      fi
      ;;
  esac
  arg_index=$((arg_index + 1))
done

extra_args=(--sandbox none --no-mcp)

run_dcode "${extra_args[@]}" "$@"
