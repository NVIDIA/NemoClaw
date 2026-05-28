#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared primitive for fake HTTP stub fixtures.
#
# Spawns a small Node.js HTTP server that answers any path with 200/JSON
# and echoes the request shape. Used by `fake-telegram.sh`, `fake-discord.sh`,
# and `fake-slack.sh` to avoid duplicating the listener harness.
#
# Function:
#   _fake_http_stub_start <provider-label> <pid-var> <port-var>
#     Writes the spawned server's PID into $pid-var and port into $port-var
#     (via `printf -v`). Exports ${provider-label-upper}_PORT and _PID.
#   _fake_http_stub_stop <pid-var>
#     Kills the stored PID. Idempotent.

_fake_http_stub_start() {
  local label="${1:?provider label required}"
  local pid_var="${2:?pid var name required}"
  local port_var="${3:?port var name required}"

  local tmp_port
  tmp_port="$(mktemp)"

  node -e '
    const http = require("http");
    const fs = require("fs");
    const portFile = process.argv[1];
    const label = process.argv[2];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          provider: label,
          method: req.method,
          url: req.url,
          body,
        }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      fs.writeFileSync(portFile, String(server.address().port));
    });
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
    process.on("SIGINT", () => server.close(() => process.exit(0)));
  ' "${tmp_port}" "${label}" &
  local pid=$!

  local i
  for i in $(seq 1 50); do
    [[ -s "${tmp_port}" ]] && break
    : "${i}" # quiet unused-var check
    sleep 0.1
  done
  if [[ ! -s "${tmp_port}" ]]; then
    echo "_fake_http_stub_start: ${label} server failed to report port" >&2
    kill "${pid}" 2>/dev/null || true
    rm -f "${tmp_port}"
    return 1
  fi
  local port
  port="$(cat "${tmp_port}")"
  rm -f "${tmp_port}"

  # shellcheck disable=SC2229  # dynamic name is the point
  printf -v "${pid_var}" '%s' "${pid}"
  printf -v "${port_var}" '%s' "${port}"

  local upper
  upper="$(printf '%s' "${label}" | tr '[:lower:]' '[:upper:]')"
  export "FAKE_${upper}_PORT=${port}"
  export "FAKE_${upper}_PID=${pid}"
  export "FAKE_${upper}_URL=http://127.0.0.1:${port}"
}

_fake_http_stub_stop() {
  local pid_var="${1:?pid var name required}"
  local pid="${!pid_var:-}"
  if [[ -n "${pid}" ]]; then
    kill "${pid}" 2>/dev/null || true
    wait "${pid}" 2>/dev/null || true
  fi
  # shellcheck disable=SC2229
  printf -v "${pid_var}" '%s' ""
}
