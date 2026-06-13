// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
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
import {
  doesModelRouterProcessOwnPort,
  findModelRouterPidForPort,
  isRouterHealthy,
  stopModelRouterProcess,
} from "./model-router-process";
import { prepareModelRouterVenv } from "./model-router-python";

const ROUTER_HEALTH_RETRIES = 15;
const ROUTER_HEALTH_INTERVAL_MS = 2000;
const MODEL_ROUTER_RELATIVE_DIR = path.join("nemoclaw-blueprint", "router", "llm-router");
const MODEL_ROUTER_VENV_DIR = path.join(os.homedir(), ".nemoclaw", "model-router-venv");
const MODEL_ROUTER_FINGERPRINT_FILE = ".nemoclaw-source-fingerprint";
const MODEL_ROUTER_FINGERPRINT_IGNORED_NAMES = new Set([
  ".git",
  ".hg",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".svn",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
  "venv",
]);
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

function resolveHostCommandPath(commandName: string): string | null {
  const result = runCapture(["sh", "-c", 'command -v "$1"', "--", commandName], {
    ignoreError: true,
  }).trim();
  return result || null;
}

function modelRouterPackageDir(): string {
  return path.join(ROOT, MODEL_ROUTER_RELATIVE_DIR);
}

function modelRouterVenvDir(): string {
  return process.env.NEMOCLAW_MODEL_ROUTER_VENV || MODEL_ROUTER_VENV_DIR;
}

function modelRouterCommandPath(venvDir = modelRouterVenvDir()): string {
  return path.join(venvDir, "bin", "model-router");
}

function modelRouterFingerprintPath(venvDir = modelRouterVenvDir()): string {
  return path.join(venvDir, MODEL_ROUTER_FINGERPRINT_FILE);
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isModelRouterPackageReady(routerDir = modelRouterPackageDir()): boolean {
  return (
    fs.existsSync(path.join(routerDir, "pyproject.toml")) ||
    fs.existsSync(path.join(routerDir, "setup.py"))
  );
}

function shouldSkipModelRouterFingerprintEntry(name: string): boolean {
  return MODEL_ROUTER_FINGERPRINT_IGNORED_NAMES.has(name) || name.endsWith(".egg-info");
}

function hashModelRouterSourceTree(routerDir = modelRouterPackageDir()): string | null {
  const sourceHash = crypto.createHash("sha256");

  const hashDirectory = (currentDir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(currentDir, { withFileTypes: true })
        .sort((left: fs.Dirent, right: fs.Dirent) => left.name.localeCompare(right.name));
    } catch {
      return false;
    }

    let hashedSourceFile = false;
    for (const entry of entries) {
      if (shouldSkipModelRouterFingerprintEntry(entry.name)) continue;
      if (entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) continue;

      const entryPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(routerDir, entryPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        hashedSourceFile = hashDirectory(entryPath) || hashedSourceFile;
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          sourceHash.update(`link:${relativePath}\0`);
          sourceHash.update(fs.readlinkSync(entryPath));
          sourceHash.update("\0");
          hashedSourceFile = true;
        } catch {
          // Ignore unreadable links; the install step will fail if they are required.
        }
        continue;
      }
      if (!entry.isFile()) continue;
      sourceHash.update(`file:${relativePath}\0`);
      sourceHash.update(fs.readFileSync(entryPath));
      sourceHash.update("\0");
      hashedSourceFile = true;
    }
    return hashedSourceFile;
  };

  return hashDirectory(routerDir) ? `files:${sourceHash.digest("hex")}` : null;
}

function getModelRouterSourceFingerprint(routerDir = modelRouterPackageDir()): string | null {
  const gitHead = runCapture(["git", "-C", routerDir, "rev-parse", "HEAD"], {
    ignoreError: true,
  }).trim();
  if (/^[0-9a-f]{40}$/i.test(gitHead)) return `git:${gitHead}`;

  const gitLink = runCapture(
    ["git", "-C", ROOT, "rev-parse", `HEAD:${MODEL_ROUTER_RELATIVE_DIR}`],
    {
      ignoreError: true,
    },
  ).trim();
  if (/^[0-9a-f]{40}$/i.test(gitLink)) return `gitlink:${gitLink}`;

  return hashModelRouterSourceTree(routerDir);
}

function readModelRouterInstalledFingerprint(venvDir = modelRouterVenvDir()): string | null {
  try {
    const fingerprint = fs.readFileSync(modelRouterFingerprintPath(venvDir), "utf8").trim();
    return fingerprint || null;
  } catch {
    return null;
  }
}

function writeModelRouterInstalledFingerprint(
  fingerprint: string | null,
  venvDir = modelRouterVenvDir(),
): void {
  if (!fingerprint) return;
  fs.writeFileSync(modelRouterFingerprintPath(venvDir), `${fingerprint}\n`, { mode: 0o600 });
}

export function isManagedModelRouterCurrent(
  routerDir = modelRouterPackageDir(),
  venvDir = modelRouterVenvDir(),
): boolean {
  if (!isExecutableFile(modelRouterCommandPath(venvDir))) return false;
  const sourceFingerprint = getModelRouterSourceFingerprint(routerDir);
  if (sourceFingerprint) {
    return readModelRouterInstalledFingerprint(venvDir) === sourceFingerprint;
  }
  // When source fingerprint is unavailable (no git), accept an existing
  // install-prefixed fingerprint to avoid reinstalling on every onboard.
  const installed = readModelRouterInstalledFingerprint(venvDir);
  return installed !== null && installed.startsWith("install:");
}

function initializeModelRouterSubmodule(routerDir = modelRouterPackageDir()): void {
  if (isModelRouterPackageReady(routerDir)) return;
  if (!fs.existsSync(path.join(ROOT, ".gitmodules")) || !fs.existsSync(path.join(ROOT, ".git"))) {
    return;
  }
  console.log("  Initializing Model Router source...");
  run(
    ["git", "-C", ROOT, "submodule", "update", "--init", "--depth", "1", MODEL_ROUTER_RELATIVE_DIR],
    {
      ignoreError: true,
    },
  );
}

function installModelRouterCommand(routerDir = modelRouterPackageDir()): string {
  initializeModelRouterSubmodule(routerDir);
  if (!isModelRouterPackageReady(routerDir)) {
    throw new Error(
      `Model Router source is not initialized at ${routerDir}. ` +
        `Run: git -C ${ROOT} submodule update --init --depth 1 ${MODEL_ROUTER_RELATIVE_DIR}`,
    );
  }

  const venvDir = modelRouterVenvDir();
  const routerCommand = modelRouterCommandPath(venvDir);
  const sourceFingerprint = getModelRouterSourceFingerprint(routerDir);
  const allowReplaceExistingVenv =
    path.resolve(venvDir) === path.resolve(MODEL_ROUTER_VENV_DIR) ||
    readModelRouterInstalledFingerprint(venvDir) !== null;
  const venvPython = prepareModelRouterVenv({
    venvDir,
    allowReplaceExisting: allowReplaceExistingVenv,
  });

  const installResult = run(
    [venvPython, "-m", "pip", "install", "--quiet", "--upgrade", `${routerDir}[prefill,proxy]`],
    {
      ignoreError: true,
      timeout: 600_000,
    },
  );
  if (installResult.status !== 0) {
    throw new Error("Failed to install Model Router dependencies.");
  }
  if (!isExecutableFile(routerCommand)) {
    throw new Error("Model Router install did not produce the model-router command.");
  }
  const version =
    JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version ?? "unknown";
  const effectiveFingerprint = sourceFingerprint ?? `install:${version}`;
  writeModelRouterInstalledFingerprint(effectiveFingerprint, venvDir);
  return routerCommand;
}

function ensureModelRouterCommand(): string {
  const routerDir = modelRouterPackageDir();
  const venvDir = modelRouterVenvDir();
  const managedCommand = modelRouterCommandPath(venvDir);

  if (isModelRouterPackageReady(routerDir) && isManagedModelRouterCurrent(routerDir, venvDir)) {
    return managedCommand;
  }

  if (!isModelRouterPackageReady(routerDir)) {
    initializeModelRouterSubmodule(routerDir);
  }

  if (isModelRouterPackageReady(routerDir)) {
    if (isManagedModelRouterCurrent(routerDir, venvDir)) return managedCommand;
    return installModelRouterCommand(routerDir);
  }

  if (isExecutableFile(managedCommand)) return managedCommand;
  return resolveHostCommandPath("model-router") || installModelRouterCommand();
}

/**
 * Start the model-router proxy and wait for it to become healthy.
 * Follows the same pattern as Ollama startup (spawn detached, poll health).
 * Returns the PID of the child process.
 */
async function startModelRouter(routerCfg: BlueprintRouterConfig): Promise<number> {
  const routerCommand = ensureModelRouterCommand();
  const port = routerCfg.port || 4000;
  const blueprintDir = path.join(ROOT, "nemoclaw-blueprint");
  const poolConfigPath = path.join(
    blueprintDir,
    routerCfg.pool_config_path || "router/pool-config.yaml",
  );
  const stateDir = path.join(os.homedir(), ".nemoclaw", "state");
  const litellmConfigPath = path.join(stateDir, "litellm-proxy.yaml");

  fs.mkdirSync(stateDir, { recursive: true });

  const proxyConfigResult = spawnSync(
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
  const routedCredential = resolveProviderCredential(credName);
  const openAiCredential = resolveProviderCredential("OPENAI_API_KEY");
  if (routedCredential) {
    credEnvVars[credName] = routedCredential;
    if (!openAiCredential) credEnvVars.OPENAI_API_KEY = routedCredential;
  }
  if (openAiCredential) credEnvVars.OPENAI_API_KEY = openAiCredential;
  const _providerKey = (process.env.NEMOCLAW_PROVIDER_KEY || "").trim();
  if (_providerKey) {
    if (!credEnvVars[credName]) credEnvVars[credName] = _providerKey;
    if (!credEnvVars.OPENAI_API_KEY) credEnvVars.OPENAI_API_KEY = _providerKey;
  }

  if (await isRouterHealthy(port)) {
    throw new Error(
      `Port ${port} already has a healthy router endpoint; refusing to start a second router.`,
    );
  }

  const child = spawn(
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
      env: buildSubprocessEnv(credEnvVars),
    },
  );
  let childExited = false;
  let childExitDetail = "";
  child.once("error", (err: Error) => {
    childExited = true;
    childExitDetail = `child failed to start: ${err.message}`;
  });
  child.once("exit", (code: number | null, signal: string | null) => {
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
    await new Promise((resolve) => setTimeout(resolve, ROUTER_HEALTH_INTERVAL_MS));
    if (childExited) break;
    const healthy = await isRouterHealthy(port);
    let processAlive = true;
    try {
      process.kill(pid, 0);
    } catch {
      processAlive = false;
    }
    if (healthy && processAlive) return pid;
    if (!processAlive) {
      childExited = true;
      if (!childExitDetail) childExitDetail = "child process is no longer running";
      break;
    }
  }
  try {
    process.kill(pid, "SIGTERM");
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
