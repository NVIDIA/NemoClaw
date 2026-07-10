// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import {
  BEDROCK_RUNTIME_ADAPTER_PORT,
  DASHBOARD_PORT,
  DASHBOARD_PORT_RANGE_END,
  DASHBOARD_PORT_RANGE_START,
  GATEWAY_PORT,
  OLLAMA_PORT,
  OLLAMA_PROXY_PORT,
  OPENROUTER_RUNTIME_ADAPTER_PORT,
  VLLM_PORT,
  validateOpenRouterRuntimeAdapterPort,
} from "../core/ports";
import { run, runCapture } from "../runner";
import { buildSubprocessEnv } from "../subprocess-env";
import {
  OPENROUTER_CREDENTIAL_ENV,
  OPENROUTER_ENDPOINT_URL,
  OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_HOST,
  OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL,
  OPENROUTER_RUNTIME_ADAPTER_OPENAI_BASE_URL,
} from "./openrouter";
import {
  ensureLocalAdapterStateDir,
  isLocalAdapterProcess,
  killLocalAdapterPid,
  loadLocalAdapterPid,
  persistLocalAdapterPid,
  readLocalAdapterJsonFile,
  removeLocalAdapterFile,
  spawnDetachedNodeAdapter,
  waitForLocalAdapterHealth,
  writeLocalAdapterJsonFile,
  type JsonObject,
} from "./local-adapter-lifecycle";
import {
  ADAPTER_NAME,
  LOCK_PATH,
  LOG_PATH,
  OPENROUTER_RUNTIME_ADAPTER_AUTHORIZATION_HASH_ENV,
  OPENROUTER_RUNTIME_ADAPTER_HEALTH_ID_ENV,
  PID_PATH,
  STATE_DIR,
  STATE_PATH,
  adapterAuthorizationHash,
  adapterConfigHash,
  generateAdapterHealthId,
  normalizeAdapterHealthId,
  normalizeAuthorizationHash,
} from "./openrouter-runtime-adapter-common";

const PROCESS_NEEDLE = "openrouter-runtime-adapter";
const LOCK_RETRY_ATTEMPTS = 100;
const LOCK_RETRY_MS = 100;
const STALE_LOCK_MS = 30_000;

type AdapterRoute = {
  baseUrl: string;
  localBaseUrl: string;
  logPath: string;
  credentialEnv: string;
  started: boolean;
  startedPid: number | null;
};

export type OpenRouterRuntimeAdapterRoute = AdapterRoute;

type EnsureOpenRouterRuntimeAdapterOptions = {
  authorizationToken?: string | null;
};

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
  throw new Error("OpenRouter Runtime adapter startup is already in progress");
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

function cleanupFailedAdapterStartup(): void {
  killStaleAdapter();
  removeLocalAdapterFile(STATE_PATH);
}

export function cleanupStartedOpenRouterRuntimeAdapter(
  adapter: Pick<OpenRouterRuntimeAdapterRoute, "started" | "startedPid">,
): void {
  if (!adapter.started || !adapter.startedPid) return;
  const persistedPid = loadPersistedPid();
  if (persistedPid !== adapter.startedPid) return;
  if (isAdapterProcess(adapter.startedPid)) {
    run(["kill", String(adapter.startedPid)], { ignoreError: true, suppressOutput: true });
  }
  removeLocalAdapterFile(PID_PATH);
  removeLocalAdapterFile(STATE_PATH);
}

function getAdapterScriptPath(): string {
  return path.join(__dirname, "openrouter-runtime-adapter-entry.js");
}

function probeAdapterHealth(
  options: { port?: number; configHash?: string | null; healthId?: string | null } = {},
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
                (!options.configHash || body.configHash === options.configHash) &&
                (!options.healthId || body.healthId === options.healthId),
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
  healthId: string,
  port = OPENROUTER_RUNTIME_ADAPTER_PORT,
): Promise<boolean> {
  return waitForLocalAdapterHealth(() => probeAdapterHealth({ port, configHash, healthId }), {
    attempts: 20,
    intervalMs: 100,
  });
}

function adapterRoute(started: boolean, startedPid: number | null): AdapterRoute {
  return {
    baseUrl: OPENROUTER_RUNTIME_ADAPTER_OPENAI_BASE_URL,
    localBaseUrl: OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL,
    logPath: LOG_PATH,
    credentialEnv: OPENROUTER_CREDENTIAL_ENV,
    started,
    startedPid,
  };
}

function validateAdapterPortConfiguration(): void {
  validateOpenRouterRuntimeAdapterPort(
    "NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT",
    OPENROUTER_RUNTIME_ADAPTER_PORT,
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
    },
  );
}

function resolveAuthorizationHash(
  authorizationToken: string | null | undefined,
  priorState: JsonObject | null,
): string {
  const seededHash =
    authorizationToken && authorizationToken.trim()
      ? adapterAuthorizationHash(authorizationToken.trim())
      : normalizeAuthorizationHash(priorState?.authorizationHash);
  if (!seededHash) {
    throw new Error(
      "OpenRouter Runtime adapter requires OPENROUTER_API_KEY once to bind adapter authorization before reusing a gateway-held credential.",
    );
  }
  return seededHash;
}

async function ensureOpenRouterRuntimeAdapterLocked(
  options: EnsureOpenRouterRuntimeAdapterOptions = {},
): Promise<AdapterRoute> {
  validateAdapterPortConfiguration();
  const upstreamBaseUrl = OPENROUTER_ENDPOINT_URL;
  const configHash = adapterConfigHash(upstreamBaseUrl);
  const priorState = readLocalAdapterJsonFile(STATE_PATH);
  const authorizationHash = resolveAuthorizationHash(options.authorizationToken, priorState);
  const priorHealthId = normalizeAdapterHealthId(priorState?.healthId);
  const priorPid = loadPersistedPid();
  if (
    isAdapterProcess(priorPid) &&
    priorState?.upstreamBaseUrl === upstreamBaseUrl &&
    priorState?.configHash === configHash &&
    normalizeAuthorizationHash(priorState?.authorizationHash) === authorizationHash &&
    priorHealthId &&
    (await probeAdapterHealth({ configHash, healthId: priorHealthId }))
  ) {
    return adapterRoute(false, null);
  }

  killStaleAdapter();
  const healthId = generateAdapterHealthId();
  const child = spawnDetachedNodeAdapter({
    scriptPath: getAdapterScriptPath(),
    env: {
      NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT: String(OPENROUTER_RUNTIME_ADAPTER_PORT),
      [OPENROUTER_RUNTIME_ADAPTER_AUTHORIZATION_HASH_ENV]: authorizationHash,
      [OPENROUTER_RUNTIME_ADAPTER_HEALTH_ID_ENV]: healthId,
    },
    buildEnv: buildSubprocessEnv,
  });
  try {
    persistLocalAdapterPid(PID_PATH, child.pid);

    if (!(await waitForAdapterHealth(configHash, healthId))) {
      throw new Error(
        `OpenRouter Runtime adapter did not become healthy on ${OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL}`,
      );
    }

    writeLocalAdapterJsonFile(STATE_PATH, {
      upstreamBaseUrl,
      configHash,
      authorizationHash,
      healthId,
      pid: child.pid ?? null,
      updatedAt: new Date().toISOString(),
    });
    if (!(await probeAdapterHealth({ configHash, healthId }))) {
      throw new Error(
        `OpenRouter Runtime adapter health changed before registration on ${OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL}`,
      );
    }
  } catch (err) {
    cleanupFailedAdapterStartup();
    throw err;
  }

  return adapterRoute(true, child.pid ?? null);
}

export async function ensureOpenRouterRuntimeAdapter(
  options: EnsureOpenRouterRuntimeAdapterOptions = {},
): Promise<AdapterRoute> {
  return withAdapterLock(() => ensureOpenRouterRuntimeAdapterLocked(options));
}

export const __test = {
  getAdapterScriptPath,
  probeAdapterHealth,
};
