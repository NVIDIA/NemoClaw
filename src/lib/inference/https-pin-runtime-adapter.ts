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
 * registered routes stay unreachable until their owning command re-runs. This
 * is an accepted consequence of never persisting plaintext credentials -- but
 * the freshly spawned process is still told which route ids those are (never
 * their credentials), so it can answer them with an actionable
 * `route_needs_recovery` response instead of a 404 indistinguishable from a
 * route that never existed (#6141).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import {
  BEDROCK_RUNTIME_ADAPTER_PORT,
  DASHBOARD_PORT,
  DASHBOARD_PORT_RANGE_END,
  DASHBOARD_PORT_RANGE_START,
  GATEWAY_PORT,
  HTTPS_PIN_RUNTIME_ADAPTER_PORT,
  OLLAMA_PORT,
  OLLAMA_PROXY_PORT,
  OPENROUTER_RUNTIME_ADAPTER_PORT,
  VLLM_PORT,
  validateHttpsPinRuntimeAdapterPort,
} from "../core/ports";
import { compactText } from "../core/url-utils";
import { ROOT, run, runCapture } from "../runner";
import { buildMinimalCredentialAdapterEnv } from "../subprocess-env";
import { assertEndpointResolvesPublic, type EndpointDnsLookupFn } from "./endpoint-ssrf-preflight";
import {
  buildHttpsPinRouteBaseUrl,
  buildHttpsPinRouteLoopbackBaseUrl,
  computeHttpsPinRouteId,
  HTTPS_PIN_RUNTIME_ADAPTER_BIND_HOST,
  HTTPS_PIN_RUNTIME_ADAPTER_CONTROL_TOKEN_ENV,
  HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_HOST,
  HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_ORIGIN,
  HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
  type HttpsPinCredentialProviderType,
  resolveHttpsPinCredentialHeader,
} from "./https-pin-runtime";
import {
  ForwardHttpError,
  forwardHttpsPinnedRequest,
  type HttpsPinTarget,
  sendForwardError,
} from "./https-pin-runtime-adapter-forward";
import {
  appendLocalAdapterJsonLine,
  DEFAULT_LOCAL_ADAPTER_STATE_DIR,
  ensureLocalAdapterStateDir,
  isLocalAdapterProcess,
  type JsonObject,
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
} from "./local-adapter-lifecycle";

const STATE_DIR = DEFAULT_LOCAL_ADAPTER_STATE_DIR;
const TOKEN_PATH = path.join(STATE_DIR, "https-pin-runtime-adapter-token");
const PID_PATH = path.join(STATE_DIR, "https-pin-runtime-adapter.pid");
const STATE_PATH = path.join(STATE_DIR, "https-pin-runtime-adapter.json");
const LOCK_PATH = path.join(STATE_DIR, "https-pin-runtime-adapter.lock");
export const LOG_PATH = path.join(STATE_DIR, "https-pin-runtime-adapter.log");
const PROCESS_NEEDLE = "https-pin-runtime-adapter.js";
const MAX_CONTROL_BODY_BYTES = 16 * 1024;
// Matches the sibling OpenRouter adapter's lock retry budget
// (openrouter-runtime-adapter-lifecycle.ts): long enough to outlast a normal
// spawn-and-health-check cycle, short enough to fail loudly on a truly stuck
// lock rather than hang the CLI command indefinitely.
const LOCK_RETRY_ATTEMPTS = 100;
const LOCK_RETRY_MS = 100;
const STALE_LOCK_MS = 30_000;

interface RouteRuntime {
  targetBaseUrl: string;
  pinnedAddresses: string[];
  providerType: HttpsPinCredentialProviderType;
  credentialValue: string;
  // Distinct random bearer token for this route only (#6906): the sandbox
  // authorized for this route authenticates data-plane requests with this
  // value, never the shared control-plane token, so a sandbox holding one
  // route's token cannot replay it against a different route.
  routeToken: string;
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

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * Loopback plus the RFC1918 / unique-local ranges that cover the Docker
 * bridge network a sandbox actually connects from when it reaches the
 * adapter through `host.openshell.internal` (see the module doc comment on
 * `HTTPS_PIN_RUNTIME_ADAPTER_BIND_HOST` for why the listener itself stays on
 * `0.0.0.0`). This does not attempt to discover the real bridge subnet --
 * that varies by Docker/Colima/Podman setup -- it just excludes the case a
 * `0.0.0.0` bind actually widens: a peer that reaches this host port over a
 * public or otherwise routable address that was never the intended
 * sandbox-to-host boundary.
 */
function isPrivateNetworkRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.replace(/^::ffff:/, "");
  if (isLoopbackRemoteAddress(normalized)) return true;
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  const lower = normalized.toLowerCase();
  // fc00::/7 (unique local) and fe80::/10 (link-local)
  return /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
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
  const routeToken = typeof raw.routeToken === "string" ? raw.routeToken : "";
  const pinnedAddresses = Array.isArray(raw.pinnedAddresses)
    ? raw.pinnedAddresses.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      )
    : [];
  if (
    !targetBaseUrl ||
    !providerType ||
    !credentialValue ||
    !routeToken ||
    pinnedAddresses.length === 0
  ) {
    throw new ForwardHttpError(
      400,
      "targetBaseUrl, providerType, credentialValue, routeToken, and pinnedAddresses are required.",
      "invalid_route",
    );
  }
  try {
    new URL(targetBaseUrl);
  } catch {
    throw new ForwardHttpError(400, `"${targetBaseUrl}" is not a valid URL.`, "invalid_route");
  }
  return { targetBaseUrl, pinnedAddresses, providerType, credentialValue, routeToken };
}

/**
 * Builds the shared adapter server. Routes live only in memory (`routes`),
 * seeded from `initialRoutes` at startup and otherwise populated by
 * authenticated `PUT /control/routes/:routeId` calls from
 * `ensureHttpsPinRuntimeAdapter`.
 *
 * Two distinct bearer credentials are in play (#6906): `controlToken`
 * authenticates only the host-only, loopback-restricted control plane
 * (`PUT /control/routes/:id`); each route's own `routeToken` authenticates
 * only data-plane requests to that exact route (`/route/:id`). A sandbox
 * holding one route's token never learns or can pass the control token, and
 * cannot authenticate against any other route's data-plane path with it.
 */
export function createHttpsPinRuntimeAdapterServer(options: {
  controlToken: string;
  initialRoutes?: Record<string, RouteRuntime>;
  orphanedRouteIds?: string[];
  logger?: AdapterLogger;
}): http.Server {
  const logger = options.logger || defaultAdapterLogger;
  const routes = new Map<string, RouteRuntime>(Object.entries(options.initialRoutes || {}));
  const orphanedRouteIds = new Set(options.orphanedRouteIds || []);

  return http.createServer(async (req, res) => {
    const started = Date.now();
    let routeId = "unknown";
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          tokenHash: adapterTokenHash(options.controlToken),
          routeCount: routes.size,
        });
        return;
      }

      const controlMatch = url.pathname.match(/^\/control\/routes\/([^/]+)$/);
      if (controlMatch) {
        routeId = controlMatch[1];
        if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
          // Route registration accepts a caller-supplied targetBaseUrl and
          // pinnedAddresses with no SSRF re-validation here -- that only
          // happens host-side in ensureHttpsPinRuntimeAdapter before it
          // calls this endpoint over loopback. A sandbox authenticates
          // data-plane requests with its own route token, never the control
          // token, so without this check it could still try to reach
          // /control/routes/:id directly and register a route pointed at an
          // internal address.
          sendJson(res, 404, {
            error: { message: "Not found", type: "not_found", code: "not_found" },
          });
          logAdapterEvent(logger, "request_rejected", {
            routeId,
            status: 404,
            reason: "control_plane_non_loopback",
            durationMs: Date.now() - started,
          });
          return;
        }
        if (!authMatches(req.headers.authorization, options.controlToken)) {
          sendJson(res, 401, {
            error: { message: "Unauthorized", type: "unauthorized", code: "unauthorized" },
          });
          logAdapterEvent(logger, "request_rejected", {
            routeId,
            status: 401,
            reason: "control_plane_unauthorized",
            durationMs: Date.now() - started,
          });
          return;
        }
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
        if (!isPrivateNetworkRemoteAddress(req.socket.remoteAddress)) {
          // Each route's token is scoped to that route alone, but a peer
          // that reaches this port from outside the intended sandbox-to-host
          // boundary still must not be able to probe route state at all.
          sendJson(res, 404, {
            error: { message: "Not found", type: "not_found", code: "not_found" },
          });
          logAdapterEvent(logger, "request_rejected", {
            routeId,
            status: 404,
            reason: "route_non_private_network",
            durationMs: Date.now() - started,
          });
          return;
        }
        const route = routes.get(routeId);
        if (!route) {
          if (orphanedRouteIds.has(routeId)) {
            // Known before the adapter's last restart but not recovered by
            // it -- distinct from a route that never existed, so the caller
            // gets an actionable signal instead of an indistinguishable 404.
            sendJson(res, 503, {
              error: {
                message:
                  "This route was registered before the adapter's last restart and was not recovered. Re-run the original `inference set --endpoint-url` command for this endpoint.",
                type: "unavailable",
                code: "route_needs_recovery",
              },
            });
            logAdapterEvent(logger, "request_rejected", {
              routeId,
              status: 503,
              reason: "route_needs_recovery",
              durationMs: Date.now() - started,
            });
            return;
          }
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
        // Route-scoped auth (#6906): compared against this specific route's
        // own token, never the shared control token or any other route's
        // token, so a sandbox authorized for a different route (or holding
        // no credential at all) is rejected here before the request ever
        // reaches this route's real upstream.
        if (!authMatches(req.headers.authorization, route.routeToken)) {
          sendJson(res, 401, {
            error: { message: "Unauthorized", type: "unauthorized", code: "unauthorized" },
          });
          logAdapterEvent(logger, "request_rejected", {
            routeId,
            status: 401,
            reason: "route_unauthorized",
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
      routeToken?: unknown;
    };
    if (typeof parsed.routeId !== "string" || !parsed.routeId) return null;
    const route = parseRoutePutBody(parsed as JsonObject);
    return { routeId: parsed.routeId, route };
  } catch {
    return null;
  }
}

function parseOrphanedRouteIds(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function startHttpsPinRuntimeAdapterFromEnv(): http.Server {
  const controlToken = process.env[HTTPS_PIN_RUNTIME_ADAPTER_CONTROL_TOKEN_ENV];
  const port = Number(
    process.env.NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT || HTTPS_PIN_RUNTIME_ADAPTER_PORT,
  );

  if (!controlToken) {
    throw new Error(`${HTTPS_PIN_RUNTIME_ADAPTER_CONTROL_TOKEN_ENV} is required`);
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT must be a valid port");
  }

  const bootstrap = parseBootstrapRoute(
    process.env.NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_BOOTSTRAP_ROUTE,
  );
  const initialRoutes: Record<string, RouteRuntime> = bootstrap
    ? { [bootstrap.routeId]: bootstrap.route }
    : {};
  const orphanedRouteIds = parseOrphanedRouteIds(
    process.env.NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_ORPHANED_ROUTE_IDS,
  );

  const server = createHttpsPinRuntimeAdapterServer({
    controlToken,
    initialRoutes,
    orphanedRouteIds,
  });
  server.listen(port, HTTPS_PIN_RUNTIME_ADAPTER_BIND_HOST, () => {
    defaultAdapterLogger("adapter_ready", {
      bindHost: HTTPS_PIN_RUNTIME_ADAPTER_BIND_HOST,
      port,
      routeCount: Object.keys(initialRoutes).length,
      orphanedRouteCount: orphanedRouteIds.length,
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
  killLocalAdapterPid({ pidPath: PID_PATH, processMatcher: PROCESS_NEEDLE, run, runCapture });
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
  controlToken: string;
  routeId: string;
  targetBaseUrl: string;
  pinnedAddresses: string[];
  providerType: HttpsPinCredentialProviderType;
  credentialValue: string;
  routeToken: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      targetBaseUrl: options.targetBaseUrl,
      pinnedAddresses: options.pinnedAddresses,
      providerType: options.providerType,
      credentialValue: options.credentialValue,
      routeToken: options.routeToken,
    });
    const req = http.request(
      {
        hostname: HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_HOST,
        port: HTTPS_PIN_RUNTIME_ADAPTER_PORT,
        path: `/control/routes/${options.routeId}`,
        method: "PUT",
        headers: {
          Authorization: `Bearer ${options.controlToken}`,
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

function extractPersistedRoutes(prior: JsonObject | null): Record<string, JsonObject> {
  if (!prior?.routes || typeof prior.routes !== "object" || Array.isArray(prior.routes)) return {};
  return prior.routes as Record<string, JsonObject>;
}

function persistRouteState(routeId: string, meta: RoutePersistedMeta): void {
  const prior = readLocalAdapterJsonFile(STATE_PATH);
  const priorRoutes = extractPersistedRoutes(prior);
  writeLocalAdapterJsonFile(STATE_PATH, {
    pid: (prior?.pid as number | null | undefined) ?? loadPersistedPid(),
    updatedAt: new Date().toISOString(),
    // Re-registering a route (fresh `meta`, no `orphanedAt`) always
    // supersedes any prior orphaned entry for the same id -- this is how a
    // route heals after its owner re-runs `inference set` post-recovery.
    routes: { ...priorRoutes, [routeId]: meta },
  });
}

/**
 * Computes which previously-registered routes a fresh adapter respawn will
 * NOT recover (every one except the route currently being bootstrapped),
 * since credentials are only ever seeded into the process at spawn/PUT time
 * and are never persisted to disk (see the module doc comment). Returns
 * their ids -- so the freshly spawned process can tell "this route was
 * orphaned by a restart" apart from "this route never existed" and respond
 * accordingly instead of a bare 404 either way -- plus the persisted-state
 * shape that keeps them recorded (still without credentials) until their
 * owner re-runs `inference set` and `persistRouteState` supersedes them.
 */
function computeRespawnState(
  priorRoutes: Record<string, JsonObject>,
  bootstrapRouteId: string,
): { orphanedRouteIds: string[]; persistedRoutes: Record<string, JsonObject> } {
  const orphanedRouteIds: string[] = [];
  const persistedRoutes: Record<string, JsonObject> = {};
  const orphanedAt = new Date().toISOString();
  for (const [id, meta] of Object.entries(priorRoutes)) {
    if (id === bootstrapRouteId) continue;
    orphanedRouteIds.push(id);
    persistedRoutes[id] = { ...meta, orphanedAt };
  }
  return { orphanedRouteIds, persistedRoutes };
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
  // Minted fresh on every call, distinct from every other route's token and
  // from the adapter's own control-plane token (#6906): this is the only
  // credential the sandbox that owns this route ever receives, and it
  // authenticates data-plane requests to this route alone.
  const routeToken = crypto.randomBytes(24).toString("hex");
  const controlToken = await ensureAdapterProcess({
    routeId,
    endpointUrl: options.endpointUrl,
    pinnedAddresses,
    providerType: options.providerType,
    credentialValue: options.credentialValue,
    routeToken,
  });

  await putRoute({
    controlToken,
    routeId,
    targetBaseUrl: options.endpointUrl,
    pinnedAddresses,
    providerType: options.providerType,
    credentialValue: options.credentialValue,
    routeToken,
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
    // Route-scoped, not the adapter's shared control-plane token (#6906):
    // this is what the caller stages as the sandbox-facing credential, so
    // each route's sandbox only ever learns its own token.
    token: routeToken,
    routeId,
    pinnedAddresses,
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeStaleLock(): void {
  try {
    const ageMs = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
    if (ageMs > STALE_LOCK_MS) fs.unlinkSync(LOCK_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function tryAcquireAdapterLock(): (() => void) | null {
  ensureLocalAdapterStateDir(STATE_DIR);
  removeStaleLock();
  try {
    const fd = fs.openSync(LOCK_PATH, "wx", 0o600);
    fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    return () => {
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch {
        /* best-effort lock cleanup */
      }
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }
}

/**
 * Serializes the read-check-kill-spawn recovery decision in
 * `ensureAdapterProcess` across concurrent `inference set` invocations.
 * Without this, two callers can both see no healthy prior process, both kill
 * and respawn, and race to bind the same port and overwrite
 * PID_PATH/TOKEN_PATH/STATE_PATH -- leaking a process and potentially
 * leaving the persisted token out of sync with whichever process actually
 * won the port.
 */
async function withAdapterLock<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt++) {
    const release = tryAcquireAdapterLock();
    if (release) {
      try {
        return await operation();
      } finally {
        release();
      }
    }
    await sleepMs(LOCK_RETRY_MS);
  }
  throw new Error("HTTPS Pin Runtime adapter startup is already in progress");
}

function validateAdapterPortConfiguration(): void {
  validateHttpsPinRuntimeAdapterPort(
    "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT",
    HTTPS_PIN_RUNTIME_ADAPTER_PORT,
    {
      dashboardPort: DASHBOARD_PORT,
      dashboardRangeStart: DASHBOARD_PORT_RANGE_START,
      dashboardRangeEnd: DASHBOARD_PORT_RANGE_END,
      gatewayPort: GATEWAY_PORT,
      vllmPort: VLLM_PORT,
      ollamaPort: OLLAMA_PORT,
      ollamaProxyPort: OLLAMA_PROXY_PORT,
      bedrockRuntimeAdapterPort: BEDROCK_RUNTIME_ADAPTER_PORT,
      openrouterRuntimeAdapterPort: OPENROUTER_RUNTIME_ADAPTER_PORT,
      httpsPinRuntimeAdapterPort: HTTPS_PIN_RUNTIME_ADAPTER_PORT,
    },
  );
}

/** Returns a live adapter control token, reusing the running process when possible or spawning a fresh one. */
async function ensureAdapterProcessLocked(bootstrap: {
  routeId: string;
  endpointUrl: string;
  pinnedAddresses: string[];
  providerType: HttpsPinCredentialProviderType;
  credentialValue: string;
  routeToken: string;
}): Promise<string> {
  validateAdapterPortConfiguration();
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
  // Reusing a still-valid persisted control token (rather than always
  // minting a new one) keeps the running adapter process's identity stable
  // across a respawn whenever possible. This is the host-only control-plane
  // token (#6906) -- never staged into a sandbox.
  const controlToken = priorToken || crypto.randomBytes(24).toString("hex");
  // A fresh process starts with an empty in-memory route map -- every route
  // other than the one being bootstrapped now is unrecoverable this restart,
  // since credentials are never persisted to disk (see module doc comment).
  // Tell the freshly spawned process which route ids those are so it can
  // answer them with an actionable "needs recovery" response instead of a
  // bare 404 indistinguishable from a route that never existed (#6141).
  const priorState = readLocalAdapterJsonFile(STATE_PATH);
  const { orphanedRouteIds, persistedRoutes } = computeRespawnState(
    extractPersistedRoutes(priorState),
    bootstrap.routeId,
  );
  const child = spawnDetachedNodeAdapter({
    scriptPath: getAdapterScriptPath(),
    env: {
      NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT: String(HTTPS_PIN_RUNTIME_ADAPTER_PORT),
      [HTTPS_PIN_RUNTIME_ADAPTER_CONTROL_TOKEN_ENV]: controlToken,
      NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_BOOTSTRAP_ROUTE: JSON.stringify({
        routeId: bootstrap.routeId,
        targetBaseUrl: bootstrap.endpointUrl,
        pinnedAddresses: bootstrap.pinnedAddresses,
        providerType: bootstrap.providerType,
        credentialValue: bootstrap.credentialValue,
        routeToken: bootstrap.routeToken,
      }),
      NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_ORPHANED_ROUTE_IDS: JSON.stringify(orphanedRouteIds),
    },
    // This is a long-lived, credential-bearing process, so it gets a
    // purpose-built minimal environment rather than the general subprocess
    // allowlist -- it must not inherit DOCKER_HOST/KUBECONFIG/SSH_AUTH_SOCK/
    // proxy capabilities that an ordinary short-lived CLI subprocess might
    // legitimately need. See #6141.
    buildEnv: buildMinimalCredentialAdapterEnv,
  });
  try {
    persistLocalAdapterPid(PID_PATH, child.pid);
    if (!(await waitForAdapterHealth(controlToken))) {
      throw new Error(
        `HTTPS Pin Runtime adapter did not become healthy on ${HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_ORIGIN}`,
      );
    }
    writeLocalAdapterSecretFile(TOKEN_PATH, controlToken);
    // Keep the orphaned routes recorded (still without credentials) instead
    // of dropping them: `persistRouteState` supersedes an entry here the
    // moment its owner re-runs `inference set`, which is how a route heals.
    writeLocalAdapterJsonFile(STATE_PATH, {
      pid: child.pid ?? null,
      updatedAt: new Date().toISOString(),
      routes: persistedRoutes,
    });
  } catch (err) {
    killStaleAdapter();
    removeLocalAdapterFile(STATE_PATH);
    throw err;
  }
  return controlToken;
}

function ensureAdapterProcess(bootstrap: {
  routeId: string;
  endpointUrl: string;
  pinnedAddresses: string[];
  providerType: HttpsPinCredentialProviderType;
  credentialValue: string;
  routeToken: string;
}): Promise<string> {
  return withAdapterLock(() => ensureAdapterProcessLocked(bootstrap));
}

export const __test = {
  routeCredentialHash,
  getAdapterScriptPath,
  probeAdapterHealth,
  tryAcquireAdapterLock,
  withAdapterLock,
  computeRespawnState,
  LOCK_PATH,
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
