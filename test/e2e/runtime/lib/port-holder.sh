#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Local TCP listener helper for deterministic gateway port-conflict tests.

E2E_PORT_HOLDER_PID="${E2E_PORT_HOLDER_PID:-}"

e2e_port_holder_start() {
  local port="$1"
  if [[ -n "${E2E_PORT_HOLDER_PID}" ]]; then
    e2e_port_holder_stop
  fi
  E2E_PORT_HOLDER_PID=""
  node - "${port}" <<'NODE' >/tmp/nemoclaw-e2e-port-holder.log 2>&1 &
const net = require("node:net");
const port = Number(process.argv[2]);
const server = net.createServer((socket) => socket.end());
server.on("error", (err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(2);
});
server.listen(port, "127.0.0.1", () => {
  console.log("ready");
});
setInterval(() => {}, 1000);
NODE
  E2E_PORT_HOLDER_PID=$!
  local _i
  for _i in $(seq 1 40); do
    if node -e 'const net=require("node:net"); const port=Number(process.argv[1]); const s=net.connect(port,"127.0.0.1"); s.once("connect",()=>{s.destroy(); process.exit(0);}); s.once("error",()=>process.exit(1)); setTimeout(()=>process.exit(1),250);' "${port}" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "${E2E_PORT_HOLDER_PID}" >/dev/null 2>&1; then
      E2E_PORT_HOLDER_PID=""
      return 1
    fi
    sleep 0.25
  done
  if [[ -n "${E2E_PORT_HOLDER_PID}" ]]; then
    kill "${E2E_PORT_HOLDER_PID}" >/dev/null 2>&1 || true
    wait "${E2E_PORT_HOLDER_PID}" >/dev/null 2>&1 || true
    E2E_PORT_HOLDER_PID=""
  fi
  return 1
}

e2e_port_holder_stop() {
  if [[ -n "${E2E_PORT_HOLDER_PID}" ]]; then
    kill "${E2E_PORT_HOLDER_PID}" >/dev/null 2>&1 || true
    wait "${E2E_PORT_HOLDER_PID}" >/dev/null 2>&1 || true
    E2E_PORT_HOLDER_PID=""
  fi
}
