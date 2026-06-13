#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

start_fake_openai_compatible_api() {
  local script_dir server_script port_file ready_host public_host
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
  server_script="${script_dir}/fake-openai-compatible-api.mts"
  port_file="${FAKE_OPENAI_PORT_FILE:-$(mktemp)}"
  ready_host="${FAKE_OPENAI_READY_HOST:-127.0.0.1}"

  : "${FAKE_OPENAI_HOST:=127.0.0.1}"
  : "${FAKE_OPENAI_PORT:=0}"
  : "${FAKE_OPENAI_MODEL:=test-model}"
  : "${FAKE_OPENAI_LOG:=$(mktemp)}"

  rm -f "$port_file"
  : >"$FAKE_OPENAI_LOG"

  NEMOCLAW_FAKE_OPENAI_HOST="$FAKE_OPENAI_HOST" \
    NEMOCLAW_FAKE_OPENAI_PORT="$FAKE_OPENAI_PORT" \
    NEMOCLAW_FAKE_OPENAI_PORT_FILE="$port_file" \
    NEMOCLAW_FAKE_OPENAI_LOG_FILE="$FAKE_OPENAI_LOG" \
    NEMOCLAW_FAKE_OPENAI_MODEL="$FAKE_OPENAI_MODEL" \
    NEMOCLAW_FAKE_OPENAI_API_KEY="${FAKE_OPENAI_API_KEY:-}" \
    NEMOCLAW_FAKE_OPENAI_REQUIRE_AUTH="${FAKE_OPENAI_REQUIRE_AUTH:-0}" \
    NEMOCLAW_FAKE_OPENAI_CHAT_CONTENT="${FAKE_OPENAI_CHAT_CONTENT:-ok}" \
    NEMOCLAW_FAKE_OPENAI_RESPONSE_TEXT="${FAKE_OPENAI_RESPONSE_TEXT:-${FAKE_OPENAI_CHAT_CONTENT:-ok}}" \
    node --experimental-strip-types "$server_script" &
  FAKE_OPENAI_PID="$!"

  for _ in $(seq 1 "${FAKE_OPENAI_READY_ATTEMPTS:-30}"); do
    if [ -s "$port_file" ]; then
      FAKE_OPENAI_PORT="$(cat "$port_file")"
      if curl -sf "http://${ready_host}:${FAKE_OPENAI_PORT}/v1/models" >/dev/null 2>&1; then
        public_host="${FAKE_OPENAI_PUBLIC_HOST:-$FAKE_OPENAI_HOST}"
        if [ "$public_host" = "0.0.0.0" ]; then
          public_host="127.0.0.1"
        fi
        FAKE_OPENAI_BASE_URL="http://${public_host}:${FAKE_OPENAI_PORT}/v1"
        rm -f "$port_file"
        export FAKE_OPENAI_BASE_URL FAKE_OPENAI_PID FAKE_OPENAI_PORT
        return 0
      fi
    fi
    sleep 1
  done

  stop_fake_openai_compatible_api
  rm -f "$port_file"
  return 1
}

stop_fake_openai_compatible_api() {
  if [ -n "${FAKE_OPENAI_PID:-}" ] && kill -0 "$FAKE_OPENAI_PID" 2>/dev/null; then
    kill "$FAKE_OPENAI_PID" 2>/dev/null || true
    wait "$FAKE_OPENAI_PID" 2>/dev/null || true
  fi
  FAKE_OPENAI_PID=""
}
