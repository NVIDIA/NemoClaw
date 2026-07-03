// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { waitUntil } from "../core/wait";

const PORT_FREE_PROBE_SCRIPT = `
const net = require("node:net");
const port = Number(process.argv[1]);
const server = net.createServer();
let done = false;
const finish = (code) => {
  if (done) return;
  done = true;
  server.close(() => process.exit(code));
};
server.once("error", () => process.exit(1));
server.listen(port, "127.0.0.1", () => finish(0));
`;

export interface ConfirmGatewayPortOptions {
  port: number;
  timeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  sleep?: (ms: number) => void;
  probePortFree: (port: number) => boolean;
  /** Optional authoritative listener scan; null means the scan itself failed. */
  listeningPids?: () => number[] | null;
}

export interface ConfirmGatewayPortResult {
  released: boolean;
  remaining: number[];
}

/** Bind loopback in a child so this synchronous stop path can prove the port is free. */
export function defaultProbePortFree(port: number): boolean {
  try {
    return (
      spawnSync(process.execPath, ["-e", PORT_FREE_PROBE_SCRIPT, String(port)], {
        stdio: "ignore",
        timeout: 2000,
      }).status === 0
    );
  } catch {
    return false;
  }
}

/**
 * Confirm both observation layers agree: lsof sees no listener (when
 * available) and an independent bind succeeds. The bind is required even
 * after an empty lsof result because unprivileged lsof can hide root-owned
 * listeners. Polling is bounded by both deadline and attempt count.
 */
export function confirmGatewayPortReleased(
  options: ConfirmGatewayPortOptions,
): ConfirmGatewayPortResult {
  let remaining: number[] = [];
  const released = waitUntil(
    () => {
      if (options.listeningPids) {
        const pids = options.listeningPids();
        if (pids === null) return false;
        remaining = pids;
        if (pids.length > 0) return false;
      }
      return options.probePortFree(options.port);
    },
    {
      deadlineMs: options.now() + options.timeoutMs,
      maxAttempts: 20,
      initialIntervalMs: options.pollIntervalMs,
      maxIntervalMs: options.pollIntervalMs,
      backoffFactor: 1,
      now: options.now,
      ...(options.sleep ? { sleep: options.sleep } : {}),
    },
  );
  return { released, remaining };
}
