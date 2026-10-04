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
 * credential value — those values enter the process only through the
 * authenticated loopback control plane and are never written to disk or
 * placed in the child process environment. Persisted recovery bookkeeping
 * contains only opaque route ids, provider type, non-secret token generation
 * values, and timestamps.
 *
 * If the adapter process dies, only the next route whose owning command calls
 * `ensureHttpsPinRuntimeAdapter` recovers automatically; other previously
 * registered routes stay unreachable until their owning command re-runs. This
 * is an accepted consequence of never persisting plaintext credentials -- but
 * the freshly spawned process is still told which route ids those are (never
 * their credentials), so it can answer them with an actionable
 * `route_needs_recovery` response instead of a 404 indistinguishable from a
 * route that never existed (#6141).
 *
 * Recovery boundary:
 * - whyNotSourceFix: the durable row intentionally omits the upstream URL,
 *   pinned addresses, and credential. Only the owning `inference set` caller
 *   holds all three, so a respawn cannot reconstruct another route safely.
 * - removalCondition: retire orphaning/manual re-registration only when a
 *   reviewed secure recovery source or capability can rehydrate every
 *   registered route after respawn without persisting plaintext credentials,
 *   exposing them to OpenShell or a sandbox, or weakening per-route token and
 *   pinned-address isolation.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { BlockList, isIP } from "node:net";
import path from "node:path";

import { HTTPS_PIN_RUNTIME_ADAPTER_PORT, validateRuntimeAdapterPort } from "../core/ports";
import { retryUntilAsync } from "../core/retry";
import { getVersion } from "../core/version";
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

export { parseHttpsPinRouteId } from "./https-pin-runtime";

import {
  describeForwardHttpError,
  ForwardHttpError,
  forwardHttpsPinnedRequest,
  type HttpsPinTarget,
  sendForwardError,
} from "./https-pin-runtime-adapter-forward";
import {
  DEFAULT_LOCAL_ADAPTER_STATE_DIR,
  ensureLocalAdapterStateDir,
  isLocalAdapterProcess,
  type JsonObject,
  killLocalAdapterPid,
  loadLocalAdapterPid,
  persistLocalAdapterPid,
  readLocalAdapterJsonFile,
  readLocalAdapterTextFile,
  removeLocalAdapterFile,
  spawnDetachedNodeAdapter,
  waitForLocalAdapterHealth,
  writeLocalAdapterJsonFile,
  writeLocalAdapterSecretFile,
} from "./local-adapter-lifecycle";
import { type AdapterLogger, createLocalAdapterLogger } from "./runtime-adapter/logger";

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
const PROCESS_EXIT_WAIT_ATTEMPTS = 30;
const PROCESS_EXIT_WAIT_MS = 100;
const ADAPTER_PROTOCOL_VERSION = "3";

interface AdapterIdentity {
  protocolVersion: string;
  buildId: string;
}

/**
 * Captured once per process so an adapter that survives an upgrade keeps
 * proving the build it actually started from, not the files currently on
 * disk. The opaque digest avoids exposing local version or source metadata.
 */
const CURRENT_ADAPTER_IDENTITY: Readonly<AdapterIdentity> = Object.freeze({
  protocolVersion: ADAPTER_PROTOCOL_VERSION,
  buildId: crypto
    .createHash("sha256")
    .update(`nemoclaw:https-pin-adapter-build:v1\0${getVersion()}`)
    .digest("hex"),
});

interface RouteRuntime {
  targetBaseUrl: string;
  pinnedAddresses: string[];
  providerType: HttpsPinCredentialProviderType;
  credentialValue: string;
  generation: string;
}

interface RoutePersistedMeta {
  providerType: HttpsPinCredentialProviderType;
  generation: string;
  registeredAt: string;
}

type OrphanedRouteMeta = Pick<RoutePersistedMeta, "providerType" | "generation">;

/** Executable architecture contract mirrored by the orphan-recovery tests. */
const ORPHANED_ROUTE_RECOVERY_BOUNDARY = {
  whyNotSourceFix:
    "Durable recovery metadata intentionally omits the upstream URL, pinned addresses, and credential; only the owning inference set caller can supply all three.",
  removalCondition:
    "Retire orphaning/manual re-registration only when a reviewed secure recovery source or capability can rehydrate every registered route after respawn without persisting plaintext credentials, exposing them to OpenShell or a sandbox, or weakening per-route token and pinned-address isolation.",
} as const;

const { defaultLogger: defaultAdapterLogger, logEvent: logAdapterEvent } = createLocalAdapterLogger(
  { logPath: LOG_PATH },
);

function authMatches(actual: string | string[] | undefined, token: string): boolean {
  const header = Array.isArray(actual) ? actual[0] : actual;
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(header);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function rawTokenMatches(actual: string | string[] | undefined, token: string): boolean {
  const header = Array.isArray(actual) ? actual[0] : actual;
  if (!header) return false;
  const expected = Buffer.from(token);
  const received = Buffer.from(header);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function routeAuthMatches(
  req: http.IncomingMessage,
  token: string,
  providerType: HttpsPinCredentialProviderType,
): boolean {
  return providerType === "anthropic"
    ? rawTokenMatches(req.headers["x-api-key"], token)
    : authMatches(req.headers.authorization, token);
}

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

/** Parse one exact runtime-provider subnet before it becomes a route-source capability. */
function normalizeAllowedSourceCidr(value: string): string | null {
  const candidate = value.trim();
  const slash = candidate.lastIndexOf("/");
  if (slash <= 0) return null;
  const address = candidate.slice(0, slash);
  const family = isIP(address);
  const prefix = Number(candidate.slice(slash + 1));
  const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : 0;
  if (!maxPrefix || !Number.isInteger(prefix) || prefix < 1 || prefix > maxPrefix) return null;
  return `${address}/${prefix}`;
}

function buildAllowedRouteSourceMatcher(allowedSourceCidrs: readonly string[]): {
  cidrs: string[];
  matches: (remoteAddress: string | undefined) => boolean;
} {
  const cidrs = [
    ...new Set(
      allowedSourceCidrs
        .map(normalizeAllowedSourceCidr)
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ];
  if (cidrs.length === 0) {
    throw new Error("HTTPS Pin Runtime adapter requires an OpenShell bridge source CIDR.");
  }
  const blockList = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefixText] = cidr.split("/");
    const family = isIP(address) === 4 ? "ipv4" : "ipv6";
    blockList.addSubnet(address, Number(prefixText), family);
  }
  return {
    cidrs,
    matches(remoteAddress) {
      if (!remoteAddress) return false;
      if (isLoopbackRemoteAddress(remoteAddress)) return true;
      const normalized = remoteAddress.replace(/^::ffff:/, "");
      const family = isIP(normalized);
      return family === 4
        ? blockList.check(normalized, "ipv4")
        : family === 6
          ? blockList.check(normalized, "ipv6")
          : false;
    },
  };
}

function routeSourcePolicyDigest(cidrs: readonly string[]): string {
  return crypto
    .createHash("sha256")
    .update(`nemoclaw:https-pin-route-sources:v1\0${[...cidrs].sort().join("\0")}`)
    .digest("hex");
}

function controlChallengeProof(
  controlToken: string,
  nonce: string,
  identity: Readonly<AdapterIdentity>,
  sourcePolicyDigest: string,
): string {
  return crypto
    .createHmac("sha256", controlToken)
    .update(
      `nemoclaw:https-pin-control-challenge:v3\0${identity.protocolVersion}\0${identity.buildId}\0${sourcePolicyDigest}\0${nonce}`,
    )
    .digest("hex");
}

/**
 * Derives the credential for exactly one sandbox-facing route from the
 * persisted host-only control secret. The explicit domain separator prevents
 * the derived value from being confused with any other HMAC use, while the
 * route id binding means a credential issued for route A cannot authorize
 * route B. The non-secret generation keeps the token stable across ordinary
 * adapter restarts while ensuring DELETE plus re-registration cannot
 * resurrect a previously issued token.
 */
function deriveRouteToken(controlToken: string, routeId: string, generation: string): string {
  return crypto
    .createHmac("sha256", controlToken)
    .update(`nemoclaw:https-pin-route:v2\0${routeId}\0${generation}`)
    .digest("hex");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function buildContainedForwardPath(
  route: RouteRuntime,
  normalizedSuffix: string,
  search: string,
  rawRequestTarget: string,
): string {
  const rawPath = rawRequestTarget.split("?", 1)[0];
  // Reject encoded path delimiters/dot segments (including a first layer of
  // double encoding) before a downstream framework can decode them into a
  // different path than the adapter authorized. Literal dot segments are
  // already normalized by URL parsing and fail the base-prefix check below.
  if (
    /%(?:2e|2f|5c|25)/i.test(rawPath) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/u.test(rawPath) ||
    rawPath.includes("\\") ||
    rawPath.includes("\0")
  ) {
    throw new ForwardHttpError(404, "Route path not found.", "route_path_not_found");
  }

  const targetPath = new URL(route.targetBaseUrl).pathname.replace(/\/+$/, "") || "/";
  const suffix = normalizedSuffix === "/" ? "" : normalizedSuffix;
  // OpenShell exposes OpenAI routes at the canonical `/v1` gateway surface,
  // while targetBaseUrl is already the provider base validated by NemoClaw.
  // Translate only that structural gateway segment; inferring arbitrary path
  // overlap could collapse legitimate resource names such as `messages`.
  const translatedSuffix =
    targetPath !== "/" &&
    route.providerType === "openai" &&
    (suffix === "/v1" || suffix.startsWith("/v1/"))
      ? suffix.slice(3)
      : suffix;
  const joined = targetPath === "/" ? translatedSuffix || "/" : `${targetPath}${translatedSuffix}`;
  const canonical = new URL(joined, "http://adapter.invalid").pathname;
  const contained =
    canonical === joined &&
    (targetPath === "/" || canonical === targetPath || canonical.startsWith(`${targetPath}/`));
  if (!contained) {
    throw new ForwardHttpError(404, "Route path not found.", "route_path_not_found");
  }
  return `${canonical}${search}`;
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
  const generation = typeof raw.generation === "string" ? raw.generation : "";
  const pinnedAddresses = Array.isArray(raw.pinnedAddresses)
    ? raw.pinnedAddresses.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      )
    : [];
  if (
    !targetBaseUrl ||
    !providerType ||
    !credentialValue ||
    pinnedAddresses.length === 0 ||
    !/^[0-9a-f]{32}$/u.test(generation)
  ) {
    throw new ForwardHttpError(
      400,
      "targetBaseUrl, providerType, credentialValue, pinnedAddresses, and a valid generation are required.",
      "invalid_route",
    );
  }
  try {
    const target = new URL(targetBaseUrl);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.search ||
      target.hash
    ) {
      throw new Error("credential-bearing URL components are not supported");
    }
  } catch {
    throw new ForwardHttpError(
      400,
      "targetBaseUrl must be a valid HTTPS URL without userinfo, query, or fragment components.",
      "invalid_route",
    );
  }
  return { targetBaseUrl, pinnedAddresses, providerType, credentialValue, generation };
}

/**
 * Builds the shared adapter server. Routes live only in memory (`routes`),
 * seeded from `initialRoutes` at startup and otherwise populated by
 * authenticated `PUT /control/routes/:routeId` calls from
 * `ensureHttpsPinRuntimeAdapter`.
 */
export function createHttpsPinRuntimeAdapterServer(options: {
  controlToken: string;
  /**
   * Exact runtime-provider sandbox source subnets. Direct unit callers may omit this
   * and get loopback-only behavior; the spawned production adapter always
   * receives inspected bridge CIDRs in its authenticated bootstrap.
   */
  allowedSourceCidrs?: readonly string[];
  initialRoutes?: Record<string, RouteRuntime>;
  orphanedRoutes?: Record<string, OrphanedRouteMeta>;
  logger?: AdapterLogger;
  adapterIdentity?: Readonly<AdapterIdentity>;
}): http.Server {
  const logger = options.logger || defaultAdapterLogger;
  const adapterIdentity = options.adapterIdentity || CURRENT_ADAPTER_IDENTITY;
  const allowedRouteSources = buildAllowedRouteSourceMatcher(
    options.allowedSourceCidrs ?? ["127.0.0.1/32"],
  );
  const sourcePolicyDigest = routeSourcePolicyDigest(allowedRouteSources.cidrs);
  const routes = new Map<string, RouteRuntime>(Object.entries(options.initialRoutes || {}));
  const orphanedRoutes = new Map<string, OrphanedRouteMeta>(
    Object.entries(options.orphanedRoutes || {}),
  );

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let routeId = "unknown";
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/health") {
        if (!allowedRouteSources.matches(req.socket.remoteAddress)) {
          sendJson(res, 404, {
            error: { message: "Not found", type: "not_found", code: "not_found" },
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          routeCount: routes.size,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/control/health") {
        if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
          sendJson(res, 404, {
            error: { message: "Not found", type: "not_found", code: "not_found" },
          });
          return;
        }
        const nonce = url.searchParams.get("nonce") || "";
        if (!/^[0-9a-f]{64}$/u.test(nonce)) {
          sendJson(res, 400, {
            error: {
              message: "Invalid control challenge",
              type: "invalid_request",
              code: "invalid_control_challenge",
            },
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          protocolVersion: adapterIdentity.protocolVersion,
          buildId: adapterIdentity.buildId,
          sourcePolicyDigest,
          proof: controlChallengeProof(
            options.controlToken,
            nonce,
            adapterIdentity,
            sourcePolicyDigest,
          ),
        });
        return;
      }

      if (req.method === "TRACE" || req.method === "TRACK") {
        sendJson(res, 405, {
          error: {
            message: "Method not allowed",
            type: "method_not_allowed",
            code: "method_not_allowed",
          },
        });
        logAdapterEvent(logger, "request_rejected", {
          method: req.method,
          status: 405,
          reason: "method_not_allowed",
          durationMs: Date.now() - started,
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
          // calls this endpoint over loopback. The sandbox never receives
          // the control token, but the source check remains a second boundary
          // against any accidental credential exposure or host routing drift.
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
            method: req.method || "unknown",
            status: 401,
            reason: "control_plane_unauthorized",
            durationMs: Date.now() - started,
          });
          return;
        }
        if (req.method === "DELETE") {
          routes.delete(routeId);
          orphanedRoutes.delete(routeId);
          sendJson(res, 200, { ok: true, routeId });
          logAdapterEvent(logger, "route_revoked", {
            routeId,
            routeCount: routes.size,
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
          providerType: route.providerType,
          routeCount: routes.size,
          durationMs: Date.now() - started,
        });
        return;
      }

      const routeMatch = url.pathname.match(/^\/route\/([^/]+)(\/.*)?$/);
      if (routeMatch) {
        routeId = routeMatch[1];
        if (!allowedRouteSources.matches(req.socket.remoteAddress)) {
          // Route tokens are scoped to one route, but a peer that reaches this
          // host port from outside the intended sandbox-to-host boundary must
          // not be able to exercise even its own route credential.
          sendJson(res, 404, {
            error: { message: "Not found", type: "not_found", code: "not_found" },
          });
          logAdapterEvent(logger, "request_rejected", {
            routeId,
            status: 404,
            reason: "route_non_openshell_network",
            durationMs: Date.now() - started,
          });
          return;
        }
        const route = routes.get(routeId);
        const orphanedRoute = orphanedRoutes.get(routeId);
        if (!route && !orphanedRoute) {
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
        const providerType = route?.providerType ?? orphanedRoute?.providerType;
        const generation = route?.generation ?? orphanedRoute?.generation;
        const routeToken = generation
          ? deriveRouteToken(options.controlToken, routeId, generation)
          : null;
        const authenticated = providerType
          ? Boolean(routeToken && routeAuthMatches(req, routeToken, providerType))
          : false;
        if (!authenticated) {
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
        if (!route) {
          if (orphanedRoute) {
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
          // The no-route/no-orphan case returns above. This branch exists only
          // to make the type narrowing explicit after authenticated orphan
          // handling.
          throw new ForwardHttpError(404, "Unknown route", "route_not_found");
        }
        const forwardPath = buildContainedForwardPath(
          route,
          routeMatch[2] || "/",
          url.search,
          req.url || "/",
        );
        const target: HttpsPinTarget = {
          targetUrl: new URL(route.targetBaseUrl),
          pinnedAddress: route.pinnedAddresses[0],
          credential: resolveHttpsPinCredentialHeader(route.providerType, route.credentialValue),
        };
        const status = await forwardHttpsPinnedRequest({ req, res, forwardPath, target });
        logAdapterEvent(logger, "request_forwarded", {
          routeId,
          status,
          durationMs: Date.now() - started,
        });
        return;
      }

      sendJson(res, 404, { error: { message: "Not found", type: "not_found", code: "not_found" } });
    } catch (err) {
      const { status, code } = describeForwardHttpError(err);
      logAdapterEvent(logger, "request_failed", {
        routeId,
        status,
        code,
        durationMs: Date.now() - started,
      });
      sendForwardError(res, err);
    }
  });

  // CONNECT bypasses Node's normal request callback. Reject it explicitly so
  // this credential-injecting proxy cannot be repurposed as a generic tunnel.
  server.on("connect", (_req, socket) => {
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    logAdapterEvent(logger, "request_rejected", {
      method: "CONNECT",
      status: 405,
      reason: "method_not_allowed",
    });
  });
  return server;
}

function parseAllowedSourceCidrs(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const allowedSourceCidrs = Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is string => typeof entry === "string" && Boolean(entry.trim()),
        )
      : [];
    return buildAllowedRouteSourceMatcher(allowedSourceCidrs).cidrs;
  } catch {
    return [];
  }
}

function parseOrphanedRoutes(raw: string | undefined): Record<string, OrphanedRouteMeta> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const routes: Record<string, OrphanedRouteMeta> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const meta = value as JsonObject;
      const providerType = meta.providerType;
      const generation = meta.generation;
      if (
        id &&
        (providerType === "openai" || providerType === "anthropic") &&
        typeof generation === "string" &&
        /^[0-9a-f]{32}$/u.test(generation)
      ) {
        routes[id] = { providerType, generation };
      }
    }
    return routes;
  } catch {
    return {};
  }
}

export function startHttpsPinRuntimeAdapterFromEnv(): http.Server {
  // Keep this read explicit so the env-var documentation gate can prove the
  // internal host-only secret is accounted for in its allowlist.
  const controlToken = process.env.NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_CONTROL_TOKEN;
  const port = Number(
    process.env.NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT || HTTPS_PIN_RUNTIME_ADAPTER_PORT,
  );

  if (!controlToken) throw new Error(`${HTTPS_PIN_RUNTIME_ADAPTER_CONTROL_TOKEN_ENV} is required`);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT must be a valid port");
  }

  const allowedSourceCidrs = parseAllowedSourceCidrs(
    process.env.NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_ALLOWED_SOURCE_CIDRS,
  );
  const orphanedRoutes = parseOrphanedRoutes(
    process.env.NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_ORPHANED_ROUTES,
  );

  const server = createHttpsPinRuntimeAdapterServer({
    controlToken,
    allowedSourceCidrs,
    orphanedRoutes,
  });
  server.listen(port, HTTPS_PIN_RUNTIME_ADAPTER_BIND_HOST, () => {
    defaultAdapterLogger("adapter_ready", {
      bindHost: HTTPS_PIN_RUNTIME_ADAPTER_BIND_HOST,
      port,
      routeCount: 0,
      orphanedRouteCount: Object.keys(orphanedRoutes).length,
      allowedSourceCidrs: allowedSourceCidrs.join(","),
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

async function waitForAdapterProcessExit(
  pid: number,
  options: {
    isRunning?: (candidatePid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
    attempts?: number;
    intervalMs?: number;
  } = {},
): Promise<boolean> {
  const isRunning = options.isRunning || ((candidatePid: number) => isAdapterProcess(candidatePid));
  const sleep = options.sleep || sleepMs;
  const attempts = options.attempts ?? PROCESS_EXIT_WAIT_ATTEMPTS;
  const intervalMs = options.intervalMs || PROCESS_EXIT_WAIT_MS;
  if (attempts <= 0) return false;

  return retryUntilAsync(() => !isRunning(pid), {
    accept: (exited) => exited,
    retryDelaysMs: Array.from({ length: Math.ceil(attempts) - 1 }, () => intervalMs),
    sleep,
  });
}

async function killStaleAdapter(): Promise<void> {
  const persistedPid = loadPersistedPid();
  const wasAdapterProcess = isAdapterProcess(persistedPid);
  killLocalAdapterPid({ pidPath: PID_PATH, processMatcher: PROCESS_NEEDLE, run, runCapture });
  if (wasAdapterProcess && persistedPid && !(await waitForAdapterProcessExit(persistedPid))) {
    throw new Error(
      `HTTPS Pin Runtime adapter process ${persistedPid} did not exit after SIGTERM; refusing to start a competing listener.`,
    );
  }
}

/**
 * Unlike the Bedrock/OpenRouter adapters' hand-maintained `scripts/*.js`
 * wrappers, this adapter is spawned directly from its own compiled output so
 * the entrypoint stays TypeScript-only (see the `require.main` guard below).
 */
function getAdapterScriptPath(): string {
  return path.join(ROOT, "dist", "lib", "inference", "https-pin-runtime-adapter.js");
}

function probeAdapterControlHealth(options: {
  controlToken: string;
  port?: number;
  nonce?: string;
  timeoutMs?: number;
  expectedIdentity?: Readonly<AdapterIdentity>;
  expectedSourceCidrs?: readonly string[];
}): Promise<boolean> {
  const nonce = options.nonce || crypto.randomBytes(32).toString("hex");
  const expectedIdentity = options.expectedIdentity || CURRENT_ADAPTER_IDENTITY;
  const expectedSources = buildAllowedRouteSourceMatcher(
    options.expectedSourceCidrs ?? ["127.0.0.1/32"],
  );
  const expectedSourcePolicyDigest = routeSourcePolicyDigest(expectedSources.cidrs);
  const expectedProof = controlChallengeProof(
    options.controlToken,
    nonce,
    expectedIdentity,
    expectedSourcePolicyDigest,
  );
  return new Promise((resolve) => {
    let settled = false;
    let absoluteDeadline: NodeJS.Timeout | null = null;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (absoluteDeadline) clearTimeout(absoluteDeadline);
      resolve(value);
    };
    const timeoutMs = options.timeoutMs || 1000;
    const req = http.request(
      {
        hostname: HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_HOST,
        port: options.port || HTTPS_PIN_RUNTIME_ADAPTER_PORT,
        path: `/control/health?nonce=${nonce}`,
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > 1024) {
            res.destroy();
            settle(false);
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        res.on("end", () => {
          if (settled || res.statusCode !== 200) {
            settle(false);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
            const protocolVersion =
              typeof body.protocolVersion === "string" ? body.protocolVersion : "";
            const buildId = typeof body.buildId === "string" ? body.buildId : "";
            const sourcePolicyDigest =
              typeof body.sourcePolicyDigest === "string" ? body.sourcePolicyDigest : "";
            if (
              protocolVersion !== expectedIdentity.protocolVersion ||
              buildId !== expectedIdentity.buildId ||
              sourcePolicyDigest !== expectedSourcePolicyDigest
            ) {
              settle(false);
              return;
            }
            const proof = typeof body.proof === "string" ? body.proof : "";
            const expected = Buffer.from(expectedProof);
            const received = Buffer.from(proof);
            settle(
              received.length === expected.length && crypto.timingSafeEqual(received, expected),
            );
          } catch {
            settle(false);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      settle(false);
    });
    req.on("error", () => settle(false));
    absoluteDeadline = setTimeout(() => {
      req.destroy();
      settle(false);
    }, timeoutMs);
    req.end();
  });
}

async function waitForAdapterHealth(
  token: string,
  expectedSourceCidrs: readonly string[],
  port = HTTPS_PIN_RUNTIME_ADAPTER_PORT,
): Promise<boolean> {
  return waitForLocalAdapterHealth(
    () =>
      probeAdapterControlHealth({
        port,
        controlToken: token,
        expectedSourceCidrs,
      }),
    {
      attempts: 20,
      intervalMs: 100,
    },
  );
}

function putRoute(options: {
  controlToken: string;
  routeId: string;
  targetBaseUrl: string;
  pinnedAddresses: string[];
  providerType: HttpsPinCredentialProviderType;
  credentialValue: string;
  generation: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      targetBaseUrl: options.targetBaseUrl,
      pinnedAddresses: options.pinnedAddresses,
      providerType: options.providerType,
      credentialValue: options.credentialValue,
      generation: options.generation,
    });
    // The file-backed value here is a purpose-specific 0600 control token,
    // intentionally sent only to the fixed loopback adapter after its HMAC
    // health challenge proved that the expected process owns this port. The
    // destination and request path never derive from file data.
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

function deleteRoute(controlToken: string, routeId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // This is the same fixed-loopback authenticated control boundary as PUT;
    // callers prove adapter identity with the HMAC health challenge before
    // transmitting the purpose-specific token read from its 0600 state file.
    const req = http.request(
      {
        hostname: HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_HOST,
        port: HTTPS_PIN_RUNTIME_ADAPTER_PORT,
        path: `/control/routes/${routeId}`,
        method: "DELETE",
        headers: { Authorization: `Bearer ${controlToken}` },
        timeout: 3000,
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          if (res.statusCode === 200) resolve();
          else {
            reject(
              new Error(
                `HTTPS Pin Runtime adapter rejected route revocation (status ${res.statusCode}).`,
              ),
            );
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("HTTPS Pin Runtime adapter route revocation timed out."));
    });
    req.on("error", reject);
    req.end();
  });
}

function extractPersistedRoutes(prior: JsonObject | null): Record<string, JsonObject> {
  if (!prior?.routes || typeof prior.routes !== "object" || Array.isArray(prior.routes)) return {};
  const sanitized: Record<string, JsonObject> = {};
  for (const [id, value] of Object.entries(prior.routes)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const meta = value as JsonObject;
    if (meta.providerType !== "openai" && meta.providerType !== "anthropic") continue;
    if (typeof meta.generation !== "string" || !/^[0-9a-f]{32}$/u.test(meta.generation)) {
      continue;
    }
    sanitized[id] = {
      providerType: meta.providerType,
      generation: meta.generation,
      registeredAt:
        typeof meta.registeredAt === "string" ? meta.registeredAt : new Date(0).toISOString(),
      ...(typeof meta.orphanedAt === "string" ? { orphanedAt: meta.orphanedAt } : {}),
    };
  }
  return sanitized;
}

/**
 * Reads back the route-source policy the live adapter was actually started
 * with. The control-plane challenge proof binds that policy's digest, so a
 * caller that has to authenticate the adapter later needs the recorded value,
 * not one re-derived from the current host: re-discovery returns whatever the
 * bridge looks like *now*, which silently stops matching the moment the
 * network is recreated or renumbered (#7878).
 *
 * Returns null when the record is absent or malformed so callers fail closed
 * rather than falling back to a default that cannot authenticate a
 * sandbox-facing adapter.
 */
function extractPersistedAllowedSourceCidrs(state: unknown): readonly string[] | null {
  const raw = (state as { allowedSourceCidrs?: unknown } | null)?.allowedSourceCidrs;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every((entry) => typeof entry === "string" && entry.trim())) return null;
  try {
    const canonical = buildAllowedRouteSourceMatcher(raw as string[]).cidrs;
    return canonical.length > 0 ? canonical : null;
  } catch {
    return null;
  }
}

function persistRouteState(
  routeId: string,
  meta: RoutePersistedMeta,
  allowedSourceCidrs?: readonly string[],
): void {
  const prior = readLocalAdapterJsonFile(STATE_PATH);
  const priorRoutes = extractPersistedRoutes(prior);
  writeLocalAdapterJsonFile(STATE_PATH, {
    pid: (prior?.pid as number | null | undefined) ?? loadPersistedPid(),
    updatedAt: new Date().toISOString(),
    // Record the policy this registration proved the live adapter is running
    // under, so a later revocation can authenticate it without re-discovery.
    allowedSourceCidrs: allowedSourceCidrs
      ? [...allowedSourceCidrs]
      : extractPersistedAllowedSourceCidrs(prior),
    // Re-registering a route (fresh `meta`, no `orphanedAt`) always
    // supersedes any prior orphaned entry for the same id -- this is how a
    // route heals after its owner re-runs `inference set` post-recovery.
    routes: { ...priorRoutes, [routeId]: meta },
  });
}

function removeRouteState(routeId: string): void {
  const prior = readLocalAdapterJsonFile(STATE_PATH);
  const routes = extractPersistedRoutes(prior);
  delete routes[routeId];
  writeLocalAdapterJsonFile(STATE_PATH, {
    pid: (prior?.pid as number | null | undefined) ?? loadPersistedPid(),
    updatedAt: new Date().toISOString(),
    // The adapter keeps running with the same policy after one of its routes
    // is dropped, so carry the record forward instead of erasing it.
    allowedSourceCidrs: extractPersistedAllowedSourceCidrs(prior),
    routes,
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
 *
 * The module-level `whyNotSourceFix` and `removalCondition` define the exit
 * criterion for this deliberately degraded state: this function must keep
 * orphaning non-bootstrap routes until a reviewed recovery source can
 * rehydrate every route while preserving the same credential and route
 * isolation boundaries.
 */
function computeRespawnState(
  priorRoutes: Record<string, JsonObject>,
  bootstrapRouteId: string,
): {
  orphanedRoutes: Record<string, OrphanedRouteMeta>;
  persistedRoutes: Record<string, JsonObject>;
} {
  const orphanedRoutes: Record<string, OrphanedRouteMeta> = {};
  const persistedRoutes: Record<string, JsonObject> = {};
  const orphanedAt = new Date().toISOString();
  for (const [id, meta] of Object.entries(priorRoutes)) {
    if (id === bootstrapRouteId) continue;
    if (meta.providerType !== "openai" && meta.providerType !== "anthropic") continue;
    if (typeof meta.generation !== "string" || !/^[0-9a-f]{32}$/u.test(meta.generation)) continue;
    orphanedRoutes[id] = { providerType: meta.providerType, generation: meta.generation };
    persistedRoutes[id] = {
      providerType: meta.providerType,
      generation: meta.generation,
      registeredAt:
        typeof meta.registeredAt === "string" ? meta.registeredAt : new Date(0).toISOString(),
      orphanedAt,
    };
  }
  return { orphanedRoutes, persistedRoutes };
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
  discoverAllowedSourceCidrs: () => readonly string[];
}): Promise<{
  baseUrl: string;
  localBaseUrl: string;
  logPath: string;
  credentialEnv: string;
  token: string;
  routeId: string;
  pinnedAddresses: string[];
}> {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(options.endpointUrl);
  } catch {
    throw new Error("HTTPS Pin Runtime adapter requires a valid endpoint URL.");
  }
  if (sourceUrl.protocol !== "https:") {
    throw new Error("HTTPS Pin Runtime adapter requires an HTTPS endpoint URL.");
  }
  if (sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash) {
    throw new Error(
      "HTTPS Pin Runtime adapter endpoint URLs cannot contain userinfo, query, or fragment components.",
    );
  }
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
  const allowedSourceCidrs = buildAllowedRouteSourceMatcher(
    options.discoverAllowedSourceCidrs(),
  ).cidrs;
  // Keep the lifecycle lock through the whole adapter-registration
  // transaction. In particular, persistRouteState is a read/modify/write of
  // the shared state file; releasing after spawn/reuse would let concurrent
  // CLI processes register both live routes but race their metadata writes
  // and silently drop one route from restart recovery.
  const token = await withAdapterLock(async () => {
    const priorRoute = extractPersistedRoutes(readLocalAdapterJsonFile(STATE_PATH))[routeId];
    const generation =
      typeof priorRoute?.generation === "string"
        ? priorRoute.generation
        : crypto.randomBytes(16).toString("hex");
    const controlToken = await ensureAdapterProcessLocked({
      routeId,
      allowedSourceCidrs,
    });

    await putRoute({
      controlToken,
      routeId,
      targetBaseUrl: options.endpointUrl,
      pinnedAddresses,
      providerType: options.providerType,
      credentialValue: options.credentialValue,
      generation,
    });
    // `ensureAdapterProcessLocked` authenticated the live adapter against this
    // policy just above -- on the reuse path that is the only proof of what it
    // is running under, so record it here too and not just at spawn (#7878).
    persistRouteState(
      routeId,
      {
        providerType: options.providerType,
        generation,
        registeredAt: new Date().toISOString(),
      },
      allowedSourceCidrs,
    );

    // Only this route-scoped value leaves the host lifecycle boundary. The
    // control token stays in its 0600 host state file and the adapter process
    // environment; it is never staged into OpenShell.
    return deriveRouteToken(controlToken, routeId, generation);
  });

  return {
    baseUrl: buildHttpsPinRouteBaseUrl(routeId),
    localBaseUrl: buildHttpsPinRouteLoopbackBaseUrl(routeId),
    logPath: LOG_PATH,
    credentialEnv: HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
    token,
    routeId,
    pinnedAddresses,
  };
}

/**
 * Revokes one no-longer-referenced route after its provider, selection, and
 * registry transaction has committed. The lifecycle lock serializes this
 * control-plane delete with route registration and adapter respawn.
 */
export async function revokeHttpsPinRuntimeAdapterRoute(routeId: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/u.test(routeId)) {
    throw new Error("Refusing to revoke an invalid HTTPS Pin Runtime route id.");
  }
  return withAdapterLock(() => revokeRouteLocked(routeId));
}

async function revokeRouteLocked(
  routeId: string,
  deps: {
    loadPid: () => number | null;
    readControlToken: () => string | null;
    readAllowedSourceCidrs: () => readonly string[] | null;
    probeHealth: (options: {
      controlToken: string;
      expectedSourceCidrs?: readonly string[];
    }) => Promise<boolean>;
    deleteRoute: (controlToken: string, candidateRouteId: string) => Promise<void>;
    isAdapterProcess: (pid: number | null) => boolean;
    removeRouteState: (candidateRouteId: string) => void;
  } = {
    loadPid: loadPersistedPid,
    readControlToken: () => readLocalAdapterTextFile(TOKEN_PATH),
    readAllowedSourceCidrs: () =>
      extractPersistedAllowedSourceCidrs(readLocalAdapterJsonFile(STATE_PATH)),
    probeHealth: (options) => probeAdapterControlHealth(options),
    deleteRoute,
    isAdapterProcess,
    removeRouteState,
  },
): Promise<boolean> {
  const pid = deps.loadPid();
  const controlToken = deps.readControlToken();
  // The control-plane challenge proof binds the adapter's route-source policy,
  // so probing without it silently authenticates against the `127.0.0.1/32`
  // default while every sandbox-facing adapter runs on the OpenShell bridge
  // range. That mismatch is why a superseded route could not be revoked and
  // its upstream credentials stayed resident (#7878). Use the policy recorded
  // when the adapter was started -- never one re-derived here, which stops
  // matching as soon as the bridge is recreated or renumbered.
  const allowedSourceCidrs = deps.readAllowedSourceCidrs();
  const authenticatedLiveAdapter = Boolean(
    controlToken &&
    allowedSourceCidrs &&
    (await deps.probeHealth({
      controlToken: controlToken as string,
      expectedSourceCidrs: allowedSourceCidrs,
    })),
  );
  if (authenticatedLiveAdapter && controlToken) {
    await deps.deleteRoute(controlToken, routeId);
  } else if (controlToken || deps.isAdapterProcess(pid)) {
    // Fail closed. An adapter started before this record existed cannot be
    // authenticated for revocation, and falling back to a re-derived or
    // default policy would authenticate it against a value this process just
    // made up. A missing PID record does not prove that the adapter stopped;
    // preserve the route state while either identity artifact remains. Its
    // next route registration records the policy and heals it.
    throw new Error(
      allowedSourceCidrs
        ? "Cannot authenticate the live HTTPS Pin Runtime adapter for revocation."
        : "Cannot authenticate the live HTTPS Pin Runtime adapter for revocation: " +
            "its route-source policy was not recorded. Re-run the inference set that " +
            "registered this route to record it, then retry.",
    );
  }
  deps.removeRouteState(routeId);
  return true;
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

async function findReusableAdapterControlToken(
  priorToken: string | null,
  allowedSourceCidrs: readonly string[] = ["127.0.0.1/32"],
  probeHealth: (options: {
    controlToken: string;
    expectedIdentity?: Readonly<AdapterIdentity>;
    expectedSourceCidrs?: readonly string[];
  }) => Promise<boolean> = probeAdapterControlHealth,
): Promise<string | null> {
  if (!priorToken) return null;
  return (await probeHealth({
    controlToken: priorToken,
    expectedIdentity: CURRENT_ADAPTER_IDENTITY,
    expectedSourceCidrs: allowedSourceCidrs,
  }))
    ? priorToken
    : null;
}

function buildAdapterChildEnv(
  controlToken: string,
  allowedSourceCidrs: readonly string[],
  orphanedRoutes: Record<string, OrphanedRouteMeta>,
): Record<string, string> {
  return {
    NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT: String(HTTPS_PIN_RUNTIME_ADAPTER_PORT),
    [HTTPS_PIN_RUNTIME_ADAPTER_CONTROL_TOKEN_ENV]: controlToken,
    NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_ALLOWED_SOURCE_CIDRS: JSON.stringify(allowedSourceCidrs),
    NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_ORPHANED_ROUTES: JSON.stringify(orphanedRoutes),
  };
}

/** Returns the host-only control token, reusing the running process when possible or spawning fresh. */
async function ensureAdapterProcessLocked(options: {
  routeId: string;
  allowedSourceCidrs: string[];
}): Promise<string> {
  validateRuntimeAdapterPort(
    "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT",
    HTTPS_PIN_RUNTIME_ADAPTER_PORT,
  );
  const priorToken = readLocalAdapterTextFile(TOKEN_PATH);
  // The authenticated, build-bound health response is stronger identity
  // evidence than a PID file. Reuse the live adapter even if its PID metadata
  // is absent or stale, but replace it when the protocol or build differs so
  // an upgrade cannot keep older forwarding security behavior alive.
  const reusableToken = await findReusableAdapterControlToken(
    priorToken,
    options.allowedSourceCidrs,
  );
  if (reusableToken) return reusableToken;

  await killStaleAdapter();
  // Reusing a still-valid persisted token (rather than always minting a new
  // one) keeps previously registered OpenShell provider credentials working
  // across an adapter respawn whenever possible.
  const token = priorToken || crypto.randomBytes(24).toString("hex");
  // A fresh process starts with an empty in-memory route map -- every route
  // other than the one being bootstrapped now is unrecoverable this restart,
  // since credentials are never persisted to disk (see module doc comment).
  // Tell the freshly spawned process which route ids those are so it can
  // answer them with an actionable "needs recovery" response instead of a
  // bare 404 indistinguishable from a route that never existed (#6141).
  const priorState = readLocalAdapterJsonFile(STATE_PATH);
  const { orphanedRoutes, persistedRoutes } = computeRespawnState(
    extractPersistedRoutes(priorState),
    options.routeId,
  );
  const child = spawnDetachedNodeAdapter({
    scriptPath: getAdapterScriptPath(),
    env: buildAdapterChildEnv(token, options.allowedSourceCidrs, orphanedRoutes),
    // This is a long-lived, credential-bearing process, so it gets a
    // purpose-built minimal environment rather than the general subprocess
    // allowlist -- it must not inherit DOCKER_HOST/KUBECONFIG/SSH_AUTH_SOCK/
    // proxy capabilities that an ordinary short-lived CLI subprocess might
    // legitimately need. See #6141.
    buildEnv: buildMinimalCredentialAdapterEnv,
  });
  try {
    persistLocalAdapterPid(PID_PATH, child.pid);
    if (!(await waitForAdapterHealth(token, options.allowedSourceCidrs))) {
      throw new Error(
        `HTTPS Pin Runtime adapter did not become healthy on ${HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_ORIGIN}`,
      );
    }
    writeLocalAdapterSecretFile(TOKEN_PATH, token);
    // Keep the orphaned routes recorded (still without credentials) instead
    // of dropping them: `persistRouteState` supersedes an entry here the
    // moment its owner re-runs `inference set`, which is how a route heals.
    writeLocalAdapterJsonFile(STATE_PATH, {
      pid: child.pid ?? null,
      updatedAt: new Date().toISOString(),
      // Provenance for the control-plane challenge proof: this is the policy
      // the child was actually spawned with, which revocation must reuse
      // rather than re-derive (#7878).
      allowedSourceCidrs: [...options.allowedSourceCidrs],
      routes: persistedRoutes,
    });
  } catch (err) {
    await killStaleAdapter();
    removeLocalAdapterFile(STATE_PATH);
    throw err;
  }
  return token;
}

export const __test = {
  ORPHANED_ROUTE_RECOVERY_BOUNDARY,
  CURRENT_ADAPTER_IDENTITY,
  deriveRouteToken,
  buildAdapterChildEnv,
  buildContainedForwardPath,
  parseAllowedSourceCidrs,
  waitForAdapterProcessExit,
  persistRouteState,
  getAdapterScriptPath,
  probeAdapterControlHealth,
  tryAcquireAdapterLock,
  withAdapterLock,
  computeRespawnState,
  buildAllowedRouteSourceMatcher,
  extractPersistedAllowedSourceCidrs,
  findReusableAdapterControlToken,
  revokeRouteLocked,
  LOCK_PATH,
  STATE_PATH,
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
