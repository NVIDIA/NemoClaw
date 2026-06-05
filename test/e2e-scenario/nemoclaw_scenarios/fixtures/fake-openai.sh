#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Fake OpenAI-compatible endpoint fixture.
#
# Spawns a tiny Node.js HTTP server that responds to `/v1/chat/completions`
# and `/v1/models` with deterministic stub payloads. Removes dependency on
# real NVIDIA / OpenAI endpoints for parity comparisons and fast-mode
# inference probes (Risk #2 mitigation in the migration spec).
#
# Follows the same inline-Node pattern as test-messaging-providers.sh:
# a `bash` wrapper that spawns `node -e 'http.createServer(...)'` and
# exposes the chosen port on an `_PORT` env var.
#
# Contract:
#   fake_openai_start   — start server, block until ready, export
#                         FAKE_OPENAI_PORT and FAKE_OPENAI_PID. If
#                         E2E_CONTEXT_DIR is set, also records these in
#                         context.env so later teardown can find them.
#   fake_openai_stop    — stop the server. Idempotent.

_E2E_FAKE_OPENAI_PID=""
_E2E_FAKE_OPENAI_PORT=""

fake_openai_start() {
  # Pick an ephemeral port deterministically via the server itself.
  local tmp_port
  tmp_port="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '${tmp_port}'" RETURN

  node -e '
    const http = require("http");
    const fs = require("fs");
    const portFile = process.argv[1];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        if (req.url === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            object: "list",
            data: [{ id: "fake-model", object: "model" }],
          }));
          return;
        }
        if (req.url === "/v1/chat/completions") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "chatcmpl-fake",
            object: "chat.completion",
            choices: [{
              index: 0,
              message: { role: "assistant", content: "pong" },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      fs.writeFileSync(portFile, String(server.address().port));
    });
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
    process.on("SIGINT", () => server.close(() => process.exit(0)));
  ' "${tmp_port}" &
  _E2E_FAKE_OPENAI_PID=$!

  # Wait up to ~5s for the server to write its port.
  local i
  for i in $(seq 1 50); do
    if [[ -s "${tmp_port}" ]]; then
      break
    fi
    : "${i}" # quiet unused-var check
    sleep 0.1
  done
  if [[ ! -s "${tmp_port}" ]]; then
    echo "fake_openai_start: server failed to report port" >&2
    kill "${_E2E_FAKE_OPENAI_PID}" 2>/dev/null || true
    return 1
  fi
  _E2E_FAKE_OPENAI_PORT="$(cat "${tmp_port}")"
  export FAKE_OPENAI_PORT="${_E2E_FAKE_OPENAI_PORT}"
  export FAKE_OPENAI_PID="${_E2E_FAKE_OPENAI_PID}"
  export FAKE_OPENAI_URL="http://127.0.0.1:${_E2E_FAKE_OPENAI_PORT}"
  if [[ -n "${E2E_CONTEXT_DIR:-}" && -d "${E2E_CONTEXT_DIR}" ]]; then
    printf 'FAKE_OPENAI_PORT=%s\n' "${_E2E_FAKE_OPENAI_PORT}" >>"${E2E_CONTEXT_DIR}/context.env" 2>/dev/null || true
    printf 'FAKE_OPENAI_PID=%s\n' "${_E2E_FAKE_OPENAI_PID}" >>"${E2E_CONTEXT_DIR}/context.env" 2>/dev/null || true
  fi
}

fake_openai_stop() {
  local pid="${FAKE_OPENAI_PID:-${_E2E_FAKE_OPENAI_PID:-}}"
  if [[ -n "${pid}" ]]; then
    kill "${pid}" 2>/dev/null || true
    wait "${pid}" 2>/dev/null || true
  fi
  unset FAKE_OPENAI_PORT FAKE_OPENAI_PID FAKE_OPENAI_URL
  _E2E_FAKE_OPENAI_PID=""
  _E2E_FAKE_OPENAI_PORT=""
}
