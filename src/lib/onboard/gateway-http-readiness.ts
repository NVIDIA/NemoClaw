// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-level HTTP readiness probe for the OpenShell gateway.
 *
 * Hits the local gateway HTTP endpoint directly (no Docker dependency),
 * which lets the reuse path verify the gateway is genuinely serving even when
 * the Docker daemon is flaky and openshell CLI metadata is stale. See #3258
 * (regression of #2020) for the original motivation.
 */

import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import path from "node:path";

import { getGatewayHttpEndpoint, getGatewayHttpsEndpoint } from "../core/gateway-address";
import { GATEWAY_PORT } from "../core/ports";
import { sleepSeconds, waitUntilAsync } from "../core/wait";
import { addTraceEvent, withTraceSpan } from "../trace";
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
  /** Keep observation-only callers from initializing the onboard trace sink. */
  recordTrace?: boolean;
};

export type GatewayHttpReadinessTraceOptions = {
  /** Defaults to true so onboarding keeps its existing trace coverage. */
  recordTrace?: boolean;
};

function withOptionalTraceSpan<T>(
  options: GatewayHttpReadinessTraceOptions,
  name: string,
  attributes: Record<string, unknown>,
  fn: () => T,
): T {
  return options.recordTrace === false ? fn() : withTraceSpan(name, attributes, fn);
}

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
 * Probe the host-level gateway HTTP endpoint.
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
  url = `${getGatewayHttpEndpoint(GATEWAY_PORT)}/`,
  method: "GET" | "POST" = "GET",
  signal?: AbortSignal,
  traceOptions: GatewayHttpReadinessTraceOptions = {},
): Promise<boolean> {
  return withOptionalTraceSpan(
    traceOptions,
    "nemoclaw.gateway.http_probe",
    { timeout_ms: timeoutMs, url, method },
    () => isGatewayHttpReadyImpl(timeoutMs, url, method, signal),
  );
}

function isGatewayHttpReadyImpl(
  timeoutMs = ISGATEWAY_HTTP_READY_DEFAULT_TIMEOUT_MS,
  url = `${getGatewayHttpEndpoint(GATEWAY_PORT)}/`,
  method: "GET" | "POST" = "GET",
  signal?: AbortSignal,
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
    let request: http.ClientRequest;
    try {
      request = http
        .request(url, { method, signal }, (res) => {
          res.resume();
          const code = res.statusCode || 0;
          settle(GATEWAY_HTTP_ALIVE_CODES.has(code));
        })
        .on("error", () => settle(false));
    } catch {
      settle(false);
      return;
    }
    request.setTimeout(effectiveTimeout, () => {
      request.destroy();
      settle(false);
    });
    request.end();
  });
}

export function isDockerDriverGatewayHttpReady(
  timeoutMs = ISGATEWAY_HTTP_READY_DEFAULT_TIMEOUT_MS,
  url = `${getGatewayHttpsEndpoint(GATEWAY_PORT)}/openshell.v1.OpenShell/Health`,
  env: NodeJS.ProcessEnv = process.env,
  traceOptions: GatewayHttpReadinessTraceOptions = {},
): Promise<boolean> {
  return withOptionalTraceSpan(
    traceOptions,
    "nemoclaw.gateway.docker_driver_http_probe",
    { timeout_ms: timeoutMs, url },
    () => isDockerDriverGatewayHttpReadyImpl(timeoutMs, url, env),
  );
}

function isDockerDriverGatewayHttpReadyImpl(
  timeoutMs = ISGATEWAY_HTTP_READY_DEFAULT_TIMEOUT_MS,
  url = `${getGatewayHttpsEndpoint(GATEWAY_PORT)}/openshell.v1.OpenShell/Health`,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const effectiveTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.round(timeoutMs)
      : ISGATEWAY_HTTP_READY_DEFAULT_TIMEOUT_MS;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let statusCode = 0;
    let contentType = "";
    let grpcStatus: string | undefined;
    let client: http2.ClientHttp2Session | null = null;
    let stream: http2.ClientHttp2Stream | null = null;

    const headerValue = (value: string | string[] | number | undefined): string => {
      if (Array.isArray(value)) return value[0] ?? "";
      if (value == null) return "";
      return String(value);
    };

    const isHealthyResponse = () =>
      statusCode === 200 &&
      /^application\/grpc\b/i.test(contentType) &&
      (grpcStatus === undefined || grpcStatus === "0");

    const settle = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        stream?.close();
      } catch {
        // best-effort cleanup
      }
      try {
        client?.close();
      } catch {
        // best-effort cleanup
      }
      resolve(ready);
    };

    const timer = setTimeout(() => settle(false), effectiveTimeout);

    try {
      const origin = `${parsed.protocol}//${parsed.host}`;
      const connectOptions = dockerDriverGatewayHttp2ConnectOptions(parsed, env);
      if (parsed.protocol === "https:" && !connectOptions) return settle(false);
      client = http2.connect(origin, connectOptions);
      client.on("error", () => settle(false));
      stream = client.request({
        [http2.constants.HTTP2_HEADER_METHOD]: http2.constants.HTTP2_METHOD_POST,
        [http2.constants.HTTP2_HEADER_PATH]: `${parsed.pathname}${parsed.search}`,
        [http2.constants.HTTP2_HEADER_SCHEME]: parsed.protocol.replace(":", ""),
        [http2.constants.HTTP2_HEADER_AUTHORITY]: parsed.host,
        [http2.constants.HTTP2_HEADER_CONTENT_TYPE]: "application/grpc",
        [http2.constants.HTTP2_HEADER_TE]: "trailers",
      });
      stream.on("response", (headers) => {
        statusCode = Number(headers[http2.constants.HTTP2_HEADER_STATUS] || 0);
        contentType = headerValue(headers[http2.constants.HTTP2_HEADER_CONTENT_TYPE]);
        const status = headerValue(headers["grpc-status"]);
        if (status) grpcStatus = status;
      });
      stream.on("trailers", (headers) => {
        const status = headerValue(headers["grpc-status"]);
        if (status) grpcStatus = status;
      });
      stream.on("data", () => {
        // Drain the gRPC response body; the readiness signal is in headers/trailers.
      });
      stream.on("error", () => settle(false));
      stream.on("end", () => settle(isHealthyResponse()));
      // Empty protobuf message: one uncompressed gRPC frame with zero payload bytes.
      stream.end(Buffer.alloc(5));
    } catch {
      settle(false);
    }
  });
}

function dockerDriverGatewayHttp2ConnectOptions(
  parsed: URL,
  env: NodeJS.ProcessEnv = process.env,
): http2.SecureClientSessionOptions | undefined {
  if (parsed.protocol !== "https:") return undefined;
  const localTlsDir = env.OPENSHELL_LOCAL_TLS_DIR;
  if (!localTlsDir) return undefined;
  try {
    const options: http2.SecureClientSessionOptions = {
      ca: fs.readFileSync(path.join(localTlsDir, "ca.crt")),
      cert: fs.readFileSync(path.join(localTlsDir, "client", "tls.crt")),
      key: fs.readFileSync(path.join(localTlsDir, "client", "tls.key")),
      rejectUnauthorized: true,
    };
    // Node 25 rejects an IP-literal TLS ServerName (RFC 6066; DEP0123 became a
    // thrown error). For IP endpoints, certificate verification matches the
    // connection IP against the certificate's IP SANs without SNI, so only
    // send servername for DNS hostnames.
    const bareHostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
    if (net.isIP(bareHostname) === 0) {
      options.servername = parsed.hostname;
    }
    return options;
  } catch {
    return undefined;
  }
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
  return withOptionalTraceSpan(opts, "nemoclaw.gateway.http_readiness_wait", {}, async () => {
    const recordTrace = opts.recordTrace !== false;
    const probe =
      opts.probe ??
      (() =>
        isGatewayHttpReady(undefined, undefined, undefined, undefined, {
          recordTrace,
        }));
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
    if (recordTrace) {
      addTraceEvent("wait_config", {
        max_attempts: maxAttempts,
        interval_seconds: intervalSeconds,
      });
    }

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

    let attempt = 0;
    const ready = await waitUntilAsync(
      async () => {
        attempt += 1;
        if (!(await safeProbe())) return false;
        if (recordTrace) addTraceEvent("ready", { attempt });
        return true;
      },
      {
        initialIntervalMs: intervalSeconds * 1000,
        maxIntervalMs: intervalSeconds * 1000,
        backoffFactor: 1,
        maxAttempts,
        sleep: (ms) => sleeper(ms / 1000),
      },
    );
    if (ready) {
      return true;
    }
    if (recordTrace) addTraceEvent("not_ready", { attempts: maxAttempts });
    return false;
  });
}
