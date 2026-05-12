// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-level HTTP readiness probe for the OpenShell gateway.
 *
 * Hits `http://127.0.0.1:${GATEWAY_PORT}/` directly (no Docker dependency),
 * which lets the reuse path verify the gateway is genuinely serving even when
 * the Docker daemon is flaky and openshell CLI metadata is stale. See #3258
 * (regression of #2020) for the original motivation.
 */

import http from "node:http";

import { GATEWAY_PORT } from "../core/ports";
import { sleepSeconds } from "../core/wait";
import { envInt } from "./env";

/**
 * HTTP status codes that indicate the gateway dispatcher is healthy.
 *
 * Mirrors the established whitelist in `verify-deployment.ts`: 200 = serving,
 * 401 = device-auth gate is enabled but the gateway is running. Anything else
 * — including 404, 403, 502, transport errors — is treated as not ready.
 */
const GATEWAY_HTTP_ALIVE_CODES = new Set<number>([200, 401]);

const ISGATEWAY_HTTP_READY_DEFAULT_TIMEOUT_MS = 3000;

export type WaitForGatewayHttpReadyOpts = {
  probe?: () => Promise<boolean>;
  sleeper?: (seconds: number) => void;
  maxAttempts?: number;
  intervalSeconds?: number;
};

/**
 * Resolve raw poll count and interval (seconds) for the reuse-time gateway
 * HTTP readiness wait, from `NEMOCLAW_REUSE_HEALTH_POLL_COUNT` and
 * `NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL`.
 *
 * Defaults are tighter than the startup health wait because reuse only needs
 * to verify a previously-warm gateway is still serving — not wait for a cold
 * k3s cluster to come up.
 *
 * The values are normalised in `waitForGatewayHttpReady`, not here, so the
 * consumer-layer guards (probe at least once; non-negative interval) cover
 * both env-derived and caller-supplied options uniformly.
 */
export function getGatewayReuseHealthWaitConfig(): { count: number; interval: number } {
  return {
    count: envInt("NEMOCLAW_REUSE_HEALTH_POLL_COUNT", 6),
    interval: envInt("NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL", 5),
  };
}

/**
 * Probe the host-level gateway HTTP endpoint at `http://127.0.0.1:${GATEWAY_PORT}/`.
 *
 * Returns true when the gateway responds with a known-alive status code,
 * false on any other status (notably 5xx from a warming upstream) or any
 * transport-level error.
 *
 * Doesn't depend on Docker — issues a direct HTTP request to the host port.
 * That makes it the right probe for the Docker-state-`unknown` branch where
 * the docker daemon is itself flaky.
 *
 * `url` is overridable for unit tests; production callers use the default.
 */
export function isGatewayHttpReady(
  timeoutMs = ISGATEWAY_HTTP_READY_DEFAULT_TIMEOUT_MS,
  url = `http://127.0.0.1:${GATEWAY_PORT}/`,
): Promise<boolean> {
  const effectiveTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.round(timeoutMs)
      : ISGATEWAY_HTTP_READY_DEFAULT_TIMEOUT_MS;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (ready: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ready);
    };
    const request = http
      .get(url, (res) => {
        res.resume();
        const code = res.statusCode || 0;
        settle(GATEWAY_HTTP_ALIVE_CODES.has(code));
      })
      .on("error", () => settle(false));
    request.setTimeout(effectiveTimeout, () => {
      request.destroy();
      settle(false);
    });
  });
}

/**
 * Poll the gateway HTTP endpoint until it returns ready or the configured
 * budget is exhausted. Returns true on the first ready response, false if
 * no attempt succeeds within the budget.
 *
 * Used at gateway-reuse decision sites to catch the case where the container
 * is running (or Docker can't be probed) but the gateway upstream is still
 * warming up — e.g. immediately after `colima stop && colima start`. Without
 * this, openshell CLI metadata reports "healthy" from the previous run and
 * onboard skips startup, only to fail later in step 4 with "Connection
 * refused". See #3258 (regression of #2020).
 *
 * `probe` and `sleeper` are injectable for unit testing.
 */
export async function waitForGatewayHttpReady(
  opts: WaitForGatewayHttpReadyOpts = {},
): Promise<boolean> {
  const probe = opts.probe ?? (() => isGatewayHttpReady());
  const sleeper = opts.sleeper ?? sleepSeconds;
  const config = getGatewayReuseHealthWaitConfig();
  // Always probe at least once, even if the caller passed a non-positive
  // maxAttempts. Non-finite (NaN, Infinity) values fall back to safe defaults
  // — Math.max alone would let Infinity through and hang the loop, and NaN
  // would propagate into sleeper().
  const rawAttempts = opts.maxAttempts ?? config.count;
  const maxAttempts = Number.isFinite(rawAttempts) ? Math.max(1, Math.round(rawAttempts)) : 1;
  const rawInterval = opts.intervalSeconds ?? config.interval;
  const intervalSeconds = Number.isFinite(rawInterval) ? Math.max(0, rawInterval) : 0;

  // The default probe (isGatewayHttpReady) never rejects, but injected probes
  // can. Treat a rejection as "not ready this attempt" so we exhaust the
  // budget instead of bailing on the first transient failure.
  const safeProbe = async (): Promise<boolean> => {
    try {
      return await probe();
    } catch {
      return false;
    }
  };

  if (await safeProbe()) return true;
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    sleeper(intervalSeconds);
    if (await safeProbe()) return true;
  }
  return false;
}
