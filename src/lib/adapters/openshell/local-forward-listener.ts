// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Worker } from "node:worker_threads";

const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const WORKER_RESPONSE_GRACE_MS = 50;
const PROBE_WORKER_SOURCE = `const { parentPort } = require("node:worker_threads");
const net = require("node:net");
parentPort.on("message", ({ port, timeout, state }) => {
  const result = new Int32Array(state);
  let finished = false;
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const finish = (value) => {
    if (finished) return;
    finished = true;
    socket.destroy();
    Atomics.store(result, 0, value);
    Atomics.notify(result, 0);
  };
  socket.setTimeout(timeout);
  socket.once("connect", () => finish(1));
  socket.once("error", () => finish(2));
  socket.once("timeout", () => finish(2));
});`;

let probeWorker: Worker | null = null;

function getProbeWorker(): Worker {
  if (probeWorker) return probeWorker;
  const worker = new Worker(PROBE_WORKER_SOURCE, { eval: true });
  worker.unref();
  worker.on("error", () => {
    if (probeWorker === worker) probeWorker = null;
  });
  worker.on("exit", () => {
    if (probeWorker === worker) probeWorker = null;
  });
  probeWorker = worker;
  return worker;
}

/** Transport evidence only; callers must establish listener ownership separately. */
export function probeLocalForwardListener(
  port: number,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): boolean {
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return false;
  }
  const timeout = Math.max(1, Math.floor(timeoutMs));
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  try {
    getProbeWorker().postMessage({ port, timeout, state: state.buffer });
  } catch {
    probeWorker = null;
    return false;
  }
  Atomics.wait(state, 0, 0, timeout + WORKER_RESPONSE_GRACE_MS);
  return Atomics.load(state, 0) === 1;
}
