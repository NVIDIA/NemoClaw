// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synchronous waiting primitives for CLI commands.
 */

import { buildValidatedCurlCommandArgs } from "../adapters/http/curl-args";
import { withLocalNoProxy } from "../subprocess-env.js";

/**
 * Build a curl-friendly env that injects NO_PROXY for loopback hosts so that
 * probes against localhost-bound services (Ollama, gateway, dashboard, etc.)
 * do not get routed through a user-configured HTTP_PROXY. See #4181.
 */
export function buildLoopbackProbeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  withLocalNoProxy(env);
  return env;
}

/**
 * Synchronously sleep for the given number of milliseconds.
 * Uses Atomics.wait to block without pegging the CPU.
 */
export function sleepMs(ms: number): void {
  if (ms <= 0 || !Number.isFinite(ms)) return;
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

/**
 * Synchronously sleep for the given number of seconds.
 */
export function sleepSeconds(seconds: number): void {
  sleepMs(seconds * 1000);
}

/**
 * Synchronously wait until a condition is met.
 */
export function waitUntil(
  conditionFn: () => boolean,
  timeoutSeconds = 10,
  pollIntervalMs = 250,
): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutSeconds * 1000) {
    if (conditionFn()) return true;
    sleepMs(pollIntervalMs);
  }
  return false;
}

// One-shot TCP reachability probe, evaluated in a short-lived Node subprocess.
// Used as a fallback when `nc` is not installed. The port is passed as argv
// (process.argv[1]) rather than interpolated into the script, so it can never
// be treated as code. Exit 0 = connected, 1 = refused or timed out.
const TCP_PROBE_SCRIPT =
  "const p=Number(process.argv[1]);" +
  "const s=require('node:net').connect({host:'127.0.0.1',port:p}," +
  "()=>{s.destroy();process.exit(0);});" +
  "s.on('error',()=>process.exit(1));" +
  "s.setTimeout(1000,()=>{s.destroy();process.exit(1);});";

/**
 * Synchronously wait for a TCP port to become reachable on localhost.
 *
 * Prefers `nc -z`, but falls back to a short-lived Node subprocess that opens a
 * TCP connection when `nc` is not installed (minimal Linux distros such as
 * CachyOS, and Windows). Previously a missing `nc` made every probe fail
 * silently, surfacing as a misleading "did not become ready within timeout".
 * See #4974.
 */
export function waitForPort(port: number, timeoutSeconds = 5): boolean {
  const { spawnSync } = require("node:child_process");
  return waitUntil(
    () => {
      try {
        const nc = spawnSync("nc", ["-z", "127.0.0.1", String(port)], { stdio: "ignore" });
        // If nc actually ran, trust its verdict. If nc is missing it returns
        // ENOENT (error set, status null) -- fall back to a Node-based probe
        // rather than reporting the port unreachable.
        if (nc.error == null && typeof nc.status === "number") {
          return nc.status === 0;
        }
        const probe = spawnSync(process.execPath, ["-e", TCP_PROBE_SCRIPT, String(port)], {
          stdio: "ignore",
          timeout: 2000,
        });
        return probe.status === 0;
      } catch {
        return false;
      }
    },
    timeoutSeconds,
    200,
  );
}

/**
 * Synchronously wait for an HTTP endpoint to return a success status code.
 */
export function waitForHttp(url: string, timeoutSeconds = 5): boolean {
  const { spawnSync } = require("node:child_process");
  const env = buildLoopbackProbeEnv();
  return waitUntil(
    () => {
      try {
        const result = spawnSync(
          "curl",
          buildValidatedCurlCommandArgs(["-sf", "--connect-timeout", "1", "--max-time", "1", url]),
          { stdio: "ignore", env },
        );
        return result.status === 0;
      } catch {
        return false;
      }
    },
    timeoutSeconds,
    200,
  );
}
