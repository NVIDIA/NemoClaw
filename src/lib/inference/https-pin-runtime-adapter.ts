// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTPS DNS-pinning runtime adapter server and lifecycle.
 *
 * Unlike the Bedrock/OpenRouter adapters (one process per singleton external
 * endpoint), a host can have multiple DNS-backed HTTPS custom endpoints
 * configured concurrently, so this adapter is one shared process serving many
 * routes. Routes are registered on an already-running adapter through an
 * authenticated control-plane `PUT /control/routes/:routeId` call instead of
 * a full respawn, because respawning would lose every other route's
 * credential value — those values are seeded into the process only at spawn
 * time or via a control-plane call and are never written to disk (only a
 * SHA-256 fingerprint is persisted, for diagnostics).
 *
 * If the adapter process dies, only the next route whose owning command calls
 * `ensureHttpsPinRuntimeAdapter` recovers automatically; other previously
 * registered routes are unreachable until their owning command re-runs. This
 * is an accepted consequence of never persisting plaintext credentials.
 */

import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";

import { HTTPS_PIN_RUNTIME_ADAPTER_PORT } from "../core/ports";
import { compactText } from "../core/url-utils";
import { ROOT, run, runCapture } from "../runner";
import { buildSubprocessEnv } from "../subprocess-env";
import { type EndpointDnsLookupFn, assertEndpointResolvesPublic } from "./endpoint-ssrf-preflight";
import {
  ForwardHttpError,
  type HttpsPinTarget,
  forwardHttpsPinnedRequest,
  sendForwardError,
} from "./https-pin-runtime-adapter-forward";
import {
  HTTPS_PIN_RUNTIME_ADAPTER_BIND_HOST,
  HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_HOST,
  HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_ORIGIN,
  HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
  type HttpsPinCredentialProviderType,
  buildHttpsPinRouteBaseUrl,
  buildHttpsPinRouteLoopbackBaseUrl,
  computeHttpsPinRouteId,
  resolveHttpsPinCredentialHeader,
} from "./https-pin-runtime";
import {
  DEFAULT_LOCAL_ADAPTER_STATE_DIR,
  appendLocalAdapterJsonLine,
  isLocalAdapterProcess,
  killLocalAdapterPid,
  loadLocalAdapterPid,
  localAdapterTokenHash,
  persistLocalAdapterPid,
  probeLocalAdapterHealth,
  readLocalAdapterJsonFile,
  readLocalAdapterTextFile,
  removeLocalAdapterFile,
  spawnDetachedNodeAdapter,
  waitForLocalAdapterHealth,
  writeLocalAdapterJsonFile,
  writeLocalAdapterSecretFile,
  type JsonObject,
} from "./local-adapter-lifecycle";

const STATE_DIR = DEFAULT_LOCAL_ADAPTER_STATE_DIR;
const TOKEN_PATH = path.join(STATE_DIR, "https-pin-runtime-adapter-token");
const PID_PATH = path.join(STATE_DIR, "https-pin-runtime-adapter.pid");
const STATE_PATH = path.join(STATE_DIR, "https-pin-runtime-adapter.json");
export const LOG_PATH = path.join(STATE_DIR, "https-pin-runtime-adapter.log");
const PROCESS_NEEDLE = "https-pin-runtime-adapter.js";
const MAX_CONTROL_BODY_BYTES = 16 * 1024;

interface RouteRuntime {
  targetBaseUrl: string;
  pinnedAddresses: string[];
  providerType: HttpsPinCredentialProviderType;
  credentialValue: string;
}

interface RoutePersistedMeta {
  targetBaseUrl: string;
  pinnedAddresses: string[];
  providerType: HttpsPinCredentialProviderType;
  credentialHash: string;
  registeredAt: string;
}

type AdapterLogFields = Record<string, string | number | boolean | null | undefined>;
type AdapterLogger = (event: string, fields?: AdapterLogFields) => void;

function normalizeLogField(
  value: string | number | boolean | null | undefined,
): string | number | boolean | null {
  if (value === undefined) return null;
  if (typeof value === "string") return compactText(value).slice(0, 180);
  return value;
}

function defaultAdapterLogger(event: string, fields: AdapterLogFields = {}): void {
  try {
    const payload: Record<string, string | number | boolean | null> = {
      ts: new Date().toISOString(),
      event: normalizeLogField(event) as string,
    };
    for (const [key, value] of Object.entries(fields)) {
      payload[key] = normalizeLogField(value);
    }
    appendLocalAdapterJsonLine(LOG_PATH, payload);
  } catch {
    /* best-effort diagnostics only */
  }
}

function logAdapterEvent(
  logger: AdapterLogger,
  event: string,
  fields: AdapterLogFields = {},
): void {
  try {
    logger(event, fields);
  } catch {
    /* best-effort diagnostics only */
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as JsonObject)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as JsonObject)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function authMatches(actual: string | string[] | undefined, token: string): boolean {
  const header = Array.isArray(actual) ? actual[0] : actual;
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(header);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function adapterTokenHash(token: string): string {
  return localAdapterTokenHash(token);
}

function routeCredentialHash(
  endpointUrl: string,
  providerType: HttpsPinCredentialProviderType,
  credentialValue: string,
): string {
  return crypto
    .createHash("sha256")
    .update(stableJson({ endpointUrl, providerType, credentialValue }))
    .digest("hex");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function safeHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "unknown";
  }
}

function readControlRequestJson(req: http.IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_CONTROL_BODY_BYTES) {
        // Reject without destroying the socket: destroying `req` mid-stream
        // tears down the underlying connection before the 413 response can
        // flush, so the caller sees a raw connection reset instead of a
        // clean error. Draining the remainder of a small control-plane body
        // (16 KB cap) to let `res.end()` reach the client is cheap.
        settled = true;
        reject(new ForwardHttpError(413, "Request body is too large.", "request_too_large"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("expected a JSON object");
        }
        resolve(parsed as JsonObject);
      } catch {
        reject(new ForwardHttpError(400, "Request body must be valid JSON.", "invalid_json"));
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function parseRoutePutBody(raw: JsonObject): RouteRuntime {
  const targetBaseUrl = typeof raw.targetBaseUrl === "string" ? raw.targetBaseUrl.trim() : "";
  const providerType =
    raw.providerType === "anthropic" || raw.providerType === "openai" ? raw.providerType : null;
  const credentialValue = typeof raw.credentialValue === "string" ? raw.credentialValue : "";
  const pinnedAddresses = Array.isArray(raw.pinnedAddresses)
    ? raw.pinnedAddresses.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      )
    : [];
  if (!targetBaseUrl || !providerType || !credentialValue || pinnedAddresses.length === 0) {
    throw new ForwardHttpError(
      400,
      "targetBaseUrl, providerType, credentialValue, and pinnedAddresses are required.",
      "invalid_route",
    );
  }
  try {
    new URL(targetBaseUrl);
  } catch {
    throw new ForwardHttpError(400, `"${targetBaseUrl}" is not a valid URL.`, "invalid_route");
  }
  return { targetBaseUrl, pinnedAddresses, providerType, credentialValue };
}

/**
 * Builds the shared adapter server. Routes live only in memory (`routes`),
 * seeded from `initialRoutes` at startup and otherwise populated by
 * authenticated `PUT /control/routes/:routeId` calls from
 * `ensureHttpsPinRuntimeAdapter`.
 */
export function createHttpsPinRuntimeAdapterServer(options: {
  token: string;
  initialRoutes?: Record<string, RouteRuntime>;
  logger?: AdapterLogger;
}): http.Server {
  const logger = options.logger || defaultAdapterLogger;
  const routes = new Map<string, RouteRuntime>(Object.entries(options.initialRoutes || {}));

  return http.createServer(async (req, res) => {
    const started = Date.now();
    let routeId = "unknown";
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          tokenHash: adapterTokenHash(options.token),
          routeCount: routes.size,
        });
        return;
      }

      if (!authMatches(req.headers.authorization, options.token)) {
        sendJson(res, 401, {
          error: { message: "Unauthorized", type: "unauthorized", code: "unauthorized" },
        });
        logAdapterEvent(logger, "request_rejected", {
          method: req.method || "unknown",
          path: url.pathname,
          status: 401,
          reason: "unauthorized",
          durationMs: Date.now() - started,
        });
        return;
      }

      const controlMatch = url.pathname.match(/^\/control\/routes\/([^/]+)$/);
      if (controlMatch) {
        routeId = controlMatch[1];
        if (req.method !== "PUT") {
          sendJson(res, 404, {
            error: { message: "Not found", type: "not_found", code: "not_found" },
          });
          return;
        }
        const body = await readControlRequestJson(req);
        const route = parseRoutePutBody(body);
        routes.set(routeId, route);
        sendJson(res, 200, { ok: true, routeId });
        logAdapterEvent(logger, "route_registered", {
          routeId,
          targetHost: safeHostname(route.targetBaseUrl),
          providerType: route.providerType,
          routeCount: routes.size,
          durationMs: Date.now() - started,
        });
        return;
      }

      const routeMatch = url.pathname.match(/^\/route\/([^/]+)(\/.*)?$/);
      if (routeMatch) {
        routeId = routeMatch[1];
        const route = routes.get(routeId);
        if (!route) {
          sendJson(res, 404, {
            error: { message: "Unknown route", type: "not_found", code: "route_not_found" },
          });
          logAdapterEvent(logger, "request_rejected", {
            routeId,
            status: 404,
            reason: "route_not_found",
            durationMs: Date.now() - started,
          });
          return;
        }
        const forwardPath = (routeMatch[2] || "/") + url.search;
        const target: HttpsPinTarget = {
          targetUrl: new URL(route.targetBaseUrl),
          pinnedAddress: route.pinnedAddresses[0],
          credential: resolveHttpsPinCredentialHeader(route.providerType, route.credentialValue),
        };
        const status = await forwardHttpsPinnedRequest({ req, res, forwardPath, target });
        logAdapterEvent(logger, "request_forwarded", {
          routeId,
          status,
          targetHost: safeHostname(route.targetBaseUrl),
          durationMs: Date.now() - started,
        });
        return;
      }

      sendJson(res, 404, { error: { message: "Not found", type: "not_found", code: "not_found" } });
    } catch (err) {
      const status = err instanceof ForwardHttpError ? err.status : 502;
      const code = err instanceof ForwardHttpError ? err.code : "https_pin_runtime_error";
      logAdapterEvent(logger, "request_failed", {
        routeId,
        status,
        code,
        durationMs: Date.now() - started,
      });
      sendForwardError(res, err);
    }
  });
}

function parseBootstrapRoute(
  raw: string | undefined,
): { routeId: string; route: RouteRuntime } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      routeId?: unknown;
      targetBaseUrl?: unknown;
      pinnedAddresses?: unknown;
      providerType?: unknown;
      credentialValue?: unknown;
    };
    if (typeof parsed.routeId !== "string" || !parsed.routeId) return null;
    const route = parseRoutePutBody(parsed as JsonObject);
    return { routeId: parsed.routeId, route };
  } catch {
    return null;
  }
}

export function startHttpsPinRuntimeAdapterFromEnv(): http.Server {
  const token = process.env[HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV];
  const port = Number(
    process.env.NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT || HTTPS_PIN_RUNTIME_ADAPTER_PORT,
  );

  if (!token) throw new Error(`${HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV} is required`);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT must be a valid port");
  }

  const bootstrap = parseBootstrapRoute(
    process.env.NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_BOOTSTRAP_ROUTE,
  );
  const initialRoutes: Record<string, RouteRuntime> = bootstrap
    ? { [bootstrap.routeId]: bootstrap.route }
    : {};

  const server = createHttpsPinRuntimeAdapterServer({ token, initialRoutes });
  server.listen(port, HTTPS_PIN_RUNTIME_ADAPTER_BIND_HOST, () => {
    defaultAdapterLogger("adapter_ready", {
      bindHost: HTTPS_PIN_RUNTIME_ADAPTER_BIND_HOST,
      port,
      routeCount: Object.keys(initialRoutes).length,
      logPath: LOG_PATH,
    });
    console.log(
      `HTTPS Pin Runtime adapter listening on ${HTTPS_PIN_RUNTIME_ADAPTER_BIND_HOST}:${port}; log ${LOG_PATH}`,
    );
  });
  return server;
}

function loadPersistedPid(): number | null {
  return loadLocalAdapterPid(PID_PATH);
}

function isAdapterProcess(pid: number | null | undefined): boolean {
  return isLocalAdapterProcess(pid, PROCESS_NEEDLE, runCapture);
}

function killStaleAdapter(): void {
  killLocalAdapterPid({ pidPath: PID_PATH, processNeedle: PROCESS_NEEDLE, run, runCapture });
}

/**
 * Unlike the Bedrock/OpenRouter adapters' hand-maintained `scripts/*.js`
 * wrappers, this adapter is spawned directly from its own compiled output so
 * the entrypoint stays TypeScript-only (see the `require.main` guard below).
 */
function getAdapterScriptPath(): string {
  return path.join(ROOT, "dist", "lib", "inference", "https-pin-runtime-adapter.js");
}

function probeAdapterHealth(
  options: { port?: number; tokenHash?: string | null } = {},
): Promise<boolean> {
  return probeLocalAdapterHealth({
    host: HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_HOST,
    port: options.port || HTTPS_PIN_RUNTIME_ADAPTER_PORT,
    expectedTokenHash: options.tokenHash || null,
  });
}

async function waitForAdapterHealth(
  token: string,
  port = HTTPS_PIN_RUNTIME_ADAPTER_PORT,
): Promise<boolean> {
  const tokenHash = adapterTokenHash(token);
  return waitForLocalAdapterHealth(() => probeAdapterHealth({ port, tokenHash }), {
    attempts: 20,
    intervalMs: 100,
  });
}

function putRoute(options: {
  token: string;
  routeId: string;
  targetBaseUrl: string;
  pinnedAddresses: string[];
  providerType: HttpsPinCredentialProviderType;
  credentialValue: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      targetBaseUrl: options.targetBaseUrl,
      pinnedAddresses: options.pinnedAddresses,
      providerType: options.providerType,
      credentialValue: options.credentialValue,
    });
    const req = http.request(
      {
        hostname: HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_HOST,
        port: HTTPS_PIN_RUNTIME_ADAPTER_PORT,
        path: `/control/routes/${options.routeId}`,
        method: "PUT",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 3000,
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(
              new Error(
                `HTTPS Pin Runtime adapter rejected route registration (status ${res.statusCode}).`,
              ),
            );
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("HTTPS Pin Runtime adapter route registration timed out."));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function persistRouteState(routeId: string, meta: RoutePersistedMeta): void {
  const prior = readLocalAdapterJsonFile(STATE_PATH);
  const priorRoutes =
    prior?.routes && typeof prior.routes === "object" && !Array.isArray(prior.routes)
      ? (prior.routes as Record<string, unknown>)
      : {};
  writeLocalAdapterJsonFile(STATE_PATH, {
    pid: (prior?.pid as number | null | undefined) ?? loadPersistedPid(),
    updatedAt: new Date().toISOString(),
    routes: { ...priorRoutes, [routeId]: meta },
  });
}

/**
 * Ensures the shared adapter process is running and holds a current,
 * pin-validated route for `(gatewayName, provider, endpointUrl)`, then
 * returns the sandbox-facing base URL OpenShell should be registered with.
 *
 * Re-runs the SSRF preflight on every call so the pinned address is never
 * older than this call — the address that gets registered is the one that
 * gets connected to, closing the TOCTOU window between validation and the
 * OpenShell gateway's own (would-be) resolution.
 */
export async function ensureHttpsPinRuntimeAdapter(options: {
  gatewayName: string;
  provider: string;
  endpointUrl: string;
  providerType: HttpsPinCredentialProviderType;
  credentialValue: string;
  lookup?: EndpointDnsLookupFn;
}): Promise<{
  baseUrl: string;
  localBaseUrl: string;
  logPath: string;
  credentialEnv: string;
  token: string;
  routeId: string;
  pinnedAddresses: string[];
}> {
  const preflight = await assertEndpointResolvesPublic(options.endpointUrl, options.lookup);
  if (!preflight.ok) {
    throw new Error(
      `HTTPS Pin Runtime adapter cannot validate "${options.endpointUrl}": ${preflight.reason}`,
    );
  }
  const pinnedAddresses =
    preflight.addresses && preflight.addresses.length > 0 ? preflight.addresses : [];
  if (pinnedAddresses.length === 0) {
    throw new Error(
      `HTTPS Pin Runtime adapter requires a DNS-resolved public address for "${options.endpointUrl}".`,
    );
  }
  // Checked only after the endpoint itself is proven safe to pin: an
  // unreachable/private endpoint must fail on that ground, not report a
  // confusing credential error for a URL that was never going to be allowed.
  if (!options.credentialValue || !options.credentialValue.trim()) {
    throw new Error(
      `HTTPS Pin Runtime adapter requires a non-empty credential value for "${options.endpointUrl}".`,
    );
  }

  const routeId = computeHttpsPinRouteId(
    options.gatewayName,
    options.provider,
    options.endpointUrl,
  );
  const token = await ensureAdapterProcess({
    routeId,
    endpointUrl: options.endpointUrl,
    pinnedAddresses,
    providerType: options.providerType,
    credentialValue: options.credentialValue,
  });

  await putRoute({
    token,
    routeId,
    targetBaseUrl: options.endpointUrl,
    pinnedAddresses,
    providerType: options.providerType,
    credentialValue: options.credentialValue,
  });
  persistRouteState(routeId, {
    targetBaseUrl: options.endpointUrl,
    pinnedAddresses,
    providerType: options.providerType,
    credentialHash: routeCredentialHash(
      options.endpointUrl,
      options.providerType,
      options.credentialValue,
    ),
    registeredAt: new Date().toISOString(),
  });

  return {
    baseUrl: buildHttpsPinRouteBaseUrl(routeId, options.endpointUrl),
    localBaseUrl: buildHttpsPinRouteLoopbackBaseUrl(routeId, options.endpointUrl),
    logPath: LOG_PATH,
    credentialEnv: HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
    token,
    routeId,
    pinnedAddresses,
  };
}

/** Returns a live adapter token, reusing the running process when possible or spawning a fresh one. */
async function ensureAdapterProcess(bootstrap: {
  routeId: string;
  endpointUrl: string;
  pinnedAddresses: string[];
  providerType: HttpsPinCredentialProviderType;
  credentialValue: string;
}): Promise<string> {
  const priorToken = readLocalAdapterTextFile(TOKEN_PATH);
  const priorPid = loadPersistedPid();
  if (
    priorToken &&
    isAdapterProcess(priorPid) &&
    (await probeAdapterHealth({ tokenHash: adapterTokenHash(priorToken) }))
  ) {
    return priorToken;
  }

  killStaleAdapter();
  // Reusing a still-valid persisted token (rather than always minting a new
  // one) keeps previously registered OpenShell provider credentials working
  // across an adapter respawn whenever possible.
  const token = priorToken || crypto.randomBytes(24).toString("hex");
  const child = spawnDetachedNodeAdapter({
    scriptPath: getAdapterScriptPath(),
    env: {
      NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT: String(HTTPS_PIN_RUNTIME_ADAPTER_PORT),
      [HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV]: token,
      NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_BOOTSTRAP_ROUTE: JSON.stringify({
        routeId: bootstrap.routeId,
        targetBaseUrl: bootstrap.endpointUrl,
        pinnedAddresses: bootstrap.pinnedAddresses,
        providerType: bootstrap.providerType,
        credentialValue: bootstrap.credentialValue,
      }),
    },
    buildEnv: buildSubprocessEnv,
  });
  try {
    persistLocalAdapterPid(PID_PATH, child.pid);
    if (!(await waitForAdapterHealth(token))) {
      throw new Error(
        `HTTPS Pin Runtime adapter did not become healthy on ${HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_ORIGIN}`,
      );
    }
    writeLocalAdapterSecretFile(TOKEN_PATH, token);
    // A fresh process starts with an empty in-memory route map, so the
    // persisted route metadata must be reset here — every route other than
    // the one being bootstrapped now is unreachable until it is re-ensured.
    writeLocalAdapterJsonFile(STATE_PATH, {
      pid: child.pid ?? null,
      updatedAt: new Date().toISOString(),
      routes: {},
    });
  } catch (err) {
    killStaleAdapter();
    removeLocalAdapterFile(STATE_PATH);
    throw err;
  }
  return token;
}

export const __test = {
  routeCredentialHash,
  getAdapterScriptPath,
  probeAdapterHealth,
};

// Detached-process entrypoint: `spawnDetachedNodeAdapter` runs this compiled
// file directly with plain `node` (see `getAdapterScriptPath`), so this guard
// is the only thing that distinguishes that invocation from the normal
// `require()` used by the rest of the CLI.
if (require.main === module) {
  try {
    startHttpsPinRuntimeAdapterFromEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
