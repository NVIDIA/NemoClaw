// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-level TCP readiness probe for the OpenShell Docker-driver gateway.
 *
 * Plain TCP connect to `127.0.0.1:${GATEWAY_PORT}` — semantic-free, just asks
 * "is anyone listening?". Used by `startDockerDriverGateway` in `onboard.ts`
 * to gate the "✓ Docker-driver gateway is healthy" log against the class of
 * bug reported in #3111, where the openshell-gateway binary crashed on
 * startup but metadata-based health checks (isGatewayHealthy) still
 * returned true because:
 *
 *   - `isPidAlive` (`process.kill(pid, 0)`) returns true for zombies;
 *   - `registerDockerDriverGatewayEndpoint` is metadata-only
 *     (`openshell gateway add --local`) and doesn't probe the endpoint;
 *   - `isGatewayHealthy` is a string match on `openshell status` /
 *     `openshell gateway info` output, not a live probe.
 *
 * ## Why TCP and not HTTP
 *
 * There is a peer module `gateway-http-readiness.ts` (introduced by #3312)
 * that exposes `isGatewayHttpReady` — a stronger HTTP-level probe used on
 * the K3s path. It cannot be reused on the Docker-driver path because the
 * two gateway types expose different HTTP routes for the root path:
 *
 *   - K3s gateway answers `GET /` with 200/401 via a dispatcher catch-all.
 *   - Docker-driver gateway returns 404 for `GET /`; only routes under
 *     `/openshell.v1.OpenShell/*` (gRPC-over-HTTP) are served.
 *
 * Using the HTTP probe against a running Docker-driver gateway therefore
 * always fails the `{200, 401}` whitelist, which was the regression the
 * e2e-advisor caught in the first attempt at a shared fix.
 *
 * A plain TCP probe is sufficient for detecting #3111's failure mode
 * (crashed binary → nothing listening → TCP fails) without making
 * assumptions about HTTP route shape.
 *
 * ## Prior art in the codebase
 *
 * `isLocalForwardReachable` in
 * `src/lib/actions/sandbox/process-recovery.ts` (added by #3385) does a
 * similar TCP probe for the sandbox-forward domain, but spawns a child
 * node process per probe and is intentionally private to that module.
 * The two helpers serve different domains (onboard gateway vs. sandbox
 * forward) and have different sync/async requirements, but a future
 * unified "port liveness probe" API could subsume both. Tracked in #3213
 * (unified advisory / probe registry).
 */

import net from "node:net";

import { GATEWAY_PORT } from "../core/ports";

const ISGATEWAY_TCP_READY_DEFAULT_TIMEOUT_MS = 500;

/**
 * Minimum timeout clamp. Callers are allowed to pass 0 or small values, but
 * the effective timeout never drops below this, so a regression that removes
 * the clamp or passes a zero from a misconfigured env var can't turn this
 * into a spin-loop or an instant-return.
 */
const ISGATEWAY_TCP_READY_MIN_TIMEOUT_MS = 50;

/**
 * Probe a TCP endpoint on localhost to verify something is actually
 * listening and accepting connections on the gateway port.
 *
 * Resolves true on a successful TCP connect. Resolves false on connection
 * refused, unreachable host, or timeout. Never rejects.
 *
 * @param port      Gateway port. Defaults to `GATEWAY_PORT` so normal call
 *                  sites don't have to thread the constant themselves.
 * @param timeoutMs Per-connect timeout. Clamped to a 50 ms minimum so the
 *                  probe can't spin or return instantly when a caller
 *                  passes 0.
 * @param host      Target host. Defaults to `127.0.0.1`; overridable only
 *                  for unit testing (exercising the timeout path against
 *                  a non-routable address).
 */
export function isGatewayTcpReady(
  port: number = GATEWAY_PORT,
  timeoutMs: number = ISGATEWAY_TCP_READY_DEFAULT_TIMEOUT_MS,
  host = "127.0.0.1",
): Promise<boolean> {
  const effectiveTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > ISGATEWAY_TCP_READY_MIN_TIMEOUT_MS
      ? Math.round(timeoutMs)
      : ISGATEWAY_TCP_READY_MIN_TIMEOUT_MS;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });
    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* best effort */
      }
      resolve(result);
    };
    socket.setTimeout(effectiveTimeout);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}
