// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

import { BEDROCK_RUNTIME_ADAPTER_PORT } from "../core/ports";
import { compactText } from "../core/url-utils";
import { run, runCapture, SCRIPTS } from "../runner";
import { buildSubprocessEnv } from "../subprocess-env";
import {
  BEDROCK_RUNTIME_ADAPTER_BIND_HOST,
  BEDROCK_RUNTIME_ADAPTER_LOOPBACK_HOST,
  BEDROCK_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL,
  BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
  BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
  BEDROCK_RUNTIME_AWS_BEARER_TOKEN_ENV,
  BEDROCK_RUNTIME_COMPATIBLE_CREDENTIAL_ENV,
  type CustomAnthropicEndpointClassification,
  resolveBedrockRuntimeRegion,
} from "./bedrock-runtime";
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
  spawnDetachedNodeAdapter,
  waitForLocalAdapterHealth,
  writeLocalAdapterJsonFile,
  writeLocalAdapterSecretFile,
  type JsonObject,
} from "./local-adapter-lifecycle";
import {
  AdapterHttpError,
  createOpenAiChatCompletion,
  parseJsonObject,
  streamOpenAiChatCompletion,
  type BedrockRuntimeClientLike,
  type OpenAiChatRequest,
} from "./bedrock-runtime-translation";

export {
  AdapterHttpError,
  buildBedrockConverseRequest,
  convertBedrockConverseResponse,
  convertBedrockConverseStream,
  createOpenAiChatCompletion,
  streamOpenAiChatCompletion,
} from "./bedrock-runtime-translation";

const STATE_DIR = DEFAULT_LOCAL_ADAPTER_STATE_DIR;
const TOKEN_PATH = path.join(STATE_DIR, "bedrock-runtime-adapter-token");
const PID_PATH = path.join(STATE_DIR, "bedrock-runtime-adapter.pid");
const STATE_PATH = path.join(STATE_DIR, "bedrock-runtime-adapter.json");
export const LOG_PATH = path.join(STATE_DIR, "bedrock-runtime-adapter.log");
const MAX_BODY_BYTES = 2 * 1024 * 1024;

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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof AdapterHttpError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Bedrock Runtime request failed.";
}

function sendError(res: http.ServerResponse, err: unknown): void {
  const status = err instanceof AdapterHttpError ? err.status : 502;
  const code = err instanceof AdapterHttpError ? err.code : "bedrock_runtime_error";
  const message = safeErrorMessage(err);
  sendJson(res, status, {
    error: {
      message: compactText(message),
      type: code,
      code,
    },
  });
}

function readRequestJson(req: http.IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AdapterHttpError(413, "Request body is too large.", "request_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(parseJsonObject(Buffer.concat(chunks).toString("utf8"), "request body"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function createBedrockRuntimeAdapterServer(options: {
  token: string;
  client: BedrockRuntimeClientLike;
  endpointUrl: string;
  region: string;
  logger?: AdapterLogger;
}): http.Server {
  const logger = options.logger || defaultAdapterLogger;
  return http.createServer(async (req, res) => {
    const started = Date.now();
    let model = "unknown";
    let operation = "unknown";
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          endpointUrl: options.endpointUrl,
          region: options.region,
          tokenHash: adapterTokenHash(options.token),
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
      if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
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

      const body = (await readRequestJson(req)) as OpenAiChatRequest;
      model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "unknown";
      if (body.stream === true) {
        operation = "converse_stream";
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const chunks = await streamOpenAiChatCompletion(body, options.client);
        for await (const chunk of chunks) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
        logAdapterEvent(logger, "request_completed", {
          operation,
          model,
          status: 200,
          stream: true,
          durationMs: Date.now() - started,
        });
        return;
      }

      operation = "converse";
      const response = await createOpenAiChatCompletion(body, options.client);
      sendJson(res, 200, response);
      logAdapterEvent(logger, "request_completed", {
        operation,
        model,
        status: 200,
        stream: false,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      const status = err instanceof AdapterHttpError ? err.status : 502;
      const code = err instanceof AdapterHttpError ? err.code : "bedrock_runtime_error";
      logAdapterEvent(logger, "request_failed", {
        operation,
        model,
        status,
        code,
        durationMs: Date.now() - started,
      });
      if (!res.headersSent) {
        sendError(res, err);
      } else {
        res.write(
          `data: ${JSON.stringify({ error: { message: compactText(safeErrorMessage(err)) } })}\n\n`,
        );
        res.end();
      }
    }
  });
}

export function startBedrockRuntimeAdapterFromEnv(): http.Server {
  const token = process.env[BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV];
  const endpointUrl = process.env.NEMOCLAW_BEDROCK_RUNTIME_ENDPOINT_URL;
  const region = process.env.NEMOCLAW_BEDROCK_RUNTIME_REGION || process.env.AWS_REGION;
  const port = Number(
    process.env.NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT || BEDROCK_RUNTIME_ADAPTER_PORT,
  );

  if (!token) throw new Error(`${BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV} is required`);
  if (!endpointUrl) throw new Error("NEMOCLAW_BEDROCK_RUNTIME_ENDPOINT_URL is required");
  if (!region) throw new Error("NEMOCLAW_BEDROCK_RUNTIME_REGION or AWS_REGION is required");
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT must be a valid port");
  }

  const client = new BedrockRuntimeClient({ region, endpoint: endpointUrl });
  const server = createBedrockRuntimeAdapterServer({ token, client, endpointUrl, region });
  server.listen(port, BEDROCK_RUNTIME_ADAPTER_BIND_HOST, () => {
    defaultAdapterLogger("adapter_ready", {
      region,
      bindHost: BEDROCK_RUNTIME_ADAPTER_BIND_HOST,
      port,
      sandboxRoute: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
      logPath: LOG_PATH,
    });
    console.log(
      `Bedrock Runtime adapter listening on ${BEDROCK_RUNTIME_ADAPTER_BIND_HOST}:${port}; region ${region}; sandbox route ${BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL}; log ${LOG_PATH}`,
    );
  });
  return server;
}

function loadPersistedPid(): number | null {
  return loadLocalAdapterPid(PID_PATH);
}

function isAdapterProcess(pid: number | null | undefined): boolean {
  return isLocalAdapterProcess(pid, "bedrock-runtime-adapter.js", runCapture);
}

function killStaleAdapter(): void {
  killLocalAdapterPid({
    pidPath: PID_PATH,
    processNeedle: "bedrock-runtime-adapter.js",
    run,
    runCapture,
  });
}

function getAdapterScriptPath(): string {
  const scriptsDir = typeof SCRIPTS === "string" ? SCRIPTS : path.join(process.cwd(), "scripts");
  return path.join(scriptsDir, "bedrock-runtime-adapter.js");
}

function copyAwsEnv(extra: Record<string, string>): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.startsWith("AWS_")) {
      extra[key] = value;
    }
  }
}

function forwardedAwsEnvSnapshot(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key.startsWith("AWS_")) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

function adapterCredentialHash(options: {
  endpointUrl: string;
  region: string;
  compatibleCredential: string | null;
}): string {
  const values: Record<string, string | null> = {
    endpointUrl: options.endpointUrl,
    region: options.region,
    compatibleCredential: options.compatibleCredential,
    ...forwardedAwsEnvSnapshot(),
  };
  return crypto.createHash("sha256").update(stableJson(values)).digest("hex");
}

function probeAdapterHealth(
  options: { port?: number; tokenHash?: string | null } = {},
): Promise<boolean> {
  return probeLocalAdapterHealth({
    host: BEDROCK_RUNTIME_ADAPTER_LOOPBACK_HOST,
    port: options.port || BEDROCK_RUNTIME_ADAPTER_PORT,
    expectedTokenHash: options.tokenHash || null,
  });
}

async function waitForAdapterHealth(
  token: string,
  port = BEDROCK_RUNTIME_ADAPTER_PORT,
): Promise<boolean> {
  const tokenHash = adapterTokenHash(token);
  return waitForLocalAdapterHealth(() => probeAdapterHealth({ port, tokenHash }), {
    attempts: 20,
    intervalMs: 100,
  });
}

export async function ensureBedrockRuntimeAdapter(options: {
  classification: Extract<CustomAnthropicEndpointClassification, { kind: "bedrock-runtime" }>;
  compatibleCredential?: string | null;
}): Promise<{
  baseUrl: string;
  localBaseUrl: string;
  logPath: string;
  credentialEnv: string;
  token: string;
  region: string;
}> {
  const region = resolveBedrockRuntimeRegion(options.classification);
  const endpointUrl = options.classification.endpointUrl;
  const compatibleCredential = options.compatibleCredential || null;
  const credentialHash = adapterCredentialHash({ endpointUrl, region, compatibleCredential });
  const priorState = readLocalAdapterJsonFile(STATE_PATH);
  const priorToken = readLocalAdapterTextFile(TOKEN_PATH);
  const priorPid = loadPersistedPid();
  if (
    priorToken &&
    isAdapterProcess(priorPid) &&
    priorState?.endpointUrl === endpointUrl &&
    priorState?.region === region &&
    priorState?.credentialHash === credentialHash &&
    (await probeAdapterHealth({ tokenHash: adapterTokenHash(priorToken) }))
  ) {
    process.env[BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV] = priorToken;
    return {
      baseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
      localBaseUrl: BEDROCK_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL,
      logPath: LOG_PATH,
      credentialEnv: BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
      token: priorToken,
      region,
    };
  }

  killStaleAdapter();
  const token = crypto.randomBytes(24).toString("hex");
  const childEnv: Record<string, string> = {
    NEMOCLAW_BEDROCK_RUNTIME_ENDPOINT_URL: endpointUrl,
    NEMOCLAW_BEDROCK_RUNTIME_REGION: region,
    NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT: String(BEDROCK_RUNTIME_ADAPTER_PORT),
    [BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV]: token,
    AWS_REGION: process.env.AWS_REGION || region,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || region,
  };
  copyAwsEnv(childEnv);
  if (compatibleCredential && !childEnv[BEDROCK_RUNTIME_AWS_BEARER_TOKEN_ENV]) {
    childEnv[BEDROCK_RUNTIME_AWS_BEARER_TOKEN_ENV] = compatibleCredential;
  }

  const child = spawnDetachedNodeAdapter({
    scriptPath: getAdapterScriptPath(),
    env: childEnv,
    buildEnv: buildSubprocessEnv,
  });
  persistLocalAdapterPid(PID_PATH, child.pid);

  if (!(await waitForAdapterHealth(token))) {
    throw new Error(
      `Bedrock Runtime adapter did not become healthy on ${BEDROCK_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL}`,
    );
  }

  writeLocalAdapterSecretFile(TOKEN_PATH, token);
  writeLocalAdapterJsonFile(STATE_PATH, {
    endpointUrl,
    region,
    credentialHash,
    pid: child.pid ?? null,
    updatedAt: new Date().toISOString(),
  });
  process.env[BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV] = token;

  return {
    baseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
    localBaseUrl: BEDROCK_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL,
    logPath: LOG_PATH,
    credentialEnv: BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
    token,
    region,
  };
}

export function getCompatibleAnthropicCredentialForBedrock(): string | null {
  return process.env[BEDROCK_RUNTIME_COMPATIBLE_CREDENTIAL_ENV]?.trim() || null;
}

export const __test = {
  adapterCredentialHash,
};
