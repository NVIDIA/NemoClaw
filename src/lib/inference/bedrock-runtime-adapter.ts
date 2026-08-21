// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

import {
  BEDROCK_RUNTIME_ADAPTER_PORT,
  GATEWAY_PORT,
  validateRuntimeAdapterPort,
} from "../core/ports";
import { compactText, isLoopbackRemoteAddress } from "../core/url-utils";
import { runCapture, runCaptureEx, SCRIPTS } from "../runner";
import { buildSubprocessEnv } from "../subprocess-env";
import {
  BEDROCK_RUNTIME_ADAPTER_BIND_HOST,
  BEDROCK_RUNTIME_ADAPTER_LOOPBACK_HOST,
  BEDROCK_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL,
  BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
  BEDROCK_RUNTIME_ADAPTER_PROCESS_MATCHER,
  BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
  BEDROCK_RUNTIME_AWS_BEARER_TOKEN_ENV,
  BEDROCK_RUNTIME_COMPATIBLE_CREDENTIAL_ENV,
  type CustomAnthropicEndpointClassification,
  resolveBedrockRuntimeRegion,
} from "./bedrock-runtime";
import {
  AdapterHttpError,
  type BedrockRuntimeClientLike,
  createOpenAiChatCompletion,
  type OpenAiChatRequest,
  parseJsonObject,
  streamOpenAiChatCompletion,
} from "./bedrock-runtime-translation";
import {
  BEDROCK_RUNTIME_ADAPTER_GENERATION_ENV,
  BEDROCK_RUNTIME_ADAPTER_STATE_VERSION,
  BEDROCK_RUNTIME_ADAPTER_UNINSTALL_JOURNAL_VERSION,
  type BedrockRuntimeAdapterLifecyclePaths,
  type BedrockRuntimeAdapterProcessIdentity,
  type BedrockRuntimeAdapterProcessRuntime,
  bedrockRuntimeAdapterProcessPresence,
  canonicalPath,
  canonicalPid,
  isBedrockRuntimeAdapterState,
  isBedrockRuntimeAdapterUninstallJournal,
  observeBedrockRuntimeAdapterProcess,
  readPrivateBedrockRuntimeFile,
  removeDurableBedrockRuntimeFile,
  resolveBedrockRuntimeAdapterLifecyclePaths,
  stopExactBedrockRuntimeAdapterProcess,
  withBedrockRuntimeAdapterLifecycleLockAsync,
  writeDurablePrivateBedrockRuntimeJson,
} from "./bedrock-runtime/lifecycle";
import {
  DEFAULT_LOCAL_ADAPTER_STATE_DIR,
  isLocalAdapterProcess,
  type JsonObject,
  localAdapterTokenHash,
  persistLocalAdapterPid,
  probeLocalAdapterHealth,
  readLocalAdapterJsonFile,
  readLocalAdapterTextFile,
  spawnDetachedNodeAdapter,
  waitForLocalAdapterHealth,
  writeLocalAdapterSecretFile,
} from "./local-adapter-lifecycle";
import { type AdapterLogger, createLocalAdapterLogger } from "./runtime-adapter/logger";
import { readMcpLockProcessIdentity } from "../state/mcp-lifecycle-lock-identity";

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

const { defaultLogger: defaultAdapterLogger, logEvent: logAdapterEvent } = createLocalAdapterLogger(
  { logPath: LOG_PATH },
);

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
        // Only the host probe needs this route; the 0.0.0.0 bind exists so the
        // sandbox can reach the completions route, not to publish adapter config.
        if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
          sendJson(res, 404, {
            error: { message: "Not found", type: "not_found", code: "not_found" },
          });
          return;
        }
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

function getAdapterScriptPath(): string {
  const scriptsDir = typeof SCRIPTS === "string" ? SCRIPTS : path.join(process.cwd(), "scripts");
  return path.join(scriptsDir, "bedrock-runtime-adapter.mts");
}

function bedrockRuntimeAdapterProcessRuntime(): BedrockRuntimeAdapterProcessRuntime {
  return {
    env: process.env,
    kill: (pid, signal) => {
      try {
        return process.kill(pid, signal);
      } catch {
        return false;
      }
    },
    run: (command, args, options) => {
      const result = runCaptureEx([command, ...args], { env: options?.env });
      return {
        status: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr ?? "",
      };
    },
  };
}

function captureSpawnedBedrockRuntimeAdapterIdentity(
  pid: number | null | undefined,
  generation: string,
  tokenHash: string,
): BedrockRuntimeAdapterProcessIdentity | null {
  const processStart = Number.isSafeInteger(pid) ? readMcpLockProcessIdentity(pid!, true) : null;
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0 || !processStart) return null;
  if (!Number.isSafeInteger(uid) || uid! < 0) return null;
  return {
    generation,
    pid,
    processStart,
    user: os.userInfo().username,
    uid: uid!,
    executablePath: canonicalPath(process.execPath),
    scriptPath: canonicalPath(getAdapterScriptPath()),
    adapterPort: BEDROCK_RUNTIME_ADAPTER_PORT,
    tokenHash,
  };
}

function matchesBedrockRuntimeAdapterIdentity(
  value: BedrockRuntimeAdapterProcessIdentity,
  expected: BedrockRuntimeAdapterProcessIdentity,
): boolean {
  return (
    value.generation === expected.generation &&
    value.pid === expected.pid &&
    value.processStart === expected.processStart &&
    value.user === expected.user &&
    value.uid === expected.uid &&
    canonicalPath(value.executablePath) === canonicalPath(expected.executablePath) &&
    canonicalPath(value.scriptPath) === canonicalPath(expected.scriptPath) &&
    value.adapterPort === expected.adapterPort &&
    value.tokenHash === expected.tokenHash
  );
}

function failedStartupEvidenceMatches(
  target: "journal" | "pid" | "state" | "token",
  filePath: string,
  expected: BedrockRuntimeAdapterProcessIdentity,
  gatewayPort: number,
): boolean {
  const raw = readPrivateBedrockRuntimeFile(filePath);
  if (raw === null) return false;
  if (target === "pid") return canonicalPid(raw) === expected.pid;
  if (target === "token") return adapterTokenHash(raw.trim()) === expected.tokenHash;
  try {
    const value: unknown = JSON.parse(raw);
    if (target === "state") {
      return (
        isBedrockRuntimeAdapterState(value) && matchesBedrockRuntimeAdapterIdentity(value, expected)
      );
    }
    return (
      isBedrockRuntimeAdapterUninstallJournal(value) &&
      value.gatewayPort === gatewayPort &&
      matchesBedrockRuntimeAdapterIdentity(value, expected)
    );
  } catch {
    return false;
  }
}

function retireFailedStartupEvidence(
  expected: BedrockRuntimeAdapterProcessIdentity,
  lifecycle: BedrockRuntimeAdapterLifecyclePaths,
  gatewayPort: number,
  runtime: BedrockRuntimeAdapterProcessRuntime,
): boolean {
  const evidence = [
    ["pid", PID_PATH],
    ["token", TOKEN_PATH],
    ["state", STATE_PATH],
    ["journal", lifecycle.journalPath],
  ] as const;
  if (bedrockRuntimeAdapterProcessPresence(expected.pid, runtime) !== "absent") return false;
  if (
    evidence.some(
      ([kind, target]) =>
        fs.existsSync(target) && !failedStartupEvidenceMatches(kind, target, expected, gatewayPort),
    )
  ) {
    return false;
  }
  for (const [kind, target] of evidence) {
    if (!fs.existsSync(target)) continue;
    if (
      bedrockRuntimeAdapterProcessPresence(expected.pid, runtime) !== "absent" ||
      !failedStartupEvidenceMatches(kind, target, expected, gatewayPort)
    ) {
      return false;
    }
    removeDurableBedrockRuntimeFile(target);
  }
  return true;
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

async function ensureBedrockRuntimeAdapterLocked(options: {
  classification: Extract<CustomAnthropicEndpointClassification, { kind: "bedrock-runtime" }>;
  compatibleCredential?: string | null;
  lifecycle: BedrockRuntimeAdapterLifecyclePaths;
  gatewayPort: number;
}): Promise<{
  baseUrl: string;
  localBaseUrl: string;
  logPath: string;
  credentialEnv: string;
  token: string;
  region: string;
}> {
  validateRuntimeAdapterPort("NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT", BEDROCK_RUNTIME_ADAPTER_PORT);
  const region = resolveBedrockRuntimeRegion(options.classification);
  const endpointUrl = options.classification.endpointUrl;
  const compatibleCredential = options.compatibleCredential || null;
  const credentialHash = adapterCredentialHash({ endpointUrl, region, compatibleCredential });
  const priorState = readLocalAdapterJsonFile(STATE_PATH);
  const priorToken = readLocalAdapterTextFile(TOKEN_PATH);
  const priorPidText = readLocalAdapterTextFile(PID_PATH);
  const priorEvidenceExists =
    priorState !== null ||
    priorToken !== null ||
    priorPidText !== null ||
    [STATE_PATH, TOKEN_PATH, PID_PATH].some((target) => fs.existsSync(target));
  const priorPid = priorPidText ? canonicalPid(priorPidText) : null;
  const priorProcessIsRunning = isLocalAdapterProcess(
    priorPid,
    BEDROCK_RUNTIME_ADAPTER_PROCESS_MATCHER,
    runCapture,
  );
  const priorStateProcessMatches =
    isBedrockRuntimeAdapterState(priorState) &&
    priorPid !== null &&
    priorState.pid === priorPid &&
    priorState.uid === process.getuid?.() &&
    priorState.user === os.userInfo().username &&
    canonicalPath(priorState.executablePath) === canonicalPath(process.execPath) &&
    canonicalPath(priorState.scriptPath) === canonicalPath(getAdapterScriptPath()) &&
    priorState.adapterPort === BEDROCK_RUNTIME_ADAPTER_PORT &&
    priorToken !== null &&
    priorState.tokenHash === adapterTokenHash(priorToken) &&
    readMcpLockProcessIdentity(priorPid, true) === priorState.processStart;
  let reusableProcessValidated = false;
  if (
    priorToken &&
    priorStateProcessMatches &&
    priorProcessIsRunning &&
    priorState?.endpointUrl === endpointUrl &&
    priorState?.region === region &&
    priorState?.credentialHash === credentialHash
  ) {
    const healthy = await waitForLocalAdapterHealth(
      () => probeAdapterHealth({ tokenHash: adapterTokenHash(priorToken) }),
      { attempts: 3, intervalMs: 100 },
    );
    reusableProcessValidated =
      healthy &&
      observeBedrockRuntimeAdapterProcess(
        priorState.pid,
        bedrockRuntimeAdapterProcessRuntime(),
        priorState,
      ) !== null;
  }
  if (priorToken && reusableProcessValidated) {
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

  if (priorEvidenceExists) {
    const reason = priorProcessIsRunning
      ? priorStateProcessMatches
        ? "the running generation cannot be reused"
        : "lifecycle state does not match the running process"
      : "lifecycle evidence remains for a generation that cannot be reused";
    throw new Error(`Bedrock Runtime adapter ${reason}; rerun uninstall before onboarding.`);
  }
  const token = crypto.randomBytes(24).toString("hex");
  const generation = crypto.randomBytes(16).toString("hex");
  const childEnv: Record<string, string> = {
    NEMOCLAW_BEDROCK_RUNTIME_ENDPOINT_URL: endpointUrl,
    NEMOCLAW_BEDROCK_RUNTIME_REGION: region,
    NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT: String(BEDROCK_RUNTIME_ADAPTER_PORT),
    [BEDROCK_RUNTIME_ADAPTER_GENERATION_ENV]: generation,
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
  const processRuntime = bedrockRuntimeAdapterProcessRuntime();
  const tokenHash = adapterTokenHash(token);
  let lifecycleIdentity: BedrockRuntimeAdapterProcessIdentity | null = null;
  let durableUninstallAuthorityPublished = false;
  try {
    persistLocalAdapterPid(PID_PATH, child.pid);
    lifecycleIdentity = captureSpawnedBedrockRuntimeAdapterIdentity(
      child.pid,
      generation,
      tokenHash,
    );
    if (!lifecycleIdentity) {
      throw new Error("Bedrock Runtime adapter process identity could not be recorded");
    }
    const updatedAt = new Date().toISOString();
    writeLocalAdapterSecretFile(TOKEN_PATH, token);
    try {
      writeDurablePrivateBedrockRuntimeJson(STATE_PATH, {
        version: BEDROCK_RUNTIME_ADAPTER_STATE_VERSION,
        ...lifecycleIdentity,
        endpointUrl,
        region,
        credentialHash,
        updatedAt,
      });
    } catch (stateError) {
      try {
        writeDurablePrivateBedrockRuntimeJson(options.lifecycle.journalPath, {
          version: BEDROCK_RUNTIME_ADAPTER_UNINSTALL_JOURNAL_VERSION,
          phase: "prepared",
          gatewayPort: options.gatewayPort,
          ...lifecycleIdentity,
          createdAt: updatedAt,
          updatedAt,
        });
        durableUninstallAuthorityPublished = true;
      } catch (journalError) {
        throw new AggregateError(
          [stateError, journalError],
          "Bedrock Runtime adapter lifecycle state and uninstall journal could not be published.",
        );
      }
      throw new Error(
        "Bedrock Runtime adapter lifecycle state could not be published; PID and token evidence were preserved. Rerun uninstall before onboarding.",
        { cause: stateError },
      );
    }
    if (!(await waitForAdapterHealth(token))) {
      throw new Error(
        `Bedrock Runtime adapter did not become healthy on ${BEDROCK_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL}`,
      );
    }
  } catch (err) {
    if (durableUninstallAuthorityPublished) throw err;
    lifecycleIdentity ??= captureSpawnedBedrockRuntimeAdapterIdentity(
      child.pid,
      generation,
      tokenHash,
    );
    if (!lifecycleIdentity) {
      throw new Error(
        "Bedrock Runtime adapter startup failed before its process identity could be proven; available PID evidence was preserved.",
        { cause: err },
      );
    }
    const stopped = stopExactBedrockRuntimeAdapterProcess(lifecycleIdentity, processRuntime);
    if (!stopped.ok) {
      throw new Error(
        "Bedrock Runtime adapter startup failed and the exact spawned process could not be stopped; lifecycle evidence was preserved.",
        { cause: err },
      );
    }
    if (
      !retireFailedStartupEvidence(
        lifecycleIdentity,
        options.lifecycle,
        options.gatewayPort,
        processRuntime,
      )
    ) {
      throw new Error(
        "Bedrock Runtime adapter startup failed; the process stopped, but lifecycle evidence could not be safely retired.",
        { cause: err },
      );
    }
    throw err;
  }
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
  const home = process.env.HOME || os.homedir();
  const lifecycle = resolveBedrockRuntimeAdapterLifecyclePaths(home, GATEWAY_PORT);
  return withBedrockRuntimeAdapterLifecycleLockAsync(lifecycle, async () => {
    if (fs.existsSync(lifecycle.journalPath)) {
      throw new Error(
        "Bedrock Runtime adapter uninstall cleanup is incomplete; rerun uninstall before onboarding.",
      );
    }
    return ensureBedrockRuntimeAdapterLocked({
      ...options,
      lifecycle,
      gatewayPort: GATEWAY_PORT,
    });
  });
}

export function getCompatibleAnthropicCredentialForBedrock(): string | null {
  return process.env[BEDROCK_RUNTIME_COMPATIBLE_CREDENTIAL_ENV]?.trim() || null;
}

export const __test = {
  adapterCredentialHash,
  adapterProcessNeedle: BEDROCK_RUNTIME_ADAPTER_PROCESS_MATCHER,
  getAdapterScriptPath,
};
