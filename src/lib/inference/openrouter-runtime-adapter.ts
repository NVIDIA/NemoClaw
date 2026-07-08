// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import crypto from "node:crypto";
import https from "node:https";
import path from "node:path";

import { OPENROUTER_RUNTIME_ADAPTER_PORT } from "../core/ports";
import { compactText } from "../core/url-utils";
import { run, runCapture, SCRIPTS } from "../runner";
import { buildSubprocessEnv } from "../subprocess-env";
import {
  OPENROUTER_DEFAULT_HEADERS,
  OPENROUTER_ENDPOINT_URL,
  OPENROUTER_RUNTIME_ADAPTER_BIND_HOST,
  OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_HOST,
  OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL,
  OPENROUTER_RUNTIME_ADAPTER_OPENAI_BASE_URL,
} from "./openrouter";
import {
  DEFAULT_LOCAL_ADAPTER_STATE_DIR,
  appendLocalAdapterJsonLine,
  isLocalAdapterProcess,
  killLocalAdapterPid,
  loadLocalAdapterPid,
  persistLocalAdapterPid,
  readLocalAdapterJsonFile,
  spawnDetachedNodeAdapter,
  waitForLocalAdapterHealth,
  writeLocalAdapterJsonFile,
  type JsonObject,
} from "./local-adapter-lifecycle";

const STATE_DIR = DEFAULT_LOCAL_ADAPTER_STATE_DIR;
const PID_PATH = path.join(STATE_DIR, "openrouter-runtime-adapter.pid");
const STATE_PATH = path.join(STATE_DIR, "openrouter-runtime-adapter.json");
export const LOG_PATH = path.join(STATE_DIR, "openrouter-runtime-adapter.log");
const AUTHORIZATION_HASH_ENV = "NEMOCLAW_OPENROUTER_RUNTIME_AUTHORIZATION_SHA256";

// TODO(OpenShell middleware): Replace this host-side adapter with native
// OpenShell provider middleware once OpenShell can inject provider-specific
// outbound HTTP headers. The middleware should preserve the current security
// model: OpenShell owns OPENROUTER_API_KEY, and NemoClaw only asks for the
// default OpenRouter attribution headers to be added before the upstream call.
// Until then, keep this adapter header-only and do not persist provider secrets
// or request bodies here.
const ADAPTER_ID = "openrouter-runtime-adapter";
const ALLOWED_REQUESTS = new Map<string, ReadonlySet<string>>([
  ["GET", new Set(["/v1/models"])],
  ["POST", new Set(["/v1/chat/completions", "/v1/completions", "/v1/responses"])],
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const ATTRIBUTION_HEADER_NAMES = new Set(
  OPENROUTER_DEFAULT_HEADERS.map(([name]) => name.toLowerCase()),
);
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, {
    error: {
      message: compactText(message),
      type: code,
      code,
    },
  });
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.find((item) => item.trim())?.trim() ?? null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeAuthorizationHash(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SHA256_HEX_PATTERN.test(normalized) ? normalized : null;
}

export function openRouterRuntimeAuthorizationHash(apiKey: string): string {
  return crypto.createHash("sha256").update(`Bearer ${apiKey}`).digest("hex");
}

function authorizationMatchesHash(authorization: string, expectedHash: string): boolean {
  const actual = Buffer.from(
    crypto.createHash("sha256").update(authorization).digest("hex"),
    "hex",
  );
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function isAllowedRequest(method: string | undefined, pathname: string): boolean {
  if (!method) return false;
  return ALLOWED_REQUESTS.get(method.toUpperCase())?.has(pathname) === true;
}

function buildUpstreamUrl(upstreamBaseUrl: URL, requestUrl: URL): URL {
  const suffix = requestUrl.pathname.slice("/v1".length);
  const upstream = new URL(upstreamBaseUrl.href);
  upstream.pathname = `${upstream.pathname.replace(/\/+$/u, "")}${suffix}`;
  upstream.search = requestUrl.search;
  return upstream;
}

function copySafeRequestHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const copied: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(lower) || ATTRIBUTION_HEADER_NAMES.has(lower)) continue;
    if (lower === "authorization" || lower === "x-api-key") continue;
    copied[name] = value;
  }
  const authorization = firstHeader(headers.authorization);
  if (authorization) copied.Authorization = authorization;
  for (const [name, value] of OPENROUTER_DEFAULT_HEADERS) {
    copied[name] = value;
  }
  return copied;
}

function copySafeResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const copied: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    copied[name] = value;
  }
  return copied;
}

function forwardToOpenRouter(options: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  upstreamUrl: URL;
  logger: AdapterLogger;
  started: number;
}): void {
  const { req, res, upstreamUrl, logger, started } = options;
  const transport = upstreamUrl.protocol === "http:" ? http : https;
  const upstreamReq = transport.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      method: req.method,
      headers: copySafeRequestHeaders(req.headers),
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode || 502;
      const headers = copySafeResponseHeaders(upstreamRes.headers);
      if (upstreamRes.statusMessage) {
        res.writeHead(status, upstreamRes.statusMessage, headers);
      } else {
        res.writeHead(status, headers);
      }
      upstreamRes.pipe(res);
      upstreamRes.on("end", () => {
        logAdapterEvent(logger, "request_completed", {
          method: req.method || "unknown",
          path: new URL(req.url || "/", "http://127.0.0.1").pathname,
          status: upstreamRes.statusCode || 502,
          durationMs: Date.now() - started,
        });
      });
    },
  );
  upstreamReq.on("error", (err) => {
    logAdapterEvent(logger, "request_failed", {
      method: req.method || "unknown",
      path: new URL(req.url || "/", "http://127.0.0.1").pathname,
      status: 502,
      code: "upstream_error",
      durationMs: Date.now() - started,
    });
    if (!res.headersSent) {
      sendError(res, 502, "openrouter_runtime_error", err.message || "OpenRouter request failed.");
    } else {
      res.destroy(err);
    }
  });
  req.on("error", (err) => upstreamReq.destroy(err));
  if (req.method === "GET" || req.method === "HEAD") {
    upstreamReq.end();
  } else {
    req.pipe(upstreamReq);
  }
}

export function createOpenRouterRuntimeAdapterServer(
  options: {
    upstreamBaseUrl?: string | URL;
    authorizationHash?: string | null;
    logger?: AdapterLogger;
  } = {},
): http.Server {
  const logger = options.logger || defaultAdapterLogger;
  const upstreamBaseUrl = new URL(String(options.upstreamBaseUrl || OPENROUTER_ENDPOINT_URL));
  const authorizationHash = normalizeAuthorizationHash(options.authorizationHash);
  return http.createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        adapter: ADAPTER_ID,
        authorizationRequired: Boolean(authorizationHash),
        upstreamBaseUrl: upstreamBaseUrl.href.replace(/\/+$/u, ""),
      });
      return;
    }
    const authorization = firstHeader(req.headers.authorization);
    if (
      !authorization ||
      !authorizationHash ||
      !authorizationMatchesHash(authorization, authorizationHash)
    ) {
      sendError(res, 401, "unauthorized", "Unauthorized");
      logAdapterEvent(logger, "request_rejected", {
        method: req.method || "unknown",
        path: url.pathname,
        status: 401,
        reason: authorization ? "invalid_authorization" : "missing_authorization",
        durationMs: Date.now() - started,
      });
      return;
    }
    if (!isAllowedRequest(req.method, url.pathname)) {
      sendError(res, 404, "not_found", "Not found");
      logAdapterEvent(logger, "request_rejected", {
        method: req.method || "unknown",
        path: url.pathname,
        status: 404,
        reason: "not_found",
        durationMs: Date.now() - started,
      });
      return;
    }
    forwardToOpenRouter({
      req,
      res,
      upstreamUrl: buildUpstreamUrl(upstreamBaseUrl, url),
      logger,
      started,
    });
  });
}

export function startOpenRouterRuntimeAdapterFromEnv(): http.Server {
  const port = Number(
    process.env.NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT || OPENROUTER_RUNTIME_ADAPTER_PORT,
  );
  const authorizationHash = normalizeAuthorizationHash(
    process.env.NEMOCLAW_OPENROUTER_RUNTIME_AUTHORIZATION_SHA256,
  );
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT must be a valid port");
  }
  if (!authorizationHash) {
    throw new Error(`${AUTHORIZATION_HASH_ENV} must be a SHA-256 authorization hash`);
  }
  const server = createOpenRouterRuntimeAdapterServer({ authorizationHash });
  server.listen(port, OPENROUTER_RUNTIME_ADAPTER_BIND_HOST, () => {
    defaultAdapterLogger("adapter_ready", {
      bindHost: OPENROUTER_RUNTIME_ADAPTER_BIND_HOST,
      port,
      sandboxRoute: OPENROUTER_RUNTIME_ADAPTER_OPENAI_BASE_URL,
      logPath: LOG_PATH,
    });
    console.log(
      `OpenRouter Runtime adapter listening on ${OPENROUTER_RUNTIME_ADAPTER_BIND_HOST}:${port}; sandbox route ${OPENROUTER_RUNTIME_ADAPTER_OPENAI_BASE_URL}; log ${LOG_PATH}`,
    );
  });
  return server;
}

function loadPersistedPid(): number | null {
  return loadLocalAdapterPid(PID_PATH);
}

function stateAuthorizationHash(state: JsonObject | null): string | null {
  return normalizeAuthorizationHash(state?.authorizationHash);
}

function isAdapterProcess(pid: number | null | undefined): boolean {
  return isLocalAdapterProcess(pid, "openrouter-runtime-adapter.js", runCapture);
}

function killStaleAdapter(): void {
  killLocalAdapterPid({
    pidPath: PID_PATH,
    processNeedle: "openrouter-runtime-adapter.js",
    run,
    runCapture,
  });
}

function getAdapterScriptPath(): string {
  const rootDir = typeof SCRIPTS === "string" ? path.resolve(SCRIPTS, "..") : process.cwd();
  return path.join(rootDir, "dist", "lib", "inference", "openrouter-runtime-adapter.js");
}

function probeAdapterHealth(
  options: { port?: number; upstreamBaseUrl?: string | null } = {},
): Promise<boolean> {
  const expectedUpstream = String(options.upstreamBaseUrl || OPENROUTER_ENDPOINT_URL).replace(
    /\/+$/u,
    "",
  );
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_HOST,
        port: options.port || OPENROUTER_RUNTIME_ADAPTER_PORT,
        path: "/health",
        method: "GET",
        timeout: 1000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve(false);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
            resolve(
              body.ok === true &&
                body.adapter === ADAPTER_ID &&
                body.upstreamBaseUrl === expectedUpstream,
            );
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function waitForAdapterHealth(port = OPENROUTER_RUNTIME_ADAPTER_PORT): Promise<boolean> {
  return waitForLocalAdapterHealth(() => probeAdapterHealth({ port }), {
    attempts: 20,
    intervalMs: 100,
  });
}

export async function ensureOpenRouterRuntimeAdapter(
  options: { authorizationHash?: string | null } = {},
): Promise<{
  baseUrl: string;
  localBaseUrl: string;
  logPath: string;
}> {
  const priorState = readLocalAdapterJsonFile(STATE_PATH);
  const priorAuthorizationHash = stateAuthorizationHash(priorState);
  const authorizationHash =
    normalizeAuthorizationHash(options.authorizationHash) || priorAuthorizationHash;
  if (!authorizationHash) {
    throw new Error(
      "OpenRouter Runtime adapter requires the OpenRouter credential once to initialize authorization",
    );
  }
  const priorPid = loadPersistedPid();
  if (
    isAdapterProcess(priorPid) &&
    priorState?.upstreamBaseUrl === OPENROUTER_ENDPOINT_URL &&
    priorAuthorizationHash === authorizationHash &&
    (await probeAdapterHealth())
  ) {
    return {
      baseUrl: OPENROUTER_RUNTIME_ADAPTER_OPENAI_BASE_URL,
      localBaseUrl: OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL,
      logPath: LOG_PATH,
    };
  }

  killStaleAdapter();
  const child = spawnDetachedNodeAdapter({
    scriptPath: getAdapterScriptPath(),
    env: {
      NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT: String(OPENROUTER_RUNTIME_ADAPTER_PORT),
      [AUTHORIZATION_HASH_ENV]: authorizationHash,
    },
    buildEnv: buildSubprocessEnv,
  });
  persistLocalAdapterPid(PID_PATH, child.pid);

  if (!(await waitForAdapterHealth())) {
    throw new Error(
      `OpenRouter Runtime adapter did not become healthy on ${OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL}`,
    );
  }

  writeLocalAdapterJsonFile(STATE_PATH, {
    upstreamBaseUrl: OPENROUTER_ENDPOINT_URL,
    authorizationHash,
    pid: child.pid ?? null,
    updatedAt: new Date().toISOString(),
  });

  return {
    baseUrl: OPENROUTER_RUNTIME_ADAPTER_OPENAI_BASE_URL,
    localBaseUrl: OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL,
    logPath: LOG_PATH,
  };
}

function startOpenRouterRuntimeAdapterCli(): void {
  try {
    startOpenRouterRuntimeAdapterFromEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  startOpenRouterRuntimeAdapterCli();
}

export const __test = {
  buildUpstreamUrl,
  copySafeRequestHeaders,
  copySafeResponseHeaders,
};
