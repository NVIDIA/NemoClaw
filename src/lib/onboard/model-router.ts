// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GATEWAY_PORT } from "../core/ports";
import { requireValue } from "../core/require-value";
import { compactText } from "../core/url-utils";
import {
  normalizeCredentialValue,
  resolveProviderCredential,
  saveCredential,
} from "../credentials/store";
import { ROOT, run, runCapture } from "../runner";
import { hashCredential } from "../security/credential-hash";
import { redact, redactFull, redactSensitiveText } from "../security/redact";
import { rejectSymlinksOnPath } from "../state/config-io";
import type { Session } from "../state/onboard-session";
import * as onboardSession from "../state/onboard-session";
import { nemoclawStateRoot } from "../state/state-root";
import { buildSubprocessEnv } from "../subprocess-env";
import { hydrateCredentialEnv } from "./credential-env";
import {
  formatHostServiceUnreachableMessage,
  probeHostServiceSandboxReachability,
} from "./host-service-reachability";
import { createModelRouterCommandProvisioner } from "./model-router-command";
import {
  doesModelRouterProcessOwnPort,
  findModelRouterPidForPort,
  getRouterHealthSnapshot,
  isRouterHealthy,
  ROUTER_HEALTH_TIMEOUT_MS as ROUTER_HEALTH_REQUEST_TIMEOUT_MS,
  type RouterHealthSnapshot,
  stopModelRouterProcess,
} from "./model-router-process";
import { prepareModelRouterVenv } from "./model-router-python";

export {
  createModelRouterCommandProvisioner,
  type ModelRouterCommandDeps,
  type ModelRouterCommandPaths,
  type ModelRouterCommandProvisioner,
} from "./model-router-command";

// The prefill router downloads and loads its routing model before it serves
// /health. Allow a cold host to finish while bounding both elapsed time and
// the number of health checks.
const ROUTER_HEALTH_RETRIES = 300;
const ROUTER_HEALTH_INTERVAL_MS = 2000;
const ROUTER_STARTUP_TIMEOUT_MS = 10 * 60_000;
// LiteLLM's /health live-probes every upstream endpoint per request, so it
// can need far longer than the 3-second liveness budget to answer (#8962).
// The startup poll keeps the 3-second budget: the status-only liveness
// probe must not accept a fast 200 that names zero healthy endpoints, so
// recovery for a slow-but-healthy router runs through the body-checked
// final snapshot after the poll exhausts its retries.
const ROUTER_FINAL_HEALTH_SNAPSHOT_TIMEOUT_MS = 30_000;
const ROUTER_LOG_TAIL_LINES = 20;
const ROUTER_LOG_TAIL_MAX_BYTES = 64 * 1024;
const ROUTER_LOG_TAIL_LINE_MAX_CHARS = 300;
const MODEL_ROUTER_RELATIVE_DIR = path.join("nemoclaw-blueprint", "router", "llm-router");
const MODEL_ROUTER_VENV_DIR = path.join(
  nemoclawStateRoot(os.homedir(), GATEWAY_PORT),
  "model-router-venv",
);
export const DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV = "NVIDIA_INFERENCE_API_KEY";

export type BlueprintRouterConfig = {
  enabled?: boolean;
  port?: number;
  pool_config_path?: string;
  credential_env?: string;
};

export type BlueprintInferenceProfile = {
  provider_name?: string;
  endpoint?: string;
  model: string;
  credential_env?: string;
  credential_default?: string;
  router: BlueprintRouterConfig;
};

type ModelRouterProxyConfigResult = {
  status: number | null;
  stderr?: string | Buffer;
  error?: Error;
};

type ModelRouterSpawnedProcess = {
  pid: number | undefined;
  onError(listener: (error: Error) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  unref(): void;
};

export type StartModelRouterDeps = {
  rootDir: string;
  homeDir: string;
  ensureModelRouterCommand: () => string;
  mkdirSync: (directory: string) => void;
  runProxyConfig: (
    command: string,
    args: string[],
    options: { encoding: "utf8"; timeout: number; cwd: string },
  ) => ModelRouterProxyConfigResult;
  spawnProxy: (
    command: string,
    args: string[],
    options: {
      detached: true;
      stdio: "ignore" | ["ignore", number, number];
      cwd: string;
      env: Record<string, string>;
    },
  ) => ModelRouterSpawnedProcess;
  /** Open the router log for append; null degrades the spawn to stdio "ignore". */
  openRouterLog: (logPath: string) => { fd: number; startOffset: number } | null;
  closeRouterLog: (fd: number) => void;
  /** Read this run's redacted log tail, starting at the offset the run began at. */
  readRouterLogTail: (logPath: string, startOffset: number) => string;
  /** Read the router pool config; null when unreadable. */
  readPoolConfig: (poolConfigPath: string) => string | null;
  resolveProviderCredential: (name: string) => string | null;
  buildSubprocessEnv: (extra: Record<string, string>) => Record<string, string>;
  isRouterHealthy: (port: number, timeoutMs?: number) => Promise<boolean>;
  getRouterHealthSnapshot: (port: number, timeoutMs?: number) => Promise<RouterHealthSnapshot>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  isProcessAlive: (pid: number) => boolean;
  terminateProcess: (pid: number) => void;
  getProviderKey: () => string;
};

/**
 * Load a named inference profile and router config from blueprint.yaml.
 * Returns null if the blueprint or profile is missing.
 */
export function loadBlueprintProfile(
  profileName: string,
  rootDir: string = ROOT,
): BlueprintInferenceProfile | null {
  try {
    const YAML = require("yaml");
    const blueprintPath = path.join(rootDir, "nemoclaw-blueprint", "blueprint.yaml");
    if (!fs.existsSync(blueprintPath)) return null;
    const raw = fs.readFileSync(blueprintPath, "utf8");
    const parsed = YAML.parse(raw);
    const profile = parsed?.components?.inference?.profiles?.[profileName];
    if (!profile) return null;
    const router = { ...(parsed?.components?.router || {}) };
    if (typeof profile.credential_env === "string" && profile.credential_env.trim().length > 0) {
      router.credential_env = profile.credential_env;
    }
    return { ...profile, router } as BlueprintInferenceProfile;
  } catch {
    return null;
  }
}

function modelRouterPackageDir(): string {
  return path.join(ROOT, MODEL_ROUTER_RELATIVE_DIR);
}

function modelRouterVenvDir(): string {
  return process.env.NEMOCLAW_MODEL_ROUTER_VENV || MODEL_ROUTER_VENV_DIR;
}

export function createProductionModelRouterCommandProvisioner(
  routerDir = modelRouterPackageDir(),
  venvDir = modelRouterVenvDir(),
) {
  return createModelRouterCommandProvisioner(
    {
      rootDir: ROOT,
      routerDir,
      venvDir,
      defaultVenvDir: MODEL_ROUTER_VENV_DIR,
    },
    {
      run,
      runCapture,
      prepareModelRouterVenv,
      packageVersion: () =>
        JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version ?? "unknown",
    },
  );
}

export function isManagedModelRouterCurrent(
  routerDir = modelRouterPackageDir(),
  venvDir = modelRouterVenvDir(),
): boolean {
  return createProductionModelRouterCommandProvisioner(
    routerDir,
    venvDir,
  ).isManagedModelRouterCurrent();
}

function ensureModelRouterCommand(): string {
  return createProductionModelRouterCommandProvisioner().ensureModelRouterCommand();
}

/**
 * Start the model-router proxy and wait for it to become healthy.
 * Follows the same pattern as Ollama startup (spawn detached, poll health).
 * Returns the PID of the child process.
 */
function createStartModelRouterDeps(): StartModelRouterDeps {
  return {
    rootDir: ROOT,
    homeDir: os.homedir(),
    ensureModelRouterCommand,
    mkdirSync: (directory) => fs.mkdirSync(directory, { recursive: true }),
    runProxyConfig: (command, args, options) => spawnSync(command, args, options),
    spawnProxy: (command, args, options) => {
      const child = spawn(command, args, options);
      return {
        pid: child.pid,
        onError: (listener) => {
          child.once("error", listener);
        },
        onExit: (listener) => {
          child.once("exit", listener);
        },
        unref: () => child.unref(),
      };
    },
    openRouterLog: (logPath) => {
      // O_NONBLOCK plus the fstat isFile check refuse a planted FIFO the way
      // openRegularFileNoFollow does; O_NOFOLLOW refuses a planted symlink.
      // Writes to a regular file ignore O_NONBLOCK, so the flag only affects
      // the open itself.
      const flags =
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW |
        (typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0);
      let fd: number | null = null;
      try {
        fd = fs.openSync(logPath, flags, 0o600);
        const stats = fs.fstatSync(fd);
        if (!stats.isFile()) throw new Error("not a regular file");
        // O_CREAT does not change the mode of an existing file; enforce the
        // documented owner-only permission on every open.
        fs.fchmodSync(fd, 0o600);
        return { fd, startOffset: stats.size };
      } catch (error) {
        try {
          if (fd !== null) fs.closeSync(fd);
        } catch {
          // The descriptor is already closed or invalid.
        }
        // Router output capture is diagnostic; report and never block startup.
        console.error(`  Failed to open Model Router log '${logPath}': ${String(error)}`);
        return null;
      }
    },
    closeRouterLog: (fd) => fs.closeSync(fd),
    readRouterLogTail: (logPath, startOffset) => {
      // Bounded read of this run's bytes only: an append-only log carries
      // earlier runs' output, and an unbounded readFileSync fails outright
      // past the V8 string limit. Redact before splitting so multi-line
      // secret blocks still match their patterns. The tail lands in the
      // thrown startup error, so it takes full redaction, not the partial
      // form that keeps a four-character secret prefix.
      try {
        const flags =
          fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          (typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0);
        const fd = fs.openSync(logPath, flags);
        try {
          const stats = fs.fstatSync(fd);
          if (!stats.isFile()) return "";
          const from = Math.max(startOffset, stats.size - ROUTER_LOG_TAIL_MAX_BYTES);
          const length = stats.size - from;
          if (length <= 0) return "";
          const buffer = Buffer.alloc(length);
          fs.readSync(fd, buffer, 0, length, from);
          return redactFull(redact(buffer.toString("utf8")))
            .split(/\r?\n|\r/)
            .filter(Boolean)
            .slice(-ROUTER_LOG_TAIL_LINES)
            .map((line) => line.slice(0, ROUTER_LOG_TAIL_LINE_MAX_CHARS))
            .join("\n");
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return "";
      }
    },
    readPoolConfig: (poolConfigPath) => {
      try {
        return fs.readFileSync(poolConfigPath, "utf8");
      } catch {
        return null;
      }
    },
    resolveProviderCredential,
    buildSubprocessEnv,
    isRouterHealthy,
    getRouterHealthSnapshot,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => performance.now(),
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    terminateProcess: (pid) => process.kill(pid, "SIGTERM"),
    getProviderKey: () => (process.env.NEMOCLAW_PROVIDER_KEY || "").trim(),
  };
}

export async function startModelRouter(
  routerCfg: BlueprintRouterConfig,
  overrides: Partial<StartModelRouterDeps> = {},
): Promise<number> {
  const deps: StartModelRouterDeps = { ...createStartModelRouterDeps(), ...overrides };
  const routerCommand = deps.ensureModelRouterCommand();
  const port = routerCfg.port || 4000;
  const blueprintDir = path.join(deps.rootDir, "nemoclaw-blueprint");
  const poolConfigPath = path.join(
    blueprintDir,
    routerCfg.pool_config_path || "router/pool-config.yaml",
  );
  const stateDir = path.join(nemoclawStateRoot(deps.homeDir, GATEWAY_PORT), "state");
  const litellmConfigPath = path.join(stateDir, "litellm-proxy.yaml");

  rejectSymlinksOnPath(stateDir);
  deps.mkdirSync(stateDir);
  rejectSymlinksOnPath(stateDir);

  const proxyConfigResult = deps.runProxyConfig(
    routerCommand,
    ["proxy-config", "--config", poolConfigPath, "--output", litellmConfigPath],
    { encoding: "utf8", timeout: 30_000, cwd: blueprintDir },
  );
  if (proxyConfigResult.status !== 0) {
    throw new Error(
      `model-router proxy-config failed: ${proxyConfigResult.stderr || proxyConfigResult.error || "unknown error"}`,
    );
  }

  const credEnvVars: Record<string, string> = {};
  const credName = routerCfg.credential_env || DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV;
  const routedCredential = deps.resolveProviderCredential(credName);
  if (routedCredential) {
    credEnvVars[credName] = routedCredential;
    // #8962: the generated LiteLLM proxy config authenticates every pool
    // endpoint through OPENAI_API_KEY, so for the shipped NVIDIA pool the
    // validated routed credential must own that variable. An ambient or
    // legacy-staged OPENAI_API_KEY is not valid for the default NVIDIA pool
    // endpoints, and onboarding then reported only a startup timeout. A
    // custom or unproven pool preserves the existing credential precedence.
    // #8962 does not define a credential contract for those pools. Resolving
    // OPENAI_API_KEY only on that path also avoids restaging a stale legacy
    // value into process.env for the shipped pool.
    if (poolTargetsOnlyNvidiaEndpoints(deps.readPoolConfig(poolConfigPath))) {
      credEnvVars.OPENAI_API_KEY = routedCredential;
    } else {
      const ambientOpenAiCredential = deps.resolveProviderCredential("OPENAI_API_KEY");
      credEnvVars.OPENAI_API_KEY = ambientOpenAiCredential || routedCredential;
    }
  } else {
    const openAiCredential = deps.resolveProviderCredential("OPENAI_API_KEY");
    if (openAiCredential) credEnvVars.OPENAI_API_KEY = openAiCredential;
  }
  const _providerKey = deps.getProviderKey();
  if (_providerKey) {
    if (!credEnvVars[credName]) credEnvVars[credName] = _providerKey;
    if (!credEnvVars.OPENAI_API_KEY) credEnvVars.OPENAI_API_KEY = _providerKey;
  }

  if (await deps.isRouterHealthy(port)) {
    throw new Error(
      `Port ${port} already has a healthy router endpoint; refusing to start a second router.`,
    );
  }

  // #8962: capture the router's own output; with stdio "ignore" the actual
  // startup error (for example an endpoint authentication failure) was
  // unreadable.
  const logPath = path.join(stateDir, "model-router.log");
  const routerLog = deps.openRouterLog(logPath);
  let child: ModelRouterSpawnedProcess;
  try {
    child = deps.spawnProxy(
      routerCommand,
      [
        "proxy",
        "--litellm-config",
        litellmConfigPath,
        "--router-config",
        poolConfigPath,
        "--host",
        "0.0.0.0",
        "--port",
        String(port),
      ],
      {
        detached: true,
        stdio: routerLog === null ? "ignore" : ["ignore", routerLog.fd, routerLog.fd],
        cwd: blueprintDir,
        env: deps.buildSubprocessEnv(credEnvVars),
      },
    );
  } finally {
    if (routerLog !== null) deps.closeRouterLog(routerLog.fd);
  }
  let childExited = false;
  let childExitDetail = "";
  child.onError((err: Error) => {
    childExited = true;
    childExitDetail = `child failed to start: ${err.message}`;
  });
  child.onExit((code: number | null, signal: string | null) => {
    childExited = true;
    if (!childExitDetail) {
      childExitDetail = `child exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`;
    }
  });
  child.unref();

  const pid = child.pid;
  if (!pid) {
    throw new Error(
      "Failed to start model-router proxy: no PID returned" +
        (childExitDetail ? ` (${childExitDetail})` : ""),
    );
  }

  // Reserve the final-snapshot window inside the startup budget so a failed
  // startup never exceeds the 600 seconds the error message reports.
  const startupDeadline =
    deps.now() + ROUTER_STARTUP_TIMEOUT_MS - ROUTER_FINAL_HEALTH_SNAPSHOT_TIMEOUT_MS;
  let healthAttempts = 0;
  while (healthAttempts < ROUTER_HEALTH_RETRIES && deps.now() < startupDeadline) {
    const delayMs = Math.min(ROUTER_HEALTH_INTERVAL_MS, startupDeadline - deps.now());
    await deps.sleep(delayMs);
    if (childExited) break;
    const remainingMs = startupDeadline - deps.now();
    if (remainingMs <= 0) break;
    const healthTimeoutMs = Math.max(
      1,
      Math.min(ROUTER_HEALTH_REQUEST_TIMEOUT_MS, Math.ceil(remainingMs)),
    );
    healthAttempts += 1;
    const healthy = await deps.isRouterHealthy(port, healthTimeoutMs);
    const processAlive = deps.isProcessAlive(pid);
    if (healthy && processAlive) return pid;
    if (!processAlive) {
      childExited = true;
      if (!childExitDetail) childExitDetail = "child process is no longer running";
      break;
    }
  }
  // One 30-second body read after the poll exhausts its retries. When the
  // router process is still running, this snapshot is the only source of
  // the endpoint error — and a healthy body is proof of recovery: kill only
  // a router that did not prove itself healthy.
  const finalSnapshot: RouterHealthSnapshot = childExited
    ? { healthy: false, body: null }
    : await deps.getRouterHealthSnapshot(port, ROUTER_FINAL_HEALTH_SNAPSHOT_TIMEOUT_MS);
  if (finalSnapshot.healthy && hasHealthyEndpoint(finalSnapshot.body) && deps.isProcessAlive(pid)) {
    return pid;
  }
  try {
    deps.terminateProcess(pid);
  } catch {
    // already dead
  }
  const lastHealthError = firstUnhealthyEndpointError(finalSnapshot.body);
  const logTail = routerLog === null ? "" : deps.readRouterLogTail(logPath, routerLog.startOffset);
  throw new Error(
    `Model Router failed to become healthy on port ${port} within ${ROUTER_STARTUP_TIMEOUT_MS / 1000} seconds (completed health checks: ${healthAttempts})` +
      (childExitDetail ? ` (${childExitDetail})` : "") +
      (lastHealthError ? ` (last health error: ${lastHealthError})` : "") +
      (routerLog === null ? "" : `. Router log: ${logPath}`) +
      (logTail ? `\n  Last router log lines:\n${logTail}` : ""),
  );
}

/** True when the parsed /health body names at least one healthy endpoint. */
function hasHealthyEndpoint(body: string | null): boolean {
  if (!body) return false;
  try {
    const parsed = JSON.parse(body) as { healthy_endpoints?: readonly unknown[] };
    return Array.isArray(parsed?.healthy_endpoints) && parsed.healthy_endpoints.length > 0;
  } catch {
    return false;
  }
}

/**
 * True when a nonempty pool proves that every endpoint uses HTTPS on
 * nvidia.com or one of its subdomains.
 */
export function poolTargetsOnlyNvidiaEndpoints(poolConfigText: string | null): boolean {
  if (!poolConfigText) return false;
  try {
    const YAML = require("yaml");
    const parsed = YAML.parse(poolConfigText) as {
      models?: readonly { api_base?: unknown }[];
    };
    if (!Array.isArray(parsed?.models) || parsed.models.length === 0) return false;
    const models = parsed.models;
    return models.every((model) => {
      if (typeof model?.api_base !== "string" || !model.api_base.trim()) return false;
      const endpoint = new URL(model.api_base);
      if (endpoint.protocol !== "https:") return false;
      const hostname = endpoint.hostname.replace(/\.$/, "");
      return hostname === "nvidia.com" || hostname.endsWith(".nvidia.com");
    });
  } catch {
    return false;
  }
}

/**
 * Redact and cap the first unhealthy-endpoint error so a startup failure
 * cannot print a credential or an unbounded /health body.
 */
function firstUnhealthyEndpointError(body: string | null): string | null {
  if (!body) return null;
  let error: string | null = null;
  try {
    const parsed = JSON.parse(body) as {
      unhealthy_endpoints?: readonly { error?: unknown }[];
    };
    for (const endpoint of parsed?.unhealthy_endpoints ?? []) {
      if (typeof endpoint?.error === "string" && endpoint.error.length > 0) {
        error = endpoint.error;
        break;
      }
    }
  } catch {
    // A body cut off at the capture cap is not parseable JSON; fall through
    // to the textual match so the diagnostic survives truncation.
  }
  if (!error) {
    const match = body.match(/"error"\s*:\s*"((?:[^"\\]|\\.)+)"/);
    error = match ? match[1] : null;
  }
  if (!error) return null;
  const redacted = redactSensitiveText(error);
  return redacted ? compactText(redacted) || null : null;
}

function getRoutedProfile(): BlueprintInferenceProfile {
  const bp = loadBlueprintProfile("routed");
  if (!bp || bp.router?.enabled !== true) {
    throw new Error("Router is not enabled in nemoclaw-blueprint/blueprint.yaml.");
  }
  return bp;
}

export function isRoutedInferenceProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  if (provider === "nvidia-router") return true;
  const bp = loadBlueprintProfile("routed");
  return Boolean(bp?.provider_name && provider === bp.provider_name);
}

const MODEL_ROUTER_SERVICE_LABEL = "Model Router";

/**
 * Verify the host Model Router is reachable from the OpenShell Docker network.
 *
 * `isRouterHealthy()` only proves the router answers on the host loopback. On
 * Linux Docker-driver hosts with UFW default-deny, a sandbox container can
 * still fail to reach `host.openshell.internal:<routerPort>` even though the
 * host curl succeeds (#4564). This mirrors the Ollama auth-proxy probe: on a
 * `tcp_failed` result print the concrete `ufw allow` remediation and fail so
 * onboarding does not declare an unreachable router healthy. A
 * `probe_unavailable` result (Docker Desktop, missing network during fresh
 * setup before the sandbox network exists, DNS) is non-fatal.
 */
async function verifyModelRouterSandboxReachability(routerPort: number): Promise<void> {
  const reachability = await probeHostServiceSandboxReachability({ port: routerPort });
  if (!reachability.ok && reachability.reason === "tcp_failed") {
    console.error(
      formatHostServiceUnreachableMessage(reachability, {
        serviceLabel: MODEL_ROUTER_SERVICE_LABEL,
        port: routerPort,
      }),
    );
    throw new Error(
      `Sandbox containers cannot reach the Model Router at host.openshell.internal:${routerPort}.`,
    );
  }
}

export async function reconcileModelRouter(): Promise<void> {
  const bp = getRoutedProfile();
  const routerPort = bp.router.port || 4000;
  const routerCredentialEnv =
    bp.router.credential_env || bp.credential_env || DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV;
  const routerCredential =
    hydrateCredentialEnv(routerCredentialEnv) ||
    normalizeCredentialValue(bp.credential_default || "");
  if (!routerCredential) {
    throw new Error(`${routerCredentialEnv} is required to start Model Router.`);
  }
  saveCredential(routerCredentialEnv, routerCredential);
  const routerCredentialHash = hashCredential(routerCredential);
  const session = onboardSession.loadSession();
  const recordedPid = session?.routerPid ?? null;
  const recordedCredentialHash = session?.routerCredentialHash ?? null;

  if (await isRouterHealthy(routerPort)) {
    const recordedProcessOwnsRouter = doesModelRouterProcessOwnPort(recordedPid, routerPort);
    if (
      routerCredentialHash &&
      recordedCredentialHash === routerCredentialHash &&
      recordedProcessOwnsRouter
    ) {
      console.log(`  ✓ Model router is already healthy on port ${routerPort}`);
      await verifyModelRouterSandboxReachability(routerPort);
      return;
    }
    if (recordedProcessOwnsRouter) {
      console.log("  Restarting model router with updated credentials...");
      await stopModelRouterProcess(
        requireValue(recordedPid, "Expected recorded router PID"),
        routerPort,
      );
    } else {
      // The recorded PID doesn't own the port (stale session or fresh start).
      // Try to locate the orphaned router via /proc so we can recover without
      // requiring a manual stop-and-retry. Only stop it if the cmdline
      // confirms it is actually model-router proxy — never kill an unrelated
      // service that happens to occupy the port. See issue #5169.
      const orphanPid = findModelRouterPidForPort(routerPort);
      if (orphanPid !== null) {
        console.log(`  Stopping orphaned model router (PID ${orphanPid})...`);
        await stopModelRouterProcess(orphanPid, routerPort);
      } else {
        throw new Error(
          `Port ${routerPort} already has a healthy router endpoint, but its credential state is unknown. Stop the existing model-router process and rerun onboarding.`,
        );
      }
    }
  }

  console.log("  Starting model router...");
  const routerPid = await startModelRouter(bp.router);
  console.log(`  ✓ Model router started (PID ${routerPid}) on port ${routerPort}`);
  onboardSession.updateSession((current: Session) => {
    current.routerPid = routerPid;
    current.routerCredentialHash = routerCredentialHash;
    return current;
  });
  await verifyModelRouterSandboxReachability(routerPort);
}
