// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireValue } from "../core/require-value";
import {
  normalizeCredentialValue,
  resolveProviderCredential,
  saveCredential,
} from "../credentials/store";
import { ROOT, run, runCapture } from "../runner";
import { hashCredential } from "../security/credential-hash";
import type { Session } from "../state/onboard-session";
import * as onboardSession from "../state/onboard-session";
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
  isRouterHealthy,
  stopModelRouterProcess,
} from "./model-router-process";
import { prepareModelRouterVenv } from "./model-router-python";

export {
  createModelRouterCommandProvisioner,
  type ModelRouterCommandDeps,
  type ModelRouterCommandPaths,
  type ModelRouterCommandProvisioner,
} from "./model-router-command";

const ROUTER_HEALTH_RETRIES = 15;
const ROUTER_HEALTH_INTERVAL_MS = 2000;
const MODEL_ROUTER_RELATIVE_DIR = path.join("nemoclaw-blueprint", "router", "llm-router");
const MODEL_ROUTER_VENV_DIR = path.join(os.homedir(), ".nemoclaw", "model-router-venv");
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
      stdio: "ignore";
      cwd: string;
      env: Record<string, string>;
    },
  ) => ModelRouterSpawnedProcess;
  resolveProviderCredential: (name: string) => string | null;
  buildSubprocessEnv: (extra: Record<string, string>) => Record<string, string>;
  isRouterHealthy: (port: number) => Promise<boolean>;
  sleep: (milliseconds: number) => Promise<void>;
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
    resolveProviderCredential,
    buildSubprocessEnv,
    isRouterHealthy,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
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
  const stateDir = path.join(deps.homeDir, ".nemoclaw", "state");
  const litellmConfigPath = path.join(stateDir, "litellm-proxy.yaml");

  deps.mkdirSync(stateDir);

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
  const openAiCredential = deps.resolveProviderCredential("OPENAI_API_KEY");
  if (routedCredential) {
    credEnvVars[credName] = routedCredential;
    if (!openAiCredential) credEnvVars.OPENAI_API_KEY = routedCredential;
  }
  if (openAiCredential) credEnvVars.OPENAI_API_KEY = openAiCredential;
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

  const child = deps.spawnProxy(
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
      stdio: "ignore",
      cwd: blueprintDir,
      env: deps.buildSubprocessEnv(credEnvVars),
    },
  );
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

  for (let attempt = 0; attempt < ROUTER_HEALTH_RETRIES; attempt++) {
    await deps.sleep(ROUTER_HEALTH_INTERVAL_MS);
    if (childExited) break;
    const healthy = await deps.isRouterHealthy(port);
    const processAlive = deps.isProcessAlive(pid);
    if (healthy && processAlive) return pid;
    if (!processAlive) {
      childExited = true;
      if (!childExitDetail) childExitDetail = "child process is no longer running";
      break;
    }
  }
  try {
    deps.terminateProcess(pid);
  } catch {
    // already dead
  }
  throw new Error(
    `Model router failed to become healthy on port ${port} after ${ROUTER_HEALTH_RETRIES} attempts` +
      (childExitDetail ? ` (${childExitDetail})` : ""),
  );
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
