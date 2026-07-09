// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import { OPENROUTER_RUNTIME_ADAPTER_PORT } from "../core/ports";
import { compactText } from "../core/url-utils";
import { run, runCapture, SCRIPTS } from "../runner";
import { buildSubprocessEnv } from "../subprocess-env";
import {
  OPENROUTER_CREDENTIAL_ENV,
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
const ADAPTER_NAME = "openrouter-runtime";
const PROCESS_NEEDLE = "openrouter-runtime-adapter.js";
const ALLOWED_POST_PATHS = new Set(["/v1/chat/completions"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

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

function adapterConfigHash(upstreamBaseUrl = OPENROUTER_ENDPOINT_URL): string {
  return crypto
    .createHash("sha256")
    .update(
      stableJson({
        adapter: ADAPTER_NAME,
        upstreamBaseUrl,
        defaultHeaders: OPENROUTER_DEFAULT_HEADERS,
      }),
    )
    .digest("hex");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function hasBearerAuthorization(actual: string | string[] | undefined): boolean {
  const header = Array.isArray(actual) ? actual[0] : actual;
  return typeof header === "string" && /^Bearer\s+\S+/.test(header);
}

function isAllowedRequest(method: string | undefined, pathname: string): boolean {
  return method === "POST" && ALLOWED_POST_PATHS.has(pathname);
}

function buildUpstreamUrl(upstreamBaseUrl: string, reqUrl: string | undefined): URL {
  const incoming = new URL(reqUrl || "/", "http://127.0.0.1");
  const upstream = new URL(upstreamBaseUrl);
  const basePath = upstream.pathname.replace(/\/+$/, "");
  const suffix = incoming.pathname.startsWith("/v1")
    ? incoming.pathname.slice("/v1".length)
    : incoming.pathname;
  upstream.pathname = `${basePath}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
  upstream.search = incoming.search;
  return upstream;
}

function buildForwardRequestHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  for (const [name, value] of OPENROUTER_DEFAULT_HEADERS) {
    headers[name] = value;
  }
  return headers;
}

function buildForwardResponseHeaders(source: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}

function forwardOpenRouterRequest(options: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  upstreamBaseUrl: string;
}): Promise<number> {
  const upstreamUrl = buildUpstreamUrl(options.upstreamBaseUrl, options.req.url);
  const transport = upstreamUrl.protocol === "http:" ? http : https;
  return new Promise((resolve) => {
    const upstreamReq = transport.request(
      upstreamUrl,
      {
        method: options.req.method,
        headers: buildForwardRequestHeaders(options.req),
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode || 502;
        options.res.writeHead(status, buildForwardResponseHeaders(upstreamRes.headers));
        upstreamRes.pipe(options.res);
        upstreamRes.on("end", () => resolve(status));
      },
    );
    upstreamReq.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!options.res.headersSent) {
        sendJson(options.res, 502, {
          error: {
            message: compactText(message || "OpenRouter request failed."),
            type: "openrouter_runtime_error",
            code: "openrouter_runtime_error",
          },
        });
      } else {
        options.res.destroy(err instanceof Error ? err : undefined);
      }
      resolve(502);
    });
    options.req.on("error", () => {
      upstreamReq.destroy();
      resolve(499);
    });
    options.req.pipe(upstreamReq);
  });
}

export function createOpenRouterRuntimeAdapterServer(
  options: { upstreamBaseUrl?: string; logger?: AdapterLogger } = {},
): http.Server {
  const upstreamBaseUrl = options.upstreamBaseUrl || OPENROUTER_ENDPOINT_URL;
  const configHash = adapterConfigHash(upstreamBaseUrl);
  const logger = options.logger || defaultAdapterLogger;
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          adapter: ADAPTER_NAME,
          configHash,
          headerNames: OPENROUTER_DEFAULT_HEADERS.map(([name]) => name),
        });
        return;
      }
      if (!hasBearerAuthorization(req.headers.authorization)) {
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
      if (!isAllowedRequest(req.method, url.pathname)) {
        sendJson(res, 404, {
          error: { message: "Not found", type: "not_found", code: "not_found" },
        });
        logAdapterEvent(logger, "request_rejected", {
          method: req.method || "unknown",
          path: url.pathname,
          status: 404,
          reason: "not_found",
          durationMs: Date.now() - started,
        });
        return;
      }

      const status = await forwardOpenRouterRequest({ req, res, upstreamBaseUrl });
      logAdapterEvent(logger, "request_completed", {
        method: req.method || "unknown",
        path: url.pathname,
        status,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logAdapterEvent(logger, "request_failed", {
        method: req.method || "unknown",
        path: url.pathname,
        status: 502,
        durationMs: Date.now() - started,
      });
      if (!res.headersSent) {
        sendJson(res, 502, {
          error: {
            message: compactText(message || "OpenRouter request failed."),
            type: "openrouter_runtime_error",
            code: "openrouter_runtime_error",
          },
        });
      } else {
        res.end();
      }
    }
  });
}

export function startOpenRouterRuntimeAdapterFromEnv(): http.Server {
  const port = Number(
    process.env.NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT || OPENROUTER_RUNTIME_ADAPTER_PORT,
  );
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT must be a valid port");
  }

  const server = createOpenRouterRuntimeAdapterServer();
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

function isAdapterProcess(pid: number | null | undefined): boolean {
  return isLocalAdapterProcess(pid, PROCESS_NEEDLE, runCapture);
}

function killStaleAdapter(): void {
  killLocalAdapterPid({
    pidPath: PID_PATH,
    processNeedle: PROCESS_NEEDLE,
    run,
    runCapture,
  });
}

function getAdapterScriptPath(): string {
  const scriptsDir = typeof SCRIPTS === "string" ? SCRIPTS : path.join(process.cwd(), "scripts");
  return path.join(scriptsDir, PROCESS_NEEDLE);
}

function probeAdapterHealth(
  options: { port?: number; configHash?: string | null } = {},
): Promise<boolean> {
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
              body.adapter === ADAPTER_NAME &&
                (!options.configHash || body.configHash === options.configHash),
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

async function waitForAdapterHealth(
  configHash: string,
  port = OPENROUTER_RUNTIME_ADAPTER_PORT,
): Promise<boolean> {
  return waitForLocalAdapterHealth(() => probeAdapterHealth({ port, configHash }), {
    attempts: 20,
    intervalMs: 100,
  });
}

export async function ensureOpenRouterRuntimeAdapter(): Promise<{
  baseUrl: string;
  localBaseUrl: string;
  logPath: string;
  credentialEnv: string;
}> {
  const upstreamBaseUrl = OPENROUTER_ENDPOINT_URL;
  const configHash = adapterConfigHash(upstreamBaseUrl);
  const priorState = readLocalAdapterJsonFile(STATE_PATH);
  const priorPid = loadPersistedPid();
  if (
    isAdapterProcess(priorPid) &&
    priorState?.upstreamBaseUrl === upstreamBaseUrl &&
    priorState?.configHash === configHash &&
    (await probeAdapterHealth({ configHash }))
  ) {
    return {
      baseUrl: OPENROUTER_RUNTIME_ADAPTER_OPENAI_BASE_URL,
      localBaseUrl: OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL,
      logPath: LOG_PATH,
      credentialEnv: OPENROUTER_CREDENTIAL_ENV,
    };
  }

  killStaleAdapter();
  const child = spawnDetachedNodeAdapter({
    scriptPath: getAdapterScriptPath(),
    env: {
      NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT: String(OPENROUTER_RUNTIME_ADAPTER_PORT),
    },
    buildEnv: buildSubprocessEnv,
  });
  persistLocalAdapterPid(PID_PATH, child.pid);

  if (!(await waitForAdapterHealth(configHash))) {
    throw new Error(
      `OpenRouter Runtime adapter did not become healthy on ${OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL}`,
    );
  }

  writeLocalAdapterJsonFile(STATE_PATH, {
    upstreamBaseUrl,
    configHash,
    pid: child.pid ?? null,
    updatedAt: new Date().toISOString(),
  });

  return {
    baseUrl: OPENROUTER_RUNTIME_ADAPTER_OPENAI_BASE_URL,
    localBaseUrl: OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL,
    logPath: LOG_PATH,
    credentialEnv: OPENROUTER_CREDENTIAL_ENV,
  };
}

export const __test = {
  adapterConfigHash,
};
