// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Interactive onboarding wizard — 8 steps from zero to running sandbox.
// Supports non-interactive mode via --non-interactive flag or
// NEMOCLAW_NON_INTERACTIVE=1 env var for CI/CD pipelines.

const {
  envInt,
  LOCAL_INFERENCE_TIMEOUT_SECS,
  SANDBOX_READY_TIMEOUT_SECS,
}: typeof import("./onboard/env") = require("./onboard/env");
const {
  agentProductName,
  cliDisplayName,
  cliName,
  setOnboardBrandingAgent,
}: typeof import("./onboard/branding") = require("./onboard/branding");
const {
  cleanupTempDir,
  secureTempFile,
}: typeof import("./onboard/temp-files") = require("./onboard/temp-files");
const {
  buildCompatibleEndpointSandboxSmokeCommand,
  buildCompatibleEndpointSandboxSmokeScript,
  shouldRunCompatibleEndpointSandboxSmoke,
  spawnOutputToString,
}: typeof import("./onboard/compatible-endpoint-smoke") = require("./onboard/compatible-endpoint-smoke");
const {
  buildDirectGpuPolicyYaml,
  buildDirectSandboxGpuProofCommands,
  prepareInitialSandboxCreatePolicy,
}: typeof import("./onboard/initial-policy") = require("./onboard/initial-policy");
const crypto = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const pRetry = require("p-retry");

/** Strip ANSI escape sequences before printing process output to the terminal.
 *  Covers CSI (color, erase, cursor), OSC, and C1 two-byte escapes per ECMA-48. */
const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;
const runner: typeof import("./runner") = require("./runner");
const { ROOT, SCRIPTS, redact, run, runShell, runCapture, runFile, shellQuote, validateName } =
  runner;
const nameValidation: typeof import("./name-validation") = require("./name-validation");
const { NAME_ALLOWED_FORMAT, getNameValidationGuidance } = nameValidation;
const docker: typeof import("./adapters/docker") = require("./adapters/docker");
const {
  dockerContainerInspectFormat,
  dockerExecArgv,
  dockerImageInspect,
  dockerInfo,
  dockerInfoFormat,
  dockerInspect,
  dockerRemoveVolumesByPrefix,
  dockerRm,
  dockerRmi,
  dockerStop,
} = docker;
const sandboxBaseImage: typeof import("./sandbox-base-image") = require("./sandbox-base-image");
const {
  OPENCLAW_SANDBOX_BASE_IMAGE: SANDBOX_BASE_IMAGE,
  SANDBOX_BASE_TAG,
  defaultOpenclawBaseDockerfile,
  buildLocalBaseTag,
  resolveSandboxBaseImage,
} = sandboxBaseImage;
const errnoUtils: typeof import("./core/errno") = require("./core/errno");
const { isErrnoException } = errnoUtils;

type RunnerOptions = {
  env?: NodeJS.ProcessEnv;
  stdio?: import("node:child_process").StdioOptions;
  ignoreError?: boolean;
  suppressOutput?: boolean;
  timeout?: number;
  openshellBinary?: string;
};

function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}
const {
  collectBuildContextStats,
  stageOptimizedSandboxBuildContext,
} = require("./sandbox/build-context");
const { buildSubprocessEnv } = require("./subprocess-env");
const {
  DASHBOARD_PORT,
  GATEWAY_PORT,
  VLLM_PORT,
  OLLAMA_PORT,
  OLLAMA_PROXY_PORT,
  DASHBOARD_PORT_RANGE_START,
  DASHBOARD_PORT_RANGE_END,
} = require("./core/ports");
const localInference: typeof import("./inference/local") = require("./inference/local");
const {
  findReachableOllamaHost,
  resetOllamaHostCache,
  getDefaultOllamaModel,
  getBootstrapOllamaModelOptions,
  getLocalProviderBaseUrl,
  getLocalProviderHealthCheck,
  getLocalProviderValidationBaseUrl,
  getOllamaModelOptions,
  getOllamaWarmupCommand,
  getResolvedOllamaHost,
  OLLAMA_HOST_DOCKER_INTERNAL,
  validateOllamaPortConfiguration,
  validateOllamaModel,
  validateLocalProvider,
} = localInference;
const {
  ensureOllamaAuthProxy,
  getOllamaProxyToken,
  isProxyHealthy,
  killStaleProxy,
  persistProxyToken,
  startOllamaAuthProxy,
} = require("./inference/ollama/proxy");
const {
  installOllamaOnWindowsHost,
  awaitWindowsOllamaReady,
  setupWindowsOllamaWith0000Binding,
  switchToWindowsOllamaHost,
  printWindowsOllamaTimeoutDiagnostics,
} = require("./inference/ollama/windows");
const { detectVllmProfile, installVllm } = require("./inference/vllm");
const inferenceConfig: typeof import("./inference/config") = require("./inference/config");
const {
  DEFAULT_CLOUD_MODEL,
  INFERENCE_ROUTE_URL,
  MANAGED_PROVIDER_ID,
  getProviderSelectionConfig,
  parseGatewayInference,
} = inferenceConfig;

const onboardProviders = require("./onboard/providers");
const hermesProviderAuth = require("./hermes-provider-auth");

const CUSTOM_BUILD_CONTEXT_WARN_BYTES = 100_000_000;
const CUSTOM_BUILD_CONTEXT_IGNORES = new Set([
  "node_modules",
  ".git",
  ".venv",
  "__pycache__",
  ".aws",
  ".credentials",
  ".direnv",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".ssh",
  "credentials.json",
  "key.json",
  "secrets",
  "secrets.json",
  "secrets.yaml",
  "token.json",
]);

function isIgnoredCustomBuildContextName(name: string): boolean {
  const lowerName = name.toLowerCase();
  return (
    CUSTOM_BUILD_CONTEXT_IGNORES.has(lowerName) ||
    lowerName === ".env" ||
    lowerName === ".envrc" ||
    lowerName.startsWith(".env.") ||
    lowerName.endsWith(".key") ||
    lowerName.endsWith(".pem") ||
    lowerName.endsWith(".pfx") ||
    lowerName.endsWith(".p12") ||
    lowerName.endsWith(".jks") ||
    lowerName.endsWith(".keystore") ||
    lowerName.endsWith(".tfvars") ||
    lowerName.endsWith("_ecdsa") ||
    lowerName.endsWith("_ed25519") ||
    lowerName.endsWith("_rsa") ||
    (lowerName.startsWith("service-account") && lowerName.endsWith(".json"))
  );
}

function shouldIncludeCustomBuildContextPath(src: string): boolean {
  return !isIgnoredCustomBuildContextName(path.basename(src));
}

function isInsideIgnoredCustomBuildContextPath(src: string): boolean {
  return path
    .normalize(src)
    .split(path.sep)
    .filter(Boolean)
    .some((part: string) => isIgnoredCustomBuildContextName(part));
}

type RemoteProviderConfigEntry = {
  label: string;
  providerName: string;
  providerType: string;
  credentialEnv: string;
  endpointUrl: string;
  helpUrl: string | null;
  modelMode: "catalog" | "curated" | "input";
  defaultModel: string;
  skipVerify?: boolean;
};

const {
  BUILD_ENDPOINT_URL,
  OPENAI_ENDPOINT_URL,
  ANTHROPIC_ENDPOINT_URL,
  GEMINI_ENDPOINT_URL,
  REMOTE_PROVIDER_CONFIG,
  LOCAL_INFERENCE_PROVIDERS,
  OLLAMA_PROXY_CREDENTIAL_ENV,
  VLLM_LOCAL_CREDENTIAL_ENV,
  DISCORD_SNOWFLAKE_RE,
  getProviderLabel,
  getEffectiveProviderName,
  getNonInteractiveProvider,
  getNonInteractiveModel,
  getSandboxInferenceConfig,
} = onboardProviders as {
  BUILD_ENDPOINT_URL: string;
  OPENAI_ENDPOINT_URL: string;
  ANTHROPIC_ENDPOINT_URL: string;
  GEMINI_ENDPOINT_URL: string;
  REMOTE_PROVIDER_CONFIG: Record<string, RemoteProviderConfigEntry>;
  LOCAL_INFERENCE_PROVIDERS: string[];
  OLLAMA_PROXY_CREDENTIAL_ENV: string;
  VLLM_LOCAL_CREDENTIAL_ENV: string;
  DISCORD_SNOWFLAKE_RE: RegExp;
  getProviderLabel: (key: string) => string;
  getEffectiveProviderName: (key: string | null | undefined) => string | null;
  getNonInteractiveProvider: () => string | null;
  getNonInteractiveModel: (providerKey: string) => string | null;
  getSandboxInferenceConfig: (
    model: string,
    provider?: string | null,
    preferredInferenceApi?: string | null,
  ) => {
    providerKey: string;
    primaryModelRef: string;
    inferenceBaseUrl: string;
    inferenceApi: string;
    inferenceCompat: LooseObject | null;
  };
};
const { sleepSeconds } = require("./core/wait");
const platformUtils: typeof import("./platform") = require("./platform");
const { inferContainerRuntime, isWsl, shouldPatchCoredns } = platformUtils;
const { resolveOpenshell } = require("./adapters/openshell/resolve");
const credentials: typeof import("./credentials/store") = require("./credentials/store");
const {
  prompt,
  ensureApiKey,
  getCredential,
  stageLegacyCredentialsToEnv,
  removeLegacyCredentialsFile,
  normalizeCredentialValue,
  resolveProviderCredential,
  saveCredential,
} = credentials;
const { hashCredential }: typeof import("./security/credential-hash") = require("./security/credential-hash");
const {
  cleanupStaleHostFiles,
}: typeof import("./host-artifact-cleanup") = require("./host-artifact-cleanup");
const registry: typeof import("./state/registry") = require("./state/registry");
const nim: typeof import("./inference/nim") = require("./inference/nim");
const onboardSession: typeof import("./state/onboard-session") = require("./state/onboard-session");
const policies: typeof import("./policy") = require("./policy");
const shields = require("./shields");
const tiers: typeof import("./policy/tiers") = require("./policy/tiers");
const { ensureUsageNoticeConsent } = require("./onboard/usage-notice");
const {
  getGatewayReuseHealthWaitConfig,
  isGatewayHttpReady,
  waitForGatewayHttpReady,
} = require("./onboard/gateway-http-readiness") as typeof import("./onboard/gateway-http-readiness");
const { isGatewayTcpReady } =
  require("./onboard/gateway-tcp-readiness") as typeof import("./onboard/gateway-tcp-readiness");
const { trackChildExit } =
  require("./onboard/child-exit-tracker") as typeof import("./onboard/child-exit-tracker");
const { reportDockerDriverGatewayStartFailure } =
  require("./onboard/docker-driver-gateway-failure") as typeof import("./onboard/docker-driver-gateway-failure");
const preflightUtils: typeof import("./onboard/preflight") = require("./onboard/preflight");
const clusterImagePatch: typeof import("./cluster-image-patch") = require("./cluster-image-patch");
const {
  assessHost,
  checkPortAvailable,
  ensureSwap,
  getDockerBridgeGatewayIp,
  getMemoryInfo,
  planHostRemediation,
  probeContainerDns,
} = preflightUtils;
const agentOnboard = require("./agent/onboard");
const agentDefs = require("./agent/defs");

const gatewayState: typeof import("./state/gateway") = require("./state/gateway");
const sandboxState: typeof import("./state/sandbox") = require("./state/sandbox");
const validation: typeof import("./validation") = require("./validation");
const urlUtils: typeof import("./core/url-utils") = require("./core/url-utils");
const buildContext = require("./build-context");
const dashboardContract: typeof import("./dashboard/contract") = require("./dashboard/contract");
const httpProbe: typeof import("./adapters/http/probe") = require("./adapters/http/probe");
const modelPrompts: typeof import("./inference/model-prompts") = require("./inference/model-prompts");
const providerModels: typeof import("./inference/provider-models") = require("./inference/provider-models");
const sandboxCreateStream: typeof import("./sandbox/create-stream") = require("./sandbox/create-stream");
const validationRecovery: typeof import("./validation-recovery") = require("./validation-recovery");
const webSearch: typeof import("./inference/web-search") = require("./inference/web-search");

import type { AgentDefinition } from "./agent/defs";
import type { CurlProbeResult } from "./adapters/http/probe";
import type { GatewayReuseState } from "./state/gateway";
import type { GatewayInference, ProviderSelectionConfig } from "./inference/config";
import type { GpuInfo, ValidationResult } from "./inference/local";
import {
  hydrateMessagingChannelConfig,
  type MessagingChannelConfig,
  mergeMessagingChannelConfigs,
  normalizeMessagingChannelConfigValue,
  readMessagingChannelConfigFromEnv,
  sanitizeMessagingChannelConfig,
} from "./messaging-channel-config";
import type { ContainerRuntime } from "./platform";
import type { Session, SessionUpdates } from "./state/onboard-session";
import type {
  ModelCatalogFetchResult,
  ModelValidationResult,
  ProbeResult,
  ValidationFailureLike,
} from "./onboard/types";
import { listChannels } from "./sandbox/channels";
import type { StreamSandboxCreateResult } from "./sandbox/create-stream";
import type { SandboxEntry } from "./state/registry";
import type { BackupResult } from "./state/sandbox";
import type { TierDefinition, TierPreset } from "./policy/tiers";
import type { SandboxCreateFailure, ValidationClassification } from "./validation";
import type { ProbeRecovery } from "./validation-recovery";
import type { WebSearchConfig } from "./inference/web-search";

const EXPERIMENTAL = process.env.NEMOCLAW_EXPERIMENTAL === "1";
const USE_COLOR = !process.env.NO_COLOR && !!process.stdout.isTTY;
const DIM = USE_COLOR ? "\x1b[2m" : "";
const RESET = USE_COLOR ? "\x1b[0m" : "";
let OPENSHELL_BIN: string | null = null;
const GATEWAY_NAME = "nemoclaw";
const GATEWAY_BOOTSTRAP_SECRET_NAMES = [
  "openshell-server-tls",
  "openshell-server-client-ca",
  "openshell-client-tls",
  "openshell-ssh-handshake",
];
const BACK_TO_SELECTION = "__NEMOCLAW_BACK_TO_SELECTION__";
type HermesAuthMethod = "oauth" | "api_key";
const HERMES_AUTH_METHOD_OAUTH: HermesAuthMethod = "oauth";
const HERMES_AUTH_METHOD_API_KEY: HermesAuthMethod = "api_key";
const HERMES_NOUS_API_KEY_CREDENTIAL_ENV =
  hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV || "NOUS_API_KEY";
const HERMES_NOUS_API_KEY_HELP_URL = "https://portal.nousresearch.com/manage-subscription";

/**
 * Probe whether the gateway Docker container is actually running.
 * openshell CLI metadata can be stale after a manual `docker rm`, so this
 * verifies the container is live before trusting a "healthy" reuse state.
 *
 * Returns "running" | "missing" | "unknown".
 * - "running"  — container exists and State.Running is true
 * - "missing"  — container was removed or exists but is stopped (not reusable)
 * - "unknown"  — any other failure (daemon down, timeout, etc.)
 *
 * Callers should only trigger stale-metadata cleanup on "missing", not on
 * "unknown", to avoid destroying a healthy gateway when Docker is temporarily
 * unavailable.  See #2020.
 */
function verifyGatewayContainerRunning() {
  const containerName = `openshell-cluster-${GATEWAY_NAME}`;
  const result = dockerInspect(
    ["--type", "container", "--format", "{{.State.Running}}", containerName],
    { ignoreError: true, suppressOutput: true },
  );
  if (result.status === 0 && String(result.stdout || "").trim() === "true") {
    return "running";
  }
  // Container exists but is stopped (exit 0, Running !== "true")
  if (result.status === 0) {
    return "missing";
  }
  const stderr = (result.stderr || "").toString();
  if (stderr.includes("No such object") || stderr.includes("No such container")) {
    return "missing";
  }
  return "unknown";
}
const OPENCLAW_LAUNCH_AGENT_PLIST = "~/Library/LaunchAgents/ai.openclaw.gateway.plist";

const BRAVE_SEARCH_HELP_URL = "https://brave.com/search/api/";

// Re-export shared JSON types under the names used throughout this module.
// See src/lib/core/json-types.ts for the canonical definitions.
import type {
  JsonObject as LooseObject,
  JsonScalar as LooseScalar,
  JsonValue as LooseValue,
} from "./core/json-types";

type OnboardOptions = {
  nonInteractive?: boolean;
  recreateSandbox?: boolean;
  resume?: boolean;
  fresh?: boolean;
  fromDockerfile?: string | null;
  sandboxName?: string | null;
  sandboxGpu?: "enable" | "disable" | null;
  sandboxGpuDevice?: string | null;
  acceptThirdPartySoftware?: boolean;
  agent?: string | null;
  controlUiPort?: number | null;
  gpu?: boolean;
  noGpu?: boolean;
  autoYes?: boolean;
};
// Non-interactive mode: set by --non-interactive flag or env var.
// When active, all prompts use env var overrides or sensible defaults.
let NON_INTERACTIVE = false;
let RECREATE_SANDBOX = false;
let AUTO_YES = false;
// Set by onboard() before preflight() when --control-ui-port is specified.
// null means "use auto-allocation" (skip dashboard port check in preflight).
let _preflightDashboardPort: number | null = null;

// Read TELEGRAM_REQUIRE_MENTION (set either by the interactive mention prompt
// or by the user's shell) and map it to a boolean, or null when the env var
// is unset / invalid. Used at build time to bake groupPolicy into
// openclaw.json and at resume time to detect drift against the recorded
// session state. See #1737 and the CodeRabbit follow-up on #2417.
function computeTelegramRequireMention(): boolean | null {
  const raw = process.env.TELEGRAM_REQUIRE_MENTION;
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

function isNonInteractive(): boolean {
  return NON_INTERACTIVE || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
}

function isRecreateSandbox(): boolean {
  return RECREATE_SANDBOX || process.env.NEMOCLAW_RECREATE_SANDBOX === "1";
}

function isAutoYes(): boolean {
  return AUTO_YES || process.env.NEMOCLAW_YES === "1";
}

function note(message: string): void {
  console.log(`${DIM}${message}${RESET}`);
}

// Prompt wrapper: returns env var value or default in non-interactive mode,
// otherwise prompts the user interactively.
async function promptOrDefault(
  question: string,
  envVar: string | null,
  defaultValue: string,
): Promise<string> {
  if (isNonInteractive()) {
    const val = envVar ? process.env[envVar] : null;
    const result = val || defaultValue;
    note(`  [non-interactive] ${question.trim()} → ${result}`);
    return result;
  }
  return prompt(question);
}

// Yes/no prompt with a typed default. The `[Y/n]` / `[y/N]` indicator and
// the non-interactive echo letter are both derived from `defaultIsYes`, so
// the case of the indicator and the echoed default cannot drift apart.
// Returns a boolean — callers no longer have to parse reply strings.
// Replies of "y"/"yes" and "n"/"no" win regardless of case; empty and
// unknown input fall back to the default.
async function promptYesNoOrDefault(
  question: string,
  envVar: string | null,
  defaultIsYes: boolean,
): Promise<boolean> {
  const fullQuestion = `${question} ${defaultIsYes ? "[Y/n]" : "[y/N]"}: `;
  const nonInteractive = isNonInteractive();
  const input = nonInteractive ? (envVar ? process.env[envVar] : null) : await prompt(fullQuestion);

  const value = String(input ?? "")
    .trim()
    .toLowerCase();
  let chosen = defaultIsYes;
  if (value === "y" || value === "yes") chosen = true;
  else if (value === "n" || value === "no") chosen = false;

  if (nonInteractive) {
    note(`  [non-interactive] ${fullQuestion.trim()} → ${chosen ? "Y" : "N"}`);
  }
  return chosen;
}

// ── Helpers ──────────────────────────────────────────────────────

// Gateway state functions — delegated to src/lib/state/gateway.ts
const {
  isSandboxReady,
  parseSandboxStatus,
  hasStaleGateway,
  isSelectedGateway,
  isGatewayHealthy,
  getGatewayReuseState,
  shouldSelectNamedGatewayForReuse,
  getSandboxStateFromOutputs,
} = gatewayState;

type GatewayReuseSnapshot = {
  gatewayStatus: string;
  gwInfo: string;
  activeGatewayInfo: string;
  gatewayReuseState: ReturnType<typeof getGatewayReuseState>;
};

function getGatewayReuseSnapshot(): GatewayReuseSnapshot {
  const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
  const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
    ignoreError: true,
  });
  const activeGatewayInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
  return {
    gatewayStatus,
    gwInfo,
    activeGatewayInfo,
    gatewayReuseState: getGatewayReuseState(gatewayStatus, gwInfo, activeGatewayInfo),
  };
}

function selectNamedGatewayForReuseIfNeeded(snapshot: GatewayReuseSnapshot): GatewayReuseSnapshot {
  if (
    !shouldSelectNamedGatewayForReuse(
      snapshot.gatewayStatus,
      snapshot.gwInfo,
      snapshot.activeGatewayInfo,
    )
  ) {
    return snapshot;
  }

  const selectResult = runOpenshell(["gateway", "select", GATEWAY_NAME], {
    ignoreError: true,
    suppressOutput: true,
  });
  if (selectResult.status !== 0) {
    return snapshot;
  }

  const refreshed = getGatewayReuseSnapshot();
  if (refreshed.gatewayReuseState === "healthy") {
    process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
    console.log(`  ✓ Selected existing ${cliDisplayName()} gateway`);
  }
  return refreshed;
}

/**
 * Remove known_hosts lines whose host field contains an openshell-* entry.
 * Preserves blank lines and comments. Returns the cleaned string.
 */
function pruneKnownHostsEntries(contents: string): string {
  return contents
    .split("\n")
    .filter((l) => {
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith("#")) return true;
      const hostField = trimmed.split(/\s+/)[0];
      return !hostField.split(",").some((h) => h.startsWith("openshell-"));
    })
    .join("\n");
}

function getSandboxReuseState(sandboxName: string | null) {
  if (!sandboxName) return "missing";
  const getOutput = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
  const listOutput = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
  return getSandboxStateFromOutputs(sandboxName, getOutput, listOutput);
}

function repairRecordedSandbox(sandboxName: string | null): void {
  if (!sandboxName) return;
  note(`  [resume] Cleaning up recorded sandbox '${sandboxName}' before recreating it.`);
  runOpenshell(["forward", "stop", String(DASHBOARD_PORT)], { ignoreError: true });
  runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
  registry.removeSandbox(sandboxName);
}

const { streamSandboxCreate } = sandboxCreateStream;

/** Spawn `openshell gateway start` and stream its output with progress heartbeats. */
function streamGatewayStart(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number; output: string }> {
  const child = spawn("bash", ["-lc", command], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines: string[] = [];
  let pending = "";
  let settled = false;
  let resolvePromise: (value: { status: number; output: string }) => void;
  let lastPrintedLine = "";
  let currentPhase = "cluster";
  let lastHeartbeatBucket = -1;
  let lastOutputAt = Date.now();
  const startedAt = Date.now();

  function getDisplayWidth(): number {
    return Math.max(60, Number(process.stdout.columns || 100));
  }

  function trimDisplayLine(line: string): string {
    const width = getDisplayWidth();
    const maxLen = Math.max(40, width - 4);
    if (line.length <= maxLen) return line;
    return `${line.slice(0, Math.max(0, maxLen - 3))}...`;
  }

  function printProgressLine(line: string): void {
    const display = trimDisplayLine(line);
    if (display !== lastPrintedLine) {
      console.log(display);
      lastPrintedLine = display;
    }
  }

  function elapsedSeconds(): number {
    return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  }

  function setPhase(nextPhase: string | null): void {
    if (!nextPhase || nextPhase === currentPhase) return;
    currentPhase = nextPhase;
    const phaseLine =
      nextPhase === "install"
        ? "  Installing OpenShell components..."
        : nextPhase === "pod"
          ? "  Starting OpenShell gateway pod..."
          : nextPhase === "health"
            ? "  Waiting for gateway health..."
            : "  Starting gateway cluster...";
    printProgressLine(phaseLine);
  }

  function classifyLine(line: string): string | null {
    if (/ApplyJob|helm-install-openshell|Applying HelmChart/i.test(line)) return "install";
    if (
      /openshell-0|Observed pod startup duration|MountVolume\.MountDevice succeeded/i.test(line)
    ) {
      return "pod";
    }
    if (/Gateway .* ready\.?$/i.test(line)) return "health";
    return null;
  }

  function flushLine(rawLine: string): void {
    const line = rawLine.replace(/\r/g, "").trimEnd();
    if (!line) return;
    lines.push(line);
    lastOutputAt = Date.now();
    const nextPhase = classifyLine(line);
    if (nextPhase) setPhase(nextPhase);
  }

  function onChunk(chunk: Buffer | string): void {
    pending += chunk.toString();
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    parts.forEach(flushLine);
  }

  function finish(result: { status: number; output: string }): void {
    if (settled) return;
    settled = true;
    if (pending) flushLine(pending);
    clearInterval(heartbeatTimer);
    resolvePromise(result);
  }

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  printProgressLine("  Starting gateway cluster...");
  const heartbeatTimer = setInterval(() => {
    if (settled) return;
    const elapsed = elapsedSeconds();
    const bucket = Math.floor(elapsed / 10);
    if (bucket === lastHeartbeatBucket) return;
    if (Date.now() - lastOutputAt < 3000 && elapsed < 10) return;
    const heartbeatLine =
      currentPhase === "install"
        ? `  Still installing OpenShell components... (${elapsed}s elapsed)`
        : currentPhase === "pod"
          ? `  Still starting OpenShell gateway pod... (${elapsed}s elapsed)`
          : currentPhase === "health"
            ? `  Still waiting for gateway health... (${elapsed}s elapsed)`
            : `  Still starting gateway cluster... (${elapsed}s elapsed)`;
    printProgressLine(heartbeatLine);
    lastHeartbeatBucket = bucket;
  }, 5000);
  heartbeatTimer.unref?.();

  // Hard timeout to prevent indefinite hangs if the openshell process
  // never exits (e.g. Docker daemon unresponsive, k3s restart loop). (#1830)
  // On timeout, send SIGTERM and let the `close` event resolve the promise
  // so the child has actually exited before the caller proceeds to retry.
  const GATEWAY_START_TIMEOUT = envInt("NEMOCLAW_GATEWAY_START_TIMEOUT", 600) * 1000;
  let killedByTimeout = false;
  const killTimer = setTimeout(() => {
    killedByTimeout = true;
    lines.push("[NemoClaw] Gateway start timed out — killing process.");
    child.kill("SIGTERM");
    // If SIGTERM is ignored, force-kill after 10s.
    setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, 10_000).unref?.();
  }, GATEWAY_START_TIMEOUT);
  killTimer.unref?.();

  return new Promise<{ status: number; output: string }>((resolve) => {
    resolvePromise = resolve;
    child.on("error", (error: Error) => {
      clearTimeout(killTimer);
      const detail = error?.message || String(error);
      lines.push(detail);
      finish({ status: 1, output: lines.join("\n") });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(killTimer);
      const exitCode = killedByTimeout ? 1 : (code ?? 1);
      finish({ status: exitCode, output: lines.join("\n") });
    });
  });
}

function step(n: number, total: number, msg: string): void {
  console.log("");
  console.log(`  [${n}/${total}] ${msg}`);
  console.log(`  ${"─".repeat(50)}`);
}

function getInstalledOpenshellVersion(versionOutput: string | null = null): string | null {
  const openshellBin = resolveOpenshell();
  if (!versionOutput && !openshellBin) return null;
  const output = String(
    versionOutput ?? runCapture([openshellBin, "-V"], { ignoreError: true }),
  ).trim();
  const match = output.match(/openshell\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
  if (match) return match[1];
  return null;
}

/**
 * Compare two semver-like x.y.z strings. Returns true iff `left >= right`.
 * Non-numeric or missing components are treated as 0.
 */
function versionGte(left = "0.0.0", right = "0.0.0"): boolean {
  const lhs = String(left)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const rhs = String(right)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(lhs.length, rhs.length);
  for (let index = 0; index < length; index += 1) {
    const a = lhs[index] || 0;
    const b = rhs[index] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

/**
 * Read a semver field from nemoclaw-blueprint/blueprint.yaml. Returns null if
 * the blueprint or field is missing or unparseable — callers must treat null
 * as "no constraint configured" so a malformed install does not become a hard
 * onboard blocker. See #1317.
 */
function getBlueprintVersionField(field: string, rootDir = ROOT): string | null {
  try {
    // Lazy require: yaml is already a dependency via the policy helpers but
    // pulling it at module load would slow down `nemoclaw --help` for users
    // who never reach the preflight path.
    const YAML = require("yaml");
    const blueprintPath = path.join(rootDir, "nemoclaw-blueprint", "blueprint.yaml");
    if (!fs.existsSync(blueprintPath)) return null;
    const raw = fs.readFileSync(blueprintPath, "utf8");
    const parsed = YAML.parse(raw);
    const value = parsed && parsed[field];
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(trimmed)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

function getBlueprintMinOpenshellVersion(rootDir = ROOT): string | null {
  return getBlueprintVersionField("min_openshell_version", rootDir);
}

function getBlueprintMaxOpenshellVersion(rootDir = ROOT): string | null {
  return getBlueprintVersionField("max_openshell_version", rootDir);
}

type OpenshellChannel = "stable" | "dev" | "auto";

/**
 * Load a named inference profile and router config from blueprint.yaml.
 * Returns null if the blueprint or profile is missing.
 */
type BlueprintRouterConfig = {
  enabled?: boolean;
  port?: number;
  pool_config_path?: string;
  credential_env?: string;
};

type BlueprintInferenceProfile = {
  provider_name?: string;
  endpoint?: string;
  model: string;
  credential_env?: string;
  credential_default?: string;
  router: BlueprintRouterConfig;
};

function loadBlueprintProfile(
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

const ROUTER_HEALTH_RETRIES = 15;
const ROUTER_HEALTH_INTERVAL_MS = 2000;
const ROUTER_HEALTH_TIMEOUT_MS = 3000;
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
const DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV = "NVIDIA_API_KEY";

async function isRouterHealthy(port: number, timeoutMs = ROUTER_HEALTH_TIMEOUT_MS): Promise<boolean> {
  const http = require("http");
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      resolve(healthy);
    };
    const request = http
      .get(`http://127.0.0.1:${port}/health`, (res: import("node:http").IncomingMessage) => {
        res.resume();
        settle((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300);
      })
      .on("error", () => settle(false));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      settle(false);
    });
  });
}

function isProcessRunning(pid: number | null | undefined): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function stopModelRouterProcess(pid: number, port: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!isProcessRunning(pid) && !(await isRouterHealthy(port, 1000))) return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already stopped
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!isProcessRunning(pid) && !(await isRouterHealthy(port, 1000))) return;
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
  return fs.existsSync(path.join(routerDir, "pyproject.toml")) ||
    fs.existsSync(path.join(routerDir, "setup.py"));
}

function shouldSkipModelRouterFingerprintEntry(name: string): boolean {
  return MODEL_ROUTER_FINGERPRINT_IGNORED_NAMES.has(name) || name.endsWith(".egg-info");
}

function hashModelRouterSourceTree(routerDir = modelRouterPackageDir()): string | null {
  const sourceHash = crypto.createHash("sha256");

  const hashDirectory = (currentDir: string): boolean => {
    let entries: import("fs").Dirent[];
    try {
      entries = fs
        .readdirSync(currentDir, { withFileTypes: true })
        .sort((left: import("fs").Dirent, right: import("fs").Dirent) =>
          left.name.localeCompare(right.name),
        );
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

  const gitLink = runCapture(["git", "-C", ROOT, "rev-parse", `HEAD:${MODEL_ROUTER_RELATIVE_DIR}`], {
    ignoreError: true,
  }).trim();
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

function isManagedModelRouterCurrent(
  routerDir = modelRouterPackageDir(),
  venvDir = modelRouterVenvDir(),
): boolean {
  if (!isExecutableFile(modelRouterCommandPath(venvDir))) return false;
  const sourceFingerprint = getModelRouterSourceFingerprint(routerDir);
  return Boolean(
    sourceFingerprint && readModelRouterInstalledFingerprint(venvDir) === sourceFingerprint,
  );
}

function initializeModelRouterSubmodule(routerDir = modelRouterPackageDir()): void {
  if (isModelRouterPackageReady(routerDir)) return;
  if (!fs.existsSync(path.join(ROOT, ".gitmodules")) || !fs.existsSync(path.join(ROOT, ".git"))) {
    return;
  }
  console.log("  Initializing Model Router source...");
  run(["git", "-C", ROOT, "submodule", "update", "--init", "--depth", "1", MODEL_ROUTER_RELATIVE_DIR], {
    ignoreError: true,
  });
}

function installModelRouterCommand(routerDir = modelRouterPackageDir()): string {
  initializeModelRouterSubmodule(routerDir);
  if (!isModelRouterPackageReady(routerDir)) {
    throw new Error(
      `Model Router source is not initialized at ${routerDir}. ` +
        `Run: git -C ${ROOT} submodule update --init --depth 1 ${MODEL_ROUTER_RELATIVE_DIR}`,
    );
  }

  if (!resolveHostCommandPath("python3")) {
    throw new Error("python3 is required to prepare Model Router.");
  }

  const venvDir = modelRouterVenvDir();
  const venvPython = path.join(venvDir, "bin", "python");
  const routerCommand = modelRouterCommandPath(venvDir);
  const sourceFingerprint = getModelRouterSourceFingerprint(routerDir);

  fs.mkdirSync(path.dirname(venvDir), { recursive: true });
  console.log(`  Preparing Model Router environment: ${venvDir}`);
  const venvResult = run(["python3", "-m", "venv", venvDir], {
    ignoreError: true,
    timeout: 120_000,
  });
  if (venvResult.status !== 0 || !fs.existsSync(venvPython)) {
    throw new Error("Failed to create Model Router virtual environment.");
  }

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
  writeModelRouterInstalledFingerprint(sourceFingerprint, venvDir);
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

  const { buildSubprocessEnv } = require("./subprocess-env");
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
      "--litellm-config", litellmConfigPath,
      "--router-config", poolConfigPath,
      "--host", "0.0.0.0",
      "--port", String(port),
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

function isRoutedInferenceProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  if (provider === "nvidia-router") return true;
  const bp = loadBlueprintProfile("routed");
  return Boolean(bp?.provider_name && provider === bp.provider_name);
}

async function reconcileModelRouter(): Promise<void> {
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
    if (
      routerCredentialHash &&
      recordedCredentialHash === routerCredentialHash &&
      isProcessRunning(recordedPid)
    ) {
      console.log(`  ✓ Model router is already healthy on port ${routerPort}`);
      return;
    }
    if (isProcessRunning(recordedPid)) {
      console.log("  Restarting model router with updated credentials...");
      await stopModelRouterProcess(requireValue(recordedPid, "Expected recorded router PID"), routerPort);
    } else {
      throw new Error(
        `Port ${routerPort} already has a healthy router endpoint, but its credential state is unknown. Stop the existing model-router process and rerun onboarding.`,
      );
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
}

function getOpenshellChannel(env: NodeJS.ProcessEnv = process.env): OpenshellChannel {
  const raw = String(env.NEMOCLAW_OPENSHELL_CHANNEL || "auto")
    .trim()
    .toLowerCase();
  if (raw === "stable" || raw === "dev" || raw === "auto") return raw;
  return "auto";
}

function shouldUseOpenshellDevChannel(
  _platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const channel = getOpenshellChannel(env);
  return channel === "dev";
}

function isOpenshellDevVersion(versionOutput: string | null | undefined): boolean {
  return /\bdev[0-9.]*/i.test(String(versionOutput || ""));
}

function shouldAllowOpenshellAboveBlueprintMax(
  versionOutput: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return shouldUseOpenshellDevChannel(platform, env) && isOpenshellDevVersion(versionOutput);
}

type SandboxGpuMode = "auto" | "1" | "0";
type SandboxGpuFlag = "enable" | "disable" | null;

type SandboxGpuConfig = {
  mode: SandboxGpuMode;
  hostGpuDetected: boolean;
  sandboxGpuEnabled: boolean;
  sandboxGpuDevice: string | null;
  errors: string[];
};

type ResumeSandboxGpuOverrides = {
  flag: SandboxGpuFlag;
  device: string | null;
};

function isNvidiaGpuDetected(gpu: ReturnType<typeof nim.detectGpu>): boolean {
  return Boolean(gpu && gpu.type === "nvidia");
}

function normalizeSandboxGpuMode(value: string | null | undefined): SandboxGpuMode | null {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (raw === "auto") return "auto";
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return "1";
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return "0";
  return null;
}

function resolveSandboxGpuConfig(
  gpu: ReturnType<typeof nim.detectGpu>,
  options: {
    flag?: SandboxGpuFlag;
    device?: string | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): SandboxGpuConfig {
  const env = options.env ?? process.env;
  const errors: string[] = [];
  const envModeRaw = env.NEMOCLAW_SANDBOX_GPU;
  const envMode = normalizeSandboxGpuMode(envModeRaw);
  if (envModeRaw !== undefined && envMode === null) {
    errors.push("NEMOCLAW_SANDBOX_GPU must be one of: auto, 1, 0.");
  }

  let mode: SandboxGpuMode = envMode ?? "auto";
  if (options.flag === "enable") mode = "1";
  if (options.flag === "disable") mode = "0";

  const device = (options.device ?? env.NEMOCLAW_SANDBOX_GPU_DEVICE ?? "").trim() || null;
  if (device && mode === "0") {
    errors.push("NEMOCLAW_SANDBOX_GPU_DEVICE cannot be used when sandbox GPU mode is 0.");
  }
  if (device && options.flag !== "disable" && envMode !== "0") {
    mode = "1";
  }

  const hostGpuDetected = isNvidiaGpuDetected(gpu);
  if (mode === "1" && !hostGpuDetected) {
    errors.push("Sandbox GPU was requested, but no NVIDIA GPU was detected on the host.");
  }

  return {
    mode,
    hostGpuDetected,
    sandboxGpuEnabled: mode === "1" || (mode === "auto" && hostGpuDetected),
    sandboxGpuDevice: device,
    errors,
  };
}

function resolveSandboxGpuFlagFromOptions(
  opts: Pick<OnboardOptions, "sandboxGpu" | "gpu" | "noGpu">,
): SandboxGpuFlag {
  const requestedGpuPassthrough = opts.gpu === true;
  const optedOutGpuPassthrough = opts.noGpu === true;
  const sandboxGpuFlag = opts.sandboxGpu ?? null;
  if (requestedGpuPassthrough && optedOutGpuPassthrough) {
    console.error("  --gpu and --no-gpu cannot both be set.");
    process.exit(1);
  }
  if (
    (requestedGpuPassthrough && sandboxGpuFlag === "disable") ||
    (optedOutGpuPassthrough && sandboxGpuFlag === "enable")
  ) {
    console.error("  --gpu/--no-gpu conflict with the sandbox GPU flags.");
    process.exit(1);
  }
  if (sandboxGpuFlag) return sandboxGpuFlag;
  if (requestedGpuPassthrough) return "enable";
  if (optedOutGpuPassthrough) return "disable";
  return null;
}

function getResumeSandboxGpuOverrides(
  entry: Pick<SandboxEntry, "sandboxGpuMode" | "sandboxGpuDevice"> | null | undefined,
  sessionGpuPassthrough: boolean | undefined,
): ResumeSandboxGpuOverrides {
  const recordedMode = normalizeSandboxGpuMode(entry?.sandboxGpuMode);
  if (recordedMode === "1") {
    return { flag: "enable", device: entry?.sandboxGpuDevice || null };
  }
  if (recordedMode === "0") {
    return { flag: "disable", device: null };
  }
  if (recordedMode === "auto") {
    return { flag: null, device: null };
  }
  if (sessionGpuPassthrough === true) {
    return { flag: "enable", device: entry?.sandboxGpuDevice || null };
  }
  return { flag: null, device: null };
}

function buildSandboxGpuCreateArgs(config: SandboxGpuConfig): string[] {
  if (!config.sandboxGpuEnabled) return [];
  const args = ["--gpu"];
  if (config.sandboxGpuDevice) {
    args.push("--gpu-device", config.sandboxGpuDevice);
  }
  return args;
}

function parseDockerCdiSpecDirs(value: string | null | undefined): string[] {
  const raw = String(value || "").trim();
  if (!raw || raw === "<no value>") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
  } catch {
    return raw
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
}

function getDockerCdiSpecDirs(): string[] {
  return parseDockerCdiSpecDirs(
    dockerInfoFormat("{{json .CDISpecDirs}}", { ignoreError: true }),
  );
}

function isLikelyNvidiaCdiSpecFile(filePath: string): boolean {
  if (!/\.(json|ya?ml)$/i.test(filePath)) return false;
  let stat: import("fs").Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }
  return /nvidia\.com\/gpu|nvidia-container|libcuda|cuda/i.test(content);
}

function findReadableNvidiaCdiSpecFiles(dirs: string[]): string[] {
  const specs: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry);
      if (isLikelyNvidiaCdiSpecFile(candidate)) specs.push(candidate);
    }
  }
  return specs.sort();
}

function sandboxGpuRemediationLines(): string[] {
  return [
    "Install/configure NVIDIA Container Toolkit CDI, then restart Docker:",
    "  sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml",
    "  sudo systemctl restart docker",
    "Or force CPU sandbox behavior with NEMOCLAW_SANDBOX_GPU=0.",
  ];
}

function validateSandboxGpuPreflight(config: SandboxGpuConfig): void {
  if (config.errors.length > 0) {
    console.error("");
    for (const error of config.errors) console.error(`  ✗ ${error}`);
    process.exit(1);
  }
  if (!config.sandboxGpuEnabled) return;
  if (!isLinuxDockerDriverGatewayPlatform()) return;

  const cdiSpecDirs = getDockerCdiSpecDirs();
  const cdiSpecFiles = findReadableNvidiaCdiSpecFiles(cdiSpecDirs);
  if (cdiSpecFiles.length === 0) {
    console.error("");
    console.error("  ✗ Docker CDI GPU support was not detected.");
    for (const line of sandboxGpuRemediationLines()) {
      console.error(`    ${line}`);
    }
    process.exit(1);
  }
  console.log(`  ✓ Docker CDI GPU support detected (${cdiSpecFiles.join(", ")})`);
}

// ── Base image resolution ───────────────────────────────────────
// Pulls candidate sandbox-base images from GHCR and inspects them to get the
// actual repo digest when available. This avoids the registry mismatch that
// broke e2e tests in #1937 while still allowing PR branches to use a source-SHA
// base image or local build before latest has been rebuilt. See #1904.

/**
 * Resolve a compatible sandbox-base image and pin it to a repo digest when
 * possible. PR-branch validation first tries a source-SHA tag, then latest,
 * and finally a local Dockerfile.base build when the OpenShell Docker driver
 * requires a newer glibc than the published image provides.
 */
function pullAndResolveBaseImageDigest(
  options: { requireOpenshellSandboxAbi?: boolean } = {},
): { digest: string | null; ref: string; source?: string; glibcVersion?: string | null } | null {
  return resolveSandboxBaseImage({
    imageName: SANDBOX_BASE_IMAGE,
    dockerfilePath: defaultOpenclawBaseDockerfile(ROOT),
    localTag: buildLocalBaseTag("nemoclaw-sandbox-base-local", ROOT),
    envVar: "NEMOCLAW_SANDBOX_BASE_IMAGE_REF",
    label: "OpenClaw sandbox base image",
    requireOpenshellSandboxAbi: options.requireOpenshellSandboxAbi === true,
    rootDir: ROOT,
  });
}

function getStableGatewayImageRef(versionOutput: string | null = null): string | null {
  const version = getInstalledOpenshellVersion(versionOutput);
  if (!version) return null;
  return `ghcr.io/nvidia/openshell/cluster:${version}`;
}

function getOpenshellBinary(): string {
  if (OPENSHELL_BIN) return OPENSHELL_BIN;
  const resolved = resolveOpenshell();
  if (typeof resolved !== "string" || resolved.length === 0) {
    console.error("  openshell CLI not found.");
    console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
    process.exit(1);
  }
  OPENSHELL_BIN = resolved;
  return OPENSHELL_BIN;
}

function openshellShellCommand(args: string[], options: { openshellBinary?: string } = {}): string {
  const openshellBinary = options.openshellBinary || getOpenshellBinary();
  return [shellQuote(openshellBinary), ...args.map((arg) => shellQuote(arg))].join(" ");
}

function openshellArgv(args: string[], options: { openshellBinary?: string } = {}): string[] {
  const openshellBinary = options.openshellBinary || getOpenshellBinary();
  return [openshellBinary, ...args];
}

function runOpenshell(args: string[], opts: RunnerOptions & { openshellBinary?: string } = {}) {
  return run(openshellArgv(args, opts), opts);
}

function runCaptureOpenshell(
  args: string[],
  opts: RunnerOptions & { openshellBinary?: string } = {},
) {
  return runCapture(openshellArgv(args, opts), opts);
}

/**
 * Execute a shell command inside a sandbox for post-deployment verification.
 * Returns a structured result with status, stdout, stderr — or null if
 * the sandbox is unreachable. Uses `openshell sandbox exec` with sh -c.
 */
function executeSandboxCommandForVerification(
  sandboxName: string,
  script: string,
): { status: number; stdout: string; stderr: string } | null {
  try {
    const result = spawnSync(
      getOpenshellBinary(),
      ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-c", script],
      { encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.error) return null;
    return {
      status: result.status ?? 1,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  } catch {
    return null;
  }
}

// URL/string utilities — delegated to src/lib/core/url-utils.ts
const {
  compactText,
  normalizeProviderBaseUrl,
  isLoopbackHostname,
  formatEnvAssignment,
  parsePolicyPresetEnv,
} = urlUtils;

/**
 * Resolve a credential into `process.env[envName]` so subsequent gateway
 * upserts can read it via `--credential <ENV>`. Idempotently stages any
 * pre-fix plaintext credentials.json (non-destructively) so callers that
 * reach a credential check from outside the onboard entry point — such as
 * rebuild preflight — can still find legacy values. The file itself is
 * removed only after a full successful onboard, so an interrupted run can
 * be retried without losing the user's only copy.
 *
 * @param envName Credential env variable name, e.g. `NVIDIA_API_KEY`.
 * @returns The resolved value, or `null` if `envName` is empty/unstaged.
 */
function hydrateCredentialEnv(envName: string | null | undefined): string | null {
  if (!envName) return null;
  // Thin wrapper for back-compat. resolveProviderCredential() (introduced
  // by PR #2306 as the canonical entry point) now performs the staging
  // dance internally — env first, then a one-time on-demand legacy stage,
  // then write back into process.env for downstream code.
  return resolveProviderCredential(envName);
}

const {
  getCurlTimingArgs,
  summarizeCurlFailure,
  summarizeProbeFailure,
  runCurlProbe,
  runStreamingEventProbe,
} = httpProbe;

function getNavigationChoice(value = ""): "back" | "exit" | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "back") return "back";
  if (normalized === "exit" || normalized === "quit") return "exit";
  return null;
}

function exitOnboardFromPrompt(): never {
  console.log("  Exiting onboarding.");
  process.exit(1);
}

function normalizeHermesAuthMethod(value: string | null | undefined): HermesAuthMethod | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!normalized) return null;
  if (normalized === "oauth" || normalized === "nous_oauth" || normalized === "nous_portal_oauth") {
    return HERMES_AUTH_METHOD_OAUTH;
  }
  if (
    normalized === "api" ||
    normalized === "key" ||
    normalized === "api_key" ||
    normalized === "apikey" ||
    normalized === "nous_api_key"
  ) {
    return HERMES_AUTH_METHOD_API_KEY;
  }
  return null;
}

function hermesAuthMethodLabel(method: HermesAuthMethod | null | undefined): string {
  return method === HERMES_AUTH_METHOD_API_KEY ? "Nous API Key" : "Nous Portal OAuth";
}

function getRequestedHermesAuthMethod(): HermesAuthMethod | null {
  const raw =
    process.env.NEMOCLAW_HERMES_AUTH_METHOD ||
    process.env.NEMOCLAW_HERMES_AUTH ||
    process.env.NEMOCLAW_NOUS_AUTH_METHOD ||
    "";
  const method = normalizeHermesAuthMethod(raw);
  if (!raw || method) return method;
  console.error(`  Unsupported Hermes Provider auth method: ${raw}`);
  console.error("  Valid values: oauth, nous-portal-oauth, api-key, nous-api-key");
  process.exit(1);
}

async function promptHermesAuthMethod(): Promise<HermesAuthMethod | typeof BACK_TO_SELECTION> {
  const methods: Array<{ key: HermesAuthMethod; label: string }> = [
    { key: HERMES_AUTH_METHOD_OAUTH, label: "Nous Portal OAuth (authenticate via browser)" },
    {
      key: HERMES_AUTH_METHOD_API_KEY,
      label: "Nous API Key (paste a key from the provider dashboard)",
    },
  ];
  const requested = getRequestedHermesAuthMethod();
  if (isNonInteractive()) {
    const method =
      requested ||
      (resolveHermesNousApiKey()
        ? HERMES_AUTH_METHOD_API_KEY
        : HERMES_AUTH_METHOD_OAUTH);
    note(`  [non-interactive] Hermes auth: ${hermesAuthMethodLabel(method)}`);
    return method;
  }

  console.log("");
  console.log("  Hermes Provider authentication:");
  methods.forEach((method, index) => {
    console.log(`    ${index + 1}) ${method.label}`);
  });
  console.log("");

  const defaultIdx = (requested ? methods.findIndex((method) => method.key === requested) : 0) + 1;
  const choice = await prompt(`  Choose [${defaultIdx}]: `);
  const navigation = getNavigationChoice(choice);
  if (navigation === "back") return BACK_TO_SELECTION;
  if (navigation === "exit") exitOnboardFromPrompt();
  const idx = parseInt(choice || String(defaultIdx), 10) - 1;
  return methods[idx]?.key || methods[defaultIdx - 1]?.key || HERMES_AUTH_METHOD_OAUTH;
}

function resolveHermesNousApiKey(): string | null {
  return (
    // check-direct-credential-env-ignore -- Hermes Provider API keys are read only from the invoking shell for OpenShell provider registration; do not resolve host credentials.json.
    normalizeCredentialValue(process.env[HERMES_NOUS_API_KEY_CREDENTIAL_ENV]) ||
    normalizeCredentialValue(process.env.NEMOCLAW_PROVIDER_KEY) ||
    null
  );
}

function stageNousApiKeyProviderEnv(): void {
  const key = resolveHermesNousApiKey();
  if (key) {
    process.env[HERMES_NOUS_API_KEY_CREDENTIAL_ENV] = key;
  }
}

async function ensureHermesNousApiKeyEnv(): Promise<string> {
  const existing = resolveHermesNousApiKey();
  if (existing) {
    process.env[HERMES_NOUS_API_KEY_CREDENTIAL_ENV] = existing;
    return existing;
  }
  console.log("");
  console.log("  Hermes Provider Nous API Key");
  console.log(`  Create or copy a key from ${HERMES_NOUS_API_KEY_HELP_URL}`);
  const key = normalizeCredentialValue(
    await prompt("  Nous API Key: ", {
      secret: true,
    }),
  );
  const validationError = validateNvidiaApiKeyValue(key, HERMES_NOUS_API_KEY_CREDENTIAL_ENV);
  if (validationError) {
    console.error(validationError);
    process.exit(1);
  }
  process.env[HERMES_NOUS_API_KEY_CREDENTIAL_ENV] = key;
  return key;
}

async function selectOnboardAgent({
  agentFlag = null,
  session = null,
}: {
  agentFlag?: string | null;
  session?: { agent?: string | null } | null;
  resume?: boolean;
  canPrompt?: boolean;
} = {}): Promise<AgentDefinition | null> {
  const agent = agentOnboard.resolveAgent({ agentFlag, session });
  if (isNonInteractive()) {
    const displayName = agent?.displayName || agentDefs.loadAgent("openclaw").displayName;
    note(`  [non-interactive] Agent: ${displayName}`);
  }
  return agent;
}

const { getTransportRecoveryMessage, getProbeRecovery } = validationRecovery;

// Validation functions — delegated to src/lib/validation.ts
const {
  classifyValidationFailure,
  classifyApplyFailure,
  classifySandboxCreateFailure,
  validateNvidiaApiKeyValue,
  isSafeModelId,
  isNvcfFunctionNotFoundForAccount,
  nvcfFunctionNotFoundMessage,
  shouldSkipResponsesProbe,
  shouldForceCompletionsApi,
} = validation;

// validateNvidiaApiKeyValue — see validation import above

async function replaceNamedCredential(
  envName: string,
  label: string,
  helpUrl: string | null = null,
  validator: ((value: string) => string | null) | null = null,
): Promise<string> {
  if (helpUrl) {
    console.log("");
    console.log(`  Get your ${label} from: ${helpUrl}`);
    console.log("");
  }

  while (true) {
    const key = normalizeCredentialValue(await prompt(`  ${label}: `, { secret: true }));
    if (!key) {
      console.error(`  ${label} is required.`);
      continue;
    }
    const validationError = typeof validator === "function" ? validator(key) : null;
    if (validationError) {
      console.error(validationError);
      continue;
    }
    saveCredential(envName, key);
    process.env[envName] = key;
    console.log("");
    console.log(`  ${envName} staged. Onboarding will register it with the OpenShell gateway.`);
    console.log("");
    return key;
  }
}

async function promptValidationRecovery(
  label: string,
  recovery: ProbeRecovery,
  credentialEnv: string | null = null,
  helpUrl: string | null = null,
): Promise<"credential" | "selection" | "retry" | "model"> {
  if (isNonInteractive()) {
    process.exit(1);
  }

  if (recovery.kind === "credential" && credentialEnv) {
    console.log(
      `  ${label} authorization failed. Re-enter the API key or choose a different provider/model.`,
    );
    console.log("  ⚠️  Do NOT paste your API key here — use the options below:");
    const choice = (
      await prompt("  Options: retry (re-enter key), back (change provider), exit [retry]: ", {
        secret: true,
      })
    )
      .trim()
      .toLowerCase();
    // Guard against the user accidentally pasting an API key at this prompt.
    // Tokens don't contain spaces; human sentences do — the no-space + length check
    // avoids false-positives on long typed sentences.
    const API_KEY_PREFIXES = ["nvapi-", "ghp_", "gcm-", "sk-", "gpt-", "gemini-", "nvcf-"];
    const looksLikeToken =
      API_KEY_PREFIXES.some((p) => choice.startsWith(p)) ||
      (!choice.includes(" ") && choice.length > 40) ||
      // Regex fallback: base64-safe token pattern (20+ chars, no spaces, mixed alphanum)
      /^[A-Za-z0-9_\-\.]{20,}$/.test(choice);
    // validateNvidiaApiKeyValue is provider-aware: it only enforces the
    // nvapi- prefix when credentialEnv === "NVIDIA_API_KEY", so passing it
    // unconditionally here is safe for Anthropic/OpenAI/Gemini too.
    const validator = (key: string) => validateNvidiaApiKeyValue(key, credentialEnv);
    if (looksLikeToken) {
      console.log("  ⚠️  That looks like an API key — do not paste credentials here.");
      console.log("  Treating as 'retry'. You will be prompted to enter the key securely.");
      await replaceNamedCredential(credentialEnv, `${label} API key`, helpUrl, validator);
      return "credential";
    }
    if (choice === "back") {
      console.log("  Returning to provider selection.");
      console.log("");
      return "selection";
    }
    if (choice === "exit" || choice === "quit") {
      exitOnboardFromPrompt();
    }
    if (choice === "" || choice === "retry") {
      await replaceNamedCredential(credentialEnv, `${label} API key`, helpUrl, validator);
      return "credential";
    }
    console.log("  Please choose a provider/model again.");
    console.log("");
    return "selection";
  }

  if (recovery.kind === "transport") {
    console.log(getTransportRecoveryMessage("failure" in recovery ? recovery.failure || {} : {}));
    const choice = (await prompt("  Type 'retry', 'back', or 'exit' [retry]: "))
      .trim()
      .toLowerCase();
    if (choice === "back") {
      console.log("  Returning to provider selection.");
      console.log("");
      return "selection";
    }
    if (choice === "exit" || choice === "quit") {
      exitOnboardFromPrompt();
    }
    if (choice === "" || choice === "retry") {
      console.log("");
      return "retry";
    }
    console.log("  Please choose a provider/model again.");
    console.log("");
    return "selection";
  }

  if (recovery.kind === "model") {
    console.log(`  Please enter a different ${label} model name.`);
    console.log("");
    return "model";
  }

  console.log("  Please choose a provider/model again.");
  console.log("");
  return "selection";
}

// Provider CRUD — thin wrappers that inject runOpenshell to avoid circular deps.
const { buildProviderArgs } = onboardProviders;

// Snapshot of legacy {env-key → value} pairs that stageLegacyCredentialsToEnv()
// imported from ~/.nemoclaw/credentials.json at the start of this run.
// Captured by the onboard() entry point; consulted by the upsertProvider /
// upsertMessagingProviders wrappers below to decide whether a successful
// gateway upsert actually migrated the *legacy* value (vs. e.g. a vllm/ollama
// branch that upserts a placeholder under the same env-key name).
const stagedLegacyValues: Map<string, string> = new Map<string, string>();

// Env-keys whose successful gateway upsert actually used the staged legacy
// value. Seeded from the persisted onboard session at the start of every
// run so a `--resume` invocation that skips already-completed upserts still
// remembers the migrations the prior attempt committed. The post-onboard
// legacy-file cleanup is gated on `stagedLegacyKeys ⊆ migratedLegacyKeys`
// so picking a local inference provider, disabling a preselected messaging
// channel, or any other path that upserts a different value under the same
// env-key name leaves the file alone instead of stranding the user's only
// copy.
const migratedLegacyKeys: Set<string> = new Set<string>();

// SHA-256 hex digest of `value`. Used to fingerprint migrated legacy
// secrets in the persisted onboard session so a later `--resume` can
// detect when the legacy file value was edited between runs (or another
// session is on disk with stale entries) and refuse to inherit a stale
// "migrated" mark.
function legacyValueHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Mirror the in-memory `migratedLegacyKeys` set into the persisted onboard
// session along with each entry's value hash. `--resume` invocations that
// skip the upsert wrappers entirely use this to inherit migration state
// from the previous attempt — but only when the staged value at restore
// time still hashes to the same digest, so an edit to the legacy file or
// an out-of-band gateway reset cannot satisfy the cleanup gate.
function persistMigratedLegacyKeys(): void {
  try {
    const hashes: Record<string, string> = {};
    for (const key of migratedLegacyKeys) {
      const stagedValue = stagedLegacyValues.get(key);
      if (stagedValue !== undefined) {
        hashes[key] = legacyValueHash(stagedValue);
      }
    }
    onboardSession.updateSession((current: Session) => {
      current.migratedLegacyValueHashes = hashes;
      return current;
    });
  } catch {
    // updateSession can throw if the session file isn't yet writable
    // (e.g. very early in the run before lockless state is established).
    // The cleanup gate in this same process still consults the in-memory
    // set, so a missed write only matters if THIS run later crashes and
    // a future --resume needs the persisted value. Best effort.
  }
}

function upsertProvider(
  name: string,
  type: string,
  credentialEnv: string,
  baseUrl: string | null,
  env: NodeJS.ProcessEnv = {},
) {
  const result = onboardProviders.upsertProvider(
    name,
    type,
    credentialEnv,
    baseUrl,
    env,
    runOpenshell,
  );
  if (result.ok && credentialEnv) {
    const stagedValue = stagedLegacyValues.get(credentialEnv);
    if (stagedValue !== undefined) {
      // openshell receives `--credential <ENV>` and reads the value from the
      // `env` block passed here, falling back to the inherited process.env.
      // Use getCredential() for the env-fallback branch (per the
      // direct credential env guard from PR #2306) — it mirrors
      // openshell's resolution order while the staging contract has
      // already populated the same value into process.env.
      const upsertedValue = env[credentialEnv] ?? getCredential(credentialEnv);
      if (upsertedValue === stagedValue) {
        // The gateway received the staged legacy value verbatim — count
        // this key as migrated.
        migratedLegacyKeys.add(credentialEnv);
      } else {
        // A later upsert under the same env-key wrote a different value
        // (e.g. a retry-loop after validation failure replaced the legacy
        // key with a freshly entered one, or a placeholder like "dummy"
        // for vllm-local). The gateway no longer holds the staged legacy
        // value under this env-key, so withdraw the migration mark — the
        // cleanup gate must keep the legacy file intact.
        migratedLegacyKeys.delete(credentialEnv);
      }
      persistMigratedLegacyKeys();
    }
  }
  return result;
}

type MessagingTokenDef = { name: string; envKey: string; token: string | null };

type EndpointValidationResult =
  | { ok: true; api: string | null; retry?: undefined }
  | { ok: false; retry: "credential" | "selection" | "retry" | "model"; api?: undefined };

type SelectionDrift = {
  changed: boolean;
  providerChanged: boolean;
  modelChanged: boolean;
  existingProvider: string | null;
  existingModel: string | null;
  unknown: boolean;
};

function verifyDirectSandboxGpu(sandboxName: string): void {
  console.log("  Verifying direct sandbox GPU access...");
  for (const proof of buildDirectSandboxGpuProofCommands(sandboxName)) {
    const result = runOpenshell(proof.args, {
      ignoreError: true,
      suppressOutput: true,
      timeout: 30_000,
    });
    if (result.status === 0) {
      console.log(`  ✓ GPU proof passed: ${proof.label}`);
      continue;
    }
    const diagnostic = compactText(redact(`${result.stderr || ""} ${result.stdout || ""}`));
    console.error(`  ✗ GPU proof failed: ${proof.label}`);
    if (diagnostic) console.error(`    ${diagnostic.slice(0, 300)}`);
    for (const line of sandboxGpuRemediationLines()) {
      console.error(`    ${line}`);
    }
    const statusText = String(result.status || 1);
    const diagnosticSuffix = diagnostic ? `: ${diagnostic.slice(0, 300)}` : "";
    throw new Error(`GPU proof failed: ${proof.label} (status ${statusText})${diagnosticSuffix}`);
  }
}

function upsertMessagingProviders(tokenDefs: MessagingTokenDef[]) {
  const upserted = onboardProviders.upsertMessagingProviders(tokenDefs, runOpenshell);
  // upsertMessagingProviders process.exits on failure, so reaching this
  // point means every entry in tokenDefs that had a token was registered.
  // Mark migrated only when the registered token equals the staged legacy
  // value — a token rotated since staging (or a fresh prompt) is not a
  // legacy migration even if it happens to use the same env-key name.
  // Mirror upsertProvider's withdrawal logic so a later messaging upsert
  // that replaces the legacy value with something else cannot leave the
  // mark stuck on.
  let mutated = false;
  for (const def of tokenDefs) {
    if (!def.token || !def.envKey) continue;
    const stagedValue = stagedLegacyValues.get(def.envKey);
    if (stagedValue === undefined) continue;
    if (def.token === stagedValue) {
      migratedLegacyKeys.add(def.envKey);
      mutated = true;
    } else {
      migratedLegacyKeys.delete(def.envKey);
      mutated = true;
    }
  }
  if (mutated) persistMigratedLegacyKeys();
  return upserted;
}
function providerExistsInGateway(name: string) {
  return onboardProviders.providerExistsInGateway(name, runOpenshell);
}

function getMessagingChannelForEnvKey(envKey: string): string | null {
  if (envKey === "DISCORD_BOT_TOKEN") return "discord";
  if (envKey === "SLACK_BOT_TOKEN") return "slack";
  if (envKey === "TELEGRAM_BOT_TOKEN") return "telegram";
  return null;
}

function getKnownMessagingChannels(channels: string[] | null | undefined): string[] {
  if (!Array.isArray(channels)) return [];
  const known = new Set(MESSAGING_CHANNELS.map((channel) => channel.name));
  return [...new Set(channels.filter((channel) => known.has(channel)))];
}

function getRecordedMessagingChannelsForResume(
  resume: boolean,
  session: Session | null,
): string[] | null {
  if (!resume || !isNonInteractive() || !Array.isArray(session?.messagingChannels)) {
    return null;
  }
  return getKnownMessagingChannels(session.messagingChannels);
}

/**
 * Detect whether any messaging provider credential has been rotated since
 * the sandbox was created, by comparing SHA-256 hashes of the current
 * token values against hashes stored in the sandbox registry.
 *
 * Returns `changed: false` for legacy sandboxes that have no stored hashes
 * (conservative — avoids unnecessary rebuilds after upgrade).
 *
 * @param {string} sandboxName - Name of the sandbox to check.
 * @param {Array<{name: string, envKey: string, token: string|null}>} tokenDefs
 * @returns {{ changed: boolean, changedProviders: string[] }}
 */
function detectMessagingCredentialRotation(
  sandboxName: string,
  tokenDefs: MessagingTokenDef[],
): { changed: boolean; changedProviders: string[] } {
  const sb = registry.getSandbox(sandboxName);
  const storedHashes = sb?.providerCredentialHashes || {};
  const changedProviders = [];
  for (const { name, envKey, token } of tokenDefs) {
    if (!token) continue;
    const storedHash = storedHashes[envKey];
    if (!storedHash) continue;
    if (storedHash !== hashCredential(token)) {
      changedProviders.push(name);
    }
  }
  return { changed: changedProviders.length > 0, changedProviders };
}

// Tri-state probe factory for messaging-conflict backfill. An upfront liveness
// check is necessary because `openshell provider get` exits non-zero for both
// "provider not attached" and "gateway unreachable"; without the liveness
// gate, a transient gateway failure would be recorded as "no providers" and
// permanently suppress future backfill retries.
function makeConflictProbe() {
  let gatewayAlive: boolean | null = null;
  const isGatewayAlive = () => {
    if (gatewayAlive === null) {
      const result = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      // runCaptureOpenshell returns stdout/stderr as a single string; treat
      // any non-empty output as a sign openshell answered. Empty output with
      // ignoreError typically means the binary failed to produce anything.
      gatewayAlive = typeof result === "string" && result.length > 0;
    }
    return gatewayAlive;
  };
  return {
    providerExists: (name: string) => {
      if (!isGatewayAlive()) return "error";
      return providerExistsInGateway(name) ? "present" : "absent";
    },
  };
}

function verifyInferenceRoute(_provider: string, _model: string): void {
  const output = runCaptureOpenshell(["inference", "get"], { ignoreError: true });
  if (!output || /Gateway inference:\s*[\r\n]+\s*Not configured/i.test(output)) {
    console.error("  OpenShell inference route was not configured.");
    process.exit(1);
  }
}

function isInferenceRouteReady(provider: string, model: string): boolean {
  const live = parseGatewayInference(
    runCaptureOpenshell(["inference", "get"], { ignoreError: true }),
  );
  return Boolean(live && live.provider === provider && live.model === model);
}

function verifyCompatibleEndpointSandboxSmoke(options: {
  sandboxName: string;
  provider: string;
  model: string;
  endpointUrl?: string | null;
  credentialEnv?: string | null;
  messagingChannels?: string[] | null;
  agent?: AgentDefinition | null;
}): void {
  if (
    !shouldRunCompatibleEndpointSandboxSmoke(
      options.provider,
      options.messagingChannels,
      options.agent,
    )
  ) {
    return;
  }

  console.log("  Verifying compatible endpoint through the messaging sandbox...");

  const providerResult = runOpenshell(["provider", "get", options.provider], {
    ignoreError: true,
    suppressOutput: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const providerDetails = [
    spawnOutputToString(providerResult.stdout),
    spawnOutputToString(providerResult.stderr),
  ]
    .join("\n")
    .trim();

  if (providerResult.status !== 0) {
    console.error(
      `  Compatible endpoint provider '${options.provider}' is missing from the OpenShell gateway.`,
    );
    console.error(
      "  The sandbox would start Telegram, but agent turns would fail before reaching the model.",
    );
    if (providerDetails) console.error(`  ${compactText(redact(providerDetails)).slice(0, 800)}`);
    process.exit(providerResult.status || 1);
  }

  if (
    options.endpointUrl &&
    providerDetails &&
    /OPENAI_BASE_URL|baseUrl|base URL|endpoint/i.test(providerDetails) &&
    !providerDetails.includes(options.endpointUrl)
  ) {
    console.warn(
      `  ⚠ Gateway provider '${options.provider}' did not report the selected endpoint URL.`,
    );
    console.warn("    Continuing to the sandbox-side inference.local smoke check.");
  }
  if (
    options.credentialEnv &&
    providerDetails &&
    /credential|api key|secret/i.test(providerDetails) &&
    !providerDetails.includes(options.credentialEnv)
  ) {
    console.warn(
      `  ⚠ Gateway provider '${options.provider}' did not report ${options.credentialEnv}.`,
    );
  }

  const script = buildCompatibleEndpointSandboxSmokeCommand(options.model);
  const smokeResult = runOpenshell(
    ["sandbox", "exec", "-n", options.sandboxName, "--", "sh", "-lc", script],
    {
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 90_000,
    },
  );
  const smokeOutput = [
    spawnOutputToString(smokeResult.stdout),
    spawnOutputToString(smokeResult.stderr),
  ]
    .join("\n")
    .trim();

  if (smokeResult.status !== 0 || !/INFERENCE_SMOKE_OK/.test(smokeOutput)) {
    console.error("  Compatible endpoint sandbox smoke check failed.");
    console.error("  Telegram provider startup is not the root cause; inference.local failed.");
    if (smokeOutput) console.error(`  ${compactText(redact(smokeOutput)).slice(0, 1200)}`);
    process.exit(smokeResult.status || 1);
  }

  console.log("  ✓ Compatible endpoint responds through inference.local inside the sandbox");
}

function sandboxExistsInGateway(sandboxName: string): boolean {
  const output = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
  return Boolean(output);
}

function pruneStaleSandboxEntry(sandboxName: string): boolean {
  const existing = registry.getSandbox(sandboxName);
  const liveExists = sandboxExistsInGateway(sandboxName);
  if (existing && !liveExists) {
    registry.removeSandbox(sandboxName);
  }
  return liveExists;
}

function findSelectionConfigPath(dir: string): string | null {
  if (!dir || !fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findSelectionConfigPath(fullPath);
      if (found) return found;
      continue;
    }
    if (entry.name === "config.json") {
      return fullPath;
    }
  }
  return null;
}

function readSandboxSelectionConfig(sandboxName: string): ProviderSelectionConfig | null {
  if (!sandboxName) return null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-selection-"));
  try {
    const result = runOpenshell(
      [
        "sandbox",
        "download",
        sandboxName,
        "/sandbox/.nemoclaw/config.json",
        `${tmpDir}${path.sep}`,
      ],
      { ignoreError: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    if (result.status !== 0) return null;
    const configPath = findSelectionConfigPath(tmpDir);
    if (!configPath) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function getSelectionDrift(
  sandboxName: string,
  requestedProvider: string | null,
  requestedModel: string | null,
): SelectionDrift {
  const existing = readSandboxSelectionConfig(sandboxName);
  if (!existing) {
    return {
      changed: true,
      providerChanged: false,
      modelChanged: false,
      existingProvider: null,
      existingModel: null,
      unknown: true,
    };
  }

  const existingProvider = typeof existing.provider === "string" ? existing.provider : null;
  const existingModel = typeof existing.model === "string" ? existing.model : null;
  if (!existingProvider || !existingModel) {
    return {
      changed: true,
      providerChanged: false,
      modelChanged: false,
      existingProvider,
      existingModel,
      unknown: true,
    };
  }

  const providerChanged = Boolean(
    existingProvider && requestedProvider && existingProvider !== requestedProvider,
  );
  const modelChanged = Boolean(existingModel && requestedModel && existingModel !== requestedModel);

  return {
    changed: providerChanged || modelChanged,
    providerChanged,
    modelChanged,
    existingProvider,
    existingModel,
    unknown: false,
  };
}

async function confirmRecreateForSelectionDrift(
  sandboxName: string,
  drift: SelectionDrift,
  requestedProvider: string | null,
  requestedModel: string | null,
): Promise<boolean> {
  const currentProvider = drift.existingProvider || "unknown";
  const currentModel = drift.existingModel || "unknown";
  const nextProvider = requestedProvider || "unknown";
  const nextModel = requestedModel || "unknown";

  console.log(`  Sandbox '${sandboxName}' exists but requested inference selection changed.`);
  console.log(`  Current:   provider=${currentProvider}  model=${currentModel}`);
  console.log(`  Requested: provider=${nextProvider}  model=${nextModel}`);
  console.log(
    `  Recreating the sandbox is required to apply this change to the running ${agentProductName()} UI.`,
  );

  if (isNonInteractive()) {
    note("  [non-interactive] Recreating sandbox due to provider/model drift.");
    return true;
  }

  const answer = await prompt(`  Recreate sandbox '${sandboxName}' now? [y/N]: `);
  return isAffirmativeAnswer(answer);
}

function buildSandboxConfigSyncScript(selectionConfig: ProviderSelectionConfig): string {
  // Do not rewrite openclaw.json at runtime. Model routing is handled by the
  // host-side gateway (`openshell inference set` in Step 5), not from inside
  // the sandbox. We write the NemoClaw selection config and normalize the
  // mutable-default OpenClaw config permissions after the gateway has had a
  // chance to perform its own startup initialization.
  return `
set -euo pipefail
mkdir -p ~/.nemoclaw
cat > ~/.nemoclaw/config.json <<'EOF_NEMOCLAW_CFG'
${JSON.stringify(selectionConfig, null, 2)}
EOF_NEMOCLAW_CFG
config_dir=/sandbox/.openclaw
if [ -d "$config_dir" ]; then
  config_dir_owner="$(stat -c '%U' "$config_dir" 2>/dev/null || echo unknown)"
  if [ "$config_dir_owner" != "root" ]; then
    chmod -R g+rwX,o-rwx "$config_dir" 2>/dev/null || true
    find "$config_dir" -type d -exec chmod g+s {} + 2>/dev/null || true
    chmod 2770 "$config_dir" 2>/dev/null || true
    chmod 660 "$config_dir/openclaw.json" "$config_dir/.config-hash" 2>/dev/null || true
  fi
fi
exit
`.trim();
}

function isOpenclawReady(sandboxName: string): boolean {
  return Boolean(fetchGatewayAuthTokenFromSandbox(sandboxName));
}

function writeSandboxConfigSyncFile(script: string): string {
  const scriptFile = secureTempFile("nemoclaw-sync", ".sh");
  fs.writeFileSync(scriptFile, `${script}\n`, { mode: 0o600 });
  return scriptFile;
}

function encodeDockerJsonArg(value: LooseValue): string {
  return Buffer.from(JSON.stringify(value || {}), "utf8").toString("base64");
}

function isAffirmativeAnswer(value: string | null | undefined): boolean {
  return ["y", "yes"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function validateBraveSearchApiKey(apiKey: string): CurlProbeResult {
  return runCurlProbe([
    "-sS",
    "--compressed",
    "-H",
    "Accept: application/json",
    "-H",
    "Accept-Encoding: gzip",
    "-H",
    `X-Subscription-Token: ${apiKey}`,
    "--get",
    "--data-urlencode",
    "q=ping",
    "--data-urlencode",
    "count=1",
    "https://api.search.brave.com/res/v1/web/search",
  ]);
}

async function promptBraveSearchRecovery(
  validation: ValidationFailureLike,
): Promise<"retry" | "skip"> {
  const recovery = classifyValidationFailure(validation);

  if (recovery.kind === "credential") {
    console.log("  Brave Search rejected that API key.");
  } else if (recovery.kind === "transport") {
    console.log(getTransportRecoveryMessage(validation));
  } else {
    console.log("  Brave Search validation did not succeed.");
  }

  const answer = (await prompt("  Type 'retry', 'skip', or 'exit' [retry]: ")).trim().toLowerCase();
  if (answer === "skip") return "skip";
  if (answer === "exit" || answer === "quit") {
    exitOnboardFromPrompt();
  }
  return "retry";
}

async function promptBraveSearchApiKey(): Promise<string> {
  console.log("");
  console.log(`  Get your Brave Search API key from: ${BRAVE_SEARCH_HELP_URL}`);
  console.log("");

  while (true) {
    const key = normalizeCredentialValue(
      await prompt("  Brave Search API key: ", { secret: true }),
    );
    if (!key) {
      console.error("  Brave Search API key is required.");
      continue;
    }
    return key;
  }
}

async function ensureValidatedBraveSearchCredential(
  nonInteractive = isNonInteractive(),
): Promise<string | null> {
  const savedApiKey = getCredential(webSearch.BRAVE_API_KEY_ENV);
  let apiKey: string | null =
    savedApiKey || normalizeCredentialValue(process.env[webSearch.BRAVE_API_KEY_ENV]);
  let usingSavedKey = Boolean(savedApiKey);

  while (true) {
    if (!apiKey) {
      if (nonInteractive) {
        throw new Error(
          "Brave Search requires BRAVE_API_KEY or a saved Brave Search credential in non-interactive mode.",
        );
      }
      apiKey = await promptBraveSearchApiKey();
      usingSavedKey = false;
    }

    const validation = validateBraveSearchApiKey(apiKey);
    if (validation.ok) {
      saveCredential(webSearch.BRAVE_API_KEY_ENV, apiKey);
      process.env[webSearch.BRAVE_API_KEY_ENV] = apiKey;
      return apiKey;
    }

    const prefix = usingSavedKey
      ? "  Saved Brave Search API key validation failed."
      : "  Brave Search API key validation failed.";
    console.error(prefix);
    if (validation.message) {
      console.error(`  ${validation.message}`);
    }

    if (nonInteractive) {
      throw new Error(
        validation.message || "Brave Search API key validation failed in non-interactive mode.",
      );
    }

    const action = await promptBraveSearchRecovery(validation);
    if (action === "skip") {
      console.log("  Skipping Brave Web Search setup.");
      console.log("");
      return null;
    }

    apiKey = null;
    usingSavedKey = false;
  }
}

/**
 * Check whether the agent's Dockerfile declares ARG NEMOCLAW_WEB_SEARCH_ENABLED.
 * If the ARG is absent, the patchStagedDockerfile replace is a silent no-op and
 * the config generator has no code path to emit a web search block — so offering
 * the Brave prompt would mislead the user.
 *
 * OpenClaw uses the root Dockerfile (not agents/openclaw/Dockerfile), so we
 * fall back to the root Dockerfile when the agent-specific one doesn't exist.
 */
function agentSupportsWebSearch(
  agent: AgentDefinition | null | undefined,
  dockerfilePathOverride: string | null = null,
): boolean {
  // Hermes has native web tools, but the NemoClaw onboarding wizard wires the
  // OpenClaw Brave provider path. Do not offer a Brave prompt for Hermes until
  // that provider is supported end to end.
  if (agent?.name === "hermes") {
    return false;
  }

  const candidates = [
    dockerfilePathOverride,
    agent?.dockerfilePath,
    path.join(ROOT, "Dockerfile"),
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );

  for (const dockerfilePath of candidates) {
    try {
      const content = fs.readFileSync(dockerfilePath, "utf-8");
      return /^\s*ARG\s+NEMOCLAW_WEB_SEARCH_ENABLED=/m.test(content);
    } catch {
      // Try the next candidate; custom Dockerfile paths can disappear between resume runs.
    }
  }
  return false;
}

async function configureWebSearch(
  existingConfig: WebSearchConfig | null = null,
  agent: AgentDefinition | null = null,
  dockerfilePathOverride: string | null = null,
): Promise<WebSearchConfig | null> {
  if (!agentSupportsWebSearch(agent, dockerfilePathOverride)) {
    note(`  Web search is not yet supported by ${agent?.displayName ?? "this agent"}. Skipping.`);
    return null;
  }

  if (existingConfig) {
    return { fetchEnabled: true };
  }

  if (isNonInteractive()) {
    const braveApiKey = normalizeCredentialValue(process.env[webSearch.BRAVE_API_KEY_ENV]);
    if (!braveApiKey) {
      return null;
    }
    note("  [non-interactive] Brave Web Search requested.");
    const validation = validateBraveSearchApiKey(braveApiKey);
    if (!validation.ok) {
      console.warn(
        `  Brave Search API key validation failed. Web search will be disabled — re-enable later via \`${cliName()} config web-search\`.`,
      );
      if (validation.message) {
        console.warn(`  ${validation.message}`);
      }
      return null;
    }
    saveCredential(webSearch.BRAVE_API_KEY_ENV, braveApiKey);
    process.env[webSearch.BRAVE_API_KEY_ENV] = braveApiKey;
    return { fetchEnabled: true };
  }
  const enableAnswer = await prompt("  Enable Brave Web Search? [y/N]: ");
  if (!isAffirmativeAnswer(enableAnswer)) {
    return null;
  }

  const braveApiKey = await ensureValidatedBraveSearchCredential();
  if (!braveApiKey) {
    return null;
  }

  console.log("  ✓ Enabled Brave Web Search");
  console.log("");
  return { fetchEnabled: true };
}

/**
 * Post-creation probe: verify web search is actually functional inside the
 * sandbox. Hermes silently ignores unknown web.backend values, so checking
 * the config file alone is insufficient — we need to ask the runtime.
 *
 * For Hermes: runs `hermes dump` and checks for an active web backend.
 * For OpenClaw: checks that the tools.web.search block is present in the config.
 *
 * This is a best-effort warning — it does not abort onboarding.
 */
function verifyWebSearchInsideSandbox(
  sandboxName: string,
  agent: AgentDefinition | null | undefined,
): void {
  const agentName = agent?.name || "openclaw";
  try {
    if (agentName === "hermes") {
      // `hermes dump` outputs config_overrides and active toolsets.
      // Look for the web backend in its output.
      const dump = runCaptureOpenshell(
        ["sandbox", "exec", "-n", sandboxName, "--", "hermes", "dump"],
        {
          ignoreError: true,
          timeout: 10_000,
        },
      );
      if (!dump) {
        console.warn("  ⚠ Could not verify web search config inside sandbox (hermes dump failed).");
        return;
      }
      // A working web backend shows as an explicit config override or active-toolset entry.
      // Avoid broad /web.*search/ matching so warning text never looks like success.
      const hasWebBackend =
        /^\s*web\.backend:\s*\S+/m.test(dump) ||
        /^\s*active toolsets:\s*.*\bweb\b/im.test(dump) ||
        /^\s*toolsets:\s*.*\bweb\b/im.test(dump);
      if (!hasWebBackend) {
        console.warn(
          "  ⚠ Web search was configured but Hermes does not report an active web backend.",
        );
        console.warn("    The agent may not have accepted the web search configuration.");
        console.warn(`    Check: ${cliName()} ${sandboxName} exec hermes dump`);
      } else {
        console.log("  ✓ Web search is active inside sandbox");
      }
    } else if (agentName === "openclaw") {
      // OpenClaw: verify tools.web.search block exists in the baked config.
      const configCheck = runCaptureOpenshell(
        ["sandbox", "exec", "-n", sandboxName, "--", "cat", "/sandbox/.openclaw/openclaw.json"],
        { ignoreError: true, timeout: 10_000 },
      );
      if (!configCheck) {
        console.warn("  ⚠ Could not verify web search config inside sandbox.");
        return;
      }
      try {
        const parsed = JSON.parse(configCheck);
        if (parsed?.tools?.web?.search?.enabled) {
          console.log("  ✓ Web search is active inside sandbox");
        } else {
          console.warn(
            "  ⚠ Web search was configured but tools.web.search is not enabled in openclaw.json.",
          );
        }
      } catch {
        console.warn("  ⚠ Could not parse openclaw.json to verify web search config.");
      }
    } else {
      console.warn(`  ⚠ Web search verification is not implemented for agent '${agentName}'.`);
    }
  } catch {
    // Best-effort — don't let probe failures derail onboarding.
    console.warn("  ⚠ Web search verification probe failed (non-fatal).");
  }
}

// getSandboxInferenceConfig — moved to onboard-providers.ts

// Shared validators for NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT.
// Both `patchStagedDockerfile()` (build-time Dockerfile ARG override) and
// `createSandbox()` (runtime sandbox env whitelist) must reject the same
// inputs, otherwise the build and runtime paths can diverge — e.g. a
// build-time-accepted value silently no-ops at runtime, leaving the
// container running with the default proxy. Hostname regex deliberately
// excludes `:` so raw IPv6 literals are rejected: the runtime
// `http://${HOST}:${PORT}` template does not bracket them and would
// produce a malformed URL. Port is range-checked because a 5-digit
// length filter alone would accept out-of-range values like 70000.
const PROXY_HOST_RE = /^[A-Za-z0-9._-]+$/;
function isValidProxyHost(value: string): boolean {
  return PROXY_HOST_RE.test(value);
}
function isValidProxyPort(value: string): boolean {
  if (!/^[0-9]{1,5}$/.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65535;
}

function patchStagedDockerfile(
  dockerfilePath: string,
  model: string,
  chatUiUrl: string,
  buildId = String(Date.now()),
  provider: string | null = null,
  preferredInferenceApi: string | null = null,
  webSearchConfig: WebSearchConfig | null = null,
  messagingChannels: string[] = [],
  messagingAllowedIds: LooseObject = {},
  discordGuilds: LooseObject = {},
  baseImageRef: string | null = null,
  telegramConfig: LooseObject = {},
) {
  const { providerKey, primaryModelRef, inferenceBaseUrl, inferenceApi, inferenceCompat } =
    getSandboxInferenceConfig(model, provider, preferredInferenceApi);
  let dockerfile = fs.readFileSync(dockerfilePath, "utf8");
  // Pin the base image to a specific digest when available (#1904).
  // The ref must come from pullAndResolveBaseImageDigest() — never from
  // blueprint.yaml, whose digest belongs to a different registry.
  // Only rewrite when the current value already points at our sandbox-base
  // image — custom --from Dockerfiles may use a different base.
  if (baseImageRef) {
    dockerfile = dockerfile.replace(
      /^ARG BASE_IMAGE=(.*)$/m,
      (line: string, currentValue: string) => {
        const trimmed = String(currentValue).trim();
        if (
          trimmed.startsWith(`${SANDBOX_BASE_IMAGE}:`) ||
          trimmed.startsWith(`${SANDBOX_BASE_IMAGE}@`)
        ) {
          return `ARG BASE_IMAGE=${baseImageRef}`;
        }
        return line;
      },
    );
  }
  dockerfile = dockerfile.replace(/^ARG NEMOCLAW_MODEL=.*$/m, `ARG NEMOCLAW_MODEL=${model}`);
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_PROVIDER_KEY=.*$/m,
    `ARG NEMOCLAW_PROVIDER_KEY=${providerKey}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_PRIMARY_MODEL_REF=.*$/m,
    `ARG NEMOCLAW_PRIMARY_MODEL_REF=${primaryModelRef}`,
  );
  dockerfile = dockerfile.replace(/^ARG CHAT_UI_URL=.*$/m, `ARG CHAT_UI_URL=${chatUiUrl}`);
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_BASE_URL=.*$/m,
    `ARG NEMOCLAW_INFERENCE_BASE_URL=${inferenceBaseUrl}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_API=.*$/m,
    `ARG NEMOCLAW_INFERENCE_API=${inferenceApi}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_COMPAT_B64=.*$/m,
    `ARG NEMOCLAW_INFERENCE_COMPAT_B64=${encodeDockerJsonArg(inferenceCompat)}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_BUILD_ID=.*$/m,
    `ARG NEMOCLAW_BUILD_ID=${buildId}`,
  );
  // Honor NEMOCLAW_CONTEXT_WINDOW / NEMOCLAW_MAX_TOKENS / NEMOCLAW_REASONING
  // so the user can tune model metadata without editing the Dockerfile.
  const POSITIVE_INT_RE = /^[1-9][0-9]*$/;
  const contextWindow = process.env.NEMOCLAW_CONTEXT_WINDOW;
  if (contextWindow && POSITIVE_INT_RE.test(contextWindow)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_CONTEXT_WINDOW=.*$/m,
      `ARG NEMOCLAW_CONTEXT_WINDOW=${contextWindow}`,
    );
  }
  const maxTokens = process.env.NEMOCLAW_MAX_TOKENS;
  if (maxTokens && POSITIVE_INT_RE.test(maxTokens)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_MAX_TOKENS=.*$/m,
      `ARG NEMOCLAW_MAX_TOKENS=${maxTokens}`,
    );
  }
  const reasoning = process.env.NEMOCLAW_REASONING;
  if (reasoning === "true" || reasoning === "false") {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_REASONING=.*$/m,
      `ARG NEMOCLAW_REASONING=${reasoning}`,
    );
  }
  // Honor NEMOCLAW_INFERENCE_INPUTS for vision-capable models. OpenClaw's
  // model schema currently accepts "text" and "image" only, so validate
  // strictly against that vocabulary. Adding modalities to OpenClaw later
  // only requires widening this regex. See #2421.
  const inferenceInputs = process.env.NEMOCLAW_INFERENCE_INPUTS;
  if (inferenceInputs && /^(text|image)(,(text|image))*$/.test(inferenceInputs)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_INFERENCE_INPUTS=.*$/m,
      `ARG NEMOCLAW_INFERENCE_INPUTS=${inferenceInputs}`,
    );
  }
  // NEMOCLAW_AGENT_TIMEOUT — override agents.defaults.timeoutSeconds at build
  // time. Lets users increase the per-request inference timeout without
  // editing the Dockerfile. Ref: issue #2281
  const agentTimeout = process.env.NEMOCLAW_AGENT_TIMEOUT;
  if (agentTimeout && POSITIVE_INT_RE.test(agentTimeout)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_AGENT_TIMEOUT=.*$/m,
      `ARG NEMOCLAW_AGENT_TIMEOUT=${agentTimeout}`,
    );
  }
  // NEMOCLAW_AGENT_HEARTBEAT_EVERY — override agents.defaults.heartbeat.every
  // at build time. Accepts Go-style durations with a required s/m/h suffix
  // ("30m", "1h"); "0m" disables heartbeat. Ref: issue #2880
  const agentHeartbeat = process.env.NEMOCLAW_AGENT_HEARTBEAT_EVERY;
  if (agentHeartbeat && /^\d+(s|m|h)$/.test(agentHeartbeat)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_AGENT_HEARTBEAT_EVERY=.*$/m,
      `ARG NEMOCLAW_AGENT_HEARTBEAT_EVERY=${agentHeartbeat}`,
    );
  }
  // Honor NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT exported in the host
  // shell so the sandbox-side nemoclaw-start.sh sees them via $ENV at runtime.
  // Without this, the host export is silently dropped at image build time and
  // the sandbox falls back to the default 10.200.0.1:3128 proxy. See #1409.
  const proxyHostEnv = process.env.NEMOCLAW_PROXY_HOST;
  if (proxyHostEnv && isValidProxyHost(proxyHostEnv)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_PROXY_HOST=.*$/m,
      `ARG NEMOCLAW_PROXY_HOST=${proxyHostEnv}`,
    );
  }
  const proxyPortEnv = process.env.NEMOCLAW_PROXY_PORT;
  if (proxyPortEnv && isValidProxyPort(proxyPortEnv)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_PROXY_PORT=.*$/m,
      `ARG NEMOCLAW_PROXY_PORT=${proxyPortEnv}`,
    );
  }
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_WEB_SEARCH_ENABLED=.*$/m,
    `ARG NEMOCLAW_WEB_SEARCH_ENABLED=${webSearchConfig ? "1" : "0"}`,
  );
  // Onboard flow expects immediate dashboard access without device pairing,
  // so disable device auth for images built during onboard (see #1217).
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_DISABLE_DEVICE_AUTH=.*$/m,
    `ARG NEMOCLAW_DISABLE_DEVICE_AUTH=1`,
  );
  if (messagingChannels.length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_MESSAGING_CHANNELS_B64=.*$/m,
      `ARG NEMOCLAW_MESSAGING_CHANNELS_B64=${encodeDockerJsonArg(messagingChannels)}`,
    );
  }
  if (Object.keys(messagingAllowedIds).length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=.*$/m,
      `ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=${encodeDockerJsonArg(messagingAllowedIds)}`,
    );
  }
  if (Object.keys(discordGuilds).length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_DISCORD_GUILDS_B64=.*$/m,
      `ARG NEMOCLAW_DISCORD_GUILDS_B64=${encodeDockerJsonArg(discordGuilds)}`,
    );
  }
  if (telegramConfig && Object.keys(telegramConfig).length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_TELEGRAM_CONFIG_B64=.*$/m,
      `ARG NEMOCLAW_TELEGRAM_CONFIG_B64=${encodeDockerJsonArg(telegramConfig)}`,
    );
  }
  fs.writeFileSync(dockerfilePath, dockerfile);
}

// Inference probes — moved to inference/onboard-probes.ts
const {
  hasResponsesToolCall,
  hasChatCompletionsToolCall,
  hasChatCompletionsToolCallLeak,
  shouldRequireResponsesToolCalling,
  getProbeAuthMode,
  getValidationProbeCurlArgs,
  probeOpenAiLikeEndpoint,
  probeAnthropicEndpoint,
} = require("./inference/onboard-probes");

// shouldSkipResponsesProbe and isNvcfFunctionNotFoundForAccount /
// nvcfFunctionNotFoundMessage — see validation import above. They live in
// src/lib/validation.ts so they can be unit-tested independently.

async function validateOpenAiLikeSelection(
  label: string,
  endpointUrl: string,
  model: string,
  credentialEnv: string | null = null,
  retryMessage = "Please choose a provider/model again.",
  helpUrl: string | null = null,
  options: {
    authMode?: "bearer" | "query-param";
    requireResponsesToolCalling?: boolean;
    requireChatCompletionsToolCalling?: boolean;
    skipResponsesProbe?: boolean;
    probeStreaming?: boolean;
  } = {},
): Promise<EndpointValidationResult> {
  const apiKey = credentialEnv ? getCredential(credentialEnv) : "";
  const probe = probeOpenAiLikeEndpoint(endpointUrl, model, apiKey, options);
  if (!probe.ok) {
    console.error(`  ${label} endpoint validation failed.`);
    console.error(`  ${probe.message}`);
    if (isNonInteractive()) {
      process.exit(1);
    }
    const retry = await promptValidationRecovery(
      label,
      getProbeRecovery(probe),
      credentialEnv,
      helpUrl,
    );
    if (retry === "selection") {
      console.log(`  ${retryMessage}`);
      console.log("");
    }
    return { ok: false, retry };
  }
  if (probe.note) {
    console.log(`  ℹ ${probe.note}`);
  } else {
    console.log(`  ${probe.label} available — ${agentProductName()} will use ${probe.api}.`);
  }
  return { ok: true, api: probe.api ?? "openai-completions" };
}

async function validateAnthropicSelectionWithRetryMessage(
  label: string,
  endpointUrl: string,
  model: string,
  credentialEnv: string,
  retryMessage = "Please choose a provider/model again.",
  helpUrl: string | null = null,
): Promise<EndpointValidationResult> {
  const apiKey = getCredential(credentialEnv);
  const probe = probeAnthropicEndpoint(endpointUrl, model, apiKey);
  if (!probe.ok) {
    console.error(`  ${label} endpoint validation failed.`);
    console.error(`  ${probe.message}`);
    if (isNonInteractive()) {
      process.exit(1);
    }
    const retry = await promptValidationRecovery(
      label,
      getProbeRecovery(probe),
      credentialEnv,
      helpUrl,
    );
    if (retry === "selection") {
      console.log(`  ${retryMessage}`);
      console.log("");
    }
    return { ok: false, retry };
  }
  console.log(`  ${probe.label} available — ${agentProductName()} will use ${probe.api}.`);
  return { ok: true, api: probe.api };
}

async function validateCustomOpenAiLikeSelection(
  label: string,
  endpointUrl: string,
  model: string,
  credentialEnv: string,
  helpUrl: string | null = null,
): Promise<EndpointValidationResult> {
  const apiKey = getCredential(credentialEnv);
  const probe = probeOpenAiLikeEndpoint(endpointUrl, model, apiKey, {
    requireResponsesToolCalling: true,
    skipResponsesProbe: shouldForceCompletionsApi(process.env.NEMOCLAW_PREFERRED_API),
    probeStreaming: true,
  });
  if (probe.ok) {
    if (probe.note) {
      console.log(`  ℹ ${probe.note}`);
    } else {
      console.log(`  ${probe.label} available — ${agentProductName()} will use ${probe.api}.`);
    }
    return { ok: true, api: probe.api ?? "openai-completions" };
  }
  console.error(`  ${label} endpoint validation failed.`);
  console.error(`  ${probe.message}`);
  if (isNonInteractive()) {
    process.exit(1);
  }
  const retry = await promptValidationRecovery(
    label,
    getProbeRecovery(probe, { allowModelRetry: true }),
    credentialEnv,
    helpUrl,
  );
  if (retry === "selection") {
    console.log("  Please choose a provider/model again.");
    console.log("");
  }
  return { ok: false, retry };
}

async function validateCustomAnthropicSelection(
  label: string,
  endpointUrl: string,
  model: string,
  credentialEnv: string,
  helpUrl: string | null = null,
): Promise<EndpointValidationResult> {
  const apiKey = getCredential(credentialEnv);
  const probe = probeAnthropicEndpoint(endpointUrl, model, apiKey);
  if (probe.ok) {
    console.log(`  ${probe.label} available — ${agentProductName()} will use ${probe.api}.`);
    return { ok: true, api: probe.api };
  }
  console.error(`  ${label} endpoint validation failed.`);
  console.error(`  ${probe.message}`);
  if (isNonInteractive()) {
    process.exit(1);
  }
  const retry = await promptValidationRecovery(
    label,
    getProbeRecovery(probe, { allowModelRetry: true }),
    credentialEnv,
    helpUrl,
  );
  if (retry === "selection") {
    console.log("  Please choose a provider/model again.");
    console.log("");
  }
  return { ok: false, retry };
}

const { promptManualModelId, promptCloudModel, promptRemoteModel, promptInputModel } = modelPrompts;
const { validateAnthropicModel, validateOpenAiLikeModel } = providerModels;
const nousModels: typeof import("./inference/nous-models") = require("./inference/nous-models");

// Build context helpers — delegated to src/lib/build-context.ts
const { shouldIncludeBuildContextPath, copyBuildContextDir, printSandboxCreateRecoveryHints } =
  buildContext;
// classifySandboxCreateFailure — see validation import above

// ---------------------------------------------------------------------------
// Ollama model prompt/pull/prepare functions — from inference/ollama/proxy.ts
// (proxy lifecycle functions already imported at the top of this file)
const {
  promptOllamaModel,
  printOllamaExposureWarning,
  pullOllamaModel,
  prepareOllamaModel,
} = require("./inference/ollama/proxy");

const ollamaModelSize: typeof import("./inference/ollama/model-size") = require("./inference/ollama/model-size");

function getRequestedSandboxNameHint(opts: { sandboxName?: string | null } = {}): string | null {
  const raw =
    typeof opts.sandboxName === "string" && opts.sandboxName.length > 0
      ? opts.sandboxName
      : process.env.NEMOCLAW_SANDBOX_NAME;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return normalized || null;
}

function getResumeSandboxConflict(
  session: Session | null,
  opts: { sandboxName?: string | null } = {},
) {
  // Use opts.sandboxName as the sole source — the caller has already
  // resolved it (--name first, NEMOCLAW_SANDBOX_NAME only when prompting
  // is impossible). Falling back to the env var here would fire spurious
  // conflicts for interactive resume runs whose shell happens to export
  // NEMOCLAW_SANDBOX_NAME but which never actually consult it.
  // #2753: only treat session.sandboxName as a conflict source if the
  // sandbox step actually completed. A pre-fix incomplete session would
  // otherwise reject a legitimate `--resume --name <new>` that the user
  // is supplying precisely to recover from the phantom.
  const raw = typeof opts.sandboxName === "string" ? opts.sandboxName.trim().toLowerCase() : "";
  const requestedSandboxName = raw || null;
  const recordedSandboxName =
    session?.steps?.sandbox?.status === "complete" ? session?.sandboxName ?? null : null;
  if (!requestedSandboxName || !recordedSandboxName) {
    return null;
  }
  return requestedSandboxName !== recordedSandboxName
    ? { requestedSandboxName, recordedSandboxName }
    : null;
}

// Provider hint wrappers — supply isNonInteractive() default, delegate to onboard-providers.
function getRequestedProviderHint(nonInteractive = isNonInteractive()) {
  return onboardProviders.getRequestedProviderHint(nonInteractive);
}
function getRequestedModelHint(nonInteractive = isNonInteractive()) {
  return onboardProviders.getRequestedModelHint(nonInteractive);
}

function getResumeConfigConflicts(
  session: Session | null,
  opts: {
    nonInteractive?: boolean;
    fromDockerfile?: string | null;
    sandboxName?: string | null;
    agent?: string | null;
  } = {},
) {
  const conflicts = [];
  const nonInteractive = opts.nonInteractive ?? isNonInteractive();

  const sandboxConflict = getResumeSandboxConflict(session, { sandboxName: opts.sandboxName });
  if (sandboxConflict) {
    conflicts.push({
      field: "sandbox",
      requested: sandboxConflict.requestedSandboxName,
      recorded: sandboxConflict.recordedSandboxName,
    });
  }

  const requestedProvider = getRequestedProviderHint(nonInteractive);
  const effectiveRequestedProvider = getEffectiveProviderName(requestedProvider);
  if (
    effectiveRequestedProvider &&
    session?.provider &&
    effectiveRequestedProvider !== session.provider
  ) {
    conflicts.push({
      field: "provider",
      requested: effectiveRequestedProvider,
      recorded: session.provider,
    });
  }

  const requestedModel = getRequestedModelHint(nonInteractive);
  if (requestedModel && session?.model && requestedModel !== session.model) {
    conflicts.push({
      field: "model",
      requested: requestedModel,
      recorded: session.model,
    });
  }

  const requestedFrom = opts.fromDockerfile ? path.resolve(opts.fromDockerfile) : null;
  const recordedFrom = session?.metadata?.fromDockerfile
    ? path.resolve(session.metadata.fromDockerfile)
    : null;
  if (requestedFrom !== recordedFrom) {
    conflicts.push({
      field: "fromDockerfile",
      requested: requestedFrom,
      recorded: recordedFrom,
    });
  }

  const requestedAgent = opts.agent || process.env.NEMOCLAW_AGENT || null;
  const recordedAgent = session?.agent || null;
  if (requestedAgent && recordedAgent && requestedAgent !== recordedAgent) {
    conflicts.push({
      field: "agent",
      requested: requestedAgent,
      recorded: recordedAgent,
    });
  }

  return conflicts;
}

function getContainerRuntime(): ContainerRuntime {
  const info = dockerInfo({ ignoreError: true });
  return inferContainerRuntime(info);
}

function printRemediationActions(
  actions: Array<{ title: string; reason: string; commands?: string[] }> | null | undefined,
): void {
  if (!Array.isArray(actions) || actions.length === 0) {
    return;
  }

  console.error("");
  console.error("  Suggested fix:");
  console.error("");
  for (const action of actions) {
    console.error(`  - ${action.title}: ${action.reason}`);
    for (const command of action.commands || []) {
      console.error(`    ${command}`);
    }
  }
}

function isOpenshellInstalled(): boolean {
  return resolveOpenshell() !== null;
}

function getFutureShellPathHint(binDir: string, pathValue = process.env.PATH || ""): string | null {
  const parts = String(pathValue).split(path.delimiter).filter(Boolean);
  if (parts[0] === binDir) {
    return null;
  }
  return `export PATH="${binDir}:$PATH"`;
}

function getPortConflictServiceHints(platform = process.platform): string[] {
  if (platform === "darwin") {
    return [
      "       # or, if it's a launchctl service (macOS):",
      "       launchctl list | grep -i claw   # columns: PID | ExitStatus | Label",
      `       launchctl unload ${OPENCLAW_LAUNCH_AGENT_PLIST}`,
      "       # or: launchctl bootout gui/$(id -u)/ai.openclaw.gateway",
    ];
  }
  return [
    "       # or, if it's a systemd service:",
    "       systemctl --user stop openclaw-gateway.service",
  ];
}

function installOpenshell(): {
  installed: boolean;
  localBin: string | null;
  futureShellPathHint: string | null;
} {
  const result = spawnSync("bash", [path.join(SCRIPTS, "install-openshell.sh")], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 300_000,
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (output) {
      console.error(output);
    }
    return { installed: false, localBin: null, futureShellPathHint: null };
  }
  const localBin = process.env.XDG_BIN_HOME || path.join(process.env.HOME || "", ".local", "bin");
  const openshellPath = path.join(localBin, "openshell");
  const futureShellPathHint = fs.existsSync(openshellPath)
    ? getFutureShellPathHint(localBin, process.env.PATH)
    : null;
  if (fs.existsSync(openshellPath) && futureShellPathHint) {
    process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH}`;
  }
  OPENSHELL_BIN = resolveOpenshell();
  if (OPENSHELL_BIN) {
    process.env.NEMOCLAW_OPENSHELL_BIN = OPENSHELL_BIN;
  }
  return {
    installed: OPENSHELL_BIN !== null,
    localBin,
    futureShellPathHint,
  };
}

function sleep(seconds: number): void {
  sleepSeconds(seconds);
}

function runQuietOpenshell(args: string[]) {
  return runOpenshell(args, {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
    suppressOutput: true,
  });
}

function removeDockerDriverGatewayRegistration(): boolean {
  const removeResult = runQuietOpenshell(["gateway", "remove", GATEWAY_NAME]);
  if (removeResult.status === 0) return true;

  // OpenShell dev builds before NVIDIA/OpenShell#1221 used `gateway destroy`
  // for local metadata cleanup. Post-#1221 builds removed lifecycle verbs and
  // use `gateway remove` instead, so keep both forms quiet and best-effort.
  const destroyResult = runQuietOpenshell(["gateway", "destroy", "-g", GATEWAY_NAME]);
  return destroyResult.status === 0;
}

function terminateDockerDriverGatewayProcess(pid: number): boolean {
  if (!isPidAlive(pid)) {
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 10; i += 1) {
      if (!isPidAlive(pid)) break;
      sleep(1);
    }
    if (isPidAlive(pid)) process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

function stopDockerDriverGatewayProcess(): boolean {
  const pid = getDockerDriverGatewayPid();
  if (pid === null || !isPidAlive(pid)) {
    fs.rmSync(getDockerDriverGatewayPidFile(), { force: true });
    return false;
  }
  if (!isDockerDriverGatewayProcess(pid, resolveOpenShellGatewayBinary())) {
    fs.rmSync(getDockerDriverGatewayPidFile(), { force: true });
    return false;
  }

  const stopped = terminateDockerDriverGatewayProcess(pid);
  fs.rmSync(getDockerDriverGatewayPidFile(), { force: true });
  return stopped;
}

function restartDockerDriverGatewayProcessForDrift(pid: number, reason: string): void {
  console.log(`  Existing OpenShell Docker-driver gateway is stale (${reason}); restarting...`);
  terminateDockerDriverGatewayProcess(pid);
  fs.rmSync(getDockerDriverGatewayPidFile(), { force: true });
}

async function refreshDockerDriverGatewayReuseState(
  gatewayReuseState: GatewayReuseState,
): Promise<GatewayReuseState> {
  if (!isLinuxDockerDriverGatewayEnabled() || gatewayReuseState !== "healthy") {
    return gatewayReuseState;
  }
  const gatewayBin = resolveOpenShellGatewayBinary();
  const desiredEnv = getDockerDriverGatewayEnv(
    runCaptureOpenshell(["--version"], { ignoreError: true }),
  );
  const pid = getDockerDriverGatewayPid();
  if (pid !== null && isDockerDriverGatewayProcessAlive()) {
    const drift = getDockerDriverGatewayRuntimeDrift(pid, desiredEnv, gatewayBin);
    if (drift) {
      console.log(
        `  Existing OpenShell Docker-driver gateway is stale (${drift.reason}); it will be recreated.`,
      );
      return "stale";
    }
    return gatewayReuseState;
  }

  const portCheck = await checkPortAvailable(GATEWAY_PORT);
  const dockerGatewayPid = getDockerDriverGatewayPortListenerPid(portCheck, {
    gatewayBin,
  });
  if (dockerGatewayPid !== null) {
    const drift = getDockerDriverGatewayRuntimeDrift(dockerGatewayPid, desiredEnv, gatewayBin);
    rememberDockerDriverGatewayPid(dockerGatewayPid);
    if (drift) {
      console.log(
        `  Existing OpenShell Docker-driver gateway is stale (${drift.reason}); it will be recreated.`,
      );
      return "stale";
    }
    return "healthy";
  }

  // `openshell status` already proved the selected gateway is reachable. If
  // the port probe cannot identify the owning PID, avoid tearing down a live
  // gateway solely because the pid file is stale.
  if (!portCheck.ok && !portCheck.pid) return "healthy";

  return "stale";
}

function destroyGateway(): boolean {
  const dockerDriver = isLinuxDockerDriverGatewayEnabled();
  if (dockerDriver) {
    stopDockerDriverGatewayProcess();
  }

  const gatewayRemoved = dockerDriver
    ? removeDockerDriverGatewayRegistration()
    : runOpenshell(["gateway", "destroy", "-g", GATEWAY_NAME], {
        ignoreError: true,
      }).status === 0;

  // Clear the local registry so `nemoclaw list` stays consistent with OpenShell state. (#532)
  if (gatewayRemoved) {
    registry.clearAll();
  }
  // Legacy OpenShell gateway cleanup doesn't remove Docker volumes, which
  // leaves corrupted cluster state that breaks the next gateway start.
  dockerRemoveVolumesByPrefix(`openshell-cluster-${GATEWAY_NAME}`, { ignoreError: true });
  return gatewayRemoved;
}

type FinalGatewayStartFailureOptions = {
  retries: number;
  collectDiagnostics?: () => string | null | undefined;
  cleanupGateway?: () => void;
  exitProcess?: (code: number) => never;
  printError?: (message?: string) => void;
};

function handleFinalGatewayStartFailure({
  retries,
  collectDiagnostics = () =>
    runCaptureOpenshell(["doctor", "logs", "--name", GATEWAY_NAME], {
      ignoreError: true,
      timeout: 10_000,
    }),
  cleanupGateway = destroyGateway,
  exitProcess = (code) => process.exit(code),
  printError = (message = "") => console.error(message),
}: FinalGatewayStartFailureOptions): never {
  printError(`  Gateway failed to start after ${retries + 1} attempts.`);
  printError("  Gateway state preserved until diagnostics are collected.");
  printError("");

  try {
    const logs = redact(collectDiagnostics() || "");
    if (logs) {
      printError("  Gateway logs:");
      for (const line of String(logs)
        .split("\n")
        .map((l) => l.replace(/\r/g, "").replace(ANSI_RE, ""))
        .filter(Boolean)) {
        printError(`    ${line}`);
      }
      printError("");
    }
  } catch {
    // doctor logs unavailable — continue to best-effort cleanup and manual instructions
  }

  printError("  Cleaning up failed gateway state...");
  try {
    cleanupGateway();
    printError("  Cleanup attempted.");
  } catch (err) {
    const message = compactText(err instanceof Error ? err.message : String(err));
    printError(message ? `  Cleanup attempt failed: ${message}` : "  Cleanup attempt failed.");
  }
  printError("");
  printError("  Diagnostic command attempted before cleanup:");
  printError(`    openshell doctor logs --name ${GATEWAY_NAME}`);
  printError("    openshell doctor check");
  printError("");
  printError("  If gateway cleanup did not complete, run:");
  printError(`    openshell gateway remove ${GATEWAY_NAME}`);
  printError(`    # For OpenShell releases that still expose lifecycle commands:`);
  printError(`    openshell gateway destroy -g ${GATEWAY_NAME}`);
  printError(
    `    docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | xargs -r docker volume rm`,
  );
  printError(`    nemoclaw onboard --resume`);
  return exitProcess(1);
}

function getGatewayClusterContainerState(): string {
  const containerName = getGatewayClusterContainerName();
  const state = dockerContainerInspectFormat(
    "{{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{end}}",
    containerName,
    { ignoreError: true },
  )
    .trim()
    .toLowerCase();
  return state || "missing";
}

function parseGatewayClusterImageVersion(imageRef: string | null | undefined): string | null {
  const match = String(imageRef || "").match(/openshell\/cluster:([0-9]+\.[0-9]+\.[0-9]+)/);
  return match ? match[1] : null;
}

function getGatewayClusterImageRef(): string | null {
  const containerName = getGatewayClusterContainerName();
  const imageRef = dockerContainerInspectFormat("{{.Config.Image}}", containerName, {
    ignoreError: true,
  }).trim();
  return imageRef || null;
}

function getGatewayClusterImageDrift(): {
  currentImage: string;
  currentVersion: string;
  expectedVersion: string;
} | null {
  const expectedVersion = getInstalledOpenshellVersion();
  const currentImage = getGatewayClusterImageRef();
  const currentVersion = parseGatewayClusterImageVersion(currentImage);
  if (!expectedVersion || !currentImage || !currentVersion || currentVersion === expectedVersion) {
    return null;
  }
  return { currentImage, currentVersion, expectedVersion };
}

function getGatewayHealthWaitConfig(_startStatus = 0, containerState = "") {
  const isArm64 = process.arch === "arm64";
  const standardCount = envInt("NEMOCLAW_HEALTH_POLL_COUNT", isArm64 ? 30 : 12);
  const standardInterval = envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", isArm64 ? 10 : 5);
  const extendedCount = envInt("NEMOCLAW_GATEWAY_START_POLL_COUNT", standardCount);
  const extendedInterval = envInt("NEMOCLAW_GATEWAY_START_POLL_INTERVAL", standardInterval);
  const normalizedState = String(containerState || "")
    .trim()
    .toLowerCase();
  const normalizedContainerState = normalizedState || "missing";
  const useExtendedWait = normalizedContainerState !== "missing";

  return {
    count: useExtendedWait ? extendedCount : standardCount,
    interval: useExtendedWait ? extendedInterval : standardInterval,
    extended: useExtendedWait,
    containerState: normalizedContainerState,
  };
}

function getGatewayClusterContainerName(): string {
  return `openshell-cluster-${GATEWAY_NAME}`;
}

function buildGatewayClusterExecArgv(script: string): string[] {
  return dockerExecArgv(getGatewayClusterContainerName(), ["sh", "-lc", script]);
}

function hostCommandExists(commandName: string): boolean {
  return !!runCapture(["sh", "-c", 'command -v "$1"', "--", commandName], {
    ignoreError: true,
  });
}

function ensureOllamaLinuxExtractionDependencies(): void {
  if (hostCommandExists("zstd")) return;
  console.log(
    "  The Ollama Linux installer requires zstd for archive extraction. " +
      "The next step uses sudo to install zstd; you may be prompted for your password.",
  );
  runShell(`if ! command -v apt-get >/dev/null 2>&1; then
  echo "ERROR: Ollama requires zstd for extraction, and only apt-based Linux is supported here." >&2
  echo "Install zstd manually (for example, sudo dnf install zstd or sudo pacman -S zstd), then rerun ${cliName()} onboard." >&2
  exit 1
fi
sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends zstd`);
}

function captureProcessArgs(pid: number): string {
  return runCapture(["ps", "-p", String(pid), "-o", "args="], {
    ignoreError: true,
  }).trim();
}

function getGatewayLocalEndpoint(): string {
  return `https://127.0.0.1:${GATEWAY_PORT}`;
}

function isLinuxDockerDriverGatewayEnabled(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): boolean {
  return platform === "linux" || (platform === "darwin" && arch === "arm64");
}

function isLinuxDockerDriverGatewayPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "linux";
}

function getDockerDriverGatewayEndpoint(): string {
  return `http://127.0.0.1:${GATEWAY_PORT}`;
}

function getDockerDriverGatewayStateDir(): string {
  const configured = process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  return path.join(os.homedir(), ".local", "state", "nemoclaw", "openshell-docker-gateway");
}

function getDockerDriverGatewayPidFile(): string {
  return path.join(getDockerDriverGatewayStateDir(), "openshell-gateway.pid");
}

function resolveSiblingBinary(binaryName: string): string | null {
  const openshellBin = OPENSHELL_BIN || resolveOpenshell();
  if (typeof openshellBin !== "string" || openshellBin.length === 0) return null;
  const sibling = path.join(path.dirname(openshellBin), binaryName);
  if (fs.existsSync(sibling)) return sibling;
  return null;
}

function resolveOpenShellGatewayBinary(): string | null {
  const configured = process.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  const sibling = resolveSiblingBinary("openshell-gateway");
  if (sibling) return sibling;
  for (const candidate of [
    path.join(os.homedir(), ".local", "bin", "openshell-gateway"),
    "/usr/local/bin/openshell-gateway",
    "/usr/bin/openshell-gateway",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveOpenShellSandboxBinary(): string | null {
  const configured = process.env.NEMOCLAW_OPENSHELL_SANDBOX_BIN;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  const sibling = resolveSiblingBinary("openshell-sandbox");
  if (sibling) return sibling;
  for (const candidate of [
    path.join(os.homedir(), ".local", "bin", "openshell-sandbox"),
    "/usr/local/bin/openshell-sandbox",
    "/usr/bin/openshell-sandbox",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveOpenShellVmDriverBinary(): string | null {
  const configuredDir = process.env.OPENSHELL_DRIVER_DIR;
  if (configuredDir && configuredDir.trim()) {
    const configured = path.join(path.resolve(configuredDir.trim()), "openshell-driver-vm");
    if (fs.existsSync(configured)) return configured;
  }
  const sibling = resolveSiblingBinary("openshell-driver-vm");
  if (sibling) return sibling;
  for (const candidate of [
    path.join(os.homedir(), ".local", "bin", "openshell-driver-vm"),
    path.join(os.homedir(), ".local", "libexec", "openshell", "openshell-driver-vm"),
    "/usr/local/bin/openshell-driver-vm",
    "/usr/local/libexec/openshell/openshell-driver-vm",
    "/usr/local/libexec/openshell-driver-vm",
    "/usr/bin/openshell-driver-vm",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function areRequiredDockerDriverBinariesPresent(
  platform: NodeJS.Platform = process.platform,
  binaries: {
    gatewayBin?: string | null;
    sandboxBin?: string | null;
    vmDriverBin?: string | null;
  } = {},
  arch: NodeJS.Architecture = process.arch,
): boolean {
  if (!isLinuxDockerDriverGatewayEnabled(platform, arch)) return true;
  const gatewayBin = Object.prototype.hasOwnProperty.call(binaries, "gatewayBin")
    ? binaries.gatewayBin
    : resolveOpenShellGatewayBinary();
  const sandboxBin = Object.prototype.hasOwnProperty.call(binaries, "sandboxBin")
    ? binaries.sandboxBin
    : resolveOpenShellSandboxBinary();
  const hasVmDriverBin = Object.prototype.hasOwnProperty.call(binaries, "vmDriverBin");
  const vmDriverBin = hasVmDriverBin ? binaries.vmDriverBin : resolveOpenShellVmDriverBinary();
  if (!gatewayBin) return false;
  if (platform === "linux" && !sandboxBin) return false;
  if (platform === "darwin" && hasVmDriverBin && !vmDriverBin) return false;
  return true;
}

function getOpenShellDockerSupervisorImage(versionOutput: string | null = null): string {
  if (process.env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE) {
    return process.env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE;
  }
  const installedVersion = getInstalledOpenshellVersion(versionOutput);
  if (shouldUseOpenshellDevChannel() || isOpenshellDevVersion(versionOutput)) {
    return "ghcr.io/nvidia/openshell/supervisor:dev";
  }
  const supportedVersion = installedVersion ?? getBlueprintMaxOpenshellVersion() ?? "0.0.37";
  return `ghcr.io/nvidia/openshell/supervisor:${supportedVersion}`;
}

function getDockerDriverGatewayEnv(
  versionOutput: string | null = null,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const stateDir = getDockerDriverGatewayStateDir();
  const env: Record<string, string> = {
    OPENSHELL_DRIVERS: platform === "darwin" ? "vm" : "docker",
    OPENSHELL_BIND_ADDRESS: "127.0.0.1",
    OPENSHELL_SERVER_PORT: String(GATEWAY_PORT),
    OPENSHELL_DISABLE_TLS: "true",
    OPENSHELL_DISABLE_GATEWAY_AUTH: "true",
    OPENSHELL_DB_URL: `sqlite:${path.join(stateDir, "openshell.db")}`,
    OPENSHELL_GRPC_ENDPOINT:
      platform === "darwin"
        ? `http://host.containers.internal:${GATEWAY_PORT}`
        : getDockerDriverGatewayEndpoint(),
    OPENSHELL_SSH_GATEWAY_HOST: "127.0.0.1",
    OPENSHELL_SSH_GATEWAY_PORT: String(GATEWAY_PORT),
  };
  if (platform === "darwin") {
    env.OPENSHELL_VM_DRIVER_STATE_DIR = path.join(stateDir, "vm-driver");
    const vmDriverBin = resolveOpenShellVmDriverBinary();
    if (vmDriverBin) {
      env.OPENSHELL_DRIVER_DIR = path.dirname(vmDriverBin);
    }
  } else {
    env.OPENSHELL_DOCKER_NETWORK_NAME =
      process.env.OPENSHELL_DOCKER_NETWORK_NAME || "openshell-docker";
    env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE = getOpenShellDockerSupervisorImage(versionOutput);
    const sandboxBin = resolveOpenShellSandboxBinary();
    if (sandboxBin) {
      env.OPENSHELL_DOCKER_SUPERVISOR_BIN = sandboxBin;
    }
  }
  return env;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

function getDockerDriverGatewayPid(): number | null {
  try {
    const raw = fs.readFileSync(getDockerDriverGatewayPidFile(), "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readProcessEnv(pid: number): Record<string, string> | null {
  const procEnvPath = `/proc/${pid}/environ`;
  const env: Record<string, string> = {};
  try {
    if (!fs.existsSync(procEnvPath)) return null;
    for (const entry of fs.readFileSync(procEnvPath, "utf-8").split("\0")) {
      if (!entry) continue;
      const idx = entry.indexOf("=");
      if (idx <= 0) continue;
      env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
  } catch {
    return null;
  }
  return env;
}

function hasDockerDriverGatewayEnv(pid: number): boolean {
  const env = readProcessEnv(pid);
  if (!env) return false;
  return (
    env.OPENSHELL_DRIVERS === "docker" ||
    Boolean(env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE) ||
    env.OPENSHELL_GRPC_ENDPOINT === getDockerDriverGatewayEndpoint()
  );
}

function readProcessExe(pid: number): string | null {
  try {
    const procExePath = `/proc/${pid}/exe`;
    if (!fs.existsSync(procExePath)) return null;
    return fs.readlinkSync(procExePath);
  } catch {
    return null;
  }
}

function normalizeGatewayExecutablePath(value: string | null | undefined): string | null {
  if (!value) return null;
  const withoutDeletedSuffix = value.replace(/ \(deleted\)$/, "");
  try {
    return fs.realpathSync.native(withoutDeletedSuffix);
  } catch {
    return path.resolve(withoutDeletedSuffix);
  }
}

type DockerDriverGatewayRuntimeDrift = { reason: string };

function shouldRequireDockerDriverEnv(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux";
}

const DOCKER_DRIVER_GATEWAY_RUNTIME_ENV_KEYS = [
  "OPENSHELL_DRIVERS",
  "OPENSHELL_BIND_ADDRESS",
  "OPENSHELL_SERVER_PORT",
  "OPENSHELL_DISABLE_TLS",
  "OPENSHELL_DISABLE_GATEWAY_AUTH",
  "OPENSHELL_DB_URL",
  "OPENSHELL_GRPC_ENDPOINT",
  "OPENSHELL_SSH_GATEWAY_HOST",
  "OPENSHELL_SSH_GATEWAY_PORT",
  "OPENSHELL_DOCKER_NETWORK_NAME",
  "OPENSHELL_DOCKER_SUPERVISOR_IMAGE",
  "OPENSHELL_DOCKER_SUPERVISOR_BIN",
] as const;

function getDockerDriverGatewayRuntimeDriftFromSnapshot({
  processEnv,
  processExe,
  desiredEnv,
  gatewayBin,
}: {
  processEnv: Record<string, string> | null;
  processExe: string | null;
  desiredEnv: Record<string, string>;
  gatewayBin?: string | null;
}): DockerDriverGatewayRuntimeDrift | null {
  if (!processEnv) {
    return { reason: "could not verify process environment" };
  }
  for (const key of DOCKER_DRIVER_GATEWAY_RUNTIME_ENV_KEYS) {
    const desired = desiredEnv[key];
    if (typeof desired !== "string") continue;
    const actual = processEnv[key];
    if (actual !== desired) {
      return { reason: `${key}=${actual || "<unset>"} (expected ${desired})` };
    }
  }

  if (processExe === null) {
    return { reason: "could not verify process executable" };
  }
  if (processExe.endsWith(" (deleted)")) {
    return { reason: "gateway executable was replaced on disk" };
  }
  const expectedExe = normalizeGatewayExecutablePath(gatewayBin);
  const actualExe = normalizeGatewayExecutablePath(processExe);
  if (expectedExe && actualExe && actualExe !== expectedExe) {
    return { reason: `executable=${actualExe} (expected ${expectedExe})` };
  }
  return null;
}

function getDockerDriverGatewayRuntimeDrift(
  pid: number,
  desiredEnv: Record<string, string>,
  gatewayBin?: string | null,
  platform: NodeJS.Platform = process.platform,
): DockerDriverGatewayRuntimeDrift | null {
  if (!shouldRequireDockerDriverEnv(platform)) return null;
  return getDockerDriverGatewayRuntimeDriftFromSnapshot({
    processEnv: readProcessEnv(pid),
    processExe: readProcessExe(pid),
    desiredEnv,
    gatewayBin,
  });
}

function isDockerDriverGatewayProcess(
  pid: number,
  gatewayBin?: string | null,
  opts: { requireDockerDriverEnv?: boolean } = {},
): boolean {
  const procCmdlinePath = `/proc/${pid}/cmdline`;
  let identity = "";
  try {
    if (fs.existsSync(procCmdlinePath)) {
      identity = fs.readFileSync(procCmdlinePath, "utf-8").replace(/\0/g, " ").trim();
    }
  } catch {
    identity = "";
  }
  if (!identity) {
    identity = captureProcessArgs(pid);
  }
  if (!identity) return false;
  const matchesGatewayBinary =
    identity.includes("openshell-gateway") ||
    (typeof gatewayBin === "string" && gatewayBin.length > 0 && identity.includes(gatewayBin));
  if (!matchesGatewayBinary) return false;
  if (opts.requireDockerDriverEnv && !hasDockerDriverGatewayEnv(pid)) return false;
  return true;
}

function isDockerDriverGatewayProcessAlive(): boolean {
  const pid = getDockerDriverGatewayPid();
  if (pid === null || !isPidAlive(pid)) return false;
  if (!isDockerDriverGatewayProcess(pid, resolveOpenShellGatewayBinary(), {
    requireDockerDriverEnv: shouldRequireDockerDriverEnv(),
  })) {
    fs.rmSync(getDockerDriverGatewayPidFile(), { force: true });
    return false;
  }
  return true;
}

function rememberDockerDriverGatewayPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const stateDir = getDockerDriverGatewayStateDir();
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(getDockerDriverGatewayPidFile(), `${pid}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function getDockerDriverGatewayPortListenerPid(
  portCheck: import("./onboard/preflight").PortProbeResult,
  opts: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    gatewayBin?: string | null;
    isPidAliveFn?: (pid: number) => boolean;
    isDockerDriverGatewayProcessFn?: (pid: number, gatewayBin?: string | null) => boolean;
  } = {},
): number | null {
  if (portCheck.ok) return null;
  if (
    !isLinuxDockerDriverGatewayEnabled(
      opts.platform ?? process.platform,
      opts.arch ?? process.arch,
    )
  )
    return null;
  const pid = Number(portCheck.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const proc = String(portCheck.process || "").toLowerCase();
  if (!proc.startsWith("openshell")) return null;
  const alive = opts.isPidAliveFn ?? isPidAlive;
  if (!alive(pid)) return null;
  const isGateway =
    opts.isDockerDriverGatewayProcessFn ??
    ((candidatePid: number, gatewayBin?: string | null) =>
      isDockerDriverGatewayProcess(candidatePid, gatewayBin, {
        requireDockerDriverEnv: shouldRequireDockerDriverEnv(opts.platform ?? process.platform),
      }));
  if (!isGateway(pid, opts.gatewayBin)) return null;
  return pid;
}

function isDockerDriverGatewayPortListener(
  portCheck: import("./onboard/preflight").PortProbeResult,
  opts: Parameters<typeof getDockerDriverGatewayPortListenerPid>[1] = {},
): boolean {
  return getDockerDriverGatewayPortListenerPid(portCheck, opts) !== null;
}

function writeDockerGatewayDebEnvOverride(): void {
  const servicePath = "/usr/lib/systemd/user/openshell-gateway.service";
  const legacyServicePath = "/lib/systemd/user/openshell-gateway.service";
  if (
    !fs.existsSync("/usr/bin/openshell-gateway") &&
    !fs.existsSync(servicePath) &&
    !fs.existsSync(legacyServicePath)
  ) {
    return;
  }
  const envFile = path.join(os.homedir(), ".config", "openshell", "gateway.env");
  fs.mkdirSync(path.dirname(envFile), { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf-8") : "";
  const preserved = existing
    .split("\n")
    .filter(
      (line: string) =>
        line.trim() &&
        !/^OPENSHELL_(DRIVERS|DOCKER_SUPERVISOR_IMAGE|DOCKER_SUPERVISOR_BIN)=/.test(line),
    );
  const override = getDockerDriverGatewayEnv();
  const next = [
    ...preserved,
    `OPENSHELL_DRIVERS=${override.OPENSHELL_DRIVERS}`,
    `OPENSHELL_DOCKER_SUPERVISOR_IMAGE=${override.OPENSHELL_DOCKER_SUPERVISOR_IMAGE}`,
    ...(override.OPENSHELL_DOCKER_SUPERVISOR_BIN
      ? [`OPENSHELL_DOCKER_SUPERVISOR_BIN=${override.OPENSHELL_DOCKER_SUPERVISOR_BIN}`]
      : []),
  ].join("\n");
  fs.writeFileSync(envFile, `${next}\n`, { encoding: "utf-8", mode: 0o600 });
}

function registerDockerDriverGatewayEndpoint(): boolean {
  const selectExisting = runQuietOpenshell(["gateway", "select", GATEWAY_NAME]);
  if (selectExisting.status === 0) {
    const status = runCaptureOpenshell(["status"], { ignoreError: true });
    const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
      ignoreError: true,
    });
    const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
    if (isGatewayHealthy(status, namedInfo, currentInfo)) {
      process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
      return true;
    }
  }

  let addResult = runOpenshell(
    ["gateway", "add", "--local", "--name", GATEWAY_NAME, getDockerDriverGatewayEndpoint()],
    { ignoreError: true, suppressOutput: true },
  );
  if (addResult.status !== 0) {
    removeDockerDriverGatewayRegistration();
    addResult = runOpenshell(
      ["gateway", "add", "--local", "--name", GATEWAY_NAME, getDockerDriverGatewayEndpoint()],
      { ignoreError: true, suppressOutput: true },
    );
  }
  const selectResult = runOpenshell(["gateway", "select", GATEWAY_NAME], {
    ignoreError: true,
    suppressOutput: true,
  });
  const ok =
    (addResult.status === 0 && selectResult.status === 0) ||
    (selectResult.status === 0 &&
      isGatewayHealthy(
        runCaptureOpenshell(["status"], { ignoreError: true }),
        runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], { ignoreError: true }),
        runCaptureOpenshell(["gateway", "info"], { ignoreError: true }),
      ));
  if (ok) {
    process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
  } else if (process.env.OPENSHELL_GATEWAY === GATEWAY_NAME) {
    delete process.env.OPENSHELL_GATEWAY;
  }
  return ok;
}

function getGatewayBootstrapRepairPlan(missingSecrets: string[] = []) {
  const allowed = new Set(GATEWAY_BOOTSTRAP_SECRET_NAMES);
  const normalized = [
    ...new Set((missingSecrets || []).map((name) => String(name).trim()).filter(Boolean)),
  ].filter((name) => allowed.has(name));
  const missing = new Set(normalized);
  const needsClientBundle =
    missing.has("openshell-server-client-ca") || missing.has("openshell-client-tls");

  return {
    missingSecrets: normalized,
    needsRepair: normalized.length > 0,
    needsServerTls: missing.has("openshell-server-tls"),
    needsClientBundle,
    needsHandshake: missing.has("openshell-ssh-handshake"),
  };
}

function buildGatewayBootstrapSecretsScript(missingSecrets: string[] = []): string {
  const plan = getGatewayBootstrapRepairPlan(missingSecrets);
  if (!plan.needsRepair) return "exit 0";

  return `
set -eu
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get namespace openshell >/dev/null 2>&1
kubectl -n openshell get statefulset/openshell >/dev/null 2>&1
TMPDIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT
if ${plan.needsServerTls ? "true" : "false"}; then
  cat >"$TMPDIR/server-ext.cnf" <<'EOF'
subjectAltName=DNS:openshell,DNS:openshell.openshell,DNS:openshell.openshell.svc,DNS:openshell.openshell.svc.cluster.local,DNS:localhost,IP:127.0.0.1
extendedKeyUsage=serverAuth
EOF
  openssl req -nodes -newkey rsa:2048 -keyout "$TMPDIR/server.key" -out "$TMPDIR/server.csr" -subj "/CN=openshell.openshell.svc.cluster.local" >/dev/null 2>&1
  openssl x509 -req -in "$TMPDIR/server.csr" -signkey "$TMPDIR/server.key" -out "$TMPDIR/server.crt" -days 3650 -sha256 -extfile "$TMPDIR/server-ext.cnf" >/dev/null 2>&1
  kubectl create secret tls -n openshell openshell-server-tls --cert="$TMPDIR/server.crt" --key="$TMPDIR/server.key" --dry-run=client -o yaml | kubectl apply -f -
fi
if ${plan.needsClientBundle ? "true" : "false"}; then
  cat >"$TMPDIR/client-ext.cnf" <<'EOF'
extendedKeyUsage=clientAuth
EOF
  openssl req -x509 -nodes -newkey rsa:2048 -keyout "$TMPDIR/client-ca.key" -out "$TMPDIR/client-ca.crt" -subj "/CN=openshell-client-ca" -days 3650 >/dev/null 2>&1
  openssl req -nodes -newkey rsa:2048 -keyout "$TMPDIR/client.key" -out "$TMPDIR/client.csr" -subj "/CN=openshell-client" >/dev/null 2>&1
  openssl x509 -req -in "$TMPDIR/client.csr" -CA "$TMPDIR/client-ca.crt" -CAkey "$TMPDIR/client-ca.key" -CAcreateserial -out "$TMPDIR/client.crt" -days 3650 -sha256 -extfile "$TMPDIR/client-ext.cnf" >/dev/null 2>&1
  kubectl create secret generic -n openshell openshell-server-client-ca --from-file=ca.crt="$TMPDIR/client-ca.crt" --dry-run=client -o yaml | kubectl apply -f -
  kubectl create secret generic -n openshell openshell-client-tls --from-file=tls.crt="$TMPDIR/client.crt" --from-file=tls.key="$TMPDIR/client.key" --from-file=ca.crt="$TMPDIR/client-ca.crt" --dry-run=client -o yaml | kubectl apply -f -
fi
if ${plan.needsHandshake ? "true" : "false"}; then
  kubectl create secret generic -n openshell openshell-ssh-handshake --from-literal=secret="$(openssl rand -hex 32)" --dry-run=client -o yaml | kubectl apply -f -
fi
`;
}

function runGatewayClusterCapture(script: string, opts: RunnerOptions = {}) {
  return runCapture(buildGatewayClusterExecArgv(script), opts);
}

function runGatewayCluster(script: string, opts: RunnerOptions = {}) {
  return run(buildGatewayClusterExecArgv(script), opts);
}

function listMissingGatewayBootstrapSecrets() {
  const output = runGatewayClusterCapture(
    `
set -eu
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get namespace openshell >/dev/null 2>&1 || exit 0
kubectl -n openshell get statefulset/openshell >/dev/null 2>&1 || exit 0
for name in ${GATEWAY_BOOTSTRAP_SECRET_NAMES.map((name) => shellQuote(name)).join(" ")}; do
  kubectl -n openshell get secret "$name" >/dev/null 2>&1 || printf '%s\\n' "$name"
done
`,
    { ignoreError: true },
  );
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function gatewayClusterHealthcheckPassed(): boolean {
  const result = runGatewayCluster("/usr/local/bin/cluster-healthcheck.sh", {
    ignoreError: true,
    suppressOutput: true,
  });
  return result.status === 0;
}

function repairGatewayBootstrapSecrets(): { repaired: boolean; missingSecrets: string[] } {
  const missingSecrets = listMissingGatewayBootstrapSecrets();
  const plan = getGatewayBootstrapRepairPlan(missingSecrets);
  if (!plan.needsRepair) return { repaired: false, missingSecrets };

  console.log(
    `  OpenShell bootstrap secrets missing: ${plan.missingSecrets.join(", ")}. Repairing...`,
  );
  const repairResult = runGatewayCluster(buildGatewayBootstrapSecretsScript(plan.missingSecrets), {
    ignoreError: true,
    suppressOutput: true,
  });
  const remainingSecrets = listMissingGatewayBootstrapSecrets();
  if (repairResult.status === 0 && remainingSecrets.length === 0) {
    console.log("  ✓ OpenShell bootstrap secrets created");
    return { repaired: true, missingSecrets: remainingSecrets };
  }
  return { repaired: false, missingSecrets: remainingSecrets };
}

function attachGatewayMetadataIfNeeded({
  forceRefresh = false,
}: { forceRefresh?: boolean } = {}): boolean {
  const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
    ignoreError: true,
  });
  // runCaptureOpenshell may return stale-but-present gateway metadata. When
  // hasStaleGateway(gwInfo) is truthy we skip runOpenshell unless a repair
  // flow explicitly forces a refresh after recreating bootstrap secrets.
  if (!forceRefresh && hasStaleGateway(gwInfo)) return true;

  if (isLinuxDockerDriverGatewayEnabled()) {
    return registerDockerDriverGatewayEndpoint();
  }

  const addResult = runOpenshell(
    ["gateway", "add", "--local", "--name", GATEWAY_NAME, getGatewayLocalEndpoint()],
    { ignoreError: true, suppressOutput: true },
  );
  if (addResult.status === 0) {
    console.log("  ✓ Gateway metadata reattached");
    return true;
  }
  return false;
}

async function ensureNamedCredential(
  envName: string | null,
  label: string,
  helpUrl: string | null = null,
): Promise<string> {
  if (!envName) {
    console.error(`  Missing credential target for ${label}.`);
    process.exit(1);
  }
  let key = getCredential(envName);
  if (key) {
    process.env[envName] = key;
    return key;
  }
  return replaceNamedCredential(envName, label, helpUrl);
}

function waitForSandboxReady(sandboxName: string, attempts = 10, delaySeconds = 2): boolean {
  for (let i = 0; i < attempts; i += 1) {
    if (isLinuxDockerDriverGatewayEnabled()) {
      const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      if (isSandboxReady(list, sandboxName)) return true;
      if (i < attempts - 1) sleep(delaySeconds);
      continue;
    }
    const podPhase = runCaptureOpenshell(
      [
        "doctor",
        "exec",
        "--",
        "kubectl",
        "-n",
        "openshell",
        "get",
        "pod",
        sandboxName,
        "-o",
        "jsonpath={.status.phase}",
      ],
      { ignoreError: true },
    );
    if (podPhase === "Running") return true;
    sleep(delaySeconds);
  }
  return false;
}

// parsePolicyPresetEnv — see urlUtils import above
// isSafeModelId — see validation import above

// getNonInteractiveProvider, getNonInteractiveModel — moved to onboard-providers.ts

// ── Step 1: Preflight ────────────────────────────────────────────

// CDI spec gap (#3152). When Docker is configured for CDI device injection
// (CDISpecDirs is set) but no nvidia.com/gpu spec is present, OpenShell's
// `gateway start --gpu` fails minutes later with `unresolvable CDI devices
// nvidia.com/gpu=all`. Block now and surface `nvidia-ctk cdi generate`. The
// check is a no-op when the user opts out of GPU passthrough (--no-gpu),
// since the legacy nvidia runtime does not need a CDI spec.
//
// Extracted so the same guard runs on the `--resume` branch, where preflight()
// itself is skipped via the cached session.
function assertCdiNvidiaGpuSpecPresent(
  host: ReturnType<typeof assessHost>,
  optedOutGpuPassthrough: boolean,
): void {
  if (!host.cdiNvidiaGpuSpecMissing || optedOutGpuPassthrough) return;
  console.error(
    "  Docker is configured for CDI device injection (CDISpecDirs is set), but no",
  );
  console.error(
    "  nvidia.com/gpu CDI spec was found on the host. OpenShell's gateway start will",
  );
  console.error(
    "  fail with `unresolvable CDI devices nvidia.com/gpu=all` (issue #3152).",
  );
  printRemediationActions(planHostRemediation(host));
  process.exit(1);
}

type PreflightOptions = Pick<
  OnboardOptions,
  "sandboxGpu" | "sandboxGpuDevice" | "gpu" | "noGpu"
> & {
  optedOutGpuPassthrough?: boolean;
};

async function preflight(
  preflightOpts: PreflightOptions = {},
): Promise<ReturnType<typeof nim.detectGpu>> {
  step(1, 8, "Preflight checks");

  const host = assessHost();

  // Docker / runtime
  if (!host.dockerReachable) {
    console.error("  Docker is not reachable. Please fix Docker and try again.");
    printRemediationActions(planHostRemediation(host));
    process.exit(1);
  }
  console.log("  ✓ Docker is running");

  const optedOutGpuPassthrough =
    preflightOpts.optedOutGpuPassthrough === true || preflightOpts.noGpu === true;
  assertCdiNvidiaGpuSpecPresent(host, optedOutGpuPassthrough);

  // DNS resolution from inside containers (#2101). A corp firewall that
  // blocks outbound UDP:53 to public resolvers leaves the sandbox build
  // unable to resolve registry.npmjs.org; npm then retries for ~15 min and
  // prints the cryptic `Exit handler never called`.
  const dns = probeContainerDns();
  // Only reasons where the probe actually *ran* nslookup and observed a DNS
  // failure warrant blocking — other reasons are inconclusive (probe itself
  // couldn't run, got killed, etc.) and shouldn't fail a valid environment.
  const dnsIsFatal = dns.reason === "servers_unreachable" || dns.reason === "resolution_failed";

  if (dns.ok) {
    console.log("  ✓ Container DNS resolution works");
  } else if (!dnsIsFatal) {
    // Inconclusive probe — warn but proceed. If the sandbox build really
    // does hit a DNS issue, the user will see #2101 pointers in that layer.
    if (dns.reason === "image_pull_failed") {
      console.warn(
        "  ⚠ Container DNS probe inconclusive: docker couldn't pull the busybox test image.",
      );
      console.warn("    This usually means the docker daemon itself can't reach Docker Hub,");
      console.warn(
        "    but doesn't prove container DNS is broken — the sandbox build may still succeed.",
      );
    } else {
      console.warn(`  ⚠ Container DNS probe inconclusive (reason: ${dns.reason ?? "unknown"}).`);
    }
    if (dns.details) {
      for (const line of String(dns.details).split("\n").slice(-3)) {
        if (line.trim()) console.warn(`    ${line.trim()}`);
      }
    }
    console.warn("    Proceeding. If the sandbox build later hangs at `npm ci`, see issue #2101.");
  } else {
    console.error("  ✗ DNS resolution from inside a docker container failed.");
    if (dns.details) {
      for (const line of String(dns.details).split("\n").slice(-4)) {
        if (line.trim()) console.error(`    ${line.trim()}`);
      }
    }
    console.error("");
    {
      console.error("  The sandbox build runs `npm ci` inside a container and needs to resolve");
      console.error("  registry.npmjs.org. On networks that block outbound UDP:53 to public DNS");
      console.error("  (common in corporate environments that force DNS-over-TLS on the host),");
      console.error("  the build appears to hang for ~15 minutes and then prints the cryptic");
      console.error("  `npm error Exit handler never called`. See issue #2101.");
      console.error("");
      console.error("  Fix options:");
      console.error("");

      // Platform-aware remediation hints. The systemd-resolved fix is
      // Linux-specific; macOS / Windows / WSL-backed-by-Docker-Desktop
      // hosts configure DNS through Docker Desktop's GUI or a
      // platform-specific daemon.json path, so we avoid printing shell
      // commands that would mislead those users.
      const isLinuxWithSystemd =
        host.platform === "linux" && !host.isWsl && host.systemctlAvailable;

      const printLinuxFix = (bridgeIp: string, note: string | null) => {
        if (note) console.error(note);
        console.error("       sudo mkdir -p /etc/systemd/resolved.conf.d/");
        console.error(
          `       printf '[Resolve]\\nDNSStubListenerExtra=${bridgeIp}\\n' | sudo tee /etc/systemd/resolved.conf.d/docker-bridge.conf`,
        );
        console.error("       sudo systemctl restart systemd-resolved");
        console.error("");
        console.error(
          "     Then add the dns key to /etc/docker/daemon.json (safely merges with existing config if jq is installed):",
        );
        console.error(
          "       sudo cp /etc/docker/daemon.json /etc/docker/daemon.json.bak-$(date +%s) 2>/dev/null",
        );
        console.error(
          `       { sudo jq '. + {"dns":["${bridgeIp}"]}' /etc/docker/daemon.json 2>/dev/null || echo '{"dns":["${bridgeIp}"]}'; } | sudo tee /etc/docker/daemon.json.new >/dev/null`,
        );
        console.error("       sudo mv /etc/docker/daemon.json.new /etc/docker/daemon.json");
        console.error("       sudo systemctl restart docker");
      };

      if (isLinuxWithSystemd) {
        const detectedBridgeIp = getDockerBridgeGatewayIp();
        const bridgeIp = detectedBridgeIp || "172.17.0.1";
        let bridgeNote: string | null = null;
        if (detectedBridgeIp && detectedBridgeIp !== "172.17.0.1") {
          bridgeNote = `     (detected your docker bridge gateway at ${detectedBridgeIp})`;
        } else if (!detectedBridgeIp) {
          bridgeNote =
            "     (could not auto-detect bridge IP; using docker's default — verify with:\n" +
            "      docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')";
        }
        console.error("  1. Make systemd-resolved reachable from containers (recommended):");
        printLinuxFix(bridgeIp, bridgeNote);
        console.error("");
        console.error("  2. Configure an explicit UDP:53-capable DNS in /etc/docker/daemon.json");
        console.error("     (ask your IT team for an internal DNS server IP).");
      } else if (host.platform === "darwin") {
        // On macOS, branch by the detected runtime (host.runtime) so users get
        // shell commands they can actually paste, not a "click this GUI" hint.
        if (host.runtime === "colima") {
          console.error("  Configure Colima's DNS (macOS):");
          console.error("       colima stop");
          console.error("       colima start --dns <corp-dns-ip>");
          console.error("     (or edit ~/.colima/default/colima.yaml and `colima restart`)");
        } else if (host.runtime === "docker-desktop" || host.runtime === "docker") {
          console.error("  Configure Docker Desktop's DNS (macOS):");
          console.error(
            "       cp ~/.docker/daemon.json ~/.docker/daemon.json.bak-$(date +%s) 2>/dev/null",
          );
          console.error(
            `       { jq '. + {"dns":["<corp-dns-ip>"]}' ~/.docker/daemon.json 2>/dev/null || echo '{"dns":["<corp-dns-ip>"]}'; } > ~/.docker/daemon.json.new && mv ~/.docker/daemon.json.new ~/.docker/daemon.json`,
          );
          console.error("       osascript -e 'quit app \"Docker\"' && sleep 3 && open -a Docker");
          console.error(
            "     (or do the same via the Docker Desktop UI: Settings → Docker Engine)",
          );
        } else {
          // Unknown / podman / other
          console.error("  Configure your container runtime's DNS (macOS):");
          console.error("     - Docker Desktop:");
          console.error(
            '         { jq \'. + {"dns":["<corp-dns-ip>"]}\' ~/.docker/daemon.json 2>/dev/null || echo \'{"dns":["<corp-dns-ip>"]}\'; } > ~/.docker/daemon.json.new && mv ~/.docker/daemon.json.new ~/.docker/daemon.json',
          );
          console.error("         osascript -e 'quit app \"Docker\"' && sleep 3 && open -a Docker");
          console.error("     - Colima:");
          console.error("         colima stop && colima start --dns <corp-dns-ip>");
          console.error("     - Rancher Desktop / Podman: edit the runtime's DNS config");
          console.error("       and restart it.");
        }
        console.error("     Ask your IT team for an internal DNS server IP that accepts UDP:53.");
      } else if (host.platform === "win32" || host.isWsl) {
        console.error("  1. Configure Docker Desktop's DNS (Windows / WSL via Docker Desktop):");
        console.error(
          "       Docker Desktop for Windows → Settings → Docker Engine — edit the JSON to add:",
        );
        console.error('         { "dns": ["<corp-dns-ip>"] }');
        console.error("       Then click Apply & Restart.");
        console.error("");
        console.error(
          "  2. If you run docker natively inside WSL (not Docker Desktop), apply the Linux fix:",
        );
        // Reuse the same bridge-IP detection the Linux branch uses — a
        // native-docker-in-WSL install can have a custom bridge subnet
        // just like any other Linux host, so a hardcoded 172.17.0.1
        // would break those users' copy-paste.
        const wslBridgeIp = getDockerBridgeGatewayIp();
        let wslBridgeNote: string | null = null;
        if (wslBridgeIp && wslBridgeIp !== "172.17.0.1") {
          wslBridgeNote = `     (detected your docker bridge gateway at ${wslBridgeIp})`;
        } else if (!wslBridgeIp) {
          wslBridgeNote =
            "     (could not auto-detect bridge IP — the snippet below uses docker's default; verify with:\n" +
            "      docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')";
        }
        printLinuxFix(wslBridgeIp || "172.17.0.1", wslBridgeNote);
      } else {
        console.error("  Configure your docker daemon to use a DNS server that accepts UDP:53.");
        console.error(
          '  Add { "dns": ["<corp-dns-ip>"] } to your docker daemon.json and restart the daemon.',
        );
        console.error("  Ask your IT team for an internal DNS server IP.");
      }
      console.error("");
      console.error("  Verify the fix worked:");
      console.error("    docker run --rm busybox nslookup registry.npmjs.org");
    }
    process.exit(1);
  }

  if (host.runtime !== "unknown") {
    console.log(`  ✓ Container runtime: ${host.runtime}`);
  }
  if (isLinuxDockerDriverGatewayPlatform() && host.runtime === "podman") {
    console.error("  ✗ NemoClaw Linux onboarding now uses OpenShell's Docker driver.");
    console.error("    Podman is not supported for this NemoClaw integration path.");
    console.error("    Switch to Docker Engine and rerun onboarding.");
    process.exit(1);
  }
  if (host.notes.includes("Running under WSL")) {
    console.log("  ⓘ Running under WSL");
  }

  if (
    host.isContainerRuntimeUnderProvisioned &&
    process.env.NEMOCLAW_IGNORE_RUNTIME_RESOURCES !== "1"
  ) {
    const detected: string[] = [];
    if (typeof host.dockerCpus === "number") detected.push(`${host.dockerCpus} vCPU`);
    if (typeof host.dockerMemTotalBytes === "number") {
      const gib = host.dockerMemTotalBytes / 1024 ** 3;
      detected.push(`${gib.toFixed(1)} GiB`);
    }
    const detectedStr = detected.length > 0 ? detected.join(" / ") : "unknown";
    console.warn(
      `  ⚠ Container runtime under-provisioned: ${detectedStr} detected ` +
        `(recommended: ${preflightUtils.MIN_RECOMMENDED_DOCKER_CPUS} vCPU / ${preflightUtils.MIN_RECOMMENDED_DOCKER_MEM_GIB} GiB).`,
    );
    console.warn(
      "    The sandbox build will be slow and may stall on default Colima settings.",
    );
    if (host.runtime === "colima") {
      console.warn(
        `    Suggested: colima stop && colima start --cpu ${preflightUtils.MIN_RECOMMENDED_DOCKER_CPUS} --memory ${preflightUtils.MIN_RECOMMENDED_DOCKER_MEM_GIB}`,
      );
    } else if (host.runtime === "docker-desktop") {
      console.warn("    Suggested: Docker Desktop → Settings → Resources, raise CPU/memory.");
    }
    console.warn(
      "    Set NEMOCLAW_IGNORE_RUNTIME_RESOURCES=1 to silence this check.",
    );
    if (!isNonInteractive()) {
      const proceed = await promptYesNoOrDefault("  Continue with onboarding?", null, true);
      if (!proceed) {
        console.error("  Aborted by user. Resize your container runtime and rerun `nemoclaw onboard`.");
        process.exit(1);
      }
    }
  } else if (host.dockerReachable) {
    const detected: string[] = [];
    if (typeof host.dockerCpus === "number") detected.push(`${host.dockerCpus} vCPU`);
    if (typeof host.dockerMemTotalBytes === "number") {
      const gib = host.dockerMemTotalBytes / 1024 ** 3;
      detected.push(`${gib.toFixed(1)} GiB`);
    }
    if (detected.length > 0) {
      console.log(`  ✓ Container runtime resources: ${detected.join(" / ")}`);
    }
  }

  // OpenShell CLI — install if missing, upgrade if below minimum version.
  // MIN_VERSION in install-openshell.sh handles the version gate; calling it
  // when openshell already exists is safe (it exits early if version is OK).
  let openshellInstall: {
    installed?: boolean;
    localBin: string | null;
    futureShellPathHint: string | null;
  } = {
    localBin: null,
    futureShellPathHint: null,
  };
  if (!isOpenshellInstalled()) {
    console.log("  openshell CLI not found. Installing...");
    openshellInstall = installOpenshell();
    if (!openshellInstall.installed) {
      console.error("  Failed to install openshell CLI.");
      console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
      process.exit(1);
    }
  } else {
    // Ensure the installed version meets the minimum required by install-openshell.sh.
    // The script itself is idempotent — it exits early if the version is already sufficient.
    const currentVersion = getInstalledOpenshellVersion();
    if (!currentVersion) {
      console.log("  openshell version could not be determined. Reinstalling...");
      openshellInstall = installOpenshell();
      if (!openshellInstall.installed) {
        console.error("  Failed to reinstall openshell CLI.");
        console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
        process.exit(1);
      }
    } else {
      // Source of truth: min_openshell_version in nemoclaw-blueprint/blueprint.yaml.
      // Fall back to the released Docker-driver floor (also MIN_VERSION in
      // scripts/install-openshell.sh) if the blueprint cannot be read.
      const minOpenshellVersion = getBlueprintMinOpenshellVersion() ?? "0.0.37";
      const currentVersionOutput = runCaptureOpenshell(["--version"], { ignoreError: true });
      const needsDevChannel =
        isLinuxDockerDriverGatewayEnabled() &&
        shouldUseOpenshellDevChannel() &&
        !isOpenshellDevVersion(currentVersionOutput);
      const needsDockerDriverBinaries =
        isLinuxDockerDriverGatewayEnabled() && !areRequiredDockerDriverBinariesPresent();
      const needsUpgrade =
        !versionGte(currentVersion, minOpenshellVersion) ||
        needsDevChannel ||
        needsDockerDriverBinaries;
      if (needsUpgrade) {
        if (needsDevChannel) {
          console.log("  OpenShell Docker-driver onboarding requires the dev channel. Upgrading...");
        } else if (needsDockerDriverBinaries) {
          const required =
            process.platform === "linux"
              ? "gateway and sandbox"
              : process.platform === "darwin"
                ? "gateway and VM driver"
                : "gateway";
          console.log(
            `  OpenShell standalone gateway onboarding requires the ${required} binaries. Reinstalling...`,
          );
        } else {
          console.log(
            `  openshell ${currentVersion} is below minimum required version. Upgrading...`,
          );
        }
        openshellInstall = installOpenshell();
        if (!openshellInstall.installed) {
          console.error("  Failed to upgrade openshell CLI.");
          console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
          process.exit(1);
        }
      }
    }
  }
  const openshellVersionOutput = runCaptureOpenshell(["--version"], { ignoreError: true });
  console.log(`  ✓ openshell CLI: ${openshellVersionOutput || "unknown"}`);
  // Enforce nemoclaw-blueprint/blueprint.yaml's min_openshell_version. Without
  // this check, users can complete a full onboard against an OpenShell that
  // pre-dates required CLI surface (e.g. `sandbox exec`, `--upload`) and hit
  // silent failures inside the sandbox at runtime. See #1317.
  const installedOpenshellVersion = getInstalledOpenshellVersion(openshellVersionOutput);
  const minOpenshellVersion = getBlueprintMinOpenshellVersion();
  if (
    installedOpenshellVersion &&
    minOpenshellVersion &&
    !versionGte(installedOpenshellVersion, minOpenshellVersion)
  ) {
    console.error("");
    console.error(
      `  ✗ openshell ${installedOpenshellVersion} is below the minimum required by this NemoClaw release.`,
    );
    console.error(`    blueprint.yaml min_openshell_version: ${minOpenshellVersion}`);
    console.error("");
    console.error("    Upgrade openshell and retry:");
    console.error("      https://github.com/NVIDIA/OpenShell/releases");
    console.error(
      "    Or remove the existing binary so the installer can re-fetch a current build:",
    );
    console.error('      command -v openshell && rm -f "$(command -v openshell)"');
    console.error("");
    process.exit(1);
  }
  // Enforce nemoclaw-blueprint/blueprint.yaml's max_openshell_version. Newer
  // OpenShell releases may change sandbox semantics that this NemoClaw version
  // has not been validated against. Blocking early avoids silent runtime
  // breakage. Users should upgrade NemoClaw to pick up support for newer
  // OpenShell releases.
  const maxOpenshellVersion = getBlueprintMaxOpenshellVersion();
  if (
    installedOpenshellVersion &&
    maxOpenshellVersion &&
    !versionGte(maxOpenshellVersion, installedOpenshellVersion) &&
    !shouldAllowOpenshellAboveBlueprintMax(openshellVersionOutput)
  ) {
    console.error("");
    console.error(
      `  ✗ openshell ${installedOpenshellVersion} is above the maximum supported by this NemoClaw release.`,
    );
    console.error(`    blueprint.yaml max_openshell_version: ${maxOpenshellVersion}`);
    console.error("");
    console.error(
      `    Upgrade ${cliDisplayName()} to a version that supports your OpenShell release,`,
    );
    console.error("    or install a supported OpenShell version:");
    console.error("      https://github.com/NVIDIA/OpenShell/releases");
    console.error("");
    process.exit(1);
  }
  if (openshellInstall.futureShellPathHint) {
    console.log(
      `  Note: openshell was installed to ${openshellInstall.localBin} for this onboarding run.`,
    );
    console.log(`  Future shells may still need: ${openshellInstall.futureShellPathHint}`);
    console.log(
      "  Add that export to your shell profile, or open a new terminal before running openshell directly.",
    );
  }

  // Clean up stale or unnamed NemoClaw gateway state before checking ports.
  // A healthy named gateway can be reused later in onboarding, so avoid
  // tearing it down here. If some other gateway is active but the named
  // NemoClaw gateway exists, select it before the port checks so onboarding
  // reuses the user's NemoClaw gateway instead of reporting a false conflict.
  const gatewaySnapshot = selectNamedGatewayForReuseIfNeeded(getGatewayReuseSnapshot());
  let gatewayReuseState = gatewaySnapshot.gatewayReuseState;
  gatewayReuseState = await refreshDockerDriverGatewayReuseState(gatewayReuseState);

  // Verify the gateway container is actually running — openshell CLI metadata
  // can be stale after a manual `docker rm`. See #2020.
  if (gatewayReuseState === "healthy" && !isLinuxDockerDriverGatewayEnabled()) {
    const containerState = verifyGatewayContainerRunning();
    if (containerState === "missing") {
      console.log("  Gateway metadata is stale (container not running). Cleaning up...");
      runOpenshell(["forward", "stop", String(DASHBOARD_PORT)], { ignoreError: true });
      destroyGateway();
      registry.clearAll();
      gatewayReuseState = "missing";
      console.log("  ✓ Stale gateway metadata cleaned up");
    } else if (containerState === "unknown") {
      // Docker probe failed but cached metadata says healthy. Try the host-level
      // HTTP probe — it doesn't depend on Docker, so it can confirm the gateway
      // is genuinely serving even when the daemon is flaky.
      //
      // Per #2020 the "unknown" state must stay non-destructive end-to-end:
      // do not downgrade to "missing" in preflight even when HTTP probe fails.
      // Doing so would feed the orphan-cleanup block below, and a transient
      // `docker inspect` failure plus an HTTP warm-up miss would delete a
      // live gateway. The main onboard "unknown" branch makes the abort/reuse
      // decision once preflight has surfaced the warning to the user.
      if (await waitForGatewayHttpReady()) {
        console.log(
          "  Warning: could not verify gateway container state (Docker may be unavailable), but the gateway is responding on HTTP. Proceeding with reuse.",
        );
      } else {
        console.log(
          "  Warning: could not verify gateway container state and the gateway is not responding on HTTP. Onboard will abort before reuse if this persists; restart Docker and re-run.",
        );
      }
    } else if (!(await waitForGatewayHttpReady())) {
      // Container is running but the gateway HTTP endpoint is not responding.
      // Common immediately after a Docker daemon restart — the container comes
      // back before the OpenShell gateway upstream finishes warming up. Safe to
      // recreate because Docker is functional. See #3258.
      console.log(
        `  Gateway container is running but http://127.0.0.1:${GATEWAY_PORT}/ is not responding. Recreating...`,
      );
      runOpenshell(["forward", "stop", String(DASHBOARD_PORT)], { ignoreError: true });
      destroyGateway();
      registry.clearAll();
      gatewayReuseState = "missing";
      console.log("  ✓ Stale gateway cleaned up");
    } else {
      const imageDrift = getGatewayClusterImageDrift();
      if (imageDrift) {
        console.log(
          `  Gateway image ${imageDrift.currentVersion} does not match openshell ${imageDrift.expectedVersion}. Recreating...`,
        );
        stopAllDashboardForwards();
        destroyGateway();
        registry.clearAll();
        gatewayReuseState = "missing";
        console.log("  ✓ Previous gateway cleaned up");
      }
    }
  }

  if (gatewayReuseState === "stale" || gatewayReuseState === "active-unnamed") {
    console.log(`  Cleaning up previous ${cliDisplayName()} session...`);
    runOpenshell(["forward", "stop", String(DASHBOARD_PORT)], { ignoreError: true });
    destroyGateway();
    console.log("  ✓ Previous session cleaned up");
  }

  // Clean up orphaned Docker containers from interrupted onboard (e.g. Ctrl+C
  // during gateway start). The container may still be running even though
  // OpenShell has no metadata for it (gatewayReuseState === "missing").
  if (gatewayReuseState === "missing" && !isLinuxDockerDriverGatewayEnabled()) {
    const containerName = `openshell-cluster-${GATEWAY_NAME}`;
    const inspectResult = dockerInspect(
      ["--type", "container", "--format", "{{.State.Status}}", containerName],
      { ignoreError: true, suppressOutput: true },
    );
    if (inspectResult.status === 0) {
      console.log("  Cleaning up orphaned gateway container...");
      dockerStop(containerName, {
        ignoreError: true,
        suppressOutput: true,
      });
      dockerRm(containerName, {
        ignoreError: true,
        suppressOutput: true,
      });
      const postInspectResult = dockerInspect(["--type", "container", containerName], {
        ignoreError: true,
        suppressOutput: true,
      });
      if (postInspectResult.status !== 0) {
        dockerRemoveVolumesByPrefix(`openshell-cluster-${GATEWAY_NAME}`, {
          ignoreError: true,
          suppressOutput: true,
        });
        registry.clearAll();
        console.log("  ✓ Orphaned gateway container removed");
      } else {
        console.warn("  ! Found an orphaned gateway container, but automatic cleanup failed.");
      }
    }
  }

  // Required ports — gateway, plus the dashboard port when an explicit one
  // is requested. envVar is the override env var documented in
  // src/lib/core/ports.ts; surfacing it in the preflight error gives users a clear
  // escape hatch when an unrelated process is holding the default port
  // (closes #2497). When --control-ui-port is set, check that port instead
  // of the default. When auto-allocation is possible (no explicit port),
  // skip the dashboard port check entirely — ensureDashboardForward will
  // find a free port.
  const dashboardPortToCheck = _preflightDashboardPort ?? null;
  const requiredPorts = [
    { port: GATEWAY_PORT, label: "OpenShell gateway", envVar: "NEMOCLAW_GATEWAY_PORT" },
    ...(dashboardPortToCheck !== null
      ? [
          {
            port: dashboardPortToCheck,
            label: `${cliDisplayName()} dashboard`,
            envVar: "NEMOCLAW_DASHBOARD_PORT",
          },
        ]
      : []),
  ];
  for (const { port, label, envVar } of requiredPorts) {
    let portCheck = await checkPortAvailable(port);
    if (!portCheck.ok) {
      if ((port === GATEWAY_PORT || port === DASHBOARD_PORT) && gatewayReuseState === "healthy") {
        console.log(
          `  ✓ Port ${port} already owned by healthy ${cliDisplayName()} runtime (${label})`,
        );
        continue;
      }
      if (port === GATEWAY_PORT) {
        const dockerGatewayPid = getDockerDriverGatewayPortListenerPid(portCheck);
        if (dockerGatewayPid !== null) {
          rememberDockerDriverGatewayPid(dockerGatewayPid);
          console.log(
            `  ✓ Port ${port} already owned by NemoClaw OpenShell Docker gateway (${label})`,
          );
          continue;
        }
      }
      // Auto-cleanup orphaned SSH port-forward from a previous NemoClaw session
      // (e.g. dashboard forward left behind after destroy). Only kill the process
      // if its command line contains "openshell" to avoid killing unrelated SSH
      // tunnels the user may have set up on the same port. (#1950)
      if (port === DASHBOARD_PORT && portCheck.process === "ssh" && portCheck.pid) {
        // Use `ps` to get the command line — works on Linux, macOS, and WSL.
        const cmdline = captureProcessArgs(portCheck.pid);
        if (cmdline.includes("openshell")) {
          console.log(
            `  Cleaning up orphaned SSH port-forward on port ${port} (PID ${portCheck.pid})...`,
          );
          run(["kill", String(portCheck.pid)], { ignoreError: true });
          sleep(1);
          portCheck = await checkPortAvailable(port);
          if (portCheck.ok) {
            console.log(`  ✓ Port ${port} available after orphaned forward cleanup (${label})`);
            continue;
          }
        }
      }
      console.error("");
      console.error(`  !! Port ${port} is not available.`);
      console.error(`     ${label} needs this port.`);
      console.error("");
      if (portCheck.process && portCheck.process !== "unknown") {
        console.error(
          `     Blocked by: ${portCheck.process}${portCheck.pid ? ` (PID ${portCheck.pid})` : ""}`,
        );
        console.error("");
        console.error("     To fix, stop the conflicting process:");
        console.error("");
        if (portCheck.pid) {
          console.error(`       sudo kill ${portCheck.pid}`);
        } else {
          console.error(`       sudo lsof -i :${port} -sTCP:LISTEN -P -n`);
        }
        for (const hint of getPortConflictServiceHints()) {
          console.error(hint);
        }
      } else {
        console.error(`     Could not identify the process using port ${port}.`);
        console.error(`     Run: sudo lsof -i :${port} -sTCP:LISTEN`);
      }
      console.error("");
      console.error(`     Or rerun with a different port:`);
      console.error(`       ${envVar}=<port> nemoclaw onboard`);
      console.error("");
      console.error(`     Detail: ${portCheck.reason}`);
      process.exit(1);
    }
    console.log(`  ✓ Port ${port} available (${label})`);
  }

  // GPU
  const gpu = nim.detectGpu();
  if (gpu && gpu.type === "nvidia") {
    const lines = nim.formatNvidiaGpuPreflightLines(gpu);
    console.log(`  ✓ ${lines[0]}`);
    for (const extra of lines.slice(1)) {
      console.log(`  ${extra}`);
    }
    if (!gpu.nimCapable) {
      console.log("  ⓘ Local NIM unavailable — GPU VRAM too small");
    }
  } else if (gpu && gpu.type === "apple") {
    console.log(
      `  ✓ Apple GPU detected: ${gpu.name}${gpu.cores ? ` (${gpu.cores} cores)` : ""}, ${gpu.totalMemoryMB} MB unified memory`,
    );
    console.log("  ⓘ Local NIM unavailable — requires NVIDIA GPU");
  } else {
    console.log("  ⓘ Local NIM unavailable — no GPU detected");
  }

  const sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
    flag: resolveSandboxGpuFlagFromOptions(preflightOpts),
    device: preflightOpts.sandboxGpuDevice ?? null,
  });
  validateSandboxGpuPreflight(sandboxGpuConfig);
  if (sandboxGpuConfig.sandboxGpuEnabled) {
    console.log(
      `  ✓ Sandbox GPU: enabled (${sandboxGpuConfig.mode}${sandboxGpuConfig.sandboxGpuDevice ? `, device ${sandboxGpuConfig.sandboxGpuDevice}` : ""})`,
    );
  } else if (sandboxGpuConfig.mode === "0") {
    console.log("  ✓ Sandbox GPU: disabled by configuration");
  } else {
    console.log("  ⓘ Sandbox GPU: disabled (no NVIDIA GPU detected)");
  }

  // Memory / swap check (Linux only)
  if (process.platform === "linux") {
    const mem = getMemoryInfo();
    if (mem) {
      if (mem.totalMB < 12000) {
        console.log(
          `  ⚠ Low memory detected (${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap = ${mem.totalMB} MB total)`,
        );

        let proceedWithSwap: boolean = false;
        if (!isNonInteractive()) {
          const answer = await prompt(
            "  Create a 4 GB swap file to prevent OOM during sandbox build? (requires sudo) [y/N]: ",
          );
          proceedWithSwap = Boolean(answer && answer.toLowerCase().startsWith("y"));
        }

        if (!proceedWithSwap) {
          console.log(
            "  ⓘ Skipping swap creation. Sandbox build may fail with OOM on this system.",
          );
        } else {
          console.log("  Creating 4 GB swap file to prevent OOM during sandbox build...");
          const swapResult = ensureSwap(12000);
          if (swapResult.ok && swapResult.swapCreated) {
            console.log("  ✓ Swap file created and activated");
          } else if (swapResult.ok) {
            if (swapResult.reason) {
              console.log(`  ⓘ ${swapResult.reason} — existing swap should help prevent OOM`);
            } else {
              console.log(`  ✓ Memory OK: ${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap`);
            }
          } else {
            console.log(`  ⚠ Could not create swap: ${swapResult.reason}`);
            console.log("  Sandbox creation may fail with OOM on low-memory systems.");
          }
        }
      } else {
        console.log(`  ✓ Memory OK: ${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap`);
      }
    }
  }

  return gpu;
}

// ── Step 2: Gateway ──────────────────────────────────────────────

/** Start the OpenShell gateway with retry logic and post-start health polling. */
async function startGatewayWithOptions(
  _gpu: ReturnType<typeof nim.detectGpu>,
  { exitOnFailure = true, gpuPassthrough = false }: { exitOnFailure?: boolean; gpuPassthrough?: boolean } = {},
) {
  step(2, 8, "Starting OpenShell gateway");

  if (isLinuxDockerDriverGatewayEnabled()) {
    return startDockerDriverGateway({ exitOnFailure });
  }

  const gatewaySnapshot = selectNamedGatewayForReuseIfNeeded(getGatewayReuseSnapshot());
  if (
    isGatewayHealthy(
      gatewaySnapshot.gatewayStatus,
      gatewaySnapshot.gwInfo,
      gatewaySnapshot.activeGatewayInfo,
    )
  ) {
    // Final reuse gate — `isGatewayHealthy()` parses openshell CLI metadata,
    // which can be stale when the gateway container was just restarted (e.g.
    // after `colima stop && colima start`). Verify the gateway HTTP endpoint
    // is actually serving before declaring reuse, so we don't skip startup
    // and fail later in step 4 with "Connection refused". See #3258.
    if (await isGatewayHttpReady()) {
      console.log("  ✓ Reusing existing gateway");
      runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
      process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
      return;
    }
    console.log(
      `  Gateway metadata reports healthy but http://127.0.0.1:${GATEWAY_PORT}/ is not responding. Starting a fresh gateway...`,
    );
  }

  // When a stale gateway is detected (metadata exists but container is gone,
  // e.g. after a Docker/Colima restart), skip the destroy — `gateway start`
  // can recover the container without wiping metadata and mTLS certs.
  // The retry loop below will destroy only if start genuinely fails.
  if (hasStaleGateway(gatewaySnapshot.gwInfo)) {
    console.log("  Stale gateway detected — attempting restart without destroy...");
  }

  // Clear stale SSH host keys from previous gateway (fixes #768)
  try {
    const { execFileSync } = require("child_process");
    execFileSync("ssh-keygen", ["-R", `openshell-${GATEWAY_NAME}`], { stdio: "ignore" });
  } catch {
    /* ssh-keygen -R may fail if entry doesn't exist — safe to ignore */
  }
  // Also purge any known_hosts entries matching the gateway hostname pattern
  const knownHostsPath = path.join(os.homedir(), ".ssh", "known_hosts");
  if (fs.existsSync(knownHostsPath)) {
    try {
      const kh = fs.readFileSync(knownHostsPath, "utf8");
      const cleaned = pruneKnownHostsEntries(kh);
      if (cleaned !== kh) fs.writeFileSync(knownHostsPath, cleaned);
    } catch {
      /* best-effort cleanup — ignore read/write errors */
    }
  }

  const gwArgs = ["--name", GATEWAY_NAME, "--port", String(GATEWAY_PORT)];
  // On NVIDIA hosts, pass --gpu unless the user explicitly opted out. This
  // makes direct CUDA tools available in the sandbox by default while still
  // supporting host-side inference providers.
  if (gpuPassthrough) {
    gwArgs.push("--gpu");
  }
  const gatewayEnv = getGatewayStartEnv();
  if (gatewayEnv.OPENSHELL_CLUSTER_IMAGE) {
    console.log(`  Using pinned OpenShell gateway image: ${gatewayEnv.OPENSHELL_CLUSTER_IMAGE}`);
  }

  // Retry gateway start with exponential backoff. On some hosts (Horde VMs,
  // first-run environments) the embedded k3s needs more time than OpenShell's
  // internal health-check window allows. Retrying after a clean destroy lets
  // the second attempt benefit from cached images and cleaner cgroup state.
  // See: https://github.com/NVIDIA/OpenShell/issues/433
  const retries = exitOnFailure ? 2 : 0;
  try {
    await pRetry(
      async () => {
        const startResult = await streamGatewayStart(
          openshellShellCommand(["gateway", "start", ...gwArgs]),
          {
            ...process.env,
            ...gatewayEnv,
          },
        );
        if (startResult.status !== 0) {
          const lines = String(redact(startResult.output || ""))
            .split("\n")
            .map((l) => compactText(l.replace(ANSI_RE, "")))
            .filter(Boolean)
            .map((l) => `    ${l}`);
          if (lines.length > 0) {
            console.log(`  Gateway start returned before healthy:\n${lines.join("\n")}`);
          }
        }
        console.log("  Waiting for gateway health...");
        const healthWait = getGatewayHealthWaitConfig(
          startResult.status,
          getGatewayClusterContainerState(),
        );
        if (healthWait.extended) {
          console.log(
            `  Gateway container is still ${healthWait.containerState}; allowing up to ${
              healthWait.count * healthWait.interval
            }s for first-time startup.`,
          );
        }

        const healthPollCount = healthWait.count;
        const healthPollInterval = healthWait.interval;
        for (let i = 0; i < healthPollCount; i++) {
          const repairResult = repairGatewayBootstrapSecrets();
          if (repairResult.repaired) {
            attachGatewayMetadataIfNeeded({ forceRefresh: true });
          } else if (gatewayClusterHealthcheckPassed()) {
            attachGatewayMetadataIfNeeded();
          }
          // Ensure the gateway remains selected before each probe.
          runCaptureOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
          const status = runCaptureOpenshell(["status"], { ignoreError: true });
          const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
            ignoreError: true,
          });
          const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
          // Require BOTH the openshell CLI metadata to report healthy AND the
          // host HTTP endpoint to be serving — the CLI metadata can report
          // healthy from the previous run while the upstream is still warming
          // up after a Docker daemon restart, leading to "Connection refused"
          // in step 4. See #3258.
          if (isGatewayHealthy(status, namedInfo, currentInfo) && (await isGatewayHttpReady())) {
            return; // success
          }
          if (i < healthPollCount - 1) sleep(healthPollInterval);
        }

        throw new Error("Gateway failed to start");
      },
      {
        retries,
        minTimeout: 10_000,
        factor: 3,
        onFailedAttempt: (err: { attemptNumber: number; retriesLeft: number }) => {
          console.log(
            `  Gateway start attempt ${err.attemptNumber} failed. ${err.retriesLeft} retries left...`,
          );
          if (err.retriesLeft > 0 && exitOnFailure) {
            destroyGateway();
          }
        },
      },
    );
  } catch {
    if (exitOnFailure) {
      handleFinalGatewayStartFailure({ retries });
    }
    throw new Error("Gateway failed to start");
  }

  console.log("  ✓ Gateway is healthy");

  // CoreDNS fix — k3s-inside-Docker has broken DNS forwarding on all platforms.
  const runtime = getContainerRuntime();
  if (shouldPatchCoredns(runtime)) {
    console.log("  Patching CoreDNS DNS forwarding...");
    run(["bash", path.join(SCRIPTS, "fix-coredns.sh"), GATEWAY_NAME], {
      ignoreError: true,
    });
  }
  sleep(5);
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
  process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
}

async function startDockerDriverGateway({
  exitOnFailure = true,
}: { exitOnFailure?: boolean } = {}): Promise<void> {
  writeDockerGatewayDebEnvOverride();
  const gatewayBin = resolveOpenShellGatewayBinary();
  const openshellVersionOutput = runCaptureOpenshell(["--version"], {
    ignoreError: true,
  });
  const gatewayEnv = getDockerDriverGatewayEnv(openshellVersionOutput);

  const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
  const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
    ignoreError: true,
  });
  const activeGatewayInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
  const pidFileGatewayPid = getDockerDriverGatewayPid();
  if (
    pidFileGatewayPid !== null &&
    isDockerDriverGatewayProcessAlive() &&
    isGatewayHealthy(gatewayStatus, gwInfo, activeGatewayInfo)
  ) {
    const drift = getDockerDriverGatewayRuntimeDrift(pidFileGatewayPid, gatewayEnv, gatewayBin);
    if (drift) {
      restartDockerDriverGatewayProcessForDrift(pidFileGatewayPid, drift.reason);
    } else if (registerDockerDriverGatewayEndpoint()) {
      console.log("  ✓ Reusing existing Docker-driver gateway");
      return;
    }
  }

  const portCheck = await checkPortAvailable(GATEWAY_PORT);
  const portListenerPid = getDockerDriverGatewayPortListenerPid(portCheck, { gatewayBin });
  if (portListenerPid !== null) {
    const drift = getDockerDriverGatewayRuntimeDrift(portListenerPid, gatewayEnv, gatewayBin);
    if (drift) {
      rememberDockerDriverGatewayPid(portListenerPid);
      restartDockerDriverGatewayProcessForDrift(portListenerPid, drift.reason);
    } else {
      rememberDockerDriverGatewayPid(portListenerPid);
    }
    if (!drift && registerDockerDriverGatewayEndpoint()) {
      const adoptedStatus = runCaptureOpenshell(["status"], { ignoreError: true });
      const adoptedGwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
        ignoreError: true,
      });
      const adoptedActiveGatewayInfo = runCaptureOpenshell(["gateway", "info"], {
        ignoreError: true,
      });
      if (isGatewayHealthy(adoptedStatus, adoptedGwInfo, adoptedActiveGatewayInfo)) {
        console.log(`  ✓ Reusing existing Docker-driver gateway process (PID ${portListenerPid})`);
        return;
      }
    }
  }
  if (!gatewayBin) {
    console.error("  OpenShell Docker-driver gateway binary not found.");
    console.error("  Install OpenShell v0.0.37, or set NEMOCLAW_OPENSHELL_GATEWAY_BIN.");
    if (exitOnFailure) process.exit(1);
    throw new Error("OpenShell gateway binary not found");
  }

  const existingPid = getDockerDriverGatewayPid() ?? portListenerPid;
  if (existingPid !== null && isPidAlive(existingPid)) {
    if (!isDockerDriverGatewayProcess(existingPid, gatewayBin)) {
      fs.rmSync(getDockerDriverGatewayPidFile(), { force: true });
    } else {
      console.log(`  Restarting unhealthy Docker-driver gateway process (PID ${existingPid})...`);
      try {
        process.kill(existingPid, "SIGTERM");
        sleep(1);
      } catch {
        /* best effort; the new process will surface any remaining port conflict */
      }
    }
  }

  const stateDir = getDockerDriverGatewayStateDir();
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(stateDir, "openshell-gateway.log");
  const outFd = fs.openSync(logPath, "a", 0o600);
  const errFd = fs.openSync(logPath, "a", 0o600);
  console.log("  Starting OpenShell Docker-driver gateway...");
  console.log(`  Gateway log: ${logPath}`);
  const child = spawn(gatewayBin, [], {
    detached: true,
    stdio: ["ignore", outFd, errFd],
    env: {
      ...process.env,
      ...gatewayEnv,
    },
  });
  const childExit = trackChildExit(child); // #3111 zombie-safe liveness
  child.unref();
  const childPid = child.pid ?? 0;
  if (childPid <= 0) {
    throw new Error("OpenShell gateway process did not return a pid");
  }
  rememberDockerDriverGatewayPid(childPid);

  const pollCount = envInt("NEMOCLAW_HEALTH_POLL_COUNT", 30);
  const pollInterval = envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
  for (let i = 0; i < pollCount; i += 1) {
    if (childExit.exited || !isPidAlive(childPid)) {
      break;
    }
    if (!registerDockerDriverGatewayEndpoint()) {
      if (i < pollCount - 1) sleep(pollInterval);
      continue;
    }
    const status = runCaptureOpenshell(["status"], { ignoreError: true });
    const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
      ignoreError: true,
    });
    const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
    // #3111: gate the healthy log on a real TCP probe. See
    // ./onboard/gateway-tcp-readiness for why TCP, not HTTP. TODO(#3213).
    if (
      isGatewayHealthy(status, namedInfo, currentInfo) &&
      (await isGatewayTcpReady())
    ) {
      console.log("  ✓ Docker-driver gateway is healthy");
      return;
    }
    if (i < pollCount - 1) sleep(pollInterval);
  }

  reportDockerDriverGatewayStartFailure(logPath, childExit, { exitOnFailure });
  throw new Error("Docker-driver gateway failed to start");
}

async function startGateway(
  _gpu: ReturnType<typeof nim.detectGpu>,
  { gpuPassthrough = false }: { gpuPassthrough?: boolean } = {},
): Promise<void> {
  return startGatewayWithOptions(_gpu, { exitOnFailure: true, gpuPassthrough });
}

async function startGatewayForRecovery(_gpu: ReturnType<typeof nim.detectGpu>): Promise<void> {
  return startGatewayWithOptions(_gpu, { exitOnFailure: false });
}

function getGatewayStartEnv(): Record<string, string> {
  const gatewayEnv: Record<string, string> = {};
  const openshellVersion = getInstalledOpenshellVersion();
  const stableGatewayImage = openshellVersion
    ? `ghcr.io/nvidia/openshell/cluster:${openshellVersion}`
    : null;
  if (stableGatewayImage && openshellVersion) {
    gatewayEnv.OPENSHELL_CLUSTER_IMAGE = stableGatewayImage;
    gatewayEnv.IMAGE_TAG = openshellVersion;
    const overlayOverride = applyOverlayfsAutoFix(stableGatewayImage);
    if (overlayOverride) {
      gatewayEnv.OPENSHELL_CLUSTER_IMAGE = overlayOverride;
    }
  }
  return gatewayEnv;
}

/**
 * Memoizes `applyOverlayfsAutoFix` per upstream image for the lifetime of
 * the process. The expensive work (host assessment + image inspect / pull /
 * build) only needs to happen once per onboard invocation; both
 * `startGatewayWithOptions` and `recoverGatewayRuntime` go through
 * `getGatewayStartEnv()`, and without this cache the recovery path would
 * re-run the full assessment.
 *
 * Reset on a per-process basis only — env-var changes mid-process are
 * not modelled here and shouldn't happen in the CLI's normal flow.
 */
const overlayFixResultCache = new Map<string, string | null>();

/**
 * When the host runs Docker 26+ with the new containerd-snapshotter overlayfs
 * driver, k3s inside the upstream cluster image cannot mount nested overlays
 * and crashes. Build a tiny patched image locally that selects fuse-overlayfs
 * (or `native` via NEMOCLAW_OVERLAY_SNAPSHOTTER) and return its tag so the
 * caller can route OPENSHELL_CLUSTER_IMAGE to it. Returns null on every host
 * that is not affected, when the user opts out, or when the build fails (in
 * which case we fall through to the upstream image and let the existing
 * doctor diagnostics surface the underlying error).
 */
function applyOverlayfsAutoFix(upstreamImage: string): string | null {
  if (process.env.NEMOCLAW_DISABLE_OVERLAY_FIX === "1") {
    return null;
  }
  if (overlayFixResultCache.has(upstreamImage)) {
    return overlayFixResultCache.get(upstreamImage) ?? null;
  }
  let assessment: ReturnType<typeof preflightUtils.assessHost>;
  try {
    assessment = preflightUtils.assessHost();
  } catch (err) {
    // Don't silently swallow — log a breadcrumb so a future regression in
    // assessHost (or a Docker-daemon hang past `2>/dev/null`) doesn't make
    // the auto-fix mysteriously stop firing without any user-visible signal.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`  Skipping overlayfs auto-fix: host assessment failed (${reason}).`);
    overlayFixResultCache.set(upstreamImage, null);
    return null;
  }
  if (!assessment.hasNestedOverlayConflict) {
    overlayFixResultCache.set(upstreamImage, null);
    return null;
  }

  const requestedSnapshotter = (process.env.NEMOCLAW_OVERLAY_SNAPSHOTTER || "")
    .trim()
    .toLowerCase();
  let snapshotter: "fuse-overlayfs" | "native" = "fuse-overlayfs";
  if (requestedSnapshotter === "native" || requestedSnapshotter === "fuse-overlayfs") {
    snapshotter = requestedSnapshotter;
  } else if (requestedSnapshotter !== "") {
    // Reject typos like 'NATIVE' or 'fuse' loudly so the user gets the image
    // they intended, not a silent default.
    console.warn(
      `  NEMOCLAW_OVERLAY_SNAPSHOTTER='${requestedSnapshotter}' is not recognized. ` +
        "Valid values are 'fuse-overlayfs' or 'native'. Falling back to 'fuse-overlayfs'.",
    );
  }

  console.log(
    `  Detected Docker 26+ containerd-snapshotter overlayfs (driver=${assessment.dockerStorageDriver}). ` +
      `Routing through a locally-built ${snapshotter} cluster image to bypass nested-overlay break.`,
  );
  console.log(
    "  Set NEMOCLAW_DISABLE_OVERLAY_FIX=1 to disable this auto-fix; see docs for the manual daemon.json workaround.",
  );

  try {
    const patchedTag = clusterImagePatch.ensurePatchedClusterImage({
      upstreamImage,
      snapshotter,
    });
    overlayFixResultCache.set(upstreamImage, patchedTag);
    return patchedTag;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`  Patched cluster image build failed: ${reason}`);
    console.error(
      "  Falling back to the upstream image. The k3s server will likely fail; see docs/reference/troubleshooting.md.",
    );
    overlayFixResultCache.set(upstreamImage, null);
    return null;
  }
}

async function recoverGatewayRuntime() {
  if (isLinuxDockerDriverGatewayEnabled()) {
    try {
      await startDockerDriverGateway({ exitOnFailure: false });
      return true;
    } catch {
      return false;
    }
  }

  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
  let status = runCaptureOpenshell(["status"], { ignoreError: true });
  if (
    status.includes("Connected") &&
    isSelectedGateway(status) &&
    (await isGatewayHttpReady())
  ) {
    process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
    return true;
  }

  const startResult = runOpenshell(
    ["gateway", "start", "--name", GATEWAY_NAME, "--port", String(GATEWAY_PORT)],
    {
      ignoreError: true,
      env: getGatewayStartEnv(),
      suppressOutput: true,
    },
  );
  if (startResult.status !== 0) {
    const diagnostic = compactText(
      redact(`${startResult.stderr || ""} ${startResult.stdout || ""}`),
    );
    console.error(`  Gateway restart failed (exit ${startResult.status}).`);
    if (diagnostic) {
      console.error(`  ${diagnostic.slice(0, 240)}`);
    }
  }
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });

  const recoveryWait = getGatewayHealthWaitConfig(
    startResult.status ?? 0,
    getGatewayClusterContainerState(),
  );
  const recoveryPollCount = recoveryWait.extended
    ? recoveryWait.count
    : envInt("NEMOCLAW_HEALTH_POLL_COUNT", 10);
  const recoveryPollInterval = recoveryWait.extended
    ? recoveryWait.interval
    : envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
  for (let i = 0; i < recoveryPollCount; i++) {
    const repairResult = repairGatewayBootstrapSecrets();
    if (repairResult.repaired) {
      attachGatewayMetadataIfNeeded({ forceRefresh: true });
    } else if (gatewayClusterHealthcheckPassed()) {
      attachGatewayMetadataIfNeeded();
    }
    status = runCaptureOpenshell(["status"], { ignoreError: true });
    if (
      status.includes("Connected") &&
      isSelectedGateway(status) &&
      (await isGatewayHttpReady())
    ) {
      process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
      const runtime = getContainerRuntime();
      if (shouldPatchCoredns(runtime)) {
        run(["bash", path.join(SCRIPTS, "fix-coredns.sh"), GATEWAY_NAME], {
          ignoreError: true,
        });
      }
      return true;
    }
    if (i < recoveryPollCount - 1) sleep(recoveryPollInterval);
  }

  return false;
}

// ── Step 3: Sandbox ──────────────────────────────────────────────

// Names that collide with CLI command namespaces. A sandbox named 'status'
// makes 'nemoclaw status connect' route to the global status command
// instead of the sandbox, and a sandbox named 'sandbox' collides with the
// oclif-native `nemoclaw sandbox ...` command namespace. Reject these wherever
// a sandbox name enters the system (interactive prompt, --name flag,
// NEMOCLAW_SANDBOX_NAME).
const RESERVED_SANDBOX_NAMES = new Set([
  "onboard",
  "list",
  "deploy",
  "setup",
  "setup-spark",
  "start",
  "stop",
  "status",
  "debug",
  "uninstall",
  "update",
  "credentials",
  "help",
  "sandbox",
]);

function normalizeSandboxAgentName(agentName: string | null | undefined): string {
  const trimmed = typeof agentName === "string" ? agentName.trim() : "";
  return trimmed && trimmed !== "openclaw" ? trimmed : "openclaw";
}

const UNKNOWN_SANDBOX_AGENT_NAME = "unknown";

function getRequestedSandboxAgentName(agent: AgentDefinition | null | undefined): string {
  return normalizeSandboxAgentName(agent?.name);
}

function formatSandboxAgentName(agentName: string | null | undefined): string {
  const normalized = normalizeSandboxAgentName(agentName);
  if (normalized === "openclaw") return "OpenClaw";
  if (normalized === "hermes") return "Hermes";
  return normalized;
}

function getDefaultSandboxNameForAgent(agent: AgentDefinition | null | undefined): string {
  return getRequestedSandboxAgentName(agent) === "hermes" ? "hermes" : "my-assistant";
}

function getSandboxPromptDefault(agent: AgentDefinition | null | undefined): string {
  const envName = (process.env.NEMOCLAW_SANDBOX_NAME || "").trim().toLowerCase();
  const agentDefault = getDefaultSandboxNameForAgent(agent);
  if (!envName) return agentDefault;
  try {
    return validateName(envName, "sandbox name");
  } catch {
    return agentDefault;
  }
}

function getEffectiveSandboxAgent(agent: AgentDefinition | null | undefined): AgentDefinition {
  return agent || agentDefs.loadAgent("openclaw");
}

function getAgentInferenceProviderOptions(agent: AgentDefinition | null | undefined): string[] {
  const effectiveAgent = agent?.name
    ? agentDefs.loadAgent(agent.name)
    : getEffectiveSandboxAgent(agent);
  return Array.isArray(effectiveAgent.inferenceProviderOptions)
    ? effectiveAgent.inferenceProviderOptions
    : [];
}

function getSandboxAgentRegistryFields(
  agent: AgentDefinition | null | undefined,
  agentVersionKnown = true,
): Pick<SandboxEntry, "agent" | "agentVersion"> {
  const effectiveAgent = getEffectiveSandboxAgent(agent);
  const agentName = normalizeSandboxAgentName(effectiveAgent.name);
  return {
    agent: agentName === "openclaw" ? null : agentName,
    agentVersion: agentVersionKnown ? effectiveAgent.expectedVersion || null : null,
  };
}

function getSandboxAgentDrift(
  sandboxName: string,
  requestedAgentName: string,
): { changed: boolean; existingAgentName: string; requestedAgentName: string } {
  const existingEntry: SandboxEntry | null = registry.getSandbox(sandboxName);
  if (!existingEntry) {
    return {
      changed: true,
      existingAgentName: UNKNOWN_SANDBOX_AGENT_NAME,
      requestedAgentName,
    };
  }
  const existingAgentName = normalizeSandboxAgentName(existingEntry?.agent);
  return {
    changed: existingAgentName !== requestedAgentName,
    existingAgentName,
    requestedAgentName,
  };
}

function getSandboxRuntimeRegistryFields(
  config: SandboxGpuConfig,
): Pick<
  SandboxEntry,
  | "gpuEnabled"
  | "hostGpuDetected"
  | "sandboxGpuEnabled"
  | "sandboxGpuMode"
  | "sandboxGpuDevice"
  | "openshellDriver"
  | "openshellVersion"
> {
  return {
    gpuEnabled: config.sandboxGpuEnabled,
    hostGpuDetected: config.hostGpuDetected,
    sandboxGpuEnabled: config.sandboxGpuEnabled,
    sandboxGpuMode: config.mode,
    sandboxGpuDevice: config.sandboxGpuDevice,
    openshellDriver: isLinuxDockerDriverGatewayEnabled()
      ? process.platform === "darwin"
        ? "vm"
        : "docker"
      : "kubernetes",
    openshellVersion: getInstalledOpenshellVersion(
      runCaptureOpenshell(["--version"], { ignoreError: true }),
    ),
  };
}

function hasSandboxGpuDrift(sandboxName: string, config: SandboxGpuConfig): boolean {
  const existingEntry: SandboxEntry | null = registry.getSandbox(sandboxName);
  if (!existingEntry) return false;
  return (
    (existingEntry.sandboxGpuEnabled === true) !== config.sandboxGpuEnabled ||
    (existingEntry.sandboxGpuMode || "auto") !== config.mode ||
    (existingEntry.sandboxGpuDevice || null) !== config.sandboxGpuDevice
  );
}

function updateReusedSandboxMetadata(
  sandboxName: string,
  agent: AgentDefinition | null | undefined,
  model: string,
  provider: string,
  dashboardPort: number,
  selectionVerified = true,
  sandboxGpuConfig: SandboxGpuConfig | null = null,
): void {
  const existingEntry = registry.getSandbox(sandboxName);
  const agentVersionKnown = existingEntry?.agentVersion !== null;
  const selectionUpdates = selectionVerified ? { model, provider } : {};
  registry.updateSandbox(sandboxName, {
    ...selectionUpdates,
    dashboardPort,
    ...getSandboxAgentRegistryFields(agent, agentVersionKnown),
    ...(sandboxGpuConfig ? getSandboxRuntimeRegistryFields(sandboxGpuConfig) : {}),
  });
  registry.setDefault(sandboxName);
}

async function promptValidatedSandboxName(agent: AgentDefinition | null = null) {
  const MAX_ATTEMPTS = 3;
  const defaultSandboxName = getSandboxPromptDefault(agent);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const nameAnswer = await promptOrDefault(
      `  Sandbox name (${NAME_ALLOWED_FORMAT}) [${defaultSandboxName}]: `,
      "NEMOCLAW_SANDBOX_NAME",
      defaultSandboxName,
    );
    const sandboxName = (nameAnswer || defaultSandboxName).trim();

    try {
      const validatedSandboxName = validateName(sandboxName, "sandbox name");
      if (RESERVED_SANDBOX_NAMES.has(sandboxName)) {
        console.error(`  Reserved name: '${sandboxName}' is a ${cliDisplayName()} CLI command.`);
        console.error("  Choose a different name to avoid routing conflicts.");
        if (isNonInteractive()) {
          process.exit(1);
        }
        if (attempt < MAX_ATTEMPTS - 1) {
          console.error("  Please try again.\n");
        }
        continue;
      }
      return validatedSandboxName;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`  ${errorMessage}`);
    }

    for (const line of getNameValidationGuidance("sandbox name", sandboxName, {
      includeAllowedFormat: false,
    })) {
      console.error(`  ${line}`);
    }

    // Non-interactive runs cannot re-prompt — abort so the caller can fix the
    // NEMOCLAW_SANDBOX_NAME env var and retry.
    if (isNonInteractive()) {
      process.exit(1);
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      console.error("  Please try again.\n");
    }
  }

  console.error("  Too many invalid attempts.");
  process.exit(1);
}

// ── Step 5: Sandbox ──────────────────────────────────────────────

type OnboardConfigSummary = {
  provider: string | null;
  model: string | null;
  credentialEnv?: string | null;
  hermesAuthMethod?: HermesAuthMethod | string | null;
  webSearchConfig?: WebSearchConfig | null;
  enabledChannels?: string[] | null;
  sandboxName: string;
  notes?: string[] | null;
};

/**
 * Render the configuration summary shown before the destructive sandbox build.
 * Extracted from confirmOnboardConfiguration() for direct unit testing — see #2165.
 *
 * Fields:
 * - credentialEnv:    env-var name of the API key (e.g. "NVIDIA_API_KEY").
 *                     Rendered with the fixed credentials.json location so
 *                     users can see where the key was stored.
 * - notes:            additional bullet lines shown under the summary,
 *                     such as a sandbox build-time estimate. Each note is
 *                     rendered as "Note: <text>" so it stays visually
 *                     distinct.
 */
function formatSandboxBuildEstimateNote(host: ReturnType<typeof assessHost>): string | null {
  if (host.isContainerRuntimeUnderProvisioned) {
    return (
      "Container runtime is under-provisioned; the sandbox build may take 30+ minutes " +
      "or stall. See preflight warning above."
    );
  }
  const cpus = host.dockerCpus;
  const memBytes = host.dockerMemTotalBytes;
  if (typeof cpus === "number" && typeof memBytes === "number") {
    const memGiB = memBytes / 1024 ** 3;
    if (cpus >= 8 && memGiB >= 16) {
      return "Sandbox build typically takes 3–8 minutes on this host.";
    }
    return "Sandbox build typically takes 5–15 minutes on this host.";
  }
  return null;
}

function formatOnboardConfigSummary({
  provider,
  model,
  credentialEnv = null,
  hermesAuthMethod = null,
  webSearchConfig = null,
  enabledChannels = null,
  sandboxName,
  notes = [],
}: OnboardConfigSummary): string {
  const bar = `  ${"─".repeat(50)}`;
  const messaging =
    Array.isArray(enabledChannels) && enabledChannels.length > 0
      ? enabledChannels.join(", ")
      : "none";
  const webSearch =
    webSearchConfig && webSearchConfig.fetchEnabled === true ? "enabled" : "disabled";
  const effectiveHermesAuthMethod =
    normalizeHermesAuthMethod(hermesAuthMethod) ||
    (provider === hermesProviderAuth.HERMES_PROVIDER_NAME &&
    credentialEnv === HERMES_NOUS_API_KEY_CREDENTIAL_ENV
      ? HERMES_AUTH_METHOD_API_KEY
      : HERMES_AUTH_METHOD_OAUTH);
  const apiKeyLine =
    provider === hermesProviderAuth.HERMES_PROVIDER_NAME
      ? effectiveHermesAuthMethod === HERMES_AUTH_METHOD_API_KEY
        ? "  Nous API key: host-managed; sandbox receives inference placeholder only"
        : "  Nous OAuth:    host-managed; sandbox receives inference placeholder only"
      : credentialEnv
        ? `  API key:       ${credentialEnv} (staged for OpenShell gateway registration)`
        : `  API key:       (not required for ${provider ?? "this provider"})`;
  const noteLines = (Array.isArray(notes) ? notes : [])
    .filter((n) => typeof n === "string" && n.length > 0)
    .map((n) => `  Note:          ${n}`);
  return [
    "",
    bar,
    "  Review configuration",
    bar,
    `  Provider:      ${provider ?? "(unset)"}`,
    `  Model:         ${model ?? "(unset)"}`,
    apiKeyLine,
    `  Web search:    ${webSearch}`,
    `  Messaging:     ${messaging}`,
    `  Sandbox name:  ${sandboxName}`,
    ...noteLines,
    bar,
  ].join("\n");
}

async function createSandbox(
  gpu: ReturnType<typeof nim.detectGpu>,
  model: string,
  provider: string,
  preferredInferenceApi: string | null = null,
  sandboxNameOverride: string | null = null,
  webSearchConfig: WebSearchConfig | null = null,
  enabledChannels: string[] | null = null,
  fromDockerfile: string | null = null,
  agent: AgentDefinition | null = null,
  controlUiPort: number | null = null,
  sandboxGpuConfig: SandboxGpuConfig | null = null,
) {
  step(6, 8, "Creating sandbox");

  const sandboxName = validateName(
    sandboxNameOverride ?? (await promptValidatedSandboxName(agent)),
    "sandbox name",
  );
  const effectiveSandboxGpuConfig =
    sandboxGpuConfig ?? resolveSandboxGpuConfig(gpu, { flag: null, device: null });

  // Port priority: --control-ui-port > CHAT_UI_URL env > registry (resume) > agent.forwardPort > default
  // Pre-resolve port availability so CHAT_UI_URL baked into the Dockerfile,
  // the sandbox env, and the readiness probe all use the final forwarded port.
  const persistedPort = registry.getSandbox(sandboxName)?.dashboardPort ?? null;
  // When CHAT_UI_URL is set, extract its port so the allocator and the URL stay in sync.
  let envPort: number | null = null;
  if (process.env.CHAT_UI_URL) {
    try {
      const u = new URL(
        process.env.CHAT_UI_URL.includes("://")
          ? process.env.CHAT_UI_URL
          : `http://${process.env.CHAT_UI_URL}`,
      );
      const p = Number(u.port);
      if (p > 0) envPort = p;
    } catch {
      /* malformed URL — ignore */
    }
  }
  const preferredPort =
    controlUiPort ?? envPort ?? persistedPort ?? (agent ? agent.forwardPort : CONTROL_UI_PORT);
  const earlyForwards = runCaptureOpenshell(["forward", "list"], { ignoreError: true });
  const effectivePort = findAvailableDashboardPort(sandboxName, preferredPort, earlyForwards);
  if (effectivePort !== preferredPort) {
    console.warn(`  ! Port ${preferredPort} is taken. Using port ${effectivePort} instead.`);
  }
  // Build chatUiUrl: preserve the hostname from CHAT_UI_URL when set, but
  // always use effectivePort so the Dockerfile, env, and readiness probe agree.
  let chatUiUrl: string;
  if (process.env.CHAT_UI_URL && controlUiPort == null) {
    const parsed = new URL(
      process.env.CHAT_UI_URL.includes("://")
        ? process.env.CHAT_UI_URL
        : `http://${process.env.CHAT_UI_URL}`,
    );
    parsed.port = String(effectivePort);
    chatUiUrl = parsed.toString().replace(/\/$/, "");
  } else {
    chatUiUrl = `http://127.0.0.1:${effectivePort}`;
  }

  // Check whether messaging providers will be needed — this must happen before
  // the sandbox reuse decision so we can detect stale sandboxes that were created
  // without provider attachments (security: prevents legacy raw-env-var leaks).
  const getMessagingToken = (envKey: string): string | null =>
    getCredential(envKey) || normalizeCredentialValue(process.env[envKey]) || null;

  // The UI toggle list can include channels the user toggled on but then
  // skipped the token prompt for. Only channels with a real token will have a
  // provider attached, so the conflict check must filter out the skipped ones
  // (otherwise we warn about phantom channels that will never poll).
  const conflictCheckChannels = Array.isArray(enabledChannels)
    ? enabledChannels.flatMap((name) => {
        const def = MESSAGING_CHANNELS.find((c) => c.name === name);
        if (!def || !getMessagingToken(def.envKey)) return [];
        const tokenEnvKeys = def.appTokenEnvKey ? [def.envKey, def.appTokenEnvKey] : [def.envKey];
        const credentialHashes: Record<string, string> = {};
        for (const envKey of tokenEnvKeys) {
          const hash = hashCredential(getMessagingToken(envKey));
          if (hash) credentialHashes[envKey] = hash;
        }
        if (Object.keys(credentialHashes).length === 0) return [];
        return [{ channel: name, credentialHashes }];
      })
    : [];

  // Messaging channels like Telegram (getUpdates), Discord (gateway), and Slack
  // (Socket Mode) enforce one consumer per channel credential. Two sandboxes
  // sharing a credential silently break both bridges (see #1953). Warn before
  // we commit.
  if (conflictCheckChannels.length > 0) {
    const { backfillMessagingChannels, findChannelConflicts } = require("./messaging-conflict");
    backfillMessagingChannels(registry, makeConflictProbe());
    const conflicts = findChannelConflicts(sandboxName, conflictCheckChannels, registry);
    if (conflicts.length > 0) {
      for (const { channel, sandbox, reason } of conflicts) {
        const detail =
          reason === "matching-token"
            ? `uses the same ${channel} credential`
            : `already has ${channel} enabled, but its credential hash is unavailable`;
        console.log(
          `  ⚠ Sandbox '${sandbox}' ${detail}. Shared channel credentials only allow one sandbox to poll/connect — continuing may break both bridges.`,
        );
      }
      if (isNonInteractive()) {
        console.error(
          `  Aborting: resolve the messaging channel conflict above or run \`${cliName()} <sandbox> channels stop <channel>\` / \`${cliName()} <sandbox> channels remove <channel>\` on the other sandbox.`,
        );
        process.exit(1);
      }
      if (!(await promptYesNoOrDefault("  Continue anyway?", null, false))) {
        console.log("  Aborting sandbox creation.");
        process.exit(1);
      }
    }
  }

  // When enabledChannels is provided (from the toggle picker), only include
  // channels the user selected. When null (backward compat), include all.
  const enabledEnvKeys =
    enabledChannels != null
      ? new Set(
          MESSAGING_CHANNELS.filter((c) => enabledChannels.includes(c.name)).flatMap((c) =>
            c.appTokenEnvKey ? [c.envKey, c.appTokenEnvKey] : [c.envKey],
          ),
        )
      : null;

  // Drop channels the operator disabled via `nemoclaw <sandbox> channels stop`.
  // Credentials stay in the keychain; the bridge simply isn't registered with
  // the gateway on the next rebuild. `channels start` removes the entry and
  // the bridge comes back.
  const disabledChannels = registry.getDisabledChannels(sandboxName);
  const disabledEnvKeys = new Set(
    MESSAGING_CHANNELS.filter((c) => disabledChannels.includes(c.name)).flatMap((c) =>
      c.appTokenEnvKey ? [c.envKey, c.appTokenEnvKey] : [c.envKey],
    ),
  );

  const messagingTokenDefs = [
    {
      name: `${sandboxName}-discord-bridge`,
      envKey: "DISCORD_BOT_TOKEN",
      token: getMessagingToken("DISCORD_BOT_TOKEN"),
    },
    {
      name: `${sandboxName}-slack-bridge`,
      envKey: "SLACK_BOT_TOKEN",
      token: getMessagingToken("SLACK_BOT_TOKEN"),
    },
    {
      name: `${sandboxName}-slack-app`,
      envKey: "SLACK_APP_TOKEN",
      token: getMessagingToken("SLACK_APP_TOKEN"),
    },
    {
      name: `${sandboxName}-telegram-bridge`,
      envKey: "TELEGRAM_BOT_TOKEN",
      token: getMessagingToken("TELEGRAM_BOT_TOKEN"),
    },
  ]
    .filter(({ envKey }) => !enabledEnvKeys || enabledEnvKeys.has(envKey))
    .filter(({ envKey }) => !disabledEnvKeys.has(envKey));

  if (webSearchConfig) {
    messagingTokenDefs.push({
      name: `${sandboxName}-brave-search`,
      envKey: webSearch.BRAVE_API_KEY_ENV,
      token: getCredential(webSearch.BRAVE_API_KEY_ENV),
    });
  }
  const previousProviderCredentialHashes =
    registry.getSandbox(sandboxName)?.providerCredentialHashes ?? {};
  const hasMessagingTokens = messagingTokenDefs.some(({ token }) => !!token);
  const reusableMessagingProviders: string[] = [];
  const reusableMessagingChannels: string[] = [];
  const reusableMessagingEnvKeys = new Set<string>();
  if (enabledChannels != null) {
    for (const { name, envKey, token } of messagingTokenDefs) {
      if (token) continue;
      const channel =
        envKey === "SLACK_APP_TOKEN" ? "slack" : getMessagingChannelForEnvKey(envKey);
      if (!channel || !enabledChannels.includes(channel)) continue;
      if (!providerExistsInGateway(name)) continue;
      reusableMessagingProviders.push(name);
      reusableMessagingEnvKeys.add(envKey);
      if (!reusableMessagingChannels.includes(channel)) {
        reusableMessagingChannels.push(channel);
      }
    }
  }

  // Reconcile local registry state with the live OpenShell gateway state.
  const liveExists = pruneStaleSandboxEntry(sandboxName);

  // Declared outside the liveExists block so it is accessible during
  // post-creation restore (the sandbox create path runs after the block).
  let pendingStateRestore: BackupResult | null = null;

  if (liveExists) {
    const existingSandboxState = getSandboxReuseState(sandboxName);
    const requestedAgentName = getRequestedSandboxAgentName(agent);
    const agentDrift = getSandboxAgentDrift(sandboxName, requestedAgentName);
    let recreateForAgentDrift = agentDrift.changed && isRecreateSandbox();

    if (agentDrift.changed && !isRecreateSandbox()) {
      console.log(
        `  Sandbox '${sandboxName}' already exists as ${formatSandboxAgentName(agentDrift.existingAgentName)}.`,
      );
      console.log(
        `  ${cliDisplayName()} is onboarding ${formatSandboxAgentName(agentDrift.requestedAgentName)} for this sandbox name.`,
      );
      console.log("  Side-by-side agents are supported, but each sandbox name has one agent type.");
      if (isNonInteractive()) {
        console.error(
          `  Aborting: choose a different name or set NEMOCLAW_RECREATE_SANDBOX=1 to recreate '${sandboxName}'.`,
        );
        console.error(
          `  Example: ${cliName()} onboard --name ${getDefaultSandboxNameForAgent(agent)}`,
        );
        process.exit(1);
      }
      if (
        await promptYesNoOrDefault(
          `  Delete and recreate '${sandboxName}' as ${formatSandboxAgentName(agentDrift.requestedAgentName)}?`,
          null,
          false,
        )
      ) {
        recreateForAgentDrift = true;
      } else {
        console.error("  Aborted. Existing sandbox left unchanged.");
        console.error(
          `  Re-run with a different name, for example: ${cliName()} onboard --name ${getDefaultSandboxNameForAgent(agent)}`,
        );
        process.exit(1);
      }
    }

    // Check whether messaging providers are missing from the gateway. Only
    // force recreation when at least one required provider doesn't exist yet —
    // this avoids destroying sandboxes already created with provider attachments.
    const needsProviderMigration =
      hasMessagingTokens &&
      messagingTokenDefs.some(({ name, token }) => token && !providerExistsInGateway(name));
    const selectionDrift = getSelectionDrift(sandboxName, provider, model);
    const confirmedSelectionDrift = selectionDrift.changed && !selectionDrift.unknown;
    const sandboxGpuDrift = hasSandboxGpuDrift(sandboxName, effectiveSandboxGpuConfig);

    // Detect whether any messaging credential has been rotated since the
    // sandbox was created. Provider credentials are resolved once at sandbox
    // startup, so a rotated token requires a rebuild to take effect.
    const credentialRotation = hasMessagingTokens
      ? detectMessagingCredentialRotation(sandboxName, messagingTokenDefs)
      : { changed: false, changedProviders: [] };

    if (
      !isRecreateSandbox() &&
      !recreateForAgentDrift &&
      !needsProviderMigration &&
      !sandboxGpuDrift &&
      !credentialRotation.changed
    ) {
      // Guard against reusing a CPU-only sandbox when GPU passthrough is enabled.
      // Placed before the non-interactive / interactive split so all reuse
      // paths are covered (interactive prompt, non-interactive ready, unknown drift).
      // Note: legacy registries had gpuEnabled always true (bug fixed in this PR),
      // so gpuEnabled=true on a legacy entry doesn't guarantee GPU support.
      // The gateway Docker-inspect check (above) catches legacy CPU-only gateways
      // before we reach this point, so a legacy sandbox behind a verified GPU
      // gateway is safe to reuse — the sandbox will be recreated if needed.
      if (effectiveSandboxGpuConfig.sandboxGpuEnabled) {
        const entry = registry.getSandbox(sandboxName);
        if (entry && !entry.gpuEnabled) {
          console.error(`  Sandbox '${sandboxName}' exists but was created without GPU passthrough.`);
          console.error(
            "  Pass --recreate-sandbox to recreate with GPU, or destroy and re-onboard:",
          );
          console.error(`    nemoclaw onboard --recreate-sandbox`);
          process.exit(1);
        }
      }

      if (isNonInteractive()) {
        if (existingSandboxState === "ready") {
          if (confirmedSelectionDrift) {
            note("  [non-interactive] Recreating sandbox due to provider/model drift.");
          } else {
            // Upsert messaging providers even on reuse so credential changes take
            // effect without requiring a full sandbox recreation.
            upsertMessagingProviders(messagingTokenDefs);
            if (selectionDrift.unknown) {
              note(
                "  [non-interactive] Existing provider/model selection is unreadable; reusing sandbox.",
              );
              note(
                "  [non-interactive] Set NEMOCLAW_RECREATE_SANDBOX=1 (or --recreate-sandbox) to force recreation.",
              );
            } else {
              note(`  [non-interactive] Sandbox '${sandboxName}' exists and is ready — reusing it`);
              note(
                "  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to force recreation.",
              );
            }
            const reusedPort = ensureDashboardForward(sandboxName, chatUiUrl);
            process.env.CHAT_UI_URL = `http://127.0.0.1:${reusedPort}`;
            updateReusedSandboxMetadata(
              sandboxName,
              agent,
              model,
              provider,
              reusedPort,
              !selectionDrift.unknown,
              effectiveSandboxGpuConfig,
            );
            return sandboxName;
          }
        } else {
          console.error(`  Sandbox '${sandboxName}' already exists but is not ready.`);
          console.error(
            "  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to overwrite.",
          );
          process.exit(1);
        }
      } else if (existingSandboxState === "ready") {
        if (confirmedSelectionDrift) {
          const confirmed = await confirmRecreateForSelectionDrift(
            sandboxName,
            selectionDrift,
            provider,
            model,
          );
          if (!confirmed) {
            console.error("  Aborted. Existing sandbox left unchanged.");
            process.exit(1);
          }
        } else {
          console.log(`  Sandbox '${sandboxName}' already exists.`);
          console.log("  Choosing 'n' will delete the existing sandbox and create a new one.");
          if (await promptYesNoOrDefault("  Reuse existing sandbox?", null, true)) {
            upsertMessagingProviders(messagingTokenDefs);
            const reusedPort2 = ensureDashboardForward(sandboxName, chatUiUrl);
            process.env.CHAT_UI_URL = `http://127.0.0.1:${reusedPort2}`;
            updateReusedSandboxMetadata(
              sandboxName,
              agent,
              model,
              provider,
              reusedPort2,
              !selectionDrift.unknown,
              effectiveSandboxGpuConfig,
            );
            return sandboxName;
          }
        }
      } else {
        console.log(`  Sandbox '${sandboxName}' exists but is not ready.`);
        console.log("  Selecting 'n' will abort onboarding.");
        if (!(await promptYesNoOrDefault("  Delete it and create a new one?", null, true))) {
          console.log("  Aborting onboarding.");
          process.exit(1);
        }
      }
    }

    // Back up workspace state before destroying the sandbox when triggered
    // by credential rotation, so files can be restored after recreation.
    if (credentialRotation.changed && existingSandboxState === "ready") {
      const rotatedNames = credentialRotation.changedProviders.join(", ");
      console.log(`  Messaging credential(s) rotated: ${rotatedNames}`);
      console.log("  Rebuilding sandbox to propagate new credentials to the L7 proxy...");
      try {
        const backup = sandboxState.backupSandboxState(sandboxName);
        if (backup.success) {
          note(
            `  ✓ State backed up (${backup.backedUpDirs.length} directories, ${backup.backedUpFiles.length} files)`,
          );
          pendingStateRestore = backup;
        } else {
          console.error("  State backup failed — aborting rebuild to prevent data loss.");
          console.error("  Pass --recreate-sandbox to force recreation without backup.");
          upsertMessagingProviders(messagingTokenDefs);
          // Update stored hashes so the next onboard doesn't re-detect rotation.
          const abortHashes: Record<string, string> = {};
          for (const { envKey, token } of messagingTokenDefs) {
            const hash = token ? hashCredential(token) : null;
            if (hash) abortHashes[envKey] = hash;
          }
          if (Object.keys(abortHashes).length > 0) {
            registry.updateSandbox(sandboxName, { providerCredentialHashes: abortHashes });
          }
          const reusedPort3 = ensureDashboardForward(sandboxName, chatUiUrl);
          process.env.CHAT_UI_URL = `http://127.0.0.1:${reusedPort3}`;
          updateReusedSandboxMetadata(
            sandboxName,
            agent,
            model,
          provider,
          reusedPort3,
          !selectionDrift.unknown,
          effectiveSandboxGpuConfig,
        );
        return sandboxName;
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`  State backup threw: ${errorMessage} — aborting rebuild.`);
        console.error("  Pass --recreate-sandbox to force recreation without backup.");
        upsertMessagingProviders(messagingTokenDefs);
        const abortHashes: Record<string, string> = {};
        for (const { envKey, token } of messagingTokenDefs) {
          const hash = token ? hashCredential(token) : null;
          if (hash) abortHashes[envKey] = hash;
        }
        if (Object.keys(abortHashes).length > 0) {
          registry.updateSandbox(sandboxName, { providerCredentialHashes: abortHashes });
        }
        const reusedPort4 = ensureDashboardForward(sandboxName, chatUiUrl);
        process.env.CHAT_UI_URL = `http://127.0.0.1:${reusedPort4}`;
        updateReusedSandboxMetadata(
          sandboxName,
          agent,
          model,
          provider,
          reusedPort4,
          !selectionDrift.unknown,
          effectiveSandboxGpuConfig,
        );
        return sandboxName;
      }
    }

    if (recreateForAgentDrift) {
      note(
        `  Sandbox '${sandboxName}' exists as ${formatSandboxAgentName(agentDrift.existingAgentName)} — recreating as ${formatSandboxAgentName(agentDrift.requestedAgentName)}.`,
      );
    } else if (needsProviderMigration) {
      console.log(`  Sandbox '${sandboxName}' exists but messaging providers are not attached.`);
      console.log("  Recreating to ensure credentials flow through the provider pipeline.");
    } else if (confirmedSelectionDrift) {
      note(`  Sandbox '${sandboxName}' exists — recreating to apply model/provider change.`);
    } else if (sandboxGpuDrift) {
      note(`  Sandbox '${sandboxName}' exists — recreating to apply sandbox GPU settings.`);
    } else if (credentialRotation.changed) {
      // Message already printed above during backup.
    } else if (existingSandboxState === "ready") {
      note(`  Sandbox '${sandboxName}' exists and is ready — recreating by explicit request.`);
    } else {
      note(`  Sandbox '${sandboxName}' exists but is not ready — recreating it.`);
    }

    const previousEntry: SandboxEntry | null = registry.getSandbox(sandboxName);
    const previousPolicies = previousEntry?.policies ?? null;
    if (previousPolicies && previousPolicies.length > 0) {
      onboardSession.updateSession((current: Session) => {
        current.policyPresets = previousPolicies;
        return current;
      });
    }

    note(`  Deleting and recreating sandbox '${sandboxName}'...`);

    // Destroy old sandbox and clean up its host-side Docker image.
    runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    if (previousEntry?.imageTag) {
      const rmiResult = dockerRmi(previousEntry.imageTag, {
        ignoreError: true,
        suppressOutput: true,
      });
      if (rmiResult.status !== 0) {
        console.warn(`  Warning: failed to remove old sandbox image '${previousEntry.imageTag}'.`);
      }
    }
    registry.removeSandbox(sandboxName);
  }

  // Stage build context — use the custom Dockerfile path when provided,
  // otherwise use the optimised default that only sends what the build needs.
  // The build context contains source code, scripts, and potentially API keys
  // in env args, so it must not persist in /tmp after a failed sandbox create.
  // run() calls process.exit() on failure (bypassing normal control flow), so
  // we register a process 'exit' handler to guarantee cleanup in all cases.
  let buildCtx: string, stagedDockerfile: string;
  if (fromDockerfile) {
    const fromResolved = path.resolve(fromDockerfile);
    if (!fs.existsSync(fromResolved)) {
      console.error(`  Custom Dockerfile not found: ${fromResolved}`);
      process.exit(1);
    }
    if (!fs.statSync(fromResolved).isFile()) {
      console.error(`  Custom Dockerfile path is not a file: ${fromResolved}`);
      process.exit(1);
    }
    const buildContextDir = path.dirname(fromResolved);
    if (isInsideIgnoredCustomBuildContextPath(buildContextDir)) {
      console.error(
        `  Custom Dockerfile is inside an ignored build-context path: ${buildContextDir}`,
      );
      console.error("  Move your Dockerfile to a dedicated directory and retry.");
      process.exit(1);
    }
    console.log(`  Using custom Dockerfile: ${fromResolved}`);
    console.log(`  Docker build context: ${buildContextDir}`);
    const buildContextStats = collectBuildContextStats(
      buildContextDir,
      shouldIncludeCustomBuildContextPath,
    );
    if (buildContextStats.totalBytes > CUSTOM_BUILD_CONTEXT_WARN_BYTES) {
      const sizeMb = (buildContextStats.totalBytes / 1_000_000).toFixed(1);
      console.warn(
        `  WARN: build context contains about ${sizeMb} MB across ${buildContextStats.fileCount} files.`,
      );
      console.warn(
        "  The --from flag sends the Dockerfile's parent directory to Docker; use a dedicated directory if this is not intentional.",
      );
    }
    buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
    stagedDockerfile = path.join(buildCtx, "Dockerfile");
    const cleanupCustomBuildCtx = (): void => {
      try {
        fs.rmSync(buildCtx, { recursive: true, force: true });
      } catch {
        // Best effort cleanup; the original error is more useful to the caller.
      }
    };
    // Copy the entire parent directory as build context.
    try {
      fs.cpSync(buildContextDir, buildCtx, {
        recursive: true,
        filter: shouldIncludeCustomBuildContextPath,
      });
      // If the caller pointed at a file not named "Dockerfile", copy it to the
      // location openshell expects (buildCtx/Dockerfile).
      if (path.basename(fromResolved) !== "Dockerfile") {
        fs.copyFileSync(fromResolved, stagedDockerfile);
      }
    } catch (err) {
      cleanupCustomBuildCtx();
      const errorObject = typeof err === "object" && err !== null ? err : null;
      if (isErrnoException(errorObject) && errorObject.code === "EACCES") {
        console.error(`  Permission denied while copying build context from: ${buildContextDir}`);
        console.error(
          "  The --from flag uses the Dockerfile's parent directory as the Docker build context.",
        );
        console.error("  Move your Dockerfile to a dedicated directory and retry.");
        process.exit(1);
      }
      throw err;
    }
  } else if (agent) {
    const agentBuild = agentOnboard.createAgentSandbox(agent);
    buildCtx = agentBuild.buildCtx;
    stagedDockerfile = agentBuild.stagedDockerfile;
  } else {
    ({ buildCtx, stagedDockerfile } = stageOptimizedSandboxBuildContext(ROOT));
  }
  // Returns true if the build context was fully removed, false otherwise.
  // The caller uses this to decide whether the process 'exit' safety net
  // can be deregistered — if inline cleanup fails, we leave the handler
  // armed so the temp dir is still removed on process exit.
  const cleanupBuildCtx = (): boolean => {
    try {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };
  process.on("exit", cleanupBuildCtx);

  // Create sandbox (use -- echo to avoid dropping into interactive shell)
  // Pass the base policy so sandbox starts in proxy mode (required for policy updates later)
  const defaultPolicyPath = path.join(
    ROOT,
    "nemoclaw-blueprint",
    "policies",
    "openclaw-sandbox.yaml",
  );
  const basePolicyPath = (agent && agentOnboard.getAgentPolicyPath(agent)) || defaultPolicyPath;
  if (webSearchConfig && !getCredential(webSearch.BRAVE_API_KEY_ENV)) {
    console.error("  Brave Search is enabled, but BRAVE_API_KEY is not available in this process.");
    console.error(
      "  Re-run with BRAVE_API_KEY set, or disable Brave Search before recreating the sandbox.",
    );
    process.exit(1);
  }
  const tokensByEnvKey = Object.fromEntries(
    messagingTokenDefs.map(({ envKey, token }) => [envKey, token]),
  );
  const activeMessagingChannels = [
    ...new Set([
      ...messagingTokenDefs
        .filter(({ token }) => !!token)
        .flatMap(({ envKey }) => {
          const channel = getMessagingChannelForEnvKey(envKey);
          if (channel) return [channel];
          // SLACK_APP_TOKEN alone does not enable slack; bot token is required.
          if (envKey === "SLACK_APP_TOKEN") {
            return tokensByEnvKey["SLACK_BOT_TOKEN"] ? ["slack"] : [];
          }
          return [];
        }),
      ...reusableMessagingChannels,
    ]),
  ];
  const initialSandboxPolicy = prepareInitialSandboxCreatePolicy(
    basePolicyPath,
    activeMessagingChannels,
    { directGpu: effectiveSandboxGpuConfig.sandboxGpuEnabled },
  );
  if (initialSandboxPolicy.cleanup) {
    process.on("exit", initialSandboxPolicy.cleanup);
  }
  if (initialSandboxPolicy.appliedPresets.length > 0) {
    console.log(
      `  Including policy preset(s) at sandbox boot: ${initialSandboxPolicy.appliedPresets.join(", ")}`,
    );
  }
  if (effectiveSandboxGpuConfig.sandboxGpuEnabled) {
    console.log("  Direct sandbox GPU enabled; allowing only /proc task comm writes.");
  }
  const createArgs = [
    "--from",
    `${buildCtx}/Dockerfile`,
    "--name",
    sandboxName,
    "--policy",
    initialSandboxPolicy.policyPath,
    ...buildSandboxGpuCreateArgs(effectiveSandboxGpuConfig),
  ];

  // Create OpenShell providers for messaging credentials so they flow through
  // the provider/placeholder system instead of raw env vars. The L7 proxy
  // rewrites Authorization headers (Bearer/Bot) and URL-path segments
  // (/bot{TOKEN}/) with real secrets at egress (OpenShell >= 0.0.20).
  const messagingProviders = [
    ...new Set([...upsertMessagingProviders(messagingTokenDefs), ...reusableMessagingProviders]),
  ];
  for (const p of messagingProviders) {
    createArgs.push("--provider", p);
  }

  console.log(`  Creating sandbox '${sandboxName}' (this takes a few minutes on first run)...`);
  const messagingChannelConfig = readMessagingChannelConfigFromEnv();
  // Build allowed sender IDs map from env vars set during the messaging prompt.
  // Each channel with a userIdEnvKey in MESSAGING_CHANNELS may have a
  // comma-separated list of IDs (e.g. TELEGRAM_ALLOWED_IDS="123,456").
  const messagingAllowedIds: Record<string, string[]> = {};
  const enabledTokenEnvKeys = new Set(messagingTokenDefs.map(({ envKey }) => envKey));
  for (const ch of MESSAGING_CHANNELS) {
    if (
      enabledTokenEnvKeys.has(ch.envKey) &&
      ch.userIdEnvKey &&
      process.env[ch.userIdEnvKey]
    ) {
      const ids = String(process.env[ch.userIdEnvKey])
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length > 0) messagingAllowedIds[ch.name] = ids;
    }
  }
  const discordGuilds: Record<string, { requireMention: boolean; users?: string[] }> = {};
  if (enabledTokenEnvKeys.has("DISCORD_BOT_TOKEN")) {
    const serverIds = (process.env.DISCORD_SERVER_IDS || process.env.DISCORD_SERVER_ID || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const userIds = (process.env.DISCORD_ALLOWED_IDS || process.env.DISCORD_USER_ID || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const serverId of serverIds) {
      if (!DISCORD_SNOWFLAKE_RE.test(serverId)) {
        console.warn(`  Warning: Discord server ID '${serverId}' does not look like a snowflake.`);
      }
    }
    for (const userId of userIds) {
      if (!DISCORD_SNOWFLAKE_RE.test(userId)) {
        console.warn(`  Warning: Discord user ID '${userId}' does not look like a snowflake.`);
      }
    }
    const requireMention = process.env.DISCORD_REQUIRE_MENTION !== "0";
    for (const serverId of serverIds) {
      discordGuilds[serverId] = {
        requireMention,
        ...(userIds.length > 0 ? { users: userIds } : {}),
      };
    }
  }
  // Telegram mention-only mode — parity with Discord's requireMention.
  // Off by default so existing sandboxes behave the same; opt-in via
  // TELEGRAM_REQUIRE_MENTION=1 or the interactive prompt. See #1737.
  const telegramConfig: { requireMention?: boolean } = {};
  if (enabledTokenEnvKeys.has("TELEGRAM_BOT_TOKEN")) {
    const telegramRequireMention = computeTelegramRequireMention();
    if (telegramRequireMention !== null) {
      telegramConfig.requireMention = telegramRequireMention;
    }
  }
  // Persist the effective Telegram config into the session so a later resume
  // can detect drift (TELEGRAM_REQUIRE_MENTION changed since last build) and
  // force a sandbox recreate — otherwise the old groupPolicy would stay baked
  // in. Mirrors the pattern used for webSearchConfig. See CodeRabbit on #2417.
  onboardSession.updateSession((current) => {
    current.telegramConfig =
      typeof telegramConfig.requireMention === "boolean"
        ? { requireMention: telegramConfig.requireMention as boolean }
        : null;
    current.messagingChannelConfig = messagingChannelConfig;
    return current;
  });
  // Pull the base image and resolve its digest so the Dockerfile is pinned to
  // exactly what we just fetched. This prevents stale :latest tags from
  // silently reusing a cached old image after NemoClaw upgrades (#1904).
  const resolved = pullAndResolveBaseImageDigest({
    requireOpenshellSandboxAbi: isLinuxDockerDriverGatewayEnabled(),
  });
  if (resolved?.digest) {
    console.log(`  Pinning base image to ${resolved.digest.slice(0, 19)}...`);
  } else if (resolved) {
    console.log(`  Using sandbox base image ${resolved.ref}`);
  } else {
    // Check if the image exists locally before falling back to unpinned :latest.
    // On a first-time install behind a firewall with no cached image, warn early
    // so the user knows the build will likely fail.
    const localCheck = dockerImageInspect(`${SANDBOX_BASE_IMAGE}:${SANDBOX_BASE_TAG}`, {
      ignoreError: true,
      suppressOutput: true,
    });
    if (localCheck.status === 0) {
      console.warn("  Warning: could not pull base image from registry; using cached :latest.");
    } else {
      console.warn(
        `  Warning: base image ${SANDBOX_BASE_IMAGE}:${SANDBOX_BASE_TAG} is not available locally.`,
      );
      console.warn("  The build will fail unless Docker can pull the image during build.");
      console.warn("  If offline, pull the image manually first:");
      console.warn(`    docker pull ${SANDBOX_BASE_IMAGE}:${SANDBOX_BASE_TAG}`);
    }
  }
  const buildId = String(Date.now());
  patchStagedDockerfile(
    stagedDockerfile,
    model,
    chatUiUrl,
    buildId,
    provider,
    preferredInferenceApi,
    webSearchConfig,
    activeMessagingChannels,
    messagingAllowedIds,
    discordGuilds,
    resolved ? resolved.ref : null,
    telegramConfig,
  );
  // Only pass non-sensitive env vars to the sandbox. Credentials flow through
  // OpenShell providers — the gateway injects them as placeholders and the L7
  // proxy rewrites Authorization headers with real secrets at egress.
  // See: crates/openshell-sandbox/src/secrets.rs (placeholder rewriting),
  //      crates/openshell-router/src/backend.rs (inference auth injection).
  //
  // Use the shared allowlist (subprocess-env.ts) instead of the old
  // blocklist. The blocklist only blocked 12 specific credential names
  // and passed EVERYTHING else — including GITHUB_TOKEN,
  // AWS_SECRET_ACCESS_KEY, SSH_AUTH_SOCK, KUBECONFIG, NPM_TOKEN, and
  // any CI/CD secrets that happened to be in the host environment.
  // The allowlist inverts the default: only known-safe env vars are
  // forwarded, everything else is dropped.
  //
  // For the sandbox specifically, we also strip KUBECONFIG and
  // SSH_AUTH_SOCK — the generic allowlist includes these for host-side
  // subprocesses (gateway start, openshell CLI) but the sandbox should
  // never have access to the host's Kubernetes cluster or SSH agent.
  const envArgs = [formatEnvAssignment("CHAT_UI_URL", chatUiUrl)];
  // Always pass the effective dashboard port into the sandbox so
  // nemoclaw-start.sh starts the gateway on the correct port. When the
  // user sets CHAT_UI_URL with a custom port (e.g. :18790), the port
  // must reach the container — otherwise _DASHBOARD_PORT defaults to
  // 18789 and the gateway listens on the wrong port. (#2267, #1925)
  const effectiveDashboardPort = getDashboardForwardPort(chatUiUrl);
  envArgs.push(formatEnvAssignment("NEMOCLAW_DASHBOARD_PORT", effectiveDashboardPort));
  // Propagate NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT to the runtime
  // sandbox container. patchStagedDockerfile() already substitutes them
  // into the build-time Dockerfile ARG/ENV, but `openshell sandbox create
  // -- env … nemoclaw-start` only forwards the explicitly listed env vars
  // — image-baked ENV does not propagate into the running pod. Without
  // this, nemoclaw-start.sh:898 falls back to the default 10.200.0.1:3128
  // and `HTTPS_PROXY` inside the sandbox ignores the host override. The
  // build-time substitution and runtime env stay in sync as a result.
  // Fixes #2424. Uses the shared isValidProxyHost / isValidProxyPort
  // helpers so build-time and runtime validation stay aligned.
  const sandboxProxyHost = process.env.NEMOCLAW_PROXY_HOST;
  if (sandboxProxyHost && isValidProxyHost(sandboxProxyHost)) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_PROXY_HOST", sandboxProxyHost));
  }
  const sandboxProxyPort = process.env.NEMOCLAW_PROXY_PORT;
  if (sandboxProxyPort && isValidProxyPort(sandboxProxyPort)) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_PROXY_PORT", sandboxProxyPort));
  }
  if (webSearchConfig?.fetchEnabled) {
    const braveKey =
      getCredential(webSearch.BRAVE_API_KEY_ENV) || process.env[webSearch.BRAVE_API_KEY_ENV];
    if (braveKey) {
      envArgs.push(formatEnvAssignment(webSearch.BRAVE_API_KEY_ENV, braveKey));
    }
  }
  // Slack Socket Mode requires both tokens in the container env so the baked
  // openshell:resolve:env: placeholders in openclaw.json are substituted.
  // The provider registration above handles L7 proxy auth header rewriting;
  // the --env args here ensure the container env vars hold the real values.
  if (tokensByEnvKey["SLACK_BOT_TOKEN"]) {
    envArgs.push(formatEnvAssignment("SLACK_BOT_TOKEN", tokensByEnvKey["SLACK_BOT_TOKEN"]));
    if (tokensByEnvKey["SLACK_APP_TOKEN"]) {
      envArgs.push(formatEnvAssignment("SLACK_APP_TOKEN", tokensByEnvKey["SLACK_APP_TOKEN"]));
    }
  }
  const sandboxEnv = buildSubprocessEnv();
  // Remove host-infrastructure credentials that the generic allowlist
  // permits for host-side processes but that must not enter the sandbox.
  delete sandboxEnv.KUBECONFIG;
  delete sandboxEnv.SSH_AUTH_SOCK;
  // Run without piping through awk — the pipe masked non-zero exit codes
  // from openshell because bash returns the status of the last pipeline
  // command (awk, always 0) unless pipefail is set. Removing the pipe
  // lets the real exit code flow through to run().
  const createCommand = `${openshellShellCommand([
    "sandbox",
    "create",
    ...createArgs,
    "--",
    "env",
    ...envArgs,
    "nemoclaw-start",
  ])} 2>&1`;
  const createResult = await streamSandboxCreate(createCommand, sandboxEnv, {
    readyCheck: () => {
      const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      return isSandboxReady(list, sandboxName);
    },
  });

  if (initialSandboxPolicy.cleanup && initialSandboxPolicy.cleanup()) {
    process.removeListener("exit", initialSandboxPolicy.cleanup);
  }

  // Clean up build context regardless of outcome.
  // Use fs.rmSync instead of run() to avoid spawning a shell process.
  // Only deregister the 'exit' safety net when inline cleanup succeeded;
  // otherwise leave it armed so a later process.exit() still removes the
  // temp dir (which may hold source and env-arg API keys).
  if (cleanupBuildCtx()) {
    process.removeListener("exit", cleanupBuildCtx);
  }

  if (createResult.status !== 0) {
    const failure = classifySandboxCreateFailure(createResult.output);
    if (failure.kind === "sandbox_create_incomplete") {
      // The sandbox was created in the gateway but the create stream exited
      // with a non-zero code (e.g. SSH 255).  Fall through to the ready-wait
      // loop — the sandbox may still reach Ready on its own.
      console.warn("");
      console.warn(
        `  Create stream exited with code ${createResult.status} after sandbox was created.`,
      );
      console.warn("  Checking whether the sandbox reaches Ready state...");
    } else {
      console.error("");
      console.error(`  Sandbox creation failed (exit ${createResult.status}).`);
      if (createResult.output) {
        console.error("");
        console.error(createResult.output);
      }
      console.error("  Try:  openshell sandbox list        # check gateway state");
      printSandboxCreateRecoveryHints(createResult.output);
      process.exit(createResult.status || 1);
    }
  }

  // Wait for sandbox to reach Ready state in k3s before registering.
  // On WSL2 + Docker Desktop the pod can take longer to initialize;
  // without this gate, NemoClaw registers a phantom sandbox that
  // causes "sandbox not found" on every subsequent connect/status call.
  console.log("  Waiting for sandbox to become ready...");
  let ready = false;
  const readyAttempts = Math.max(1, Math.ceil(SANDBOX_READY_TIMEOUT_SECS / 2));
  for (let i = 0; i < readyAttempts; i++) {
    const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
    if (isSandboxReady(list, sandboxName)) {
      ready = true;
      break;
    }
    if (i < readyAttempts - 1) sleep(2);
  }

  if (!ready) {
    // Clean up the orphaned sandbox so the next onboard retry with the same
    // name doesn't fail on "sandbox already exists".
    const delResult = runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    console.error("");
    console.error(
      `  Sandbox '${sandboxName}' was created but did not become ready within ${SANDBOX_READY_TIMEOUT_SECS}s.`,
    );
    if (delResult.status === 0) {
      console.error("  The orphaned sandbox has been removed — you can safely retry.");
    } else {
      console.error(`  Could not remove the orphaned sandbox. Manual cleanup:`);
      console.error(`    openshell sandbox delete "${sandboxName}"`);
    }
    console.error(`  Retry: ${cliName()} onboard`);
    process.exit(1);
  }

  // Wait for the branded dashboard to become fully ready (web server live)
  // This prevents port forwards from connecting to a non-existent port
  // or seeing 502/503 errors during initial load.
  // Probes /health endpoint and accepts 200 or 401 (device auth) as "alive".
  // Previously used `curl -sf` which failed on 401, causing false negatives. Fixes #2342.
  console.log("  Waiting for NemoClaw dashboard to become ready...");
  const openshellBin = getOpenshellBinary();
  for (let i = 0; i < 15; i++) {
    const readyOutput = runCaptureOpenshell(
      ["sandbox", "exec", "-n", sandboxName, "--", "curl", "-so", "/dev/null", "-w", "%{http_code}",
        "--max-time", "3", `http://localhost:${effectiveDashboardPort}/health`],
      { ignoreError: true },
    );
    const readyCode = parseInt((readyOutput || "").trim(), 10) || 0;
    if (readyCode === 200 || readyCode === 401) {
      console.log("  ✓ Dashboard is live");
      break;
    }
    if (i === 14) {
      console.warn("  Dashboard taking longer than expected to start. Continuing...");
    } else {
      sleep(2);
    }
  }

  if (effectiveSandboxGpuConfig.sandboxGpuEnabled) {
    try {
      verifyDirectSandboxGpu(sandboxName);
    } catch (error) {
      const delResult = runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
      if (delResult.status === 0) {
        console.error("  The sandbox with failed GPU access has been removed — you can retry safely.");
      } else {
        console.error("  Could not remove the sandbox with failed GPU access. Manual cleanup:");
        console.error(`    openshell sandbox delete "${sandboxName}"`);
      }
      throw error;
    }
  }

  // Verify web search config was actually accepted by the agent runtime.
  // Hermes silently ignores unknown web.backend values (e.g. "brave" before
  // upstream support lands), so we exec into the sandbox and check for a
  // recognizable signal. OpenClaw validates at config-generation time, but
  // this probe catches drift for all agents.
  if (webSearchConfig?.fetchEnabled) {
    verifyWebSearchInsideSandbox(sandboxName, agent);
  }

  // Release any stale forward on the dashboard port before claiming it for the new sandbox.
  // A previous onboard run may have left the port forwarded to a different sandbox,
  // which would silently prevent the new sandbox's dashboard from being reachable.
  // Auto-allocates the next free port if the preferred one is taken (Fixes #2174).
  // Roll back the just-created openshell sandbox on unrecoverable allocation
  // failure so the registry and `openshell sandbox list` don't drift (#2174).
  const actualDashboardPort = ensureDashboardForward(sandboxName, chatUiUrl, {
    rollbackSandboxOnFailure: true,
  });
  // Update chatUiUrl and CHAT_UI_URL env so printDashboard / getDashboardAccessInfo
  // see the final port (they re-read process.env.CHAT_UI_URL independently).
  if (actualDashboardPort !== Number(getDashboardForwardPort(chatUiUrl))) {
    chatUiUrl = `http://127.0.0.1:${actualDashboardPort}`;
  }
  process.env.CHAT_UI_URL = chatUiUrl;

  // Register only after confirmed ready — prevents phantom entries
  const providerCredentialHashes: Record<string, string> = {};
  for (const { envKey, token } of messagingTokenDefs) {
    const hash = token ? hashCredential(token) : null;
    if (hash) {
      providerCredentialHashes[envKey] = hash;
    }
  }
  for (const envKey of reusableMessagingEnvKeys) {
    const previousHash = previousProviderCredentialHashes[envKey];
    if (typeof previousHash === "string" && previousHash) {
      providerCredentialHashes[envKey] = previousHash;
    }
  }
  // openshell tags images with seconds; buildId is ms. Parse actual tag from output. Fixes #2672.
  const builtImageMatch = createResult.output.match(/Built image (openshell\/sandbox-from:\d+)/);
  if (!builtImageMatch) {
    console.warn(
      "  Warning: could not parse image tag from build output; imageTag may be stale. Run 'nemoclaw gc' if destroy fails.",
    );
  }
  const resolvedImageTag = builtImageMatch
    ? builtImageMatch[1]
    : `openshell/sandbox-from:${buildId}`;

  registry.registerSandbox({
    name: sandboxName,
    model: model || null,
    provider: provider || null,
    ...getSandboxRuntimeRegistryFields(effectiveSandboxGpuConfig),
    ...getSandboxAgentRegistryFields(agent, !fromDockerfile),
    imageTag: resolvedImageTag,
    providerCredentialHashes:
      Object.keys(providerCredentialHashes).length > 0 ? providerCredentialHashes : undefined,
    policies: initialSandboxPolicy.appliedPresets,
    messagingChannels: activeMessagingChannels,
    messagingChannelConfig: messagingChannelConfig || undefined,
    disabledChannels: disabledChannels.length > 0 ? [...disabledChannels] : undefined,
    dashboardPort: actualDashboardPort,
  });
  registry.setDefault(sandboxName);

  // Restore workspace state if we backed it up during credential rotation.
  if (pendingStateRestore?.success && pendingStateRestore.manifest) {
    note("  Restoring workspace state after credential rotation...");
    const restore = sandboxState.restoreSandboxState(
      sandboxName,
      pendingStateRestore.manifest.backupPath,
    );
    if (restore.success) {
      note(
        `  ✓ State restored (${restore.restoredDirs.length} directories, ${restore.restoredFiles.length} files)`,
      );
    } else {
      console.error(
        `  Warning: partial restore. Manual recovery: ${pendingStateRestore.manifest.backupPath}`,
      );
    }
  }

  // DNS proxy — run a forwarder in the sandbox pod so the isolated
  // sandbox namespace can resolve hostnames (fixes #626).
  if (!isLinuxDockerDriverGatewayPlatform()) {
    console.log("  Setting up sandbox DNS proxy...");
    runFile("bash", [path.join(SCRIPTS, "setup-dns-proxy.sh"), GATEWAY_NAME, sandboxName], {
      ignoreError: true,
    });
  }

  // Check that messaging providers exist in the gateway (sandbox attachment
  // cannot be verified via CLI yet — only gateway-level existence is checked).
  for (const p of messagingProviders) {
    if (!providerExistsInGateway(p)) {
      console.error(`  ⚠ Messaging provider '${p}' was not found in the gateway.`);
      console.error(`    The credential may not be available inside the sandbox.`);
      console.error(
        `    To fix: openshell provider create --name ${p} --type generic --credential <KEY>`,
      );
    }
  }

  console.log(`  ✓ Sandbox '${sandboxName}' created`);

  try {
    if (process.platform === "darwin") {
      const vmKernel = dockerInfoFormat("{{.KernelVersion}}", {
        ignoreError: true,
      }).trim();
      if (vmKernel) {
        const parts = vmKernel.split(".");
        const major = parseInt(parts[0], 10);
        const minor = parseInt(parts[1], 10);
        if (!isNaN(major) && !isNaN(minor) && (major < 5 || (major === 5 && minor < 13))) {
          console.warn(
            `  ⚠ Landlock: Docker VM kernel ${vmKernel} does not support Landlock (requires ≥5.13).`,
          );
          console.warn(
            "    Sandbox filesystem restrictions will silently degrade (best_effort mode).",
          );
        }
      }
    } else if (process.platform === "linux") {
      const uname = runCapture(["uname", "-r"], { ignoreError: true }).trim();
      if (uname) {
        const parts = uname.split(".");
        const major = parseInt(parts[0], 10);
        const minor = parseInt(parts[1], 10);
        if (!isNaN(major) && !isNaN(minor) && (major < 5 || (major === 5 && minor < 13))) {
          console.warn(`  ⚠ Landlock: Kernel ${uname} does not support Landlock (requires ≥5.13).`);
          console.warn(
            "    Sandbox filesystem restrictions will silently degrade (best_effort mode).",
          );
        }
      }
    }
  } catch {}

  return sandboxName;
}

// ── Step 3: Inference selection ──────────────────────────────────

type ProviderChoice = { key: string; label: string };

function providerNameToOptionKey(
  name: string | null | undefined,
  opts: { hasNimContainer?: boolean } = {},
): string | null {
  if (!name) return null;
  if (name === "nvidia-router") return "routed";
  if (name === "ollama-local") return "ollama";
  // Local NIM and standalone vLLM both persist as provider="vllm-local". NIM
  // is positively identified by a nimContainer record; the absence of one in
  // registry/session recovery reliably means standalone vLLM (the standalone
  // path never records a container), so default to "vllm" there. Live-gateway
  // recovery doesn't carry container info either, but the caller's
  // option-availability check still gates on whether vllm is actually running.
  if (name === "vllm-local") return opts.hasNimContainer ? "nim-local" : "vllm";
  // `nvidia-nim` is a legacy alias for cloud NVIDIA Endpoints (see
  // setupInference: it routes nvidia-nim through REMOTE_PROVIDER_CONFIG.build),
  // not a marker for Local NIM. Local NIM persists as vllm-local + nimContainer.
  if (name === "nvidia-nim") return "build";
  for (const [key, cfg] of Object.entries(REMOTE_PROVIDER_CONFIG)) {
    if ((cfg as { providerName?: string }).providerName === name) return key;
  }
  return null;
}

function readLiveInference(
  sandboxName: string | null | undefined,
): { provider: string | null; model: string | null } | null {
  if (!sandboxName) return null;
  try {
    const { defaultSandbox, sandboxes } = registry.listSandboxes();
    // The gateway holds one active inference config at a time. Trust the
    // live read for the default sandbox, or when the registry has no
    // entries (rebuild path: destroy wiped the entry but the gateway
    // config persists). Other non-default sandboxes have a stored config
    // that the gateway will swap to on their next connect.
    const trustGateway = sandboxName === defaultSandbox || sandboxes.length === 0;
    if (!trustGateway) return null;
    const output = runCaptureOpenshell(["inference", "get"], { ignoreError: true });
    return parseGatewayInference(output);
  } catch {
    return null;
  }
}

function readRecordedProvider(sandboxName: string | null | undefined): string | null {
  if (!sandboxName) return null;
  try {
    const entry = registry.getSandbox(sandboxName);
    if (entry && typeof entry.provider === "string" && entry.provider) {
      return entry.provider;
    }
  } catch {
    // fall through to session
  }
  try {
    const session = onboardSession.loadSession();
    if (
      session &&
      session.sandboxName === sandboxName &&
      typeof session.provider === "string" &&
      session.provider
    ) {
      return session.provider;
    }
  } catch {
    // fall through to live gateway
  }
  const live = readLiveInference(sandboxName);
  if (live && typeof live.provider === "string" && live.provider) {
    return live.provider;
  }
  return null;
}

function readRecordedNimContainer(sandboxName: string | null | undefined): string | null {
  if (!sandboxName) return null;
  try {
    const entry = registry.getSandbox(sandboxName);
    if (entry && typeof entry.nimContainer === "string" && entry.nimContainer) {
      return entry.nimContainer;
    }
  } catch {
    // fall through to session
  }
  try {
    const session = onboardSession.loadSession();
    if (
      session &&
      session.sandboxName === sandboxName &&
      typeof session.nimContainer === "string" &&
      session.nimContainer
    ) {
      return session.nimContainer;
    }
  } catch {
    return null;
  }
  return null;
}

function readRecordedModel(sandboxName: string | null | undefined): string | null {
  if (!sandboxName) return null;
  try {
    const entry = registry.getSandbox(sandboxName);
    if (entry && typeof entry.model === "string" && entry.model) {
      return entry.model;
    }
  } catch {
    // fall through to session
  }
  try {
    const session = onboardSession.loadSession();
    if (
      session &&
      session.sandboxName === sandboxName &&
      typeof session.model === "string" &&
      session.model
    ) {
      return session.model;
    }
  } catch {
    // fall through to live gateway
  }
  const live = readLiveInference(sandboxName);
  if (live && typeof live.model === "string" && live.model) {
    return live.model;
  }
  return null;
}

type OllamaModelSelectionOutcome =
  | { outcome: "selected"; model: string }
  | { outcome: "back-to-selection" };

// Pick an Ollama model, pull it if missing, and validate it via the local
// proxy. Shared by the three Ollama provider branches (running, Windows-host
// install/start, install-locally). Returns "back-to-selection" so the caller
// can `continue` its labelled outer selectionLoop.
async function selectAndValidateOllamaModel(
  gpu: ReturnType<typeof nim.detectGpu>,
  provider: string,
  defaults: { requestedModel: string | null; recoveredModel: string | null },
): Promise<OllamaModelSelectionOutcome> {
  const { requestedModel, recoveredModel } = defaults;
  while (true) {
    const installedModels = getOllamaModelOptions();
    let model: string;
    if (isNonInteractive()) {
      model = requestedModel || recoveredModel || getDefaultOllamaModel(gpu);
    } else {
      model = await promptOllamaModel(gpu);
    }
    if (model === BACK_TO_SELECTION) {
      console.log("  Returning to provider selection.");
      console.log("");
      return { outcome: "back-to-selection" };
    }
    const selectedModel = requireValue(model, "Expected an Ollama model selection");
    if (!installedModels.includes(selectedModel)) {
      const lookup = ollamaModelSize.getOllamaModelSize(selectedModel);
      const sizeLabel = ollamaModelSize.formatModelSize(lookup);
      if (isAutoYes()) {
        note(`  Pulling Ollama model '${selectedModel}' (${sizeLabel}).`);
      } else if (isNonInteractive()) {
        console.error(
          `  Ollama model '${selectedModel}' (${sizeLabel}) is not installed and ` +
            "non-interactive mode cannot prompt for confirmation. " +
            "Re-run with --yes / -y (or NEMOCLAW_YES=1) to authorise the download.",
        );
        process.exit(1);
      } else {
        const proceed = await promptYesNoOrDefault(
          `  Download Ollama model '${selectedModel}' (${sizeLabel})?`,
          null,
          false,
        );
        if (!proceed) {
          console.error(
            `  Skipped pulling Ollama model '${selectedModel}'. Choose another model or re-run with --yes to confirm.`,
          );
          console.log("  Choose a different Ollama model or select Other.");
          console.log("");
          continue;
        }
      }
    }
    const probe = await prepareOllamaModel(selectedModel, installedModels);
    if (!probe.ok) {
      console.error(`  ${probe.message}`);
      if (isNonInteractive()) process.exit(1);
      console.log("  Choose a different Ollama model or select Other.");
      console.log("");
      continue;
    }
    const validationBaseUrl = getLocalProviderValidationBaseUrl(provider);
    if (!validationBaseUrl) {
      console.error("  Local Ollama validation URL could not be determined.");
      process.exit(1);
    }
    const validation = await validateOpenAiLikeSelection(
      "Local Ollama",
      validationBaseUrl,
      selectedModel,
      null,
      "Choose a different Ollama model or select Other.",
      null,
      {
        skipResponsesProbe: true,
        requireChatCompletionsToolCalling: true,
      },
    );
    if (validation.retry === "selection") return { outcome: "back-to-selection" };
    if (!validation.ok) continue;
    // Ollama's /v1/responses endpoint does not produce correctly formatted
    // tool calls — force chat completions like vLLM/NIM.
    if (validation.api !== "openai-completions") {
      console.log(
        "  ℹ Using chat completions API (Ollama tool calls require /v1/chat/completions)",
      );
    }
    return { outcome: "selected", model: selectedModel };
  }
}

async function setupNim(
  gpu: ReturnType<typeof nim.detectGpu>,
  sandboxName: string | null = null,
  agent: AgentDefinition | null = null,
): Promise<{
  model: string | null;
  provider: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  hermesAuthMethod: HermesAuthMethod | null;
  preferredInferenceApi: string | null;
  nimContainer: string | null;
}> {
  step(3, 8, "Configuring inference (NIM)");

  let model: string | null = null;
  let provider: string = REMOTE_PROVIDER_CONFIG.build.providerName;
  let nimContainer: string | null = null;
  let endpointUrl: string | null = REMOTE_PROVIDER_CONFIG.build.endpointUrl;
  let credentialEnv: string | null = REMOTE_PROVIDER_CONFIG.build.credentialEnv;
  let hermesAuthMethod: HermesAuthMethod | null = null;
  let preferredInferenceApi: string | null = null;

  // Detect local inference options. Bound curl with --connect-timeout/--max-time
  // so a half-open port or stalled listener cannot hang the onboard at step 3
  // (#2674).
  const localProbeCurlArgs = ["--connect-timeout", "2", "--max-time", "5"] as const;
  const hasOllama = hostCommandExists("ollama");
  // run and consumed by the Ollama lifecycle helpers in inference/local.ts.
  const ollamaHost = findReachableOllamaHost();
  const ollamaRunning = ollamaHost !== null;
  const vllmRunning = !!runCapture(
    ["curl", "-sf", ...localProbeCurlArgs, `http://127.0.0.1:${VLLM_PORT}/v1/models`],
    { ignoreError: true },
  );
  // Pick a vLLM install recipe for this host. Profiles live in inference/vllm.ts;
  // null means "no supported platform" (vLLM stays behind EXPERIMENTAL).
  const vllmProfile = detectVllmProfile(gpu);
  // If the profile's image is already cached, the install path is really a
  // "start" — docker pull is a no-op and the container can come up in seconds.
  const hasVllmImage = !!(
    vllmProfile &&
    docker.dockerCapture(["images", "-q", vllmProfile.image], { ignoreError: true }).trim()
  );
  // Probed even when WSL has its own Ollama: users may prefer the Windows
  // instance for GPU access and a unified model cache.
  let hasWindowsOllama = false;
  if (isWsl()) {
    const winOllamaPath = runCapture(
      [
        "powershell.exe",
        "-Command",
        "Get-Command ollama.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source",
      ],
      { ignoreError: true },
    ).trim();
    hasWindowsOllama = winOllamaPath.length > 0;
  }

  let winOllamaLoopbackOnly = false;
  if (isWsl() && hasWindowsOllama) {
    const winPid = runCapture(
      [
        "powershell.exe",
        "-Command",
        "Get-Process ollama -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
      ],
      { ignoreError: true },
    ).trim();
    if (winPid) {
      const listenAddrs = runCapture(
        [
          "powershell.exe",
          "-Command",
          "Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalAddress",
        ],
        { ignoreError: true },
      );
      winOllamaLoopbackOnly =
        /127\.0\.0\.1/.test(listenAddrs) && !/0\.0\.0\.0|^::\s*$/m.test(listenAddrs);
    }
  }

  // Independent of findReachableOllamaHost: when WSL Ollama wins the cache
  // on 127.0.0.1, Windows-host may also be running on 0.0.0.0 and we want
  // to offer a "switch" without restarting anything.
  let windowsOllamaReachable = false;
  if (isWsl() && ollamaHost !== "host.docker.internal") {
    windowsOllamaReachable = !!runCapture(
      ["curl", "-sf", ...localProbeCurlArgs, `http://host.docker.internal:${OLLAMA_PORT}/api/tags`],
      { ignoreError: true },
    );
  }

  // Mirrored mode shares loopback so both probes hit the same instance;
  // only NAT mode actually has two separate daemons to warn about.
  if (isWsl() && ollamaHost === "127.0.0.1" && windowsOllamaReachable) {
    const networkingMode = runCapture(["wslinfo", "--networking-mode"], {
      ignoreError: true,
    }).trim();
    if (networkingMode !== "mirrored") {
      console.log("");
      console.log("  ⚠ Ollama is running on both WSL and the Windows host.");
      console.log("    Stop one to avoid duplicated GPU memory and model caches.");
      console.log("");
    }
  }
  const requestedProvider = isNonInteractive() ? getNonInteractiveProvider() : null;
  const requestedModel = isNonInteractive()
    ? getNonInteractiveModel(requestedProvider || "build")
    : null;
  const agentProviderOptions = getAgentInferenceProviderOptions(agent);
  const hermesProviderAvailable = agentProviderOptions.includes("hermesProvider");
  const options: Array<{ key: string; label: string }> = [];
  options.push({ key: "build", label: "NVIDIA Endpoints" });
  options.push({ key: "openai", label: "OpenAI" });
  options.push({ key: "custom", label: "Other OpenAI-compatible endpoint" });
  options.push({ key: "anthropic", label: "Anthropic" });
  options.push({ key: "anthropicCompatible", label: "Other Anthropic-compatible endpoint" });
  options.push({ key: "gemini", label: "Google Gemini" });
  if (hasOllama || ollamaRunning) {
    let hostDisplay: string;
    if (ollamaHost === "host.docker.internal") {
      hostDisplay = `Windows host:${OLLAMA_PORT}`;
    } else if (isWsl()) {
      hostDisplay = `WSL:${OLLAMA_PORT}`;
    } else {
      hostDisplay = `localhost:${OLLAMA_PORT}`;
    }
    // On WSL the Windows-host entry (Use/Restart/Start, or Install) always
    // carries the suggestion instead, since Windows-host is preferred.
    const wslOllamaSuggested =
      ollamaRunning && (ollamaHost === "host.docker.internal" || !isWsl());
    options.push({
      key: "ollama",
      label:
        `Local Ollama (${hostDisplay})${ollamaRunning ? " — running" : ""}` +
        (wslOllamaSuggested ? " (suggested)" : ""),
    });
  }
  if (EXPERIMENTAL && gpu && gpu.nimCapable) {
    options.push({ key: "nim-local", label: "Local NVIDIA NIM [experimental]" });
  }
  // vLLM: profiles in inference/vllm.ts surface as menu entries only when
  // the user explicitly opts in via NEMOCLAW_PROVIDER, or when
  // NEMOCLAW_EXPERIMENTAL=1 is set.
  // Read NEMOCLAW_PROVIDER directly so interactive runs with an explicit
  // env-var opt-in surface the menu entry too — requestedProvider is null
  // outside non-interactive mode.
  const explicitProvider = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
  const userChoseVllm = explicitProvider === "vllm" || explicitProvider === "install-vllm";
  if (vllmProfile && (userChoseVllm || EXPERIMENTAL)) {
    if (vllmRunning) {
      options.push({
        key: "vllm",
        label: `Local vLLM (localhost:${VLLM_PORT}) — running (suggested)`,
      });
    } else {
      const verb = hasVllmImage ? "Start" : "Install";
      options.push({ key: "install-vllm", label: `${verb} vLLM (${vllmProfile.name})` });
    }
  } else if (EXPERIMENTAL && vllmRunning) {
    options.push({
      key: "vllm",
      label: "Local vLLM [experimental] — running",
    });
  }
  // Skipped when Windows-host already won the cache: the running entry
  // above already covers that case.
  if (hasWindowsOllama && ollamaHost !== "host.docker.internal") {
    let windowsOllamaLabel: string;
    if (windowsOllamaReachable) {
      windowsOllamaLabel = "Use Ollama on Windows host - running (suggested)";
    } else if (winOllamaLoopbackOnly) {
      windowsOllamaLabel = "Restart Ollama on Windows host with 0.0.0.0 binding (suggested)";
    } else {
      windowsOllamaLabel = "Start Ollama on Windows host (suggested)";
    }
    options.push({ key: "start-windows-ollama", label: windowsOllamaLabel });
  }
  // On WSL, always offer to install Ollama on the Windows host when not
  // already installed, regardless of WSL Ollama state — users may prefer the
  // Windows-host instance (GPU access) even with WSL Ollama running.
  if (isWsl() && !hasWindowsOllama) {
    options.push({
      key: "install-windows-ollama",
      label: "Install Ollama on Windows host (recommended)",
    });
  }
  // Without any Ollama, offer to install one locally as a fallback (e.g. when
  // the NVIDIA API server is down and cloud keys are unavailable).
  if (!hasOllama && !ollamaRunning && !hasWindowsOllama) {
    if (process.platform === "darwin") {
      options.push({ key: "install-ollama", label: "Install Ollama (macOS)" });
    } else if (process.platform === "linux") {
      if (isWsl()) {
        options.push({ key: "install-ollama", label: "Install Ollama (WSL Linux)" });
      } else {
        options.push({ key: "install-ollama", label: "Install Ollama (Linux)" });
      }
    }
  }

  // Model Router: complexity-based routing via blueprint config.
  const blueprintRouterCfg = loadBlueprintProfile("routed");
  if (blueprintRouterCfg && blueprintRouterCfg.router?.enabled === true) {
    options.push({ key: "routed", label: "Model Router (experimental)" });
  }
  for (const providerKey of agentProviderOptions) {
    const remoteConfig = REMOTE_PROVIDER_CONFIG[providerKey];
    if (!remoteConfig || options.some((option) => option.key === providerKey)) continue;
    options.push({ key: providerKey, label: remoteConfig.label });
  }

  function checkOllamaPortsOrWarn(): boolean {
    const portValidation = validateOllamaPortConfiguration();
    if (!portValidation.ok) {
      console.error(`  ${portValidation.message}`);
      if (isNonInteractive()) {
        process.exit(1);
      }
      console.log("  Choose a different local inference provider or fix the port settings.");
      console.log("");
      return false;
    }
    return true;
  }

  if (options.length > 1) {
    selectionLoop: while (true) {
      let selected: ProviderChoice | undefined;
      // Hoisted so downstream model-selection branches can fall back to a
      // recorded model from the same recovery decision.
      let recoveredFromSandbox = false;
      let recoveredModel: string | null = null;
      hermesAuthMethod = null;

      if (isNonInteractive()) {
        let providerKey = requestedProvider;
        if (!providerKey) {
          const recordedProvider = readRecordedProvider(sandboxName);
          const hasNimContainer = !!readRecordedNimContainer(sandboxName);
          const recoveredKey = providerNameToOptionKey(recordedProvider, { hasNimContainer });
          if (recoveredKey) {
            // Refuse to silently switch providers behind the user's back; if
            // the previously-recorded one is gone, surface the recorded value
            // so the user can fix the dependency or override via env var.
            // Special case: on WSL, recorded ollama-local was WSL Ollama at
            // record time. If the only reachable Ollama is now Windows-host
            // (so the menu's "ollama" key points there), the availability
            // check below would pass and silently swap the daemon. Detect
            // and fail-loud with a hint.
            if (
              isWsl() &&
              recordedProvider === "ollama-local" &&
              ollamaHost === OLLAMA_HOST_DOCKER_INTERNAL
            ) {
              console.error(
                `  Recorded provider '${recordedProvider}' (WSL Ollama) is not available in this environment.`,
              );
              console.error(
                "  Hint: Windows-host Ollama is reachable here; re-run with NEMOCLAW_PROVIDER=ollama to use it explicitly.",
              );
              process.exit(1);
            }
            if (!options.some((o) => o.key === recoveredKey)) {
              console.error(
                `  Recorded provider '${recordedProvider}' is not available in this environment.`,
              );
              console.error(
                "  Set NEMOCLAW_PROVIDER explicitly, or restore the missing local-inference dependency.",
              );
              if (recoveredKey === "ollama") {
                const winHostKey = options.find(
                  (o) =>
                    o.key === "start-windows-ollama" || o.key === "install-windows-ollama",
                )?.key;
                if (winHostKey) {
                  console.error(
                    `  Hint: Windows-host Ollama is available here — re-run with NEMOCLAW_PROVIDER=${winHostKey} to use it.`,
                  );
                }
              }
              process.exit(1);
            }
            providerKey = recoveredKey;
            recoveredFromSandbox = true;
            recoveredModel = readRecordedModel(sandboxName);
          } else if (recordedProvider === "vllm-local") {
            // vllm-local without a nimContainer marker is ambiguous — could be
            // standalone vLLM or Local NIM. Don't guess; require an override.
            console.error(
              "  Recorded provider 'vllm-local' is ambiguous (could be standalone vLLM or Local NIM).",
            );
            console.error("  Set NEMOCLAW_PROVIDER explicitly (vllm or nim-local) and re-run.");
            process.exit(1);
          } else {
            providerKey = "build";
          }
        }
        selected = options.find((o) => o.key === providerKey);
        if (!selected) {
          // Action keys fall back to the equivalent running-provider key
          // when the menu only emits the running entry (the install would
          // have been a no-op anyway).
          if (providerKey === "install-ollama") {
            selected = options.find((o) => o.key === "ollama");
          } else if (providerKey === "install-vllm") {
            selected = options.find((o) => o.key === "vllm");
          } else if (providerKey === "vllm") {
            selected = options.find((o) => o.key === "install-vllm");
          } else if (providerKey === "ollama") {
            selected = options.find((o) => o.key === "install-ollama");
          }
          if (!selected) {
            if (providerKey === "hermesProvider" && !hermesProviderAvailable) {
              console.error("  Hermes Provider is only available when onboarding Hermes Agent.");
              console.error(
                "  Re-run with `nemohermes onboard` or `nemoclaw onboard --agent hermes`.",
              );
              process.exit(1);
            }
            console.error(
              `  Requested provider '${providerKey}' is not available in this environment.`,
            );
            process.exit(1);
          }
        }
        note(
          recoveredFromSandbox
            ? `  [non-interactive] Provider: ${selected.key} (recovered from sandbox '${sandboxName}')`
            : `  [non-interactive] Provider: ${selected.key}`,
        );
      } else {
        const suggestions: string[] = [];
        if (vllmRunning) suggestions.push("vLLM");
        if (ollamaRunning) suggestions.push("Ollama");
        if (suggestions.length > 0) {
          console.log(
            `  Detected local inference option${suggestions.length > 1 ? "s" : ""}: ${suggestions.join(", ")}`,
          );
          console.log("");
        }

        console.log("");
        console.log("  Inference options:");
        options.forEach((o, i) => {
          console.log(`    ${i + 1}) ${o.label}`);
        });
        console.log("");

        const envProviderHint = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
        const envProviderIdx = envProviderHint
          ? options.findIndex((o) => o.key.toLowerCase() === envProviderHint)
          : -1;
        const defaultIdx =
          (envProviderIdx >= 0 ? envProviderIdx : options.findIndex((o) => o.key === "build")) + 1;
        const choice = await prompt(`  Choose [${defaultIdx}]: `);
        const idx = parseInt(choice || String(defaultIdx), 10) - 1;
        selected = options[idx] || options[defaultIdx - 1];
      }

      if (!selected) {
        console.error("  No provider was selected.");
        process.exit(1);
      }
      if (selected.key !== "hermesProvider") {
        hermesAuthMethod = null;
      }

      if (REMOTE_PROVIDER_CONFIG[selected.key]) {
        const remoteConfig = REMOTE_PROVIDER_CONFIG[selected.key];
        provider = remoteConfig.providerName;
        credentialEnv = remoteConfig.credentialEnv;
        endpointUrl = remoteConfig.endpointUrl;
        preferredInferenceApi = null;

        if (selected.key === "custom") {
          const _envUrl = (process.env.NEMOCLAW_ENDPOINT_URL || "").trim();
          const endpointInput = isNonInteractive()
            ? _envUrl
            : (await prompt(
                _envUrl
                  ? `  OpenAI-compatible base URL [${_envUrl}]: `
                  : "  OpenAI-compatible base URL (e.g., https://openrouter.ai): ",
              )) || _envUrl;
          const navigation = getNavigationChoice(endpointInput);
          if (navigation === "back") {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
          if (navigation === "exit") {
            exitOnboardFromPrompt();
          }
          endpointUrl = normalizeProviderBaseUrl(endpointInput, "openai");
          if (!endpointUrl) {
            console.error("  Endpoint URL is required for Other OpenAI-compatible endpoint.");
            if (isNonInteractive()) {
              process.exit(1);
            }
            console.log("");
            continue selectionLoop;
          }
        } else if (selected.key === "anthropicCompatible") {
          const _envUrl = (process.env.NEMOCLAW_ENDPOINT_URL || "").trim();
          const endpointInput = isNonInteractive()
            ? _envUrl
            : (await prompt(
                _envUrl
                  ? `  Anthropic-compatible base URL [${_envUrl}]: `
                  : "  Anthropic-compatible base URL (e.g., https://proxy.example.com): ",
              )) || _envUrl;
          const navigation = getNavigationChoice(endpointInput);
          if (navigation === "back") {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
          if (navigation === "exit") {
            exitOnboardFromPrompt();
          }
          endpointUrl = normalizeProviderBaseUrl(endpointInput, "anthropic");
          if (!endpointUrl) {
            console.error("  Endpoint URL is required for Other Anthropic-compatible endpoint.");
            if (isNonInteractive()) {
              process.exit(1);
            }
            console.log("");
            continue selectionLoop;
          }
        }

        if (selected.key === "hermesProvider") {
          const selectedHermesAuthMethod = await promptHermesAuthMethod();
          if (selectedHermesAuthMethod === BACK_TO_SELECTION) {
            hermesAuthMethod = null;
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
          hermesAuthMethod = selectedHermesAuthMethod;
          if (hermesAuthMethod === HERMES_AUTH_METHOD_API_KEY) {
            credentialEnv = HERMES_NOUS_API_KEY_CREDENTIAL_ENV;
            stageNousApiKeyProviderEnv();
            if (isNonInteractive()) {
              if (!resolveHermesNousApiKey()) {
                console.error(
                  `  ${HERMES_NOUS_API_KEY_CREDENTIAL_ENV} (or NEMOCLAW_PROVIDER_KEY) is required for Hermes Provider Nous API Key in non-interactive mode.`,
                );
                process.exit(1);
              }
            } else {
              await ensureHermesNousApiKeyEnv();
            }
          } else {
            credentialEnv = remoteConfig.credentialEnv;
          }

          const defaultModel =
            requestedModel ||
            (recoveredFromSandbox && recoveredModel) ||
            remoteConfig.defaultModel;
          if (isNonInteractive()) {
            model = defaultModel;
          } else {
            let hermesProviderModels: string[] = [];
            try {
              hermesProviderModels = await nousModels.getHermesProviderModelOptions();
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              console.warn(
                `  Warning: failed to load Nous model recommendations; falling back to the current/default model (${detail}).`,
              );
            }
            model = await promptRemoteModel(
              remoteConfig.label,
              selected.key,
              defaultModel,
              null,
              {
                otherShowsFullList: true,
                remoteModelOptions: { [selected.key]: hermesProviderModels },
                topLevelModelLimit: 10,
              },
            );
          }
          if (model === BACK_TO_SELECTION) {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
          preferredInferenceApi = "openai-completions";
          console.log(`  Using ${remoteConfig.label} with model: ${model}`);
          break;
        }

        // Hydrate from credential env vars set earlier in this process
        // before checking env, so rebuild and other non-interactive callers
        // can resolve keys stored during the original interactive onboard.
        // See #2273.
        hydrateCredentialEnv(credentialEnv);

        if (selected.key === "build") {
          // Allow NEMOCLAW_PROVIDER_KEY as a fallback for NVIDIA_API_KEY.
          // Check raw process.env first — NEMOCLAW_PROVIDER_KEY is a user-facing
          // override that should take precedence before resolving from credentials.json.
          const _nvProviderKey = (process.env.NEMOCLAW_PROVIDER_KEY || "").trim();
          // check-direct-credential-env-ignore -- intentional: checking if env is already set before applying NEMOCLAW_PROVIDER_KEY override
          const existingNvidiaKey = normalizeCredentialValue(process.env.NVIDIA_API_KEY ?? "");
          if (_nvProviderKey && !existingNvidiaKey) {
            process.env.NVIDIA_API_KEY = _nvProviderKey;
          }
          if (isNonInteractive()) {
            const resolvedNvidiaKey = resolveProviderCredential("NVIDIA_API_KEY");
            if (!resolvedNvidiaKey) {
              console.error(
                "  NVIDIA_API_KEY (or NEMOCLAW_PROVIDER_KEY) is required for NVIDIA Endpoints in non-interactive mode.",
              );
              process.exit(1);
            }
            const keyError = validateNvidiaApiKeyValue(resolvedNvidiaKey);
            if (keyError) {
              console.error(keyError);
              console.error(`  Get a key from ${REMOTE_PROVIDER_CONFIG.build.helpUrl}`);
              process.exit(1);
            }
          } else {
            await ensureApiKey();
          }
          const _envModel = (process.env.NEMOCLAW_MODEL || "").trim();
          model =
            requestedModel ||
            (recoveredFromSandbox && recoveredModel) ||
            (isNonInteractive()
              ? DEFAULT_CLOUD_MODEL
              : await promptCloudModel({ defaultModelId: _envModel || undefined })) ||
            DEFAULT_CLOUD_MODEL;
          if (model === BACK_TO_SELECTION) {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
        } else {
          // NEMOCLAW_PROVIDER_KEY is a universal alias: if the specific credential env
          // isn't already set, use NEMOCLAW_PROVIDER_KEY as the API key for this provider.
          // Check raw process.env — the override must apply before resolving from credentials.json.
          const _providerKeyHint = (process.env.NEMOCLAW_PROVIDER_KEY || "").trim();
          if (_providerKeyHint && credentialEnv) {
            // check-direct-credential-env-ignore -- intentional: checking if env is already set before applying NEMOCLAW_PROVIDER_KEY override
            const existingCredentialKey = normalizeCredentialValue(process.env[credentialEnv] ?? "");
            if (!existingCredentialKey) {
              process.env[credentialEnv] = _providerKeyHint;
            }
          }

          if (isNonInteractive()) {
            if (!resolveProviderCredential(credentialEnv)) {
              console.error(
                `  ${credentialEnv} (or NEMOCLAW_PROVIDER_KEY) is required for ${remoteConfig.label} in non-interactive mode.`,
              );
              process.exit(1);
            }
          } else {
            await ensureNamedCredential(
              credentialEnv,
              remoteConfig.label + " API key",
              remoteConfig.helpUrl,
            );
          }
          const _envModelRemote = (process.env.NEMOCLAW_MODEL || "").trim();
          const defaultModel =
            requestedModel ||
            _envModelRemote ||
            (recoveredFromSandbox && recoveredModel) ||
            remoteConfig.defaultModel;
          const selectedCredentialEnv = requireValue(
            credentialEnv,
            `Missing credential env for ${remoteConfig.label}`,
          );
          let modelValidator: ((candidate: string) => ModelValidationResult) | null = null;
          if (selected.key === "openai" || selected.key === "gemini") {
            const modelAuthMode = getProbeAuthMode(provider);
            modelValidator = (candidate) =>
              validateOpenAiLikeModel(
                remoteConfig.label,
                endpointUrl || remoteConfig.endpointUrl,
                candidate,
                getCredential(selectedCredentialEnv) || "",
                ...(modelAuthMode ? [{ authMode: modelAuthMode }] : []),
              );
          } else if (selected.key === "anthropic") {
            modelValidator = (candidate) =>
              validateAnthropicModel(
                endpointUrl || ANTHROPIC_ENDPOINT_URL,
                candidate,
                getCredential(selectedCredentialEnv) || "",
              );
          }
          while (true) {
            if (isNonInteractive()) {
              model = defaultModel;
            } else if (remoteConfig.modelMode === "curated") {
              model = await promptRemoteModel(
                remoteConfig.label,
                selected.key,
                defaultModel,
                modelValidator,
              );
            } else {
              model = await promptInputModel(remoteConfig.label, defaultModel, modelValidator);
            }
            if (model === BACK_TO_SELECTION) {
              console.log("  Returning to provider selection.");
              console.log("");
              continue selectionLoop;
            }

            if (selected.key === "custom") {
              const validation = await validateCustomOpenAiLikeSelection(
                remoteConfig.label,
                endpointUrl || OPENAI_ENDPOINT_URL,
                model,
                selectedCredentialEnv,
                remoteConfig.helpUrl,
              );
              if (validation.ok) {
                // Force chat completions for all OpenAI-compatible endpoints
                // unless the user explicitly opted in to responses via env var.
                // Many backends (Ollama, vLLM, LiteLLM) expose /v1/responses
                // but do not correctly handle the `developer` role used by the
                // Responses API — messages with that role are silently dropped,
                // causing the model to receive no system prompt or tool
                // definitions. Chat completions uses the `system` role which
                // is universally supported.
                // See: https://github.com/NVIDIA/NemoClaw/issues/1932
                const explicitApi = (process.env.NEMOCLAW_PREFERRED_API || "").trim().toLowerCase();
                if (
                  explicitApi &&
                  explicitApi !== "openai-completions" &&
                  explicitApi !== "chat-completions"
                ) {
                  preferredInferenceApi = validation.api;
                } else {
                  if (validation.api !== "openai-completions") {
                    console.log(
                      "  ℹ Using chat completions API (compatible endpoints may not support the Responses API developer role)",
                    );
                  }
                  preferredInferenceApi = "openai-completions";
                }
                break;
              }
              if (
                validation.retry === "credential" ||
                validation.retry === "retry" ||
                validation.retry === "model"
              ) {
                continue;
              }
              if (validation.retry === "selection") {
                continue selectionLoop;
              }
            } else if (selected.key === "anthropicCompatible") {
              const validation = await validateCustomAnthropicSelection(
                remoteConfig.label,
                endpointUrl || ANTHROPIC_ENDPOINT_URL,
                model,
                selectedCredentialEnv,
                remoteConfig.helpUrl,
              );
              if (validation.ok) {
                preferredInferenceApi = validation.api;
                break;
              }
              if (
                validation.retry === "credential" ||
                validation.retry === "retry" ||
                validation.retry === "model"
              ) {
                continue;
              }
              if (validation.retry === "selection") {
                continue selectionLoop;
              }
            } else {
              const retryMessage = "Please choose a provider/model again.";
              if (selected.key === "anthropic") {
                const validation = await validateAnthropicSelectionWithRetryMessage(
                  remoteConfig.label,
                  endpointUrl || ANTHROPIC_ENDPOINT_URL,
                  model,
                  selectedCredentialEnv,
                  retryMessage,
                  remoteConfig.helpUrl,
                );
                if (validation.ok) {
                  preferredInferenceApi = validation.api;
                  break;
                }
                if (
                  validation.retry === "credential" ||
                  validation.retry === "retry" ||
                  validation.retry === "model"
                ) {
                  continue;
                }
              } else {
                const validation = await validateOpenAiLikeSelection(
                  remoteConfig.label,
                  endpointUrl,
                  model,
                  selectedCredentialEnv,
                  retryMessage,
                  remoteConfig.helpUrl,
                  {
                    requireResponsesToolCalling: shouldRequireResponsesToolCalling(provider),
                    skipResponsesProbe: shouldSkipResponsesProbe(provider),
                    authMode: getProbeAuthMode(provider),
                  },
                );
                if (validation.ok) {
                  preferredInferenceApi = validation.api;
                  break;
                }
                if (
                  validation.retry === "credential" ||
                  validation.retry === "retry" ||
                  validation.retry === "model"
                ) {
                  continue;
                }
              }
              continue selectionLoop;
            }
          }
        }

        if (selected.key === "build") {
          while (true) {
            const validation = await validateOpenAiLikeSelection(
              remoteConfig.label,
              endpointUrl,
              model,
              credentialEnv,
              "Please choose a provider/model again.",
              remoteConfig.helpUrl,
              {
                requireResponsesToolCalling: shouldRequireResponsesToolCalling(provider),
                skipResponsesProbe: shouldSkipResponsesProbe(provider),
                authMode: getProbeAuthMode(provider),
              },
            );
            if (validation.ok) {
              preferredInferenceApi = validation.api;
              break;
            }
            if (validation.retry === "credential" || validation.retry === "retry") {
              continue;
            }
            continue selectionLoop;
          }
        }

        console.log(`  Using ${remoteConfig.label} with model: ${model}`);
        break;
      } else if (selected.key === "nim-local") {
        const localGpu = requireValue(
          gpu,
          "GPU details are required for local NIM model selection",
        );
        // List models that fit GPU VRAM
        const models = nim.listModels().filter((m) => m.minGpuMemoryMB <= localGpu.totalMemoryMB);
        if (models.length === 0) {
          console.log("  No NIM models fit your GPU VRAM. Falling back to cloud API.");
        } else {
          let sel;
          if (isNonInteractive()) {
            const targetModel = requestedModel || (recoveredFromSandbox ? recoveredModel : null);
            if (targetModel) {
              sel = models.find((m) => m.name === targetModel);
              if (!sel) {
                const label = requestedModel ? "NEMOCLAW_MODEL for NIM" : "Recorded NIM model";
                console.error(`  Unsupported ${label}: ${targetModel}`);
                process.exit(1);
              }
            } else {
              sel = models[0];
            }
            note(`  [non-interactive] NIM model: ${sel.name}`);
          } else {
            console.log("");
            console.log("  Models that fit your GPU:");
            models.forEach((m, i) => {
              console.log(`    ${i + 1}) ${m.name} (min ${m.minGpuMemoryMB} MB)`);
            });
            console.log("");

            const modelChoice = await prompt(`  Choose model [1]: `);
            const midx = parseInt(modelChoice || "1", 10) - 1;
            sel = models[midx] || models[0];
          }
          model = sel.name;

          // Ensure Docker is logged in to NGC registry before pulling NIM images.
          // The key is also forwarded into the NIM container at runtime (#3333),
          // so we hoist it out of the not-logged-in branch.
          let ngcApiKey: string | null = null;
          if (!nim.isNgcLoggedIn()) {
            if (isNonInteractive()) {
              console.error(
                "  Docker is not logged in to nvcr.io. In non-interactive mode, run `docker login nvcr.io` first and retry.",
              );
              process.exit(1);
            }
            console.log("");
            console.log("  NGC API Key required to pull NIM images.");
            console.log("  Get one from: https://org.ngc.nvidia.com/setup/api-key");
            console.log("");
            let ngcKey = normalizeCredentialValue(
              await prompt("  NGC API Key: ", { secret: true }),
            );
            if (!ngcKey) {
              console.error("  NGC API Key is required for Local NIM.");
              process.exit(1);
            }
            if (!nim.dockerLoginNgc(ngcKey)) {
              console.error("  Failed to login to NGC registry. Check your API key and try again.");
              console.log("");
              ngcKey = normalizeCredentialValue(await prompt("  NGC API Key: ", { secret: true }));
              if (!ngcKey || !nim.dockerLoginNgc(ngcKey)) {
                console.error("  NGC login failed. Cannot pull NIM images.");
                process.exit(1);
              }
            }
            ngcApiKey = ngcKey;
          } else {
            // Docker is already logged in, but NIM still needs the key in its
            // container env to download model manifests. Users hit by the
            // original #3333 bug typically have a cached docker login from
            // the earlier broken attempt while the NGC key was never saved
            // anywhere, so a passive lookup would silently reproduce the
            // failure. Try env first, then prompt interactively; an empty
            // answer falls through to startNimContainerByName's warning so
            // we don't double-fail in non-interactive callers.
            ngcApiKey =
              hydrateCredentialEnv("NGC_API_KEY") || hydrateCredentialEnv("NVIDIA_API_KEY");
            if (!ngcApiKey && !isNonInteractive()) {
              console.log("");
              console.log("  NGC API Key required to download NIM model weights at runtime.");
              console.log("  (Docker is logged in to nvcr.io, but the key was not saved.)");
              ngcApiKey = normalizeCredentialValue(
                await prompt("  NGC API Key: ", { secret: true }),
              );
            }
          }

          console.log(`  Pulling NIM image for ${model}...`);
          nim.pullNimImage(model);

          console.log("  Starting NIM container...");
          const nimContainerNameLocal = nim.containerName(GATEWAY_NAME);
          nimContainer = nim.startNimContainerByName(nimContainerNameLocal, model, undefined, {
            ngcApiKey: ngcApiKey ?? undefined,
          });

          console.log("  Waiting for NIM to become healthy...");
          if (!nim.waitForNimHealth(undefined, undefined, { container: nimContainerNameLocal })) {
            console.error("  NIM failed to start. Falling back to cloud API.");
            model = null;
            nimContainer = null;
          } else {
            provider = "vllm-local";
            // Local NIM (vLLM under the hood) does not require a host API key —
            // setupInference registers the gateway provider with an internal
            // credential env (NEMOCLAW_VLLM_LOCAL_TOKEN). See GH #2519.
            credentialEnv = null;
            endpointUrl = getLocalProviderBaseUrl(provider);
            if (!endpointUrl) {
              console.error("  Local NVIDIA NIM base URL could not be determined.");
              process.exit(1);
            }
            const nimValidationUrl = getLocalProviderValidationBaseUrl(provider) || endpointUrl;
            const validation = await validateOpenAiLikeSelection(
              "Local NVIDIA NIM",
              nimValidationUrl,
              requireValue(model, "Expected a Local NVIDIA NIM model after startup"),
              null,
            );
            if (validation.retry === "selection" || validation.retry === "model") {
              continue selectionLoop;
            }
            if (!validation.ok) {
              continue selectionLoop;
            }
            preferredInferenceApi = validation.api;
            // NIM uses vLLM internally — same tool-call-parser limitation
            // applies to /v1/responses. Force chat completions.
            if (preferredInferenceApi !== "openai-completions") {
              console.log(
                "  ℹ Using chat completions API (tool-call-parser requires /v1/chat/completions)",
              );
            }
            preferredInferenceApi = "openai-completions";
          }
        }
        break;
      } else if (selected.key === "ollama") {
        if (!checkOllamaPortsOrWarn()) continue selectionLoop;
        if (!ollamaRunning) {
          console.log("  Starting Ollama...");
          // Keep raw Ollama loopback-only. Non-WSL containers reach it through
          // the authenticated proxy on OLLAMA_PROXY_PORT.
          // Shell required: backgrounding (&), env var prefix, output redirection.
          const ollamaEnv = isWsl() ? "" : `OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT} `;
          runShell(`${ollamaEnv}ollama serve > /dev/null 2>&1 &`, { ignoreError: true });
          sleep(2);
        }
        if (isWsl()) {
          // WSL2 doesn't need the proxy — Docker can reach the host directly.
          console.log(`  ✓ Using Ollama on localhost:${OLLAMA_PORT}`);
        } else {
          if (!startOllamaAuthProxy()) {
            process.exit(1);
          }
          console.log(
            `  ✓ Using Ollama on localhost:${OLLAMA_PORT} (proxy on :${OLLAMA_PROXY_PORT})`,
          );
        }
        provider = "ollama-local";
        // Local Ollama needs no user-supplied API key — the auth proxy uses
        // an internal token (NEMOCLAW_OLLAMA_PROXY_TOKEN, set in setupInference).
        // Leaving this null prevents the wizard from prompting for / caching
        // OPENAI_API_KEY and prevents the rebuild preflight from requiring it.
        // See GH #2519.
        credentialEnv = null;
        endpointUrl = getLocalProviderBaseUrl(provider);
        if (!endpointUrl) {
          console.error("  Local Ollama base URL could not be determined.");
          process.exit(1);
        }
        {
          const result = await selectAndValidateOllamaModel(gpu, provider, {
            requestedModel,
            recoveredModel: recoveredFromSandbox ? recoveredModel : null,
          });
          if (result.outcome === "back-to-selection") continue selectionLoop;
          model = result.model;
          preferredInferenceApi = "openai-completions";
        }
        break;
      } else if (
        selected.key === "start-windows-ollama" ||
        selected.key === "install-windows-ollama"
      ) {
        if (!checkOllamaPortsOrWarn()) continue selectionLoop;
        const isInstall = selected.key === "install-windows-ollama";
        const isSwitch = !isInstall && windowsOllamaReachable;
        const isRestart = !isInstall && !isSwitch && winOllamaLoopbackOnly;
        if (!isSwitch) {
          printOllamaExposureWarning();
        }
        const promptMsg = isInstall
          ? "  Install and launch Ollama on the Windows host with OLLAMA_HOST=0.0.0.0:11434? [Y/n]: "
          : isSwitch
            ? "  Use Ollama on the Windows host (already running)? [Y/n]: "
            : isRestart
              ? "  Stop the running Ollama and restart it with OLLAMA_HOST=0.0.0.0:11434? [Y/n]: "
              : "  Launch Ollama on the Windows host with OLLAMA_HOST=0.0.0.0:11434? [Y/n]: ";
        const proceed = isNonInteractive()
          ? true
          : !(await prompt(promptMsg)).trim().toLowerCase().startsWith("n");
        if (!proceed) {
          continue selectionLoop;
        }

        if (isSwitch) {
          switchToWindowsOllamaHost();
        } else if (isInstall) {
          const installResult = await installOllamaOnWindowsHost();
          if (!installResult.ok) {
            console.error(
              "  Install did not produce ollama.exe on PATH. Check the installer output above.",
            );
            if (isNonInteractive()) process.exit(1);
            continue selectionLoop;
          }
          if (!awaitWindowsOllamaReady()) {
            console.log("  Installer did not leave a reachable Ollama daemon; restarting it...");
            if (
              !setupWindowsOllamaWith0000Binding({
                installedPath: installResult.path,
              })
            ) {
              printWindowsOllamaTimeoutDiagnostics();
              if (isNonInteractive()) process.exit(1);
              continue selectionLoop;
            }
          }
          console.log(`  ✓ Using Ollama on host.docker.internal:${OLLAMA_PORT}`);
        } else {
          if (!setupWindowsOllamaWith0000Binding({ announceStop: isRestart })) {
            printWindowsOllamaTimeoutDiagnostics();
            if (isNonInteractive()) process.exit(1);
            continue selectionLoop;
          }
          console.log(`  ✓ Using Ollama on host.docker.internal:${OLLAMA_PORT}`);
        }
        provider = "ollama-local";
        credentialEnv = null;
        endpointUrl = getLocalProviderBaseUrl(provider);
        if (!endpointUrl) {
          console.error("  Local Ollama base URL could not be determined.");
          process.exit(1);
        }

        {
          const result = await selectAndValidateOllamaModel(gpu, provider, {
            requestedModel,
            recoveredModel: null,
          });
          if (result.outcome === "back-to-selection") {
            // The Windows-host action pinned resolved host to
            // host.docker.internal. Clear it so a subsequent provider pick
            // (e.g. plain WSL Ollama) starts from a fresh probe.
            resetOllamaHostCache();
            continue selectionLoop;
          }
          model = result.model;
          preferredInferenceApi = "openai-completions";
        }
        break;
      } else if (selected.key === "install-ollama") {
        if (!checkOllamaPortsOrWarn()) continue selectionLoop;
        if (process.platform === "darwin") {
          console.log("  Installing Ollama via Homebrew...");
          run(["brew", "install", "ollama"], { ignoreError: true });
          // brew install doesn't auto-start a service; launch directly.
          // Shell required: backgrounding (&), env var prefix, output redirection.
          console.log("  Starting Ollama...");
          runShell(`OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT} ollama serve > /dev/null 2>&1 &`, {
            ignoreError: true,
          });
          sleep(2);
        } else {
          ensureOllamaLinuxExtractionDependencies();
          console.log(
            "  The Ollama installer creates a system user, a systemd service, and writes to /usr/local. " +
              "It uses sudo for those steps; you may be prompted for your password.",
          );
          runShell("set -o pipefail; curl -fsSL https://ollama.com/install.sh | sh");
          // Give the just-started ollama.service a moment to bind port
          // 11434 before we probe or apply the systemd drop-in override.
          sleep(2);
          // install.sh only creates ollama.service when systemctl is present.
          // On non-systemd Linux (Alpine/OpenRC, container images, etc.) the
          // installer just lays down the binary and we have to start it
          // ourselves.
          const hasOllamaSystemdUnit = !!runCapture(
            [
              "sh",
              "-c",
              "command -v systemctl >/dev/null && systemctl list-unit-files ollama.service --no-legend 2>/dev/null | head -n1",
            ],
            { ignoreError: true },
          ).trim();
          // Linux native + systemd: force a loopback-only OLLAMA_HOST drop-in
          // and let systemd own the daemon (avoids racing the installer's
          // daemon with our own `ollama serve`). This also repairs older
          // NemoClaw-created overrides that exposed raw Ollama on all interfaces.
          // WSL keeps Ollama's default binding. No-systemd / daemon failed to
          // start: manual launch with the loopback binding.
          if (!isWsl() && hasOllamaSystemdUnit) {
            console.log("  Configuring Ollama systemd loopback override...");
            console.log(
              `  Applying an Ollama systemd override (OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT}). ` +
                "The next steps use sudo to write the drop-in, reload systemd, and restart the service; " +
                "you may be prompted for your password.",
            );
            const dropInBody = `[Service]\nEnvironment="OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT}"\n`;
            const tmpDropIn = secureTempFile("nemoclaw-ollama-override", ".conf");
            fs.writeFileSync(tmpDropIn, dropInBody, { mode: 0o644 });
            const overrideResult = runShell(
              `sudo install -D -m 0644 ${shellQuote(tmpDropIn)} ${shellQuote("/etc/systemd/system/ollama.service.d/override.conf")} && sudo systemctl daemon-reload && sudo systemctl restart ollama`,
              { ignoreError: true },
            );
            cleanupTempDir(tmpDropIn, "nemoclaw-ollama-override");
            if (overrideResult.error || overrideResult.status !== 0) {
              console.error("  Failed to apply Ollama systemd loopback override.");
              console.error("  Refusing to continue with a potentially non-loopback Ollama bind.");
              process.exit(1);
            }
            // Retry the probe for a few seconds before giving up — systemd's
            // daemon may still be binding the port; a single probe could falsely
            // conclude it's down and spawn a duplicate `ollama serve`.
            for (let i = 0; i < 10; i++) {
              if (findReachableOllamaHost()) break;
              sleep(1);
            }
          }
          // Fall back to manual start if systemd path failed or isn't present.
          if (!findReachableOllamaHost()) {
            console.log("  Starting Ollama...");
            const ollamaEnv = isWsl() ? "" : `OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT} `;
            runShell(`${ollamaEnv}ollama serve > /dev/null 2>&1 &`, { ignoreError: true });
            sleep(2);
          }
        }
        if (isWsl()) {
          // WSL2 doesn't need the proxy — Docker reaches the host directly.
          console.log(`  ✓ Using Ollama on localhost:${OLLAMA_PORT}`);
        } else {
          if (!startOllamaAuthProxy()) {
            process.exit(1);
          }
          console.log(
            `  ✓ Using Ollama on localhost:${OLLAMA_PORT} (proxy on :${OLLAMA_PROXY_PORT})`,
          );
        }
        provider = "ollama-local";
        // See above ollama branch — internal proxy token, no user API key.
        credentialEnv = null;
        endpointUrl = getLocalProviderBaseUrl(provider);
        if (!endpointUrl) {
          console.error("  Local Ollama base URL could not be determined.");
          process.exit(1);
        }
        {
          const result = await selectAndValidateOllamaModel(gpu, provider, {
            requestedModel,
            recoveredModel: recoveredFromSandbox ? recoveredModel : null,
          });
          if (result.outcome === "back-to-selection") continue selectionLoop;
          model = result.model;
          preferredInferenceApi = "openai-completions";
        }
        break;
      } else if (selected.key === "install-vllm") {
        if (!vllmProfile) {
          console.error("  No vLLM install profile available for this host.");
          if (isNonInteractive()) process.exit(1);
          continue selectionLoop;
        }
        const result = await installVllm(vllmProfile, {
          hasImage: hasVllmImage,
          nonInteractive: isNonInteractive(),
          promptFn: prompt,
        });
        if (!result.ok) {
          if (isNonInteractive()) process.exit(1);
          continue selectionLoop;
        }
        // Fall through to the same provider/model setup as the running-vLLM
        // branch. Mutate selected.key so the existing "vllm" branch picks up.
        selected = { key: "vllm", label: `Local vLLM (localhost:${VLLM_PORT}) — running` };
        // intentional fall-through to the next branch
      }
      if (selected.key === "vllm") {
        console.log(`  ✓ Using existing vLLM on localhost:${VLLM_PORT}`);
        provider = "vllm-local";
        // See NIM branch above — internal credential env, no user API key.
        credentialEnv = null;
        endpointUrl = getLocalProviderBaseUrl(provider);
        if (!endpointUrl) {
          console.error("  Local vLLM base URL could not be determined.");
          process.exit(1);
        }
        // Query vLLM for the actual model ID
        const vllmModelsRaw = runCapture(
          ["curl", "-sf", `http://127.0.0.1:${VLLM_PORT}/v1/models`],
          {
            ignoreError: true,
          },
        );
        try {
          const vllmModels = JSON.parse(vllmModelsRaw);
          if (vllmModels.data && vllmModels.data.length > 0) {
            const detectedModel =
              typeof vllmModels.data[0]?.id === "string" ? vllmModels.data[0].id : null;
            model = detectedModel;
            if (!detectedModel || !isSafeModelId(detectedModel)) {
              console.error(`  Detected model ID contains invalid characters: ${model}`);
              process.exit(1);
            }
            console.log(`  Detected model: ${model}`);
          } else {
            console.error("  Could not detect model from vLLM. Please specify manually.");
            process.exit(1);
          }
        } catch {
          console.error(
            `  Could not query vLLM models endpoint. Is vLLM running on localhost:${VLLM_PORT}?`,
          );
          process.exit(1);
        }
        const validationBaseUrl = getLocalProviderValidationBaseUrl(provider);
        if (!validationBaseUrl) {
          console.error("  Local vLLM validation URL could not be determined.");
          process.exit(1);
        }
        const validation = await validateOpenAiLikeSelection(
          "Local vLLM",
          validationBaseUrl,
          requireValue(model, "Expected a detected vLLM model"),
          null,
        );
        if (validation.retry === "selection" || validation.retry === "model") {
          continue selectionLoop;
        }
        if (!validation.ok) {
          continue selectionLoop;
        }
        preferredInferenceApi = validation.api;
        // Force chat completions — vLLM's /v1/responses endpoint does not
        // run the --tool-call-parser, so tool calls arrive as raw text.
        // See: https://github.com/NVIDIA/NemoClaw/issues/976
        if (preferredInferenceApi !== "openai-completions") {
          console.log(
            "  ℹ Using chat completions API (tool-call-parser requires /v1/chat/completions)",
          );
        }
        preferredInferenceApi = "openai-completions";
        break;
      } else if (selected.key === "routed") {
        const bp = loadBlueprintProfile("routed");
        if (!bp || bp.router?.enabled !== true) {
          console.error("  Router is not enabled in nemoclaw-blueprint/blueprint.yaml.");
          if (isNonInteractive()) process.exit(1);
          continue selectionLoop;
        }
        const routerCredentialEnv =
          bp.router?.credential_env || bp.credential_env || DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV;
        credentialEnv = routerCredentialEnv;
        const routedCredential =
          hydrateCredentialEnv(routerCredentialEnv) ||
          normalizeCredentialValue(bp.credential_default || "");
        if (routedCredential) {
          saveCredential(routerCredentialEnv, routedCredential);
        }
        const _providerKeyHint = (process.env.NEMOCLAW_PROVIDER_KEY || "").trim();
        if (_providerKeyHint && !resolveProviderCredential(routerCredentialEnv)) {
          saveCredential(routerCredentialEnv, _providerKeyHint);
        }
        if (isNonInteractive()) {
          if (!resolveProviderCredential(routerCredentialEnv)) {
            console.error(
              `  ${routerCredentialEnv} (or NEMOCLAW_PROVIDER_KEY) is required for Model Router in non-interactive mode.`,
            );
            process.exit(1);
          }
        } else {
          if (!resolveProviderCredential(routerCredentialEnv)) {
            console.log("");
            console.log("  Model Router accepts NVIDIA API keys (nvapi-...).");
            console.log("  Get one at https://build.nvidia.com");
            console.log("");
            await ensureNamedCredential(routerCredentialEnv, "Model Router API key", null);
          }
        }
        provider = bp.provider_name || "nvidia-router";
        model = bp.model;
        const { HOST_GATEWAY_URL } = require("./inference/local");
        const routerEndpointUrl = bp.endpoint || "";
        endpointUrl = routerEndpointUrl;
        if (routerEndpointUrl.match(/localhost|127\.0\.0\.1/)) {
          const u = new URL(routerEndpointUrl);
          endpointUrl = `${HOST_GATEWAY_URL}:${u.port}${u.pathname}`;
        }
        preferredInferenceApi = "openai-completions";
        console.log(`  ✓ Using Model Router: ${provider} / ${model}`);
        break;
      }
    }
  }

  return {
    model,
    provider,
    endpointUrl,
    credentialEnv,
    hermesAuthMethod,
    preferredInferenceApi,
    nimContainer,
  };
}

// ── Step 4: Inference provider ───────────────────────────────────

async function setupInference(
  sandboxName: string | null,
  model: string,
  provider: string,
  endpointUrl: string | null = null,
  credentialEnv: string | null = null,
  hermesAuthMethod: HermesAuthMethod | string | null = null,
): Promise<{ ok: true; retry?: undefined } | { retry: "selection" }> {
  step(4, 8, "Setting up inference provider");
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });

  if (provider === hermesProviderAuth.HERMES_PROVIDER_NAME) {
    const targetSandbox = requireValue(sandboxName, "Hermes Provider requires a sandbox name");
    const resolvedHermesAuthMethod =
      normalizeHermesAuthMethod(hermesAuthMethod) ||
      (credentialEnv === HERMES_NOUS_API_KEY_CREDENTIAL_ENV
        ? HERMES_AUTH_METHOD_API_KEY
        : HERMES_AUTH_METHOD_OAUTH);
    const providerRegistered = hermesProviderAuth.isHermesProviderRegistered(runOpenshell);
    const hasFreshNousApiKey =
      resolvedHermesAuthMethod === HERMES_AUTH_METHOD_API_KEY && !!resolveHermesNousApiKey();
    const shouldPrepareHermesCredentials =
      !providerRegistered ||
      hasFreshNousApiKey ||
      (resolvedHermesAuthMethod === HERMES_AUTH_METHOD_OAUTH && !isNonInteractive());
    if (shouldPrepareHermesCredentials) {
      try {
        const state =
          resolvedHermesAuthMethod === HERMES_AUTH_METHOD_API_KEY
            ? await hermesProviderAuth.ensureHermesProviderApiKeyCredentials(targetSandbox, {
                apiKey: resolveHermesNousApiKey(),
                runOpenshell,
                baseUrl: endpointUrl || undefined,
              })
            : await hermesProviderAuth.ensureHermesProviderOAuthCredentials(targetSandbox, {
                allowInteractiveLogin: !isNonInteractive(),
                runOpenshell,
                baseUrl: endpointUrl || undefined,
              });
        if (!state) {
          const authLabel = hermesAuthMethodLabel(resolvedHermesAuthMethod);
          console.error(`  ✗ Hermes Provider ${authLabel} is not available on the host.`);
          console.error(
            "    Re-run `nemoclaw onboard --agent hermes` interactively to configure credentials.",
          );
          process.exit(1);
        }
      } catch (err) {
        console.error(
          `  ✗ Failed to prepare Hermes Provider credentials: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        if (isNonInteractive()) process.exit(1);
        return { retry: "selection" };
      }
    }

    const applyResult = runOpenshell(
      ["inference", "set", "--no-verify", "--provider", provider, "--model", model],
      { ignoreError: true },
    );
    if (applyResult.status !== 0) {
      const message =
        compactText(redact(`${applyResult.stderr || ""} ${applyResult.stdout || ""}`)) ||
        `Failed to configure inference provider '${provider}'.`;
      console.error(`  ${message}`);
      if (isNonInteractive()) process.exit(applyResult.status || 1);
      return { retry: "selection" };
    }

    verifyInferenceRoute(provider, model);
    if (sandboxName) {
      registry.updateSandbox(sandboxName, { model, provider });
    }
    console.log(`  ✓ Inference route set: ${provider} / ${model}`);
    return { ok: true };
  }

  if (
    provider === "nvidia-prod" ||
    provider === "nvidia-nim" ||
    provider === "openai-api" ||
    provider === "anthropic-prod" ||
    provider === "compatible-anthropic-endpoint" ||
    provider === "gemini-api" ||
    provider === "compatible-endpoint"
  ) {
    const config =
      provider === "nvidia-nim"
        ? REMOTE_PROVIDER_CONFIG.build
        : Object.values(REMOTE_PROVIDER_CONFIG).find((entry) => entry.providerName === provider);
    if (!config) {
      console.error(`  Unsupported provider configuration: ${provider}`);
      process.exit(1);
    }
    while (true) {
      const resolvedCredentialEnv = credentialEnv || (config && config.credentialEnv);
      const resolvedEndpointUrl = endpointUrl || (config && config.endpointUrl);
      const credentialValue = hydrateCredentialEnv(resolvedCredentialEnv);
      const env =
        resolvedCredentialEnv && credentialValue
          ? { [resolvedCredentialEnv]: credentialValue }
          : {};
      const providerResult = upsertProvider(
        provider,
        config.providerType,
        resolvedCredentialEnv,
        resolvedEndpointUrl,
        env,
      );
      if (!providerResult.ok) {
        console.error(`  ${providerResult.message}`);
        if (isNonInteractive()) {
          process.exit(providerResult.status || 1);
        }
        const retry = await promptValidationRecovery(
          config.label,
          classifyApplyFailure(providerResult.message),
          resolvedCredentialEnv,
          config.helpUrl,
        );
        if (retry === "credential" || retry === "retry") {
          continue;
        }
        if (retry === "selection" || retry === "model") {
          return { retry: "selection" };
        }
        process.exit(providerResult.status || 1);
      }
      const args = ["inference", "set"];
      if (config.skipVerify) {
        args.push("--no-verify");
      }
      args.push("--provider", provider, "--model", model);
      if (provider === "compatible-endpoint") {
        args.push("--timeout", String(LOCAL_INFERENCE_TIMEOUT_SECS));
      }
      const applyResult = runOpenshell(args, { ignoreError: true });
      if (applyResult.status === 0) {
        break;
      }
      const message =
        compactText(redact(`${applyResult.stderr || ""} ${applyResult.stdout || ""}`)) ||
        `Failed to configure inference provider '${provider}'.`;
      console.error(`  ${message}`);
      if (isNonInteractive()) {
        process.exit(applyResult.status || 1);
      }
      const retry = await promptValidationRecovery(
        config.label,
        classifyApplyFailure(message),
        resolvedCredentialEnv,
        config.helpUrl,
      );
      if (retry === "credential" || retry === "retry") {
        continue;
      }
      if (retry === "selection" || retry === "model") {
        return { retry: "selection" };
      }
      process.exit(applyResult.status || 1);
    }
  } else if (provider === "vllm-local") {
    const validation = validateLocalProvider(provider);
    if (!validation.ok) {
      const hostCheck = getLocalProviderHealthCheck(provider);
      // Use run() and check exit status rather than coercing runCapture() output
      // to boolean — curl -sf can leave output even on failure in edge cases.
      const hostResponding = hostCheck
        ? run(hostCheck, { ignoreError: true, suppressOutput: true }).status === 0
        : false;

      if (hostResponding) {
        console.warn(`  ⚠ ${validation.message}`);
        if (validation.diagnostic) {
          console.warn(`  Diagnostic: ${validation.diagnostic}`);
        }
        console.warn(
          "  The server is healthy on the host — continuing. " +
            "The sandbox uses a different network path and may work correctly.",
        );
      } else {
        console.error(`  ${validation.message}`);
        if (validation.diagnostic) {
          console.error(`  Diagnostic: ${validation.diagnostic}`);
        }
        process.exit(1);
      }
    }
    const baseUrl = getLocalProviderBaseUrl(provider);
    // Use a dedicated internal credential env so the gateway does not pick
    // up the user's host OPENAI_API_KEY for local vLLM. vLLM does not enforce
    // the bearer at runtime, but a dedicated env name prevents accidental
    // hijacking. See GH #2519.
    const providerResult = upsertProvider(
      "vllm-local",
      "openai",
      VLLM_LOCAL_CREDENTIAL_ENV,
      baseUrl,
      { [VLLM_LOCAL_CREDENTIAL_ENV]: "dummy" },
    );
    if (!providerResult.ok) {
      console.error(`  ${providerResult.message}`);
      process.exit(providerResult.status || 1);
    }
    runOpenshell([
      "inference",
      "set",
      "--no-verify",
      "--provider",
      "vllm-local",
      "--model",
      model,
      "--timeout",
      String(LOCAL_INFERENCE_TIMEOUT_SECS),
    ]);
    // Do not mutate ~/.nemoclaw/credentials.json here: local vLLM now uses
    // VLLM_LOCAL_CREDENTIAL_ENV, so any saved OPENAI_API_KEY remains available
    // to unrelated OpenAI-backed sandboxes.
  } else if (provider === "ollama-local") {
    const validation = validateLocalProvider(provider);
    let proxyReady = false;
    if (!validation.ok) {
      // The container reachability check uses Docker's --add-host host-gateway,
      // which may not work on all Docker configurations (e.g., Brev, rootless).
      // The real sandbox uses k3s CoreDNS + NodeHosts — a different path.
      // Try to start/restart the auth proxy before probing — this recovers
      // from stale or missing proxy processes before we decide to abort.
      if (!isWsl()) {
        ensureOllamaAuthProxy();
        proxyReady = isProxyHealthy();
      }
      if (proxyReady) {
        console.warn(`  ⚠ ${validation.message}`);
        if (validation.diagnostic) {
          console.warn(`  Diagnostic: ${validation.diagnostic}`);
        }
        console.warn(
          "  The auth proxy is healthy on the host — continuing. " +
            "The sandbox uses a different network path and may work correctly.",
        );
      } else {
        console.error(`  ${validation.message}`);
        if (validation.diagnostic) {
          console.error(`  Diagnostic: ${validation.diagnostic}`);
        }
        if (process.platform === "darwin") {
          console.error(
            "  On macOS, local inference also depends on OpenShell host routing support.",
          );
        }
        process.exit(1);
      }
    }
    const baseUrl = getLocalProviderBaseUrl(provider);
    let ollamaCredential = "ollama";
    if (!isWsl()) {
      // Skip if already started during the fallback recovery above.
      if (!proxyReady) ensureOllamaAuthProxy();
      const proxyToken = getOllamaProxyToken();
      if (!proxyToken) {
        console.error(
          "  Ollama auth proxy token is not set. Re-run onboard to initialize the proxy.",
        );
        process.exit(1);
      }
      ollamaCredential = proxyToken;
      // Persist token now that ollama-local is confirmed as the provider.
      // Not persisted earlier in case the user backs out to a different provider.
      persistProxyToken(proxyToken);
    }
    // Use a dedicated internal credential env (NEMOCLAW_OLLAMA_PROXY_TOKEN)
    // so the gateway never reads the user's host OPENAI_API_KEY for local
    // Ollama. GH #2519: a stale host OPENAI_API_KEY was leaking into the
    // inference path and producing 401s.
    const providerResult = upsertProvider(
      "ollama-local",
      "openai",
      OLLAMA_PROXY_CREDENTIAL_ENV,
      baseUrl,
      { [OLLAMA_PROXY_CREDENTIAL_ENV]: ollamaCredential },
    );
    if (!providerResult.ok) {
      console.error(`  ${providerResult.message}`);
      process.exit(providerResult.status || 1);
    }
    runOpenshell([
      "inference",
      "set",
      "--no-verify",
      "--provider",
      "ollama-local",
      "--model",
      model,
      "--timeout",
      String(LOCAL_INFERENCE_TIMEOUT_SECS),
    ]);
    console.log(`  Priming Ollama model: ${model}`);
    run(getOllamaWarmupCommand(model), { ignoreError: true });
    const probe = validateOllamaModel(model);
    if (!probe.ok) {
      console.error(`  ${probe.message}`);
      process.exit(1);
    }
    // Do not mutate ~/.nemoclaw/credentials.json here: local Ollama now uses
    // OLLAMA_PROXY_CREDENTIAL_ENV, so any saved OPENAI_API_KEY remains available
    // to unrelated OpenAI-backed sandboxes.
  } else if (isRoutedInferenceProvider(provider)) {
    // Blueprint profile provider (e.g., nvidia-router for the routed profile).
    // Same pattern as vllm-local: upsert the provider and set the inference route.
    try {
      await reconcileModelRouter();
    } catch (err) {
      console.error(`  ✗ Failed to start model router: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    const resolvedCredentialEnv = credentialEnv || DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV;
    const credentialValue = hydrateCredentialEnv(resolvedCredentialEnv);
    const env = credentialValue ? { [resolvedCredentialEnv]: credentialValue } : {};
    const providerResult = upsertProvider(
      provider,
      "openai",
      resolvedCredentialEnv,
      endpointUrl,
      env,
    );
    if (!providerResult.ok) {
      console.error(`  ${providerResult.message}`);
      process.exit(providerResult.status || 1);
    }
    const inferenceArgs = [
      "inference",
      "set",
      "--no-verify",
      "--provider",
      provider,
      "--model",
      model,
    ];
    runOpenshell(inferenceArgs);
  } else {
    console.error(`  Unsupported provider configuration: ${provider}`);
    process.exit(1);
  }

  verifyInferenceRoute(provider, model);
  if (sandboxName) {
    registry.updateSandbox(sandboxName, { model, provider });
  }
  console.log(`  ✓ Inference route set: ${provider} / ${model}`);
  return { ok: true };
}

// ── Step 6: Messaging channels ───────────────────────────────────

const MESSAGING_CHANNELS = listChannels();

function getStoredMessagingChannelConfig(
  sandboxName: string | null,
  session: Session | null,
): MessagingChannelConfig | null {
  const registryConfig = sandboxName
    ? sanitizeMessagingChannelConfig(registry.getSandbox(sandboxName)?.messagingChannelConfig)
    : null;
  const sessionMatchesSandbox =
    !session?.sandboxName || !sandboxName || session.sandboxName === sandboxName;
  const sessionConfig = sessionMatchesSandbox
    ? sanitizeMessagingChannelConfig(session?.messagingChannelConfig)
    : null;
  return mergeMessagingChannelConfigs(registryConfig, sessionConfig);
}

function persistMessagingChannelConfigToSession(config: MessagingChannelConfig | null): void {
  onboardSession.updateSession((current: Session) => {
    current.messagingChannelConfig = config;
    return current;
  });
}

function messagingChannelConfigsEqual(
  left: MessagingChannelConfig | null,
  right: MessagingChannelConfig | null,
): boolean {
  const leftKeys = Object.keys(left || {}).sort();
  const rightKeys = Object.keys(right || {}).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left?.[key] === right?.[key]);
}

// Curl exit codes that indicate a network-level failure (not a token problem).
// 35 (TLS handshake failure) covers corporate proxies that MITM HTTPS.
const TELEGRAM_NETWORK_CURL_CODES = new Set([6, 7, 28, 35, 52, 56]);

async function checkTelegramReachability(token: string) {
  if (process.env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY === "1") {
    note("  [non-interactive] Skipping Telegram reachability probe by request.");
    return;
  }

  const result = runCurlProbe([
    "-sS",
    "--connect-timeout",
    "5",
    "--max-time",
    "10",
    `https://api.telegram.org/bot${token}/getMe`,
  ]);

  // HTTP 200 with "ok":true — Telegram is reachable and token is valid.
  if (result.ok) return;

  // HTTP 401 or 404 — token was rejected by Telegram (not a network issue).
  if (result.httpStatus === 401 || result.httpStatus === 404) {
    console.log("  ⚠ Bot token was rejected by Telegram — verify the token is correct.");
    return;
  }

  // Network-level failure — Telegram is unreachable from this host.
  if (result.curlStatus && TELEGRAM_NETWORK_CURL_CODES.has(result.curlStatus)) {
    console.log("");
    console.log("  ⚠ api.telegram.org is not reachable from this host.");
    console.log("    Telegram integration requires outbound HTTPS access to api.telegram.org.");
    console.log("    This is commonly blocked by corporate network proxies.");

    if (isNonInteractive()) {
      console.error(
        "  Aborting onboarding in non-interactive mode due to Telegram network reachability failure.",
      );
      process.exit(1);
    } else {
      if (!(await promptYesNoOrDefault("    Continue anyway?", null, false))) {
        console.log("  Aborting onboarding.");
        process.exit(1);
      }
    }
    return;
  }

  // Unexpected probe failure — warn but don't block.
  if (!result.ok && result.httpStatus > 0) {
    console.log(
      `  ⚠ Telegram API returned HTTP ${result.httpStatus} — the bot may not work correctly.`,
    );
  } else if (!result.ok) {
    console.log(`  ⚠ Telegram reachability probe failed: ${result.message}`);
  }
}

async function setupMessagingChannels(): Promise<string[]> {
  step(5, 8, "Messaging channels");

  const getMessagingToken = (envKey: string): string | null =>
    getCredential(envKey) || normalizeCredentialValue(process.env[envKey]) || null;

  const getMessagingConfigValue = (envKey: string): string | null =>
    normalizeMessagingChannelConfigValue(envKey, process.env[envKey]);

  // Non-interactive: skip prompt, tokens come from env/credentials
  if (isNonInteractive() || process.env.NEMOCLAW_NON_INTERACTIVE === "1") {
    const found = MESSAGING_CHANNELS.filter((c) => getMessagingToken(c.envKey)).map((c) => c.name);
    if (found.length > 0) {
      note(`  [non-interactive] Messaging tokens detected: ${found.join(", ")}`);
      if (found.includes("telegram")) {
        const telegramToken = getMessagingToken("TELEGRAM_BOT_TOKEN");
        if (telegramToken) {
          await checkTelegramReachability(telegramToken);
        }
      }
    } else {
      note("  [non-interactive] No messaging tokens configured. Skipping.");
    }
    return found;
  }

  // Single-keypress toggle selector — pre-select channels that already have tokens.
  // Press a channel number to toggle; press Enter to continue.
  const enabled = new Set(
    MESSAGING_CHANNELS.filter((c) => getMessagingToken(c.envKey)).map((c) => c.name),
  );

  const output = process.stderr;
  // Lines above the prompt: 1 blank + 1 header + N channels + 1 blank = N + 3
  const linesAbovePrompt = MESSAGING_CHANNELS.length + 3;
  let firstDraw = true;
  const showList = () => {
    if (!firstDraw) {
      // Cursor is at end of prompt line. Move to column 0, go up, clear to end of screen.
      output.write(`\r\x1b[${linesAbovePrompt}A\x1b[J`);
    }
    firstDraw = false;
    output.write("\n");
    output.write("  Available messaging channels:\n");
    MESSAGING_CHANNELS.forEach((ch, i) => {
      const marker = enabled.has(ch.name) ? "●" : "○";
      const status = getMessagingToken(ch.envKey) ? " (configured)" : "";
      output.write(`    [${i + 1}] ${marker} ${ch.name} — ${ch.description}${status}\n`);
    });
    output.write("\n");
    output.write(`  Press 1-${MESSAGING_CHANNELS.length} to toggle, Enter when done: `);
  };

  showList();

  await new Promise<void>((resolve, reject) => {
    const input = process.stdin;
    let rawModeEnabled = false;
    let finished = false;

    function cleanup() {
      input.removeListener("data", onData);
      if (rawModeEnabled && typeof input.setRawMode === "function") {
        input.setRawMode(false);
      }
      // Symmetric with the ref() at the entry; lets the wizard exit
      // naturally if this is the last prompt.
      if (typeof input.pause === "function") {
        input.pause();
      }
      if (typeof input.unref === "function") {
        input.unref();
      }
    }

    function finish(): void {
      if (finished) return;
      finished = true;
      cleanup();
      output.write("\n");
      resolve();
    }

    function onData(chunk: Buffer | string): void {
      const text = chunk.toString("utf8");
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "\u0003") {
          cleanup();
          reject(Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" }));
          process.kill(process.pid, "SIGINT");
          return;
        }
        if (ch === "\r" || ch === "\n") {
          finish();
          return;
        }
        const num = parseInt(ch, 10);
        if (num >= 1 && num <= MESSAGING_CHANNELS.length) {
          const channel = MESSAGING_CHANNELS[num - 1];
          if (enabled.has(channel.name)) {
            enabled.delete(channel.name);
          } else {
            enabled.add(channel.name);
          }
          showList();
        }
      }
    }

    // Re-attach stdin to the event loop. A prior prompt cleanup may have
    // unref'd it (sticky), and resume() alone would leave the raw-mode read
    // detached from the loop.
    if (typeof input.ref === "function") {
      input.ref();
    }
    input.setEncoding("utf8");
    if (typeof input.resume === "function") {
      input.resume();
    }
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
      rawModeEnabled = true;
    }
    input.on("data", onData);
  });

  const selected = Array.from(enabled);
  if (selected.length === 0) {
    console.log("  Skipping messaging channels.");
    return [];
  }

  // For each selected channel, prompt for token if not already set
  for (const name of selected) {
    const ch = MESSAGING_CHANNELS.find((c) => c.name === name);
    if (!ch) {
      console.log(`  Unknown channel: ${name}`);
      continue;
    }
    if (getMessagingToken(ch.envKey)) {
      console.log(`  ✓ ${ch.name} — already configured`);
    } else {
      console.log("");
      console.log(`  ${ch.help}`);
      const token = normalizeCredentialValue(await prompt(`  ${ch.label}: `, { secret: true }));
      if (token && ch.tokenFormat && !ch.tokenFormat.test(token)) {
        console.log(
          `  ✗ Invalid format. ${ch.tokenFormatHint || "Check the token and try again."}`,
        );
        console.log(`  Skipped ${ch.name} (invalid token format)`);
        enabled.delete(ch.name);
        continue;
      }
      if (token) {
        saveCredential(ch.envKey, token);
        process.env[ch.envKey] = token;
        console.log(`  ✓ ${ch.name} token saved`);
      } else {
        console.log(`  Skipped ${ch.name} (no token entered)`);
        enabled.delete(ch.name);
        continue;
      }
    }
    if (ch.appTokenEnvKey) {
      const existingAppToken = getMessagingToken(ch.appTokenEnvKey);
      if (existingAppToken) {
        console.log(`  ✓ ${ch.name} app token — already configured`);
      } else {
        console.log("");
        console.log(`  ${ch.appTokenHelp}`);
        const appToken = normalizeCredentialValue(
          await prompt(`  ${ch.appTokenLabel}: `, { secret: true }),
        );
        if (appToken && ch.appTokenFormat && !ch.appTokenFormat.test(appToken)) {
          console.log(
            `  ✗ Invalid format. ${ch.appTokenFormatHint || "Check the token and try again."}`,
          );
          console.log(`  Skipped ${ch.name} app token (invalid token format)`);
          enabled.delete(ch.name);
          continue;
        }
        if (appToken) {
          saveCredential(ch.appTokenEnvKey, appToken);
          process.env[ch.appTokenEnvKey] = appToken;
          console.log(`  ✓ ${ch.name} app token saved`);
        } else {
          console.log(`  Skipped ${ch.name} app token (Socket Mode requires both tokens)`);
          enabled.delete(ch.name);
          continue;
        }
      }
    }
    if (ch.serverIdEnvKey) {
      const existingServerIds = getMessagingConfigValue(ch.serverIdEnvKey) || "";
      if (existingServerIds) {
        process.env[ch.serverIdEnvKey] = existingServerIds;
        console.log(`  ✓ ${ch.name} — server ID already set: ${existingServerIds}`);
      } else {
        console.log(`  ${ch.serverIdHelp}`);
        const serverId = (await prompt(`  ${ch.serverIdLabel}: `)).trim();
        if (serverId) {
          process.env[ch.serverIdEnvKey] = serverId;
          console.log(`  ✓ ${ch.name} server ID saved`);
        } else {
          console.log(`  Skipped ${ch.name} server ID (guild channels stay disabled)`);
        }
      }
    }
    // Mention-control prompt: fires for any channel that exposes a
    // requireMention env key. Discord gates the prompt behind a configured
    // server ID (mention control only makes sense in a guild). Telegram
    // has no serverIdEnvKey because mention control applies to every group
    // the bot is added to, so the prompt always fires there. See #1737.
    const requireMentionKey = ch.requireMentionEnvKey;
    if (requireMentionKey && (!ch.serverIdEnvKey || Boolean(process.env[ch.serverIdEnvKey]))) {
      const existingRequireMention = getMessagingConfigValue(requireMentionKey);
      if (existingRequireMention === "0" || existingRequireMention === "1") {
        process.env[requireMentionKey] = existingRequireMention;
        const mode = existingRequireMention === "0" ? "all messages" : "@mentions only";
        console.log(`  ✓ ${ch.name} — reply mode already set: ${mode}`);
      } else {
        console.log(`  ${ch.requireMentionHelp}`);
        const answer = (await prompt("  Reply only when @mentioned? [Y/n]: ")).trim().toLowerCase();
        const value = answer === "n" || answer === "no" ? "0" : "1";
        process.env[requireMentionKey] = value;
        const mode = value === "0" ? "all messages" : "@mentions only";
        console.log(`  ✓ ${ch.name} reply mode saved: ${mode}`);
      }
    }
    // Prompt for user/sender ID when the channel supports allowlisting
    if (ch.userIdEnvKey && (!ch.serverIdEnvKey || process.env[ch.serverIdEnvKey])) {
      const existingIds = getMessagingConfigValue(ch.userIdEnvKey) || "";
      if (existingIds) {
        process.env[ch.userIdEnvKey] = existingIds;
        console.log(`  ✓ ${ch.name} — allowed IDs already set: ${existingIds}`);
      } else {
        console.log(`  ${ch.userIdHelp}`);
        const userId = (await prompt(`  ${ch.userIdLabel}: `)).trim();
        if (userId) {
          process.env[ch.userIdEnvKey] = userId;
          console.log(`  ✓ ${ch.name} allowed IDs saved`);
        } else {
          const skippedReason =
            ch.allowIdsMode === "guild"
              ? "any member in the configured server can message the bot"
              : "bot will require manual pairing";
          console.log(`  Skipped ${ch.name} user ID (${skippedReason})`);
        }
      }
    }
  }
  console.log("");

  // Channels where the user declined to enter a token were dropped from
  // `enabled` inside the per-channel loop, so only channels with credentials
  // configured remain in the Set.

  // Preflight: verify Telegram API is reachable from the host before sandbox creation.
  // The non-interactive branch above already ran this probe and returned early,
  // so this second call only fires on the interactive path — guard explicitly
  // to make the no-double-probe invariant visible at the call site.
  if (!isNonInteractive() && enabled.has("telegram")) {
    const telegramToken = getMessagingToken("TELEGRAM_BOT_TOKEN");
    if (telegramToken) {
      await checkTelegramReachability(telegramToken);
    }
  }

  return Array.from(enabled);
}

function getSuggestedPolicyPresets({
  enabledChannels = null,
  webSearchConfig = null,
  provider = null,
}: {
  enabledChannels?: string[] | null;
  webSearchConfig?: WebSearchConfig | null;
  provider?: string | null;
} = {}): string[] {
  const suggestions = ["pypi", "npm"];

  // Auto-suggest local-inference preset when a local provider is selected
  if (provider && LOCAL_INFERENCE_PROVIDERS.includes(provider)) {
    suggestions.push("local-inference");
  }
  const usesExplicitMessagingSelection = Array.isArray(enabledChannels);

  const maybeSuggestMessagingPreset = (channel: string, envKey: string): void => {
    if (usesExplicitMessagingSelection) {
      if (enabledChannels.includes(channel)) suggestions.push(channel);
      return;
    }
    if (getCredential(envKey) || process.env[envKey]) {
      suggestions.push(channel);
      if (process.stdout.isTTY && !isNonInteractive() && process.env.CI !== "true") {
        console.log(`  Auto-detected: ${envKey} -> suggesting ${channel} preset`);
      }
    }
  };

  maybeSuggestMessagingPreset("telegram", "TELEGRAM_BOT_TOKEN");
  maybeSuggestMessagingPreset("slack", "SLACK_BOT_TOKEN");
  maybeSuggestMessagingPreset("discord", "DISCORD_BOT_TOKEN");

  if (webSearchConfig) suggestions.push("brave");

  return suggestions;
}

// ── Step 7: OpenClaw ─────────────────────────────────────────────

async function setupOpenclaw(sandboxName: string, model: string, provider: string): Promise<void> {
  step(7, 8, `Setting up ${agentProductName()} inside sandbox`);

  const selectionConfig = getProviderSelectionConfig(provider, model);
  if (selectionConfig) {
    const sandboxConfig = {
      ...selectionConfig,
      onboardedAt: new Date().toISOString(),
    };
    const script = buildSandboxConfigSyncScript(sandboxConfig);
    const scriptFile = writeSandboxConfigSyncFile(script);
    try {
      const scriptContent = fs.readFileSync(scriptFile, "utf-8");
      run(openshellArgv(["sandbox", "connect", sandboxName]), {
        stdio: ["pipe", "ignore", "inherit"],
        input: scriptContent,
      });
    } finally {
      cleanupTempDir(scriptFile, "nemoclaw-sync");
    }
  }

  console.log(`  ✓ ${agentProductName()} gateway launched inside sandbox`);
}

// ── Step 7: Policy presets ───────────────────────────────────────

async function _setupPolicies(
  sandboxName: string,
  options: {
    enabledChannels?: string[] | null;
    webSearchConfig?: WebSearchConfig | null;
    provider?: string | null;
  } = {},
) {
  step(8, 8, "Policy presets");
  const suggestions = getSuggestedPolicyPresets(options);

  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  if (isNonInteractive()) {
    const policyMode = (process.env.NEMOCLAW_POLICY_MODE || "suggested").trim().toLowerCase();
    let selectedPresets: string[] = suggestions;

    if (policyMode === "skip" || policyMode === "none" || policyMode === "no") {
      note("  [non-interactive] Skipping policy presets.");
      return;
    }

    if (policyMode === "custom" || policyMode === "list") {
      selectedPresets = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS || "");
      if (selectedPresets.length === 0) {
        console.error("  NEMOCLAW_POLICY_PRESETS is required when NEMOCLAW_POLICY_MODE=custom.");
        process.exit(1);
      }
    } else if (policyMode === "suggested" || policyMode === "default" || policyMode === "auto") {
      const envPresets = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS || "");
      if (envPresets.length > 0) {
        selectedPresets = envPresets;
      }
    } else {
      console.error(`  Unsupported NEMOCLAW_POLICY_MODE: ${policyMode}`);
      console.error("  Valid values: suggested, custom, skip");
      process.exit(1);
    }

    const knownPresets = new Set(allPresets.map((p) => p.name));
    const invalidPresets = selectedPresets.filter((name) => !knownPresets.has(name));
    if (invalidPresets.length > 0) {
      console.error(`  Unknown policy preset(s): ${invalidPresets.join(", ")}`);
      process.exit(1);
    }

    if (!waitForSandboxReady(sandboxName)) {
      console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
      process.exit(1);
    }
    note(`  [non-interactive] Applying policy presets: ${selectedPresets.join(", ")}`);
    for (const name of selectedPresets) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          policies.applyPreset(sandboxName, name);
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes("sandbox not found") || attempt === 2) {
            throw err;
          }
          sleep(2);
        }
      }
    }
  } else {
    console.log("");
    console.log("  Available policy presets:");
    allPresets.forEach((p) => {
      const marker = applied.includes(p.name) || suggestions.includes(p.name) ? "●" : "○";
      const suggested = suggestions.includes(p.name) ? " (suggested)" : "";
      console.log(`    ${marker} ${p.name} — ${p.description}${suggested}`);
    });
    console.log("");

    const answer = await prompt(
      `  Apply suggested presets (${suggestions.join(", ")})? [Y/n/list]: `,
    );

    if (answer.toLowerCase() === "n") {
      console.log("  Skipping policy presets.");
      return;
    }

    if (!waitForSandboxReady(sandboxName)) {
      console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
      process.exit(1);
    }

    if (answer.toLowerCase() === "list") {
      // Let user pick
      const picks = await prompt("  Enter preset names (comma-separated): ");
      const selected = picks
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const name of selected) {
        policies.applyPreset(sandboxName, name);
      }
    } else {
      // Apply suggested
      for (const name of suggestions) {
        policies.applyPreset(sandboxName, name);
      }
    }
  }

  console.log("  ✓ Policies applied");
}

function arePolicyPresetsApplied(sandboxName: string, selectedPresets: string[] = []): boolean {
  if (!Array.isArray(selectedPresets) || selectedPresets.length === 0) return false;
  const applied = new Set(policies.getAppliedPresets(sandboxName));
  return selectedPresets.every((preset) => applied.has(preset));
}

/**
 * Prompt the user to select a policy tier (restricted / balanced / open).
 * Uses the same radio-style TUI as presetsCheckboxSelector (single-select).
 * In non-interactive mode reads NEMOCLAW_POLICY_TIER (default: balanced).
 * Returns the tier name string.
 *
 * @returns {Promise<string>}
 */
async function selectPolicyTier(): Promise<string> {
  const allTiers = tiers.listTiers();
  const defaultTier = allTiers.find((t) => t.name === "balanced") || allTiers[1];

  if (isNonInteractive()) {
    const name = (process.env.NEMOCLAW_POLICY_TIER || "balanced").trim().toLowerCase();
    if (!tiers.getTier(name)) {
      console.error(
        `  Unknown policy tier: ${name}. Valid: ${allTiers.map((t) => t.name).join(", ")}`,
      );
      process.exit(1);
    }
    note(`  [non-interactive] Policy tier: ${name}`);
    return name;
  }

  const RADIO_ON = USE_COLOR ? "[\x1b[32m✓\x1b[0m]" : "[✓]";
  const RADIO_OFF = USE_COLOR ? "\x1b[2m[ ]\x1b[0m" : "[ ]";

  // ── Fallback: non-TTY ─────────────────────────────────────────────
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("");
    console.log("  Policy tier — controls which network presets are enabled:");
    allTiers.forEach((t, i) => {
      const marker = t.name === defaultTier.name ? RADIO_ON : RADIO_OFF;
      console.log(`    ${marker} ${t.label}`);
    });
    console.log("");
    const answer = await prompt(
      `  Select tier [1-${allTiers.length}] (default: ${allTiers.indexOf(defaultTier) + 1} ${defaultTier.name}): `,
    );
    const idx =
      answer.trim() === "" ? allTiers.indexOf(defaultTier) : parseInt(answer.trim(), 10) - 1;
    const chosen = allTiers[idx] || defaultTier;
    console.log(`  Tier: ${chosen.label}`);
    return chosen.name;
  }

  // ── Raw-mode TUI (radio — single selection) ───────────────────────
  let cursor = allTiers.indexOf(defaultTier);
  let selectedIdx = cursor;
  const n = allTiers.length;

  const G = USE_COLOR ? "\x1b[32m" : "";
  const D = USE_COLOR ? "\x1b[2m" : "";
  const R = USE_COLOR ? "\x1b[0m" : "";
  const HINT = USE_COLOR
    ? `  ${G}↑/↓ j/k${R}  ${D}move${R}    ${G}Space${R}  ${D}select${R}    ${G}Enter${R}  ${D}confirm${R}`
    : "  ↑/↓ j/k  move    Space  select    Enter  confirm";

  const renderLines = () => {
    const lines = ["  Policy tier — controls which network presets are enabled:"];
    allTiers.forEach((t, i) => {
      const radio = i === selectedIdx ? RADIO_ON : RADIO_OFF;
      const arrow = i === cursor ? ">" : " ";
      lines.push(`   ${arrow} ${radio} ${t.label}`);
    });
    lines.push("");
    lines.push(HINT);
    return lines;
  };

  process.stdout.write("\n");
  const initial = renderLines();
  for (const line of initial) process.stdout.write(`${line}\n`);
  let lineCount = initial.length;

  const redraw = () => {
    process.stdout.write(`\x1b[${lineCount}A`);
    const lines = renderLines();
    for (const line of lines) process.stdout.write(`\r\x1b[2K${line}\n`);
    lineCount = lines.length;
  };

  // Re-attach stdin to the event loop. A prior prompt cleanup may have
  // unref'd it (sticky), and resume() alone would leave the raw-mode read
  // detached from the loop.
  if (typeof process.stdin.ref === "function") process.stdin.ref();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise<string>((resolve) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      // Symmetric with the ref() at the entry; lets the wizard exit
      // naturally if this is the last prompt.
      if (typeof process.stdin.unref === "function") process.stdin.unref();
      process.stdin.removeListener("data", onData);
      process.removeListener("SIGTERM", onSigterm);
    };

    const onSigterm = () => {
      cleanup();
      process.exit(1);
    };
    process.once("SIGTERM", onSigterm);

    const onData = (key: string) => {
      if (key === "\r" || key === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(allTiers[selectedIdx].name);
      } else if (key === " ") {
        selectedIdx = cursor;
        redraw();
      } else if (key === "\x03") {
        cleanup();
        process.exit(1);
      } else if (key === "\x1b[A" || key === "k") {
        cursor = (cursor - 1 + n) % n;
        redraw();
      } else if (key === "\x1b[B" || key === "j") {
        cursor = (cursor + 1) % n;
        redraw();
      }
    };

    process.stdin.on("data", onData);
  });
}

/**
 * Combined preset selector: shows ALL available presets, pre-checks those in
 * the chosen tier, and lets the user include/exclude any preset and toggle
 * per-preset access (read vs read-write).
 *
 * Tier presets are listed first (in tier order), then remaining presets
 * alphabetically. Tier presets are pre-checked; others start unchecked.
 *
 * Keys:
 *   ↑/↓ j/k — move cursor
 *   Space    — include / exclude current preset
 *   r        — toggle read / read-write for current preset
 *   Enter    — confirm
 *
 * @param {string} tierName
 * @param {Array<{name: string}>} allPresets
 * @param {string[]} [extraSelected]  — names pre-checked even if not in tier (e.g. already-applied)
 * @returns {Promise<Array<{name: string, access: string}>>}
 */
async function selectTierPresetsAndAccess(
  tierName: string,
  allPresets: Array<{ name: string; description?: string }>,
  extraSelected: string[] = [],
): Promise<Array<{ name: string; access: string }>> {
  const tierDef = tiers.getTier(tierName);
  const tierPresetMap: Record<string, string> = {};
  if (tierDef) {
    for (const p of tierDef.presets) {
      tierPresetMap[p.name] = p.access;
    }
  }

  // Tier presets first (in tier order), then the rest in their original order.
  const tierNames = tierDef ? tierDef.presets.map((p) => p.name) : [];
  const tierSet = new Set(tierNames);
  const ordered: Array<{ name: string; description?: string }> = [
    ...tierNames
      .map((name) => allPresets.find((p) => p.name === name))
      .filter((p): p is { name: string; description?: string } => Boolean(p)),
    ...allPresets.filter((p) => !tierSet.has(p.name)),
  ];

  // Initial inclusion: tier presets + any already-applied extras.
  const included = new Set([
    ...tierNames,
    ...extraSelected.filter((n) => ordered.find((p) => p.name === n)),
  ]);

  // Access levels: tier defaults for tier presets, read-write default for others.
  const accessModes: Record<string, string> = {};
  for (const p of ordered) {
    accessModes[p.name] = tierPresetMap[p.name] ?? "read-write";
  }

  const G = USE_COLOR ? "\x1b[32m" : "";
  const O = USE_COLOR ? "\x1b[38;5;208m" : "";
  const D = USE_COLOR ? "\x1b[2m" : "";
  const R = USE_COLOR ? "\x1b[0m" : "";
  const GREEN_CHECK = USE_COLOR ? `[${G}✓${R}]` : "[✓]";
  const EMPTY_CHECK = USE_COLOR ? `${D}[ ]${R}` : "[ ]";
  const TOGGLE_RW = USE_COLOR ? `[${O}rw${R}]` : "[rw]";
  const TOGGLE_R = USE_COLOR ? `${D}[ r]${R}` : "[ r]";

  const label = tierDef ? `  Presets  (${tierDef.label} defaults):` : "  Presets:";
  const n = ordered.length;

  // ── Non-interactive: return tier defaults silently ─────────────────
  if (isNonInteractive()) {
    return ordered
      .filter((p) => included.has(p.name))
      .map((p) => ({ name: p.name, access: accessModes[p.name] }));
  }

  // ── Fallback: non-TTY ─────────────────────────────────────────────
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("");
    console.log(label);
    ordered.forEach((p) => {
      const isIncluded = included.has(p.name);
      const isRw = accessModes[p.name] === "read-write";
      const check = isIncluded ? GREEN_CHECK : EMPTY_CHECK;
      const badge = isIncluded ? (isRw ? "[rw]" : "[ r]") : "    ";
      console.log(`    ${check} ${badge} ${p.name}`);
    });
    console.log("");
    const rawInclude = await prompt(
      "  Include presets (comma-separated names, Enter to keep defaults): ",
    );
    if (rawInclude.trim()) {
      const knownNames = new Set(ordered.map((p) => p.name));
      included.clear();
      for (const name of rawInclude
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        if (knownNames.has(name)) {
          included.add(name);
        } else {
          console.error(`  Unknown preset name ignored: ${name}`);
        }
      }
    }
    return ordered
      .filter((p) => included.has(p.name))
      .map((p) => ({ name: p.name, access: accessModes[p.name] }));
  }

  // ── Raw-mode TUI ─────────────────────────────────────────────────
  let cursor = 0;

  const HINT = USE_COLOR
    ? `  ${G}↑/↓ j/k${R}  ${D}move${R}    ${G}Space${R}  ${D}include${R}    ${G}r${R}  ${D}toggle rw${R}    ${G}Enter${R}  ${D}confirm${R}`
    : "  ↑/↓ j/k  move    Space  include    r  toggle rw    Enter  confirm";

  const renderLines = () => {
    const lines = [label];
    ordered.forEach((p, i) => {
      const isIncluded = included.has(p.name);
      const isRw = accessModes[p.name] === "read-write";
      const check = isIncluded ? GREEN_CHECK : EMPTY_CHECK;
      // badge is 4 visible chars + 1 space; blank when unchecked to keep name aligned
      const badge = isIncluded ? (isRw ? TOGGLE_RW + " " : TOGGLE_R + " ") : "     ";
      const arrow = i === cursor ? ">" : " ";
      lines.push(`   ${arrow} ${check} ${badge}${p.name}`);
    });
    lines.push("");
    lines.push(HINT);
    return lines;
  };

  process.stdout.write("\n");
  const initial = renderLines();
  for (const line of initial) process.stdout.write(`${line}\n`);
  let lineCount = initial.length;

  const redraw = () => {
    process.stdout.write(`\x1b[${lineCount}A`);
    const lines = renderLines();
    for (const line of lines) process.stdout.write(`\r\x1b[2K${line}\n`);
    lineCount = lines.length;
  };

  // Re-attach stdin to the event loop. A prior prompt cleanup may have
  // unref'd it (sticky), and resume() alone would leave the raw-mode read
  // detached from the loop.
  if (typeof process.stdin.ref === "function") process.stdin.ref();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise<Array<{ name: string; access: string }>>((resolve) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      // Symmetric with the ref() at the entry; lets the wizard exit
      // naturally if this is the last prompt.
      if (typeof process.stdin.unref === "function") process.stdin.unref();
      process.stdin.removeListener("data", onData);
      process.removeListener("SIGTERM", onSigterm);
    };

    const onSigterm = () => {
      cleanup();
      process.exit(1);
    };
    process.once("SIGTERM", onSigterm);

    const onData = (key: string) => {
      if (key === "\r" || key === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(
          ordered
            .filter((p) => included.has(p.name))
            .map((p) => ({ name: p.name, access: accessModes[p.name] })),
        );
      } else if (key === "\x03") {
        cleanup();
        process.exit(1);
      } else if (key === "\x1b[A" || key === "k") {
        cursor = (cursor - 1 + n) % n;
        redraw();
      } else if (key === "\x1b[B" || key === "j") {
        cursor = (cursor + 1) % n;
        redraw();
      } else if (key === " ") {
        const currentPreset = ordered[cursor];
        if (!currentPreset) return;
        const name = currentPreset.name;
        if (included.has(name)) {
          included.delete(name);
        } else {
          included.add(name);
        }
        redraw();
      } else if (key === "r" || key === "R") {
        const currentPreset = ordered[cursor];
        if (!currentPreset) return;
        const name = currentPreset.name;
        accessModes[name] = accessModes[name] === "read-write" ? "read" : "read-write";
        redraw();
      }
    };

    process.stdin.on("data", onData);
  });
}

/**
 * Raw-mode TUI preset selector.
 * Keys: ↑/↓ or k/j to move, Space to toggle, a to select/unselect all, Enter to confirm.
 * Falls back to a simple line-based prompt when stdin is not a TTY.
 */
async function presetsCheckboxSelector(
  allPresets: Array<{ name: string; description: string }>,
  initialSelected: string[],
): Promise<string[]> {
  const selected = new Set<string>(initialSelected);
  const n = allPresets.length;

  // ── Zero-presets guard ────────────────────────────────────────────
  if (n === 0) {
    console.log("  No policy presets are available.");
    return [];
  }

  const GREEN_CHECK = USE_COLOR ? "[\x1b[32m✓\x1b[0m]" : "[✓]";

  // ── Fallback: non-TTY or redirected stdout (piped input) ──────────
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("");
    console.log("  Available policy presets:");
    allPresets.forEach((p) => {
      const marker = selected.has(p.name) ? GREEN_CHECK : "[ ]";
      console.log(`    ${marker} ${p.name.padEnd(14)} — ${p.description}`);
    });
    console.log("");
    const raw = await prompt("  Select presets (comma-separated names, Enter to skip): ");
    if (!raw.trim()) {
      console.log("  Skipping policy presets.");
      return [];
    }
    const knownNames = new Set(allPresets.map((p) => p.name));
    const chosen = [];
    for (const name of raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (knownNames.has(name)) {
        chosen.push(name);
      } else {
        console.error(`  Unknown preset name ignored: ${name}`);
      }
    }
    return chosen;
  }

  // ── Raw-mode TUI ─────────────────────────────────────────────────
  let cursor = 0;

  const G = USE_COLOR ? "\x1b[32m" : "";
  const D = USE_COLOR ? "\x1b[2m" : "";
  const R = USE_COLOR ? "\x1b[0m" : "";
  const HINT = USE_COLOR
    ? `  ${G}↑/↓ j/k${R}  ${D}move${R}    ${G}Space${R}  ${D}toggle${R}    ${G}a${R}  ${D}all/none${R}    ${G}Enter${R}  ${D}confirm${R}`
    : "  ↑/↓ j/k  move    Space  toggle    a  all/none    Enter  confirm";

  const renderLines = () => {
    const lines = ["  Available policy presets:"];
    allPresets.forEach((p, i) => {
      const check = selected.has(p.name) ? GREEN_CHECK : "[ ]";
      const arrow = i === cursor ? ">" : " ";
      lines.push(`   ${arrow} ${check} ${p.name.padEnd(14)} — ${p.description}`);
    });
    lines.push("");
    lines.push(HINT);
    return lines;
  };

  // Initial paint
  process.stdout.write("\n");
  const initial = renderLines();
  for (const line of initial) process.stdout.write(`${line}\n`);
  let lineCount = initial.length;

  const redraw = () => {
    process.stdout.write(`\x1b[${lineCount}A`);
    const lines = renderLines();
    for (const line of lines) process.stdout.write(`\r\x1b[2K${line}\n`);
    lineCount = lines.length;
  };

  // Re-attach stdin to the event loop. A prior prompt cleanup may have
  // unref'd it (sticky), and resume() alone would leave the raw-mode read
  // detached from the loop.
  if (typeof process.stdin.ref === "function") process.stdin.ref();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise<string[]>((resolve) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      // Symmetric with the ref() at the entry; lets the wizard exit
      // naturally if this is the last prompt.
      if (typeof process.stdin.unref === "function") process.stdin.unref();
      process.stdin.removeListener("data", onData);
      process.removeListener("SIGTERM", onSigterm);
    };

    const onSigterm = () => {
      cleanup();
      process.exit(1);
    };
    process.once("SIGTERM", onSigterm);

    const onData = (key: string) => {
      if (key === "\r" || key === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve([...selected]);
      } else if (key === "\x03") {
        // Ctrl+C
        cleanup();
        process.exit(1);
      } else if (key === "\x1b[A" || key === "k") {
        cursor = (cursor - 1 + n) % n;
        redraw();
      } else if (key === "\x1b[B" || key === "j") {
        cursor = (cursor + 1) % n;
        redraw();
      } else if (key === " ") {
        const currentPreset = allPresets[cursor];
        if (!currentPreset) return;
        const name = currentPreset.name;
        if (selected.has(name)) selected.delete(name);
        else selected.add(name);
        redraw();
      } else if (key === "a") {
        if (selected.size === n) selected.clear();
        else for (const p of allPresets) selected.add(p.name);
        redraw();
      }
    };

    process.stdin.on("data", onData);
  });
}

function computeSetupPresetSuggestions(
  tierName: string,
  options: {
    enabledChannels?: string[] | null;
    webSearchConfig?: WebSearchConfig | null;
    provider?: string | null;
    knownPresetNames?: string[] | null;
    webSearchSupported?: boolean | null;
  } = {},
): string[] {
  const { enabledChannels = null, webSearchConfig = null, provider = null } = options;
  const known = Array.isArray(options.knownPresetNames) ? new Set(options.knownPresetNames) : null;
  const supportOptions = { webSearchSupported: options.webSearchSupported };
  const suggestions = tiers
    .resolveTierPresets(tierName)
    .map((p) => p.name)
    .filter((name) => policies.setupPolicyPresetSupported(name, supportOptions))
    .filter((name) => !known || known.has(name));
  const add = (name: string) => {
    if (!policies.setupPolicyPresetSupported(name, supportOptions)) return;
    if (suggestions.includes(name)) return;
    if (known && !known.has(name)) return;
    suggestions.push(name);
  };
  if (webSearchConfig) add("brave");
  if (provider && LOCAL_INFERENCE_PROVIDERS.includes(provider)) add("local-inference");
  if (Array.isArray(enabledChannels)) {
    for (const channel of enabledChannels) add(channel);
  }
  return suggestions;
}

async function setupPoliciesWithSelection(
  sandboxName: string,
  options: {
    selectedPresets?: string[] | null;
    onSelection?: ((policyPresets: string[]) => void) | null;
    webSearchConfig?: WebSearchConfig | null;
    enabledChannels?: string[] | null;
    provider?: string | null;
    knownPresetNames?: string[];
    webSearchSupported?: boolean | null;
  } = {},
) {
  const selectedPresets = Array.isArray(options.selectedPresets) ? options.selectedPresets : null;
  const onSelection = typeof options.onSelection === "function" ? options.onSelection : null;
  const webSearchConfig = options.webSearchConfig || null;
  const enabledChannels = Array.isArray(options.enabledChannels) ? options.enabledChannels : null;
  const provider = options.provider || null;

  step(8, 8, "Policy presets");

  const supportOptions = { webSearchSupported: options.webSearchSupported };
  const allPresets = policies.listSetupPolicyPresets(sandboxName, supportOptions);
  const knownPresets = new Set(allPresets.map((p) => p.name));
  const customPresetNames = new Set(
    policies.listCustomPresets(sandboxName).map((p: { name: string }) => p.name),
  );
  const currentAppliedPresets = policies.getAppliedPresets(sandboxName);
  const selectablePresets = [
    ...allPresets,
    ...currentAppliedPresets.map((name) => ({ name })),
  ];
  const applied = policies.clampSetupPolicyPresetNames(
    currentAppliedPresets,
    selectablePresets,
    supportOptions,
    customPresetNames,
  );
  const filterSupportedPresetNames = (presetNames: string[]) =>
    presetNames.filter(
      (name) =>
        customPresetNames.has(name) || policies.setupPolicyPresetSupported(name, supportOptions),
    );
  let chosen = selectedPresets !== null
    ? policies.clampSetupPolicyPresetNames(
        selectedPresets,
        selectablePresets,
        supportOptions,
        customPresetNames,
      )
    : null;

  // Resume path: caller supplies the preset list from a previous run.
  if (selectedPresets !== null) {
    const resumeSelection = chosen || [];
    if (onSelection) onSelection(resumeSelection);
    if (!waitForSandboxReady(sandboxName)) {
      console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
      process.exit(1);
    }
    note(`  [resume] Reapplying policy presets: ${resumeSelection.join(", ")}`);
    syncPresetSelection(sandboxName, currentAppliedPresets, resumeSelection);
    return resumeSelection;
  }

  // Tier selection — determines the default preset list for this install.
  const tierName = await selectPolicyTier();
  registry.updateSandbox(sandboxName, { policyTier: tierName });
  const suggestions = computeSetupPresetSuggestions(tierName, {
    enabledChannels,
    webSearchConfig,
    provider,
    knownPresetNames: allPresets.map((p) => p.name),
    webSearchSupported: options.webSearchSupported,
  });

  if (isNonInteractive()) {
    const policyMode = (process.env.NEMOCLAW_POLICY_MODE || "suggested").trim().toLowerCase();
    chosen = suggestions;
    let isAuthoritative = false;

    if (policyMode === "skip" || policyMode === "none" || policyMode === "no") {
      note("  [non-interactive] Skipping policy presets.");
      return [];
    }

    if (policyMode === "custom" || policyMode === "list") {
      const envPresets = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS || "");
      if (envPresets.length === 0) {
        console.error("  NEMOCLAW_POLICY_PRESETS is required when NEMOCLAW_POLICY_MODE=custom.");
        process.exit(1);
      }
      chosen = filterSupportedPresetNames(envPresets);
      isAuthoritative = true;
    } else if (policyMode === "suggested" || policyMode === "default" || policyMode === "auto") {
      const envPresets = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS || "");
      if (envPresets.length > 0) chosen = filterSupportedPresetNames(envPresets);
    } else {
      // #2429: step 8/8 runs after the sandbox is created. Exiting here left
      // the sandbox with no presets. Warn, optionally suggest the intended
      // variable, and fall through to the tier-derived suggestions list.
      console.warn(`  Unsupported NEMOCLAW_POLICY_MODE: ${policyMode}`);
      console.warn(
        "  Valid values: suggested, custom, skip (aliases: default/auto, list, none/no).",
      );
      if (tiers.getTier(policyMode)) {
        console.warn(
          `  '${policyMode}' is a policy tier — did you mean NEMOCLAW_POLICY_TIER=${policyMode}?`,
        );
      }
      console.warn(`  Falling back to suggested presets for tier '${tierName}'.`);
    }

    const invalidPresets = chosen.filter((name) => !knownPresets.has(name));
    if (invalidPresets.length > 0) {
      console.error(`  Unknown policy preset(s): ${invalidPresets.join(", ")}`);
      process.exit(1);
    }

    // Suggested mode is additive: presets the user added beyond the tier
    // defaults (typically via `nemoclaw <name> policy-add`, including custom
    // presets loaded with `--from-file`/`--from-dir`) must survive a
    // re-onboard. `applied` comes from the registry and is the source of
    // truth for what is currently on the sandbox, so trust it directly
    // instead of intersecting with the built-in list. Custom mode remains
    // authoritative — the operator-supplied list is exactly what the
    // sandbox ends up with, and deselected presets are removed.
    if (!isAuthoritative) {
      const chosenSet = new Set(chosen);
      const preserved: string[] = [];
      for (const name of applied) {
        if (chosenSet.has(name)) continue;
        chosen.push(name);
        chosenSet.add(name);
        preserved.push(name);
      }
      if (preserved.length > 0) {
        note(`  [non-interactive] Preserving previously-applied presets: ${preserved.join(", ")}`);
      }
    }

    if (onSelection) onSelection(chosen);
    if (!waitForSandboxReady(sandboxName)) {
      console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
      process.exit(1);
    }
    note(`  [non-interactive] Applying policy presets: ${chosen.join(", ")}`);
    syncPresetSelection(sandboxName, currentAppliedPresets, chosen);
    return chosen;
  }

  // Interactive: combined tier preset selector + access-mode toggle.
  // extraSelected seeds the initial checked state beyond the tier defaults:
  // - presets already applied from a previous run
  // - credential-based additions from suggestions (e.g. brave when webSearchConfig is set)
  const knownNames = new Set(allPresets.map((p) => p.name));
  const extraSelected = [
    ...applied.filter((name) => knownNames.has(name)),
    ...suggestions.filter((name) => knownNames.has(name) && !applied.includes(name)),
  ];
  const resolvedPresets = await selectTierPresetsAndAccess(tierName, allPresets, extraSelected);
  const interactiveChoice = resolvedPresets.map((p) => p.name);

  if (onSelection) onSelection(interactiveChoice);
  if (!waitForSandboxReady(sandboxName)) {
    console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
    process.exit(1);
  }

  const accessByName: Record<string, string> = {};
  for (const p of resolvedPresets) accessByName[p.name] = p.access;
  syncPresetSelection(sandboxName, currentAppliedPresets, interactiveChoice, accessByName);
  return interactiveChoice;
}

/**
 * Reconcile the sandbox's currently-applied preset list with the user's
 * target selection:
 *   - remove presets in `applied` but not in `target` (narrow)
 *   - apply presets in `target` but not in `applied` (widen)
 *   - leave unchanged presets untouched (no wasteful re-apply)
 *
 * Shared between the interactive and non-interactive paths so "narrow the
 * selection" works identically in both. Fixes #2177 (non-interactive path
 * was apply-only, so deselected presets lingered).
 *
 * @param {string} sandboxName  Target sandbox.
 * @param {string[]} applied    Preset names currently applied to the sandbox.
 * @param {string[]} target     Preset names the user wants applied after this call.
 * @param {Object<string, string>|null} [accessByName=null]
 *   Optional map of preset name → access mode ("read" | "read-write").
 *   When provided, applyPreset receives the mode per preset so the gateway
 *   can distinguish read vs read-write installs.
 * @returns {void}
 */
function syncPresetSelection(
  sandboxName: string,
  applied: string[],
  target: string[],
  accessByName: Record<string, string> | null = null,
): void {
  const targetSet = new Set(target);
  const appliedSet = new Set(applied);
  const deselected = applied.filter((name) => !targetSet.has(name));
  const newlySelected = target.filter((name) => !appliedSet.has(name));

  for (const name of deselected) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (!policies.removePreset(sandboxName, name)) {
          throw new Error(`Failed to remove preset '${name}'.`);
        }
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("sandbox not found") || attempt === 2) {
          throw err;
        }
        sleep(2);
      }
    }
  }

  for (const name of newlySelected) {
    const options = accessByName ? { access: accessByName[name] } : undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // applyPreset returns false (without throwing) on some error paths —
        // e.g. unknown preset, malformed YAML. Treat that as a failure so
        // setupPoliciesWithSelection doesn't silently report success on a
        // preset that never got applied.
        if (!policies.applyPreset(sandboxName, name, options)) {
          throw new Error(`Failed to apply preset '${name}'.`);
        }
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("sandbox not found") || attempt === 2) {
          throw err;
        }
        sleep(2);
      }
    }
  }
}

// ── Dashboard ────────────────────────────────────────────────────

const CONTROL_UI_PORT = DASHBOARD_PORT;

// Dashboard helpers — delegated to src/lib/dashboard/contract.ts
const { buildChain, buildControlUiUrls } = dashboardContract;

// Parses `openshell forward list` output and returns the sandbox currently
// owning `portToStop`, or null. Exported for unit testing — see #2169.
// Columns: SANDBOX  BIND  PORT  PID  STATUS (whitespace-separated).
function findDashboardForwardOwner(
  forwardListOutput: string | null | undefined,
  portToStop: string,
): string | null {
  if (!forwardListOutput) return null;
  const portLine = forwardListOutput
    .split("\n")
    .map((l) => l.trim())
    .find((l) => {
      const parts = l.split(/\s+/);
      return parts[2] === portToStop;
    });
  return portLine ? (portLine.split(/\s+/)[0] ?? null) : null;
}

function findForwardEntry(
  forwardListOutput: string | null | undefined,
  port: string,
): { sandboxName: string; status: string } | null {
  if (!forwardListOutput) return null;
  for (const rawLine of forwardListOutput.split("\n")) {
    const line = rawLine.replace(ANSI_RE, "");
    if (/^\s*SANDBOX\s/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || parts[2] !== port) continue;
    return {
      sandboxName: parts[0] || "",
      status: (parts[4] || "").toLowerCase(),
    };
  }
  return null;
}

function isLiveForwardStatus(status: string): boolean {
  return status === "running" || status === "active";
}

function getRunningForwardPorts(forwardListOutput: string | null | undefined): string[] {
  const ports = new Set<string>();
  if (!forwardListOutput) return [];
  for (const rawLine of forwardListOutput.split("\n")) {
    const line = rawLine.replace(ANSI_RE, "");
    if (/^\s*SANDBOX\s/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || !/^\d+$/.test(parts[2])) continue;
    const status = (parts[4] || "").toLowerCase();
    if (isLiveForwardStatus(status)) {
      ports.add(parts[2]);
    }
  }
  return [...ports];
}

function stopAllDashboardForwards(): void {
  const forwardList = runCaptureOpenshell(["forward", "list"], { ignoreError: true });
  for (const port of getRunningForwardPorts(forwardList)) {
    runOpenshell(["forward", "stop", port], { ignoreError: true });
  }
}

/**
 * Parse `openshell forward list` output into a Map<port, sandboxName>.
 * Only includes running forwards — stopped/stale entries are ignored so
 * they don't block port allocation or cause false "range exhausted" errors.
 *
 * Output format (columns separated by whitespace):
 *   SANDBOX  BIND  PORT  PID  STATUS
 */
function getOccupiedPorts(forwardListOutput: string | null): Map<string, string> {
  const occupied = new Map();
  if (!forwardListOutput) return occupied;
  for (const rawLine of forwardListOutput.split("\n")) {
    const line = rawLine.replace(ANSI_RE, "");
    if (/^\s*SANDBOX\s/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    // parts: [sandbox, bind, port, pid, status...]
    if (parts.length < 3 || !/^\d+$/.test(parts[2])) continue;
    const status = (parts[4] || "").toLowerCase();
    if (!isLiveForwardStatus(status)) continue;
    occupied.set(parts[2], parts[0]);
  }
  return occupied;
}

/**
 * Quick synchronous check whether a TCP port has an active listener on the host.
 * Uses lsof when available; returns false (optimistic) if lsof is missing.
 */
function isPortBoundOnHost(port: number): boolean {
  try {
    const out = runCapture(["lsof", "-i", `:${port}`, "-sTCP:LISTEN", "-P", "-n"], {
      ignoreError: true,
    });
    return !!out && out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Find the next available dashboard port for the given sandbox.
 * Returns the preferred port if free or already owned by this sandbox,
 * otherwise scans DASHBOARD_PORT_RANGE_START..END for a free port.
 * Validates host-port availability (via lsof) so ports bound by
 * non-OpenShell processes are skipped.
 * Throws if the entire range is exhausted.
 */
function findAvailableDashboardPort(
  sandboxName: string,
  preferredPort: number,
  forwardListOutput: string | null,
): number {
  const occupied = getOccupiedPorts(forwardListOutput);
  const preferredStr = String(preferredPort);
  const owner = occupied.get(preferredStr) ?? null;
  // If this sandbox already owns the forward, keep it.
  if (owner === sandboxName) return preferredPort;
  // If no forward claims the port, also check the host so we don't collide
  // with non-OpenShell processes.
  if (owner === null && !isPortBoundOnHost(preferredPort)) return preferredPort;

  for (let p = DASHBOARD_PORT_RANGE_START; p <= DASHBOARD_PORT_RANGE_END; p++) {
    const pStr = String(p);
    const pOwner = occupied.get(pStr) ?? null;
    if (pOwner === sandboxName) return p;
    if (pOwner === null && !isPortBoundOnHost(p)) return p;
  }

  const owners = [...occupied.entries()]
    .filter(
      ([p]) => Number(p) >= DASHBOARD_PORT_RANGE_START && Number(p) <= DASHBOARD_PORT_RANGE_END,
    )
    .map(([p, s]) => `  ${p} → ${s}`)
    .join("\n");
  throw new Error(
    `All dashboard ports in range ${DASHBOARD_PORT_RANGE_START}-${DASHBOARD_PORT_RANGE_END} are occupied:\n${owners}\n` +
      `Free a sandbox or use --control-ui-port <N> with a port outside this range.`,
  );
}

/**
 * Build the actionable error lines printed when the just-created openshell
 * sandbox is rolled back after a dashboard port-allocation failure. Pure
 * function over (sandboxName, alloc-error, delete-result) so the rollback path
 * is testable without spawning subprocesses or exiting the process (#2174).
 */
function buildOrphanedSandboxRollbackMessage(
  sandboxName: string,
  err: unknown,
  deleteSucceeded: boolean,
): string[] {
  const lines = [
    "",
    `  Could not allocate a dashboard port for '${sandboxName}'.`,
    `  ${err instanceof Error ? err.message : String(err)}`,
  ];
  if (deleteSucceeded) {
    lines.push("  The orphaned sandbox has been removed — you can safely retry.");
  } else {
    lines.push("  Could not remove the orphaned sandbox. Manual cleanup:");
    lines.push(`    openshell sandbox delete "${sandboxName}"`);
  }
  return lines;
}

/**
 * Set up the dashboard forward for a sandbox. Auto-allocates the next free
 * port if the preferred port is taken by a different sandbox (Fixes #2174).
 * Returns the actual port number used.
 *
 * When `rollbackSandboxOnFailure` is true, deletes the just-created openshell
 * sandbox before exiting on unrecoverable port-allocation failure. This keeps
 * `openshell sandbox list` and the NemoClaw registry from drifting when the
 * range is exhausted between sandbox-create and forward-setup ("leaks ghost
 * sandbox" half of #2174). Mirrors the not-ready rollback pattern in
 * createSandbox.
 */
function ensureDashboardForward(
  sandboxName: string,
  chatUiUrl = `http://127.0.0.1:${CONTROL_UI_PORT}`,
  options: { rollbackSandboxOnFailure?: boolean } = {},
): number {
  const { rollbackSandboxOnFailure = false } = options;
  const preferredPort = Number(getDashboardForwardPort(chatUiUrl));
  let existingForwards = runCaptureOpenshell(["forward", "list"], { ignoreError: true });
  const preferredEntry = findForwardEntry(existingForwards, String(preferredPort));
  if (
    preferredEntry &&
    (preferredEntry.sandboxName === sandboxName || !isLiveForwardStatus(preferredEntry.status))
  ) {
    runOpenshell(["forward", "stop", String(preferredPort)], { ignoreError: true });
    existingForwards = runCaptureOpenshell(["forward", "list"], { ignoreError: true });
  }
  let actualPort: number;
  try {
    actualPort = findAvailableDashboardPort(sandboxName, preferredPort, existingForwards);
  } catch (err) {
    if (!rollbackSandboxOnFailure) throw err;
    const delResult = runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    for (const line of buildOrphanedSandboxRollbackMessage(
      sandboxName,
      err,
      delResult.status === 0,
    )) {
      console.error(line);
    }
    process.exit(1);
  }

  if (actualPort !== preferredPort) {
    console.warn(`  ! Port ${preferredPort} is taken. Using port ${actualPort} instead.`);
  }

  // Clean up any stale forwards owned by this sandbox on other ports so we
  // don't leak forwards across port changes and exhaust the range over time.
  const occupied = getOccupiedPorts(existingForwards);
  for (const [port, owner] of occupied.entries()) {
    if (owner === sandboxName && Number(port) !== actualPort) {
      runOpenshell(["forward", "stop", port], { ignoreError: true });
    }
  }

  // Preserve the original URL's hostname (loopback vs remote) but swap to the actual port.
  const parsedUrl = new URL(chatUiUrl.includes("://") ? chatUiUrl : `http://${chatUiUrl}`);
  parsedUrl.port = String(actualPort);
  const actualTarget = getDashboardForwardTarget(parsedUrl.toString());
  runOpenshell(["forward", "stop", String(actualPort)], { ignoreError: true });
  const fwdResult = runOpenshell(["forward", "start", "--background", actualTarget, sandboxName], {
    ignoreError: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (fwdResult && fwdResult.status !== 0) {
    console.warn(
      `! Port ${actualPort} forward did not start — port may be in use by another process.`,
    );
    console.warn(
      `  Check: docker ps --format 'table {{.Names}}\\t{{.Ports}}' | grep ${actualPort}`,
    );
    console.warn(`  Free the port, then reconnect: ${cliName()} ${sandboxName} connect`);
  }
  return actualPort;
}

function ensureAgentDashboardForward(
  sandboxName: string,
  agent: { forwardPort?: number | null },
): number {
  const agentDashboardPort = agent.forwardPort ?? CONTROL_UI_PORT;
  const agentDashboardUrl = `http://127.0.0.1:${agentDashboardPort}`;
  const actualAgentDashboardPort = ensureDashboardForward(sandboxName, agentDashboardUrl);
  process.env.CHAT_UI_URL = `http://127.0.0.1:${actualAgentDashboardPort}`;
  return actualAgentDashboardPort;
}

function findOpenclawJsonPath(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found: string | null = findOpenclawJsonPath(p);
      if (found) return found;
    } else if (e.name === "openclaw.json") {
      return p;
    }
  }
  return null;
}

/**
 * Pull gateway.auth.token from the sandbox image via openshell sandbox download
 * so onboard can build dashboard access URLs. User-visible output must redact
 * the token fragment.
 */
function fetchGatewayAuthTokenFromSandbox(sandboxName: string): string | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-token-"));
  try {
    const destDir = `${tmpDir}${path.sep}`;
    const result = runOpenshell(
      ["sandbox", "download", sandboxName, "/sandbox/.openclaw/openclaw.json", destDir],
      { ignoreError: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    if (result.status !== 0) return null;
    const jsonPath = findOpenclawJsonPath(tmpDir);
    if (!jsonPath) return null;
    const cfg = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const token = cfg && cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

// buildControlUiUrls — see dashboard-contract import above

function buildDashboardChain(
  chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
  options: {
    wslHostAddress?: string | null;
    runCapture?: typeof runCapture;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    release?: string;
    isWsl?: boolean;
  } = {},
) {
  return buildChain({
    chatUiUrl,
    isWsl: isWsl(options),
    wslHostAddress: getWslHostAddress(options),
  });
}

function getDashboardForwardPort(
  chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
  options: {
    wslHostAddress?: string | null;
    runCapture?: typeof runCapture;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    release?: string;
    isWsl?: boolean;
  } = {},
): string {
  return String(buildDashboardChain(chatUiUrl, options).port);
}

function getDashboardForwardTarget(
  chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
  options: {
    wslHostAddress?: string | null;
    runCapture?: typeof runCapture;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    release?: string;
    isWsl?: boolean;
    chatUiUrl?: string;
    token?: string | null;
  } = {},
): string {
  return buildDashboardChain(chatUiUrl, options).forwardTarget;
}

function getDashboardForwardStartCommand(
  sandboxName: string,
  options: {
    chatUiUrl?: string;
    openshellBinary?: string;
    wslHostAddress?: string | null;
    runCapture?: typeof runCapture;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    release?: string;
    isWsl?: boolean;
    token?: string | null;
  } = {},
): string {
  const chatUiUrl =
    options.chatUiUrl || process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`;
  const forwardTarget = getDashboardForwardTarget(chatUiUrl, options);
  return `${openshellShellCommand(
    ["forward", "start", "--background", forwardTarget, sandboxName],
    options,
  )}`;
}

function buildAuthenticatedDashboardUrl(baseUrl: string, token: string | null = null): string {
  if (!token) return baseUrl;
  return `${baseUrl}#token=${encodeURIComponent(token)}`;
}

function dashboardUrlForDisplay(url: string): string {
  return redact(url.replace(/#token=[^\s'"]*$/i, ""));
}

function getWslHostAddress(
  options: {
    wslHostAddress?: string | null;
    runCapture?: typeof runCapture;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    release?: string;
    isWsl?: boolean;
  } = {},
): string | null {
  if (options.wslHostAddress) {
    return options.wslHostAddress;
  }
  if (!isWsl(options)) {
    return null;
  }
  const runCaptureFn = options.runCapture || runCapture;
  const output = runCaptureFn(["hostname", "-I"], { ignoreError: true });
  return (
    String(output || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)[0] || null
  );
}

function getDashboardAccessInfo(
  sandboxName: string,
  options: {
    token?: string | null;
    chatUiUrl?: string;
    wslHostAddress?: string | null;
    runCapture?: typeof runCapture;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    release?: string;
    isWsl?: boolean;
  } = {},
) {
  const token = Object.prototype.hasOwnProperty.call(options, "token")
    ? options.token
    : fetchGatewayAuthTokenFromSandbox(sandboxName);
  const chatUiUrl =
    options.chatUiUrl || process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`;
  const chain = buildDashboardChain(chatUiUrl, options);
  const dashboardAccess = buildControlUiUrls(token, chain.port, chain.accessUrl).map(
    (url, index) => ({
      label: index === 0 ? "Dashboard" : `Alt ${index}`,
      url: buildAuthenticatedDashboardUrl(url, null),
    }),
  );

  const wslHostAddress = getWslHostAddress(options);
  if (wslHostAddress) {
    const wslUrl = buildAuthenticatedDashboardUrl(`http://${wslHostAddress}:${chain.port}/`, token);
    if (!dashboardAccess.some((access) => access.url === wslUrl)) {
      dashboardAccess.push({ label: "VS Code/WSL", url: wslUrl });
    }
  }

  return dashboardAccess;
}

function getDashboardGuidanceLines(
  dashboardAccess: Array<{ label: string; url: string }> = [],
  options: {
    chatUiUrl?: string;
    wslHostAddress?: string | null;
    runCapture?: typeof runCapture;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    release?: string;
    isWsl?: boolean;
  } = {},
): string[] {
  const chatUiUrl =
    options.chatUiUrl || process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`;
  const chain = buildDashboardChain(chatUiUrl, options);
  const guidance = [`Port ${String(chain.port)} must be forwarded before opening these URLs.`];
  if (isWsl(options)) {
    guidance.push(
      "WSL detected: if localhost fails in Windows, use the WSL host IP shown by `hostname -I`.",
    );
  }
  if (dashboardAccess.length === 0) {
    guidance.push("No dashboard URLs were generated.");
  }
  return guidance;
}
/** Print the post-onboard dashboard with sandbox status and reconfiguration hints. */
function printDashboard(
  sandboxName: string,
  model: string,
  provider: string,
  nimContainer: string | null = null,
  agent: AgentDefinition | null = null,
): void {
  const nimStat = nimContainer ? nim.nimStatusByName(nimContainer) : nim.nimStatus(sandboxName);
  const showNim = nim.shouldShowNimLine(nimContainer, nimStat.running);
  const nimLabel = nimStat.running ? "running" : "not running";

  const providerLabel = getProviderLabel(provider);

  const token = fetchGatewayAuthTokenFromSandbox(sandboxName);
  const chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`;
  const wslAddr = getWslHostAddress();
  const chain = buildChain({ chatUiUrl, isWsl: isWsl(), wslHostAddress: wslAddr });

  // Build access info inline — uses chain instead of re-deriving from env
  const dashboardAccess = buildControlUiUrls(token, chain.port, chain.accessUrl).map((url, i) => ({
    label: i === 0 ? "Dashboard" : `Alt ${i}`,
    url,
  }));
  if (wslAddr) {
    const wslUrl = `http://${wslAddr}:${chain.port}/${token ? `#token=${encodeURIComponent(token)}` : ""}`;
    const existing = dashboardAccess.find((a) => a.url === wslUrl);
    if (existing) existing.label = "VS Code/WSL";
    else dashboardAccess.push({ label: "VS Code/WSL", url: wslUrl });
  }
  const guidanceLines = [`Port ${chain.port} must be forwarded before opening these URLs.`];
  if (isWsl())
    guidanceLines.push(
      "WSL detected: if localhost fails in Windows, use the WSL host IP shown by `hostname -I`.",
    );
  if (dashboardAccess.length === 0) guidanceLines.push("No dashboard URLs were generated.");

  console.log("");
  console.log(`  ${"─".repeat(50)}`);
  // console.log(`  Dashboard    http://localhost:${DASHBOARD_PORT}/`);
  console.log(`  Sandbox      ${sandboxName} (Landlock + seccomp + netns)`);
  console.log(`  Model        ${model} (${providerLabel})`);
  if (showNim) {
    console.log(`  NIM          ${nimLabel}`);
  }
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  Run:         ${cliName()} ${sandboxName} connect`);
  console.log(`  Status:      ${cliName()} ${sandboxName} status`);
  console.log(`  Logs:        ${cliName()} ${sandboxName} logs --follow`);
  console.log("");
  if (agent) {
    agentOnboard.printDashboardUi(sandboxName, token, agent, {
      note,
      buildControlUiUrls: (tokenValue: string | null, port: number) => {
        return buildControlUiUrls(tokenValue, port, chain.accessUrl);
      },
    });
  } else if (token) {
    console.log(
      `  ${agentProductName()} UI (auth token redacted from displayed URLs)`,
    );
    for (const line of guidanceLines) {
      console.log(`  ${line}`);
    }
    for (const entry of dashboardAccess) {
      console.log(`  ${entry.label}: ${dashboardUrlForDisplay(entry.url)}`);
    }
    console.log(`  Token:       ${cliName()} ${sandboxName} gateway-token --quiet`);
    console.log(`               append  #token=<token> locally if the browser asks for auth.`);
  } else {
    note("  Could not read gateway token from the sandbox (download failed).");
    console.log(`  ${agentProductName()} UI`);
    for (const line of guidanceLines) {
      console.log(`  ${line}`);
    }
    for (const entry of dashboardAccess) {
      console.log(`  ${entry.label}: ${dashboardUrlForDisplay(entry.url)}`);
    }
    console.log(
      `  Token:       ${cliName()} ${sandboxName} connect  →  jq -r '.gateway.auth.token' /sandbox/.openclaw/openclaw.json`,
    );
    console.log(`               append  #token=<token>  to the URL locally if needed.`);
  }
  console.log(`  ${"─".repeat(50)}`);
  console.log("");
  console.log("  To change settings later:");
  console.log(
    `    Model:       ${cliName()} inference set --model <model> --provider <provider> --sandbox ${sandboxName}`,
  );
  console.log(`    Policies:    ${cliName()} ${sandboxName} policy-add`);
  console.log(`    Credentials: ${cliName()} credentials reset <KEY>  then  ${cliName()} onboard`);
  console.log("");
}

// Preserve the nullable contract end-to-end: `null` means "clear this
// field on the persisted session", `undefined` means "leave unchanged".
function toNullableString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return value;
}

function toSessionUpdates(
  updates: {
    sandboxName?: string | null;
    provider?: string | null;
    model?: string | null;
    endpointUrl?: string | null;
    credentialEnv?: string | null;
    hermesAuthMethod?: HermesAuthMethod | string | null;
    preferredInferenceApi?: string | null;
    nimContainer?: string | null;
    webSearchConfig?: WebSearchConfig | null;
    policyPresets?: string[] | null;
    messagingChannels?: string[] | null;
    messagingChannelConfig?: MessagingChannelConfig | null;
  } = {},
): SessionUpdates {
  const normalized: SessionUpdates = {};
  if (updates.sandboxName !== undefined)
    normalized.sandboxName = toNullableString(updates.sandboxName);
  if (updates.provider !== undefined) normalized.provider = toNullableString(updates.provider);
  if (updates.model !== undefined) normalized.model = toNullableString(updates.model);
  if (updates.endpointUrl !== undefined)
    normalized.endpointUrl = toNullableString(updates.endpointUrl);
  if (updates.credentialEnv !== undefined)
    normalized.credentialEnv = toNullableString(updates.credentialEnv);
  if (updates.hermesAuthMethod !== undefined)
    normalized.hermesAuthMethod = normalizeHermesAuthMethod(updates.hermesAuthMethod);
  if (updates.preferredInferenceApi !== undefined) {
    normalized.preferredInferenceApi = toNullableString(updates.preferredInferenceApi);
  }
  if (updates.nimContainer !== undefined)
    normalized.nimContainer = toNullableString(updates.nimContainer);
  if (updates.webSearchConfig !== undefined) normalized.webSearchConfig = updates.webSearchConfig;
  if (updates.policyPresets) normalized.policyPresets = updates.policyPresets;
  if (updates.messagingChannels) normalized.messagingChannels = updates.messagingChannels;
  if (updates.messagingChannelConfig !== undefined) {
    normalized.messagingChannelConfig = updates.messagingChannelConfig;
  }
  return normalized;
}

function startRecordedStep(
  stepName: string,
  updates: {
    sandboxName?: string | null;
    provider?: string | null;
    model?: string | null;
    policyPresets?: string[] | null;
  } = {},
): void {
  onboardSession.markStepStarted(stepName);
  if (Object.keys(updates).length > 0) {
    onboardSession.updateSession((session: Session) => {
      if (updates.sandboxName !== undefined) session.sandboxName = updates.sandboxName;
      if (updates.provider !== undefined) session.provider = updates.provider;
      if (updates.model !== undefined) session.model = updates.model;
      if (updates.policyPresets) session.policyPresets = updates.policyPresets;
      return session;
    });
  }
}

const ONBOARD_STEP_INDEX: Record<string, { number: number; title: string }> = {
  preflight: { number: 1, title: "Preflight checks" },
  gateway: { number: 2, title: "Starting OpenShell gateway" },
  provider_selection: { number: 3, title: "Configuring inference (NIM)" },
  inference: { number: 4, title: "Setting up inference provider" },
  messaging: { number: 5, title: "Messaging channels" },
  sandbox: { number: 6, title: "Creating sandbox" },
  openclaw: { number: 7, title: "Setting up agent inside sandbox" },
  policies: { number: 8, title: "Policy presets" },
};

function skippedStepMessage(
  stepName: string,
  detail?: string | null,
  reason: "resume" | "reuse" = "resume",
): void {
  let stepInfo = ONBOARD_STEP_INDEX[stepName];
  if (stepInfo && stepName === "openclaw") {
    stepInfo = { ...stepInfo, title: `Setting up ${agentProductName()} inside sandbox` };
  }
  if (stepInfo) {
    step(stepInfo.number, 8, stepInfo.title);
  }
  const prefix = reason === "reuse" ? "[reuse]" : "[resume]";
  console.log(`  ${prefix} Skipping ${stepName}${detail ? ` (${detail})` : ""}`);
}

// ── Main ─────────────────────────────────────────────────────────

async function onboard(opts: OnboardOptions = {}): Promise<void> {
  setOnboardBrandingAgent(opts.agent || process.env.NEMOCLAW_AGENT || null);
  NON_INTERACTIVE = opts.nonInteractive || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
  RECREATE_SANDBOX = opts.recreateSandbox || process.env.NEMOCLAW_RECREATE_SANDBOX === "1";
  AUTO_YES = opts.autoYes === true || process.env.NEMOCLAW_YES === "1";
  _preflightDashboardPort = opts.controlUiPort || null;
  delete process.env.OPENSHELL_GATEWAY;
  const resume = opts.resume === true;
  const fresh = opts.fresh === true;
  if (resume && fresh) {
    console.error("  --resume and --fresh cannot both be set.");
    process.exit(1);
  }
  // In non-interactive mode also accept the env var so CI pipelines can set it.
  // This is the explicitly requested value; on resume it may be absent and the
  // session-recorded path is used instead (see below).
  const requestedFromDockerfile =
    opts.fromDockerfile ||
    (isNonInteractive() ? process.env.NEMOCLAW_FROM_DOCKERFILE || null : null);
  // Resolve the explicit sandbox name early so both validation and the
  // --from guard work off the same source. --name always counts; the env
  // var is used as the interactive prompt default via getSandboxPromptDefault,
  // and also as the resolved name when we cannot prompt (non-interactive or
  // missing-TTY runs such as CI scripts and piped stdin).
  const stdinIsTty = Boolean(process.stdin && process.stdin.isTTY);
  const stdoutIsTty = Boolean(process.stdout && process.stdout.isTTY);
  const cannotPrompt = isNonInteractive() || !stdinIsTty || !stdoutIsTty;
  let requestedSandboxName: string | null =
    typeof opts.sandboxName === "string" && opts.sandboxName.length > 0 ? opts.sandboxName : null;
  let requestedSandboxSource: "--name" | "NEMOCLAW_SANDBOX_NAME" | null = requestedSandboxName
    ? "--name"
    : null;
  if (!requestedSandboxName && cannotPrompt) {
    const envName = process.env.NEMOCLAW_SANDBOX_NAME;
    if (typeof envName === "string" && envName.trim().length > 0) {
      requestedSandboxName = envName.trim();
      requestedSandboxSource = "NEMOCLAW_SANDBOX_NAME";
    }
  }
  if (requestedSandboxName) {
    try {
      const validated = validateName(requestedSandboxName, "sandbox name");
      if (RESERVED_SANDBOX_NAMES.has(validated)) {
        console.error(`  Reserved name: '${validated}' is a ${cliDisplayName()} CLI command.`);
        console.error(
          `  Choose a different sandbox name (passed via ${requestedSandboxSource}) to avoid routing conflicts.`,
        );
        process.exit(1);
      }
      requestedSandboxName = validated;
    } catch (error) {
      console.error(`  ${error instanceof Error ? error.message : String(error)}`);
      for (const line of getNameValidationGuidance("sandbox name", requestedSandboxName, {
        includeAllowedFormat: false,
      })) {
        console.error(`  ${line}`);
      }
      process.exit(1);
    }
  }
  // The downstream prompt path silently defaults to 'my-assistant' when no
  // input arrives. With --from in play that would clobber the default
  // sandbox, so refuse to proceed unless the caller has supplied a name
  // out-of-band. Cover both --non-interactive and missing-TTY runs (CI
  // scripts, piped stdin) — the issue's test plan asks for both. The resume
  // case is handled separately after session load (see below) because its
  // recorded sandboxName may already satisfy the requirement.
  if (cannotPrompt && !resume && requestedFromDockerfile && !requestedSandboxName) {
    console.error(
      "  --from <Dockerfile> requires --name <sandbox> (or NEMOCLAW_SANDBOX_NAME) when running without a TTY or with --non-interactive.",
    );
    console.error("  A sandbox name cannot be prompted for in this context.");
    process.exit(1);
  }
  const noticeAccepted = await ensureUsageNoticeConsent({
    nonInteractive: isNonInteractive(),
    acceptedByFlag: opts.acceptThirdPartySoftware === true,
    writeLine: console.error,
  });
  if (!noticeAccepted) {
    process.exit(1);
  }
  // Validate NEMOCLAW_PROVIDER early so invalid values fail before
  // preflight (Docker/OpenShell checks). Without this, users see a
  // misleading 'Docker is not reachable' error instead of the real
  // problem: an unsupported provider value.
  getRequestedProviderHint();
  const lockResult = onboardSession.acquireOnboardLock(
    `nemoclaw onboard${resume ? " --resume" : ""}${fresh ? " --fresh" : ""}${isNonInteractive() ? " --non-interactive" : ""}${requestedFromDockerfile ? ` --from ${requestedFromDockerfile}` : ""}`,
  );
  if (!lockResult.acquired) {
    console.error(`  Another ${cliDisplayName()} onboarding run is already in progress.`);
    if (lockResult.holderPid) {
      console.error(`  Lock holder PID: ${lockResult.holderPid}`);
    }
    if (lockResult.holderStartedAt) {
      console.error(`  Started: ${lockResult.holderStartedAt}`);
    }
    console.error("  Wait for it to finish, or remove the stale lock if the previous run crashed:");
    console.error(`    rm -f "${lockResult.lockFile}"`);
    process.exit(1);
  }

  // Stage any pre-fix plaintext credentials.json into process.env so the
  // provider upserts later in this run can pick the values up. The file is
  // NOT removed here — the secure unlink runs only after onboarding
  // completes successfully and only when every staged value was actually
  // pushed to the gateway in this run.
  stagedLegacyValues.clear();
  migratedLegacyKeys.clear();

  const stagedLegacyKeys = stageLegacyCredentialsToEnv();
  for (const key of stagedLegacyKeys) {
    const value = process.env[key];
    if (value) stagedLegacyValues.set(key, value);
  }

  // Only carry forward migration state across processes when the user is
  // explicitly continuing the same attempt via `--resume`. Even then,
  // validate each persisted entry against the *current* staged value: if
  // the legacy file was edited between runs (so the staged secret no
  // longer matches what the gateway holds), the hash mismatch drops that
  // key from migratedLegacyKeys and the cleanup gate forces a fresh
  // upsert before the file can be removed. A fresh / non-resume run
  // ignores prior persisted state entirely so a stale or unrelated
  // session record cannot satisfy the cleanup gate.
  if (resume) {
    const previousSession = onboardSession.loadSession();
    const persistedHashes = previousSession?.migratedLegacyValueHashes ?? {};
    for (const [key, hash] of Object.entries(persistedHashes)) {
      if (typeof key !== "string" || typeof hash !== "string") continue;
      const currentValue = stagedLegacyValues.get(key);
      if (currentValue === undefined) continue;
      if (legacyValueHash(currentValue) !== hash) continue;
      migratedLegacyKeys.add(key);
    }
  }

  if (stagedLegacyKeys.length > 0) {
    console.error(
      `  Staged ${String(stagedLegacyKeys.length)} legacy credential(s) for migration to the OpenShell gateway.`,
    );
  }

  let lockReleased = false;
  const releaseOnboardLock = () => {
    if (lockReleased) return;
    lockReleased = true;
    onboardSession.releaseOnboardLock();
  };
  process.once("exit", releaseOnboardLock);

  try {
    let session: Session | null;
    let selectedMessagingChannels: string[] = [];
    // Merged, absolute fromDockerfile: explicit flag/env takes precedence; on
    // resume falls back to what the original session recorded so the same image
    // is used even when --from is omitted from the resume invocation.
    let fromDockerfile: string | null;
    if (resume) {
      session = onboardSession.loadSession();
      setOnboardBrandingAgent(opts.agent || session?.agent || process.env.NEMOCLAW_AGENT || null);
      if (!session || session.resumable === false) {
        console.error("  No resumable onboarding session was found.");
        console.error("  --resume only continues an interrupted onboarding run.");
        console.error("  To change configuration on an existing sandbox, rebuild it:");
        console.error(`    ${cliName()} onboard`);
        process.exit(1);
      }
      const sessionFrom = session?.metadata?.fromDockerfile || null;
      fromDockerfile = requestedFromDockerfile
        ? path.resolve(requestedFromDockerfile)
        : sessionFrom
          ? path.resolve(sessionFrom)
          : null;
      const resumeConflicts = getResumeConfigConflicts(session, {
        nonInteractive: isNonInteractive(),
        fromDockerfile: requestedFromDockerfile,
        sandboxName: requestedSandboxName,
        agent: opts.agent || null,
      });
      if (resumeConflicts.length > 0) {
        for (const conflict of resumeConflicts) {
          if (conflict.field === "sandbox") {
            console.error(
              `  Resumable state belongs to sandbox '${conflict.recorded}', not '${conflict.requested}'.`,
            );
          } else if (conflict.field === "agent") {
            console.error(
              `  Session was started with agent '${conflict.recorded}', not '${conflict.requested}'.`,
            );
          } else if (conflict.field === "fromDockerfile") {
            if (!conflict.recorded) {
              console.error(
                `  Session was started without --from; add --from '${conflict.requested}' to resume it.`,
              );
            } else if (!conflict.requested) {
              console.error(
                `  Session was started with --from '${conflict.recorded}'; rerun with that path to resume it.`,
              );
            } else {
              console.error(
                `  Session was started with --from '${conflict.recorded}', not '${conflict.requested}'.`,
              );
            }
          } else {
            console.error(
              `  Resumable state recorded ${conflict.field} '${conflict.recorded}', not '${conflict.requested}'.`,
            );
          }
        }
        console.error(
          `  Run: ${cliName()} onboard              # start a fresh onboarding session`,
        );
        console.error("  Or rerun with the original settings to continue that session.");
        process.exit(1);
      }
      onboardSession.updateSession((current: Session) => {
        current.mode = isNonInteractive() ? "non-interactive" : "interactive";
        current.failure = null;
        current.status = "in_progress";
        return current;
      });
      session = onboardSession.loadSession();
      // #2753: a resumed onboard whose sandbox step did not complete has no
      // recorded sandboxName (the onboard fix only persists it after
      // createSandbox succeeds). Falling through would silently default to
      // the agent's `my-assistant` instead of the user's original --name.
      // Use `cannotPrompt` so non-TTY runs without explicit --non-interactive
      // are also caught, and `requestedSandboxName` (already env-var-resolved
      // and trimmed above, lines 8302-8308) so whitespace-only env values
      // can't satisfy the guard.
      const sandboxStepCompleted = session?.steps?.sandbox?.status === "complete";
      const recoveredSandboxName =
        requestedSandboxName || (sandboxStepCompleted ? session?.sandboxName || null : null);
      if (cannotPrompt && !recoveredSandboxName) {
        console.error(
          "  Cannot resume non-interactive onboard: the previous run was interrupted before sandbox creation completed,",
        );
        console.error(
          "  so no sandbox name was recorded. Re-run with --name <sandbox> (or set NEMOCLAW_SANDBOX_NAME).",
        );
        process.exit(1);
      }
    } else {
      // --fresh asks for an explicit fresh start. createSession + saveSession
      // already overwrites any existing file, but clearing first removes the
      // old file outright so an interrupted createSession cannot leave the
      // previous session readable on disk.
      if (fresh) {
        onboardSession.clearSession();
      }
      fromDockerfile = requestedFromDockerfile ? path.resolve(requestedFromDockerfile) : null;
      session = onboardSession.saveSession(
        onboardSession.createSession({
          mode: isNonInteractive() ? "non-interactive" : "interactive",
          metadata: { gatewayName: "nemoclaw", fromDockerfile: fromDockerfile || null },
        }),
      );
    }

    // Backstop for the resume path: a session may exist (so the early guard
    // skipped because resume === true) but never have recorded a sandboxName
    // — sandbox creation could have failed before that step ran. Without a
    // --name or env-var seed, the downstream prompt path would fall back to
    // 'my-assistant' under no TTY, exactly the silent-default the early
    // guard is meant to prevent.
    if (
      resume &&
      cannotPrompt &&
      fromDockerfile &&
      !requestedSandboxName &&
      !session?.sandboxName
    ) {
      console.error(
        "  --from <Dockerfile> requires --name <sandbox> (or NEMOCLAW_SANDBOX_NAME) when running without a TTY or with --non-interactive.",
      );
      console.error(
        "  The resumed session has no recorded sandbox name, so one cannot be inferred.",
      );
      process.exit(1);
    }

    let completed = false;
    process.once("exit", (code) => {
      if (!completed && code !== 0) {
        const current = onboardSession.loadSession();
        const failedStep = current?.lastStepStarted;
        if (failedStep) {
          onboardSession.markStepFailed(failedStep, "Onboarding exited before the step completed.");
        }
      }
    });

    const agent = await selectOnboardAgent({
      agentFlag: opts.agent,
      session,
      resume,
      canPrompt: !cannotPrompt,
    });
    setOnboardBrandingAgent(agent?.name || "openclaw");
    onboardSession.updateSession((s: Session) => {
      s.agent = agent?.name ?? null;
      return s;
    });

    const recordedSandboxName =
      session?.steps?.sandbox?.status === "complete" ? session?.sandboxName || null : null;
    const resumeSandboxNameForGpu = recordedSandboxName || requestedSandboxName || null;

    console.log("");
    console.log(`  ${cliDisplayName()} Onboarding`);
    if (isNonInteractive()) note("  (non-interactive mode)");
    if (resume) note("  (resume mode)");
    console.log("  ===================");

    const explicitSandboxGpuFlag = resolveSandboxGpuFlagFromOptions(opts);
    const resumePreflight = resume && session?.steps?.preflight?.status === "complete";
    const resumeHasResolvedGpuIntent =
      resumePreflight &&
      explicitSandboxGpuFlag === null &&
      opts.sandboxGpuDevice == null &&
      process.env.NEMOCLAW_SANDBOX_GPU === undefined &&
      process.env.NEMOCLAW_SANDBOX_GPU_DEVICE === undefined;
    const resumedSandboxGpuOverrides = resumeHasResolvedGpuIntent
      ? getResumeSandboxGpuOverrides(
          resumeSandboxNameForGpu ? registry.getSandbox(resumeSandboxNameForGpu) : null,
          session?.gpuPassthrough,
        )
      : { flag: null, device: null };
    const effectiveSandboxGpuFlag = explicitSandboxGpuFlag ?? resumedSandboxGpuOverrides.flag;
    const effectiveSandboxGpuDevice = opts.sandboxGpuDevice ?? resumedSandboxGpuOverrides.device;
    let gpu;
    if (resumePreflight) {
      skippedStepMessage("preflight", "cached");
      gpu = nim.detectGpu();
      // Re-check the CDI spec gap on resume (#3152). The cached preflight
      // result does not capture host CDI state, and the original onboard
      // attempt that wrote the cache likely aborted at gateway-start with
      // exactly this CDI failure — so resuming without re-checking would
      // walk into the same wall. Honour persisted `gpuPassthrough: false`
      // from the prior session as an opt-out, since the resume invocation
      // does not need to re-pass `--no-gpu` to keep that intent (the same
      // resolution is replayed a few lines below for `gpuPassthrough`).
      const resumeOptedOutGpuPassthrough =
        opts.noGpu === true || (opts.gpu !== true && session?.gpuPassthrough === false);
      assertCdiNvidiaGpuSpecPresent(assessHost(), resumeOptedOutGpuPassthrough);
      validateSandboxGpuPreflight(
        resolveSandboxGpuConfig(gpu, {
          flag: effectiveSandboxGpuFlag,
          device: effectiveSandboxGpuDevice,
        }),
      );
    } else {
      startRecordedStep("preflight");
      gpu = await preflight({ ...opts, optedOutGpuPassthrough: opts.noGpu === true });
      onboardSession.markStepComplete("preflight");
    }
    const sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
      flag: effectiveSandboxGpuFlag,
      device: effectiveSandboxGpuDevice,
    });

    const requestedGpuPassthrough = opts.gpu === true;
    const gpuPassthrough = sandboxGpuConfig.sandboxGpuEnabled;
    if (gpuPassthrough) {
      note(
        resumeHasResolvedGpuIntent && session?.gpuPassthrough === true
          ? "  [resume] Continuing GPU passthrough from the saved onboarding session."
          : requestedGpuPassthrough || sandboxGpuConfig.mode === "1"
            ? "  GPU passthrough requested; passing --gpu to OpenShell gateway and sandbox creation."
            : "  NVIDIA GPU detected; enabling OpenShell GPU passthrough. Use --no-gpu to opt out.",
      );
    } else if (process.platform === "linux") {
      // Hint when hardware is present but drivers are missing.
      try {
        const lspci = spawnSync("lspci", { encoding: "utf-8", timeout: 5000 });
        if (lspci.status === 0 && /nvidia/i.test(lspci.stdout || "")) {
          note("  NVIDIA GPU hardware detected but nvidia-smi is not available.");
          note("  Install NVIDIA drivers and the Container Toolkit for default GPU passthrough.");
        }
      } catch {
        /* lspci not available — skip hint */
      }
    }
    // Persist GPU intent in the session so resume can restore it.
    if (session && session.gpuPassthrough !== gpuPassthrough) {
      session = onboardSession.updateSession((current: Session) => {
        current.gpuPassthrough = gpuPassthrough;
        return current;
      });
    }

    const gatewaySnapshot = selectNamedGatewayForReuseIfNeeded(getGatewayReuseSnapshot());
    let gatewayReuseState = gatewaySnapshot.gatewayReuseState;
    gatewayReuseState = await refreshDockerDriverGatewayReuseState(gatewayReuseState);

    // Verify the gateway container is actually running — openshell CLI metadata
    // can be stale after a manual `docker rm`. See #2020.
    if (gatewayReuseState === "healthy" && !isLinuxDockerDriverGatewayEnabled()) {
      const containerState = verifyGatewayContainerRunning();
      if (containerState === "missing") {
        console.log("  Gateway metadata is stale (container not running). Cleaning up...");
        runOpenshell(["forward", "stop", String(DASHBOARD_PORT)], { ignoreError: true });
        destroyGateway();
        registry.clearAll();
        gatewayReuseState = "missing";
        console.log("  ✓ Stale gateway metadata cleaned up");
      } else if (containerState === "unknown") {
        // Docker probe failed but cached metadata says healthy. Try the host-level
        // HTTP probe — it doesn't depend on Docker, so it can confirm the gateway
        // is genuinely serving even when the daemon is flaky.
        if (await waitForGatewayHttpReady()) {
          console.log(
            "  Warning: could not verify gateway container state (Docker may be unavailable), but the gateway is responding on HTTP. Proceeding with reuse.",
          );
        } else {
          // Docker can't be probed AND the gateway HTTP endpoint isn't
          // responding. We cannot tell whether the existing gateway is live
          // (transient `docker inspect` flake + warm-up miss) or genuinely
          // gone. Per #2020 we must not destroy in this branch, and we must
          // not downgrade to "missing" either: that would push execution into
          // `startGatewayWithOptions`, whose retry hook calls
          // `destroyGateway()` between attempts — which would tear down a
          // possibly-live gateway. Bail with an actionable error instead.
          console.log(
            `  Error: could not verify gateway container state and http://127.0.0.1:${GATEWAY_PORT}/ is not responding.`,
          );
          console.log(
            "  Refusing to proceed without a clear Docker signal — restarting Docker and re-running onboard is the safe path. See #3258 / #2020.",
          );
          process.exit(1);
        }
      } else if (!(await waitForGatewayHttpReady())) {
        // Container is running but the gateway HTTP endpoint is not responding.
        // Common immediately after a Docker daemon restart — the container comes
        // back before the OpenShell gateway upstream finishes warming up. Safe to
        // recreate because Docker is functional. See #3258.
        console.log(
          `  Gateway container is running but http://127.0.0.1:${GATEWAY_PORT}/ is not responding. Recreating...`,
        );
        runOpenshell(["forward", "stop", String(DASHBOARD_PORT)], { ignoreError: true });
        destroyGateway();
        registry.clearAll();
        gatewayReuseState = "missing";
        console.log("  ✓ Stale gateway cleaned up");
      } else {
        const imageDrift = getGatewayClusterImageDrift();
        if (imageDrift) {
          console.log(
            `  Gateway image ${imageDrift.currentVersion} does not match openshell ${imageDrift.expectedVersion}. Recreating...`,
          );
          stopAllDashboardForwards();
          destroyGateway();
          registry.clearAll();
          gatewayReuseState = "missing";
          console.log("  ✓ Previous gateway cleaned up");
        }
      }
    }

    const canReuseHealthyGateway = gatewayReuseState === "healthy";

    // Verify the reusable gateway has GPU passthrough when needed. Runs for
    // both fresh-reuse and resume paths so a gateway recreated without GPU
    // between runs is caught.
    if (canReuseHealthyGateway && gpuPassthrough) {
      const container = `openshell-cluster-${GATEWAY_NAME}`;
      const gpuCheck = docker.dockerInspect(
        ["--type", "container", "--format", "{{json .HostConfig.DeviceRequests}}", container],
        { ignoreError: true, suppressOutput: true },
      );
      const gpuOutput = String(gpuCheck.stdout || "").trim();
      const gatewayHasGpu = gpuCheck.status === 0 && gpuOutput !== "null" && gpuOutput !== "[]";
      if (!gatewayHasGpu) {
        console.error("  Existing gateway was started without GPU passthrough.");
        console.error("  To enable GPU, destroy the existing sandbox and gateway, then re-onboard:");
        console.error(`    nemoclaw <name> destroy --yes && nemoclaw onboard --gpu`);
        process.exit(1);
      }
    }

    const resumeGateway =
      resume && session?.steps?.gateway?.status === "complete" && canReuseHealthyGateway;
    if (resumeGateway) {
      skippedStepMessage("gateway", "running");
      onboardSession.markStepComplete("gateway");
    } else if (!resume && canReuseHealthyGateway) {
      skippedStepMessage("gateway", "running", "reuse");
      note("  Reusing healthy NemoClaw gateway.");
      onboardSession.markStepComplete("gateway");
    } else {
      if (resume && session?.steps?.gateway?.status === "complete") {
        if (gatewayReuseState === "active-unnamed") {
          note("  [resume] Gateway is active but named metadata is missing; recreating it safely.");
        } else if (gatewayReuseState === "foreign-active") {
          note("  [resume] A different OpenShell gateway is active; NemoClaw will not reuse it.");
        } else if (gatewayReuseState === "stale") {
          note("  [resume] Recorded gateway is unhealthy; recreating it.");
        } else {
          note("  [resume] Recorded gateway state is unavailable; recreating it.");
        }
      }
      if (isLinuxDockerDriverGatewayEnabled() && gatewayReuseState !== "missing") {
        note("  Replacing legacy OpenShell gateway metadata with Docker-driver gateway.");
        runOpenshell(["forward", "stop", String(DASHBOARD_PORT)], { ignoreError: true });
        destroyGateway();
        registry.clearAll();
      }
      startRecordedStep("gateway");
      await startGateway(gpu, { gpuPassthrough });
      onboardSession.markStepComplete("gateway");
    }

    // #2753: prefer requestedSandboxName over an unconfirmed session name.
    // A pre-fix session may carry sandboxName even though sandbox creation
    // never completed; users supplying `--name` / NEMOCLAW_SANDBOX_NAME on
    // the resume run must win, otherwise the stale name silently overrides
    // their explicit recovery input.
    let sandboxName = recordedSandboxName || requestedSandboxName || null;
    if (sandboxName && RESERVED_SANDBOX_NAMES.has(sandboxName)) {
      console.error(
        `  Reserved name in resumed session: '${sandboxName}' is a ${cliDisplayName()} CLI command.`,
      );
      console.error("  Start a fresh onboard with --name <sandbox> to choose a different name.");
      process.exit(1);
    }
    let model = session?.model || null;
    let provider = session?.provider || null;
    let endpointUrl = session?.endpointUrl || null;
    let credentialEnv = session?.credentialEnv || null;
    let hermesAuthMethod: HermesAuthMethod | null =
      normalizeHermesAuthMethod(session?.hermesAuthMethod) ||
      (provider === hermesProviderAuth.HERMES_PROVIDER_NAME &&
      session?.credentialEnv === HERMES_NOUS_API_KEY_CREDENTIAL_ENV
        ? HERMES_AUTH_METHOD_API_KEY
        : null);
    let preferredInferenceApi = session?.preferredInferenceApi || null;
    let nimContainer = session?.nimContainer || null;
    let webSearchConfig = session?.webSearchConfig || null;
    let forceProviderSelection = false;
    while (true) {
      const resumeProviderSelection =
        !forceProviderSelection &&
        resume &&
        session?.steps?.provider_selection?.status === "complete" &&
        typeof provider === "string" &&
        typeof model === "string";
      if (resumeProviderSelection) {
        skippedStepMessage("provider_selection", `${provider} / ${model}`);
        hydrateCredentialEnv(credentialEnv);
      } else {
        // #2753: do not persist sandboxName to onboard-session.json before
        // the sandbox actually exists in the gateway (Step 6 markStepComplete
        // below). A SIGINT between any earlier step and createSandbox would
        // otherwise leave a phantom that `nemoclaw list` resurrects until
        // manually destroyed.
        startRecordedStep("provider_selection");
        const selection = await setupNim(gpu, sandboxName, agent);
        model = selection.model;
        provider = selection.provider;
        endpointUrl = selection.endpointUrl;
        credentialEnv = selection.credentialEnv;
        hermesAuthMethod = selection.hermesAuthMethod;
        preferredInferenceApi = selection.preferredInferenceApi;
        nimContainer = selection.nimContainer;
        onboardSession.markStepComplete(
          "provider_selection",
          toSessionUpdates({
            provider,
            model,
            endpointUrl,
            credentialEnv,
            hermesAuthMethod,
            preferredInferenceApi,
            nimContainer,
          }),
        );
      }

      if (typeof provider !== "string" || typeof model !== "string") {
        console.error("  Inference selection did not yield a provider/model.");
        process.exit(1);
      }
      process.env.NEMOCLAW_OPENSHELL_BIN = getOpenshellBinary();
      const resumeInference =
        !forceProviderSelection && resume && isInferenceRouteReady(provider, model);
      if (resumeInference) {
        if (provider === hermesProviderAuth.HERMES_PROVIDER_NAME) {
          startRecordedStep("inference", { provider, model });
          const inferenceResult = await setupInference(
            sandboxName,
            model,
            provider,
            endpointUrl,
            credentialEnv,
            hermesAuthMethod,
          );
          if (inferenceResult?.retry === "selection") {
            forceProviderSelection = true;
            continue;
          }
          onboardSession.markStepComplete(
            "inference",
            toSessionUpdates({ provider, model, hermesAuthMethod, nimContainer }),
          );
          break;
        }
        if (isRoutedInferenceProvider(provider)) {
          try {
            await reconcileModelRouter();
          } catch (err) {
            console.error(
              `  ✗ Failed to reconcile model router: ${err instanceof Error ? err.message : String(err)}`,
            );
            process.exit(1);
          }
        }
        skippedStepMessage("inference", `${provider} / ${model}`);
        if (nimContainer && sandboxName) {
          registry.updateSandbox(sandboxName, { nimContainer });
        }
        onboardSession.markStepComplete(
          "inference",
          toSessionUpdates({ provider, model, hermesAuthMethod, nimContainer }),
        );
        break;
      }

      // Prompt for the sandbox name and show the review gate BEFORE
      // setupInference runs upsertProvider / `inference set` on the gateway.
      // On retry (inferenceResult.retry === "selection") the user is re-prompted
      // for provider/model above and sees this gate again with the new config.
      // See #2221 (CodeRabbit).
      if (!sandboxName) {
        sandboxName = await promptValidatedSandboxName(agent);
      }
      const buildEstimateNote =
        process.env.NEMOCLAW_IGNORE_RUNTIME_RESOURCES === "1"
          ? null
          : formatSandboxBuildEstimateNote(assessHost());
      console.log(
        formatOnboardConfigSummary({
          provider,
          model,
          credentialEnv,
          hermesAuthMethod,
          webSearchConfig,
          enabledChannels: selectedMessagingChannels.length > 0 ? selectedMessagingChannels : null,
          sandboxName,
          notes: buildEstimateNote ? [buildEstimateNote] : [],
        }),
      );
      console.log("  Web search and messaging channels will be prompted next.");
      if (!isNonInteractive()) {
        if (!(await promptYesNoOrDefault("  Apply this configuration?", null, true))) {
          console.log(`  Aborted. Re-run \`${cliName()} onboard\` to start over.`);
          console.log("  Credentials entered so far were only staged in memory for this run.");
          console.log(
            "  No new gateway credential was registered because onboarding stopped here.",
          );
          process.exit(0);
        }
      }

      startRecordedStep("inference", { provider, model });
      const inferenceResult = await setupInference(
        sandboxName,
        model,
        provider,
        endpointUrl,
        credentialEnv,
        hermesAuthMethod,
      );
      delete process.env.NVIDIA_API_KEY;
      if (inferenceResult?.retry === "selection") {
        forceProviderSelection = true;
        continue;
      }
      if (nimContainer && sandboxName) {
        registry.updateSandbox(sandboxName, { nimContainer });
      }
      onboardSession.markStepComplete(
        "inference",
        toSessionUpdates({ provider, model, hermesAuthMethod, nimContainer }),
      );
      break;
    }

    const webSearchSupportProbePath = fromDockerfile ? path.resolve(fromDockerfile) : null;
    const webSearchSupported = agentSupportsWebSearch(agent, webSearchSupportProbePath);
    if (webSearchConfig && !webSearchSupported) {
      note(
        `  Web search is not yet supported by ${agent?.displayName ?? "this sandbox image"}. Clearing stale config.`,
      );
      webSearchConfig = null;
      if (session) {
        session.webSearchConfig = null;
      }
      onboardSession.updateSession((current: Session) => {
        current.webSearchConfig = null;
        return current;
      });
    }

    const storedMessagingChannelConfig = getStoredMessagingChannelConfig(sandboxName, session);
    const effectiveMessagingChannelConfig = hydrateMessagingChannelConfig(storedMessagingChannelConfig);
    const messagingChannelConfigChanged = !messagingChannelConfigsEqual(
      effectiveMessagingChannelConfig,
      storedMessagingChannelConfig,
    );
    if (effectiveMessagingChannelConfig) {
      persistMessagingChannelConfigToSession(effectiveMessagingChannelConfig);
      if (session) {
        session.messagingChannelConfig = effectiveMessagingChannelConfig;
      }
    }

    const sandboxReuseState = getSandboxReuseState(sandboxName);
    const webSearchConfigChanged = Boolean(session?.webSearchConfig) !== Boolean(webSearchConfig);
    // Telegram mention-mode is baked into openclaw.json at sandbox build time, so
    // changes to TELEGRAM_REQUIRE_MENTION only take effect after a rebuild. Treat
    // a mismatch between the recorded config and the current env value as drift
    // so the reuse path forces a recreate (mirrors webSearchConfigChanged). See
    // #1737 and the CodeRabbit review on #2417.
    //
    // Compare *effective* modes — null and false both produce groupPolicy: open
    // at config-generation time (default behavior), so they collapse to the same
    // bucket here. Without this, a sandbox built before TELEGRAM_REQUIRE_MENTION
    // existed (recordedTelegramRequireMention === null) would be reused with the
    // old groupPolicy: open even after the user sets TELEGRAM_REQUIRE_MENTION=1,
    // and vice versa.
    const currentTelegramRequireMention = computeTelegramRequireMention();
    const recordedTelegramRequireMention = session?.telegramConfig?.requireMention ?? null;
    const effectiveCurrent = currentTelegramRequireMention ?? false;
    const effectiveRecorded = recordedTelegramRequireMention ?? false;
    const telegramConfigChanged = effectiveCurrent !== effectiveRecorded;
    const sandboxGpuConfigChanged = sandboxName
      ? hasSandboxGpuDrift(sandboxName, sandboxGpuConfig)
      : false;
    const resumeSandbox =
      resume &&
      !webSearchConfigChanged &&
      !telegramConfigChanged &&
      !sandboxGpuConfigChanged &&
      !messagingChannelConfigChanged &&
      session?.steps?.sandbox?.status === "complete" &&
      sandboxReuseState === "ready";
    if (resumeSandbox) {
      if (webSearchConfig) {
        note("  [resume] Reusing Brave Search configuration already baked into the sandbox.");
      }
      selectedMessagingChannels = session?.messagingChannels ?? [];
      skippedStepMessage("sandbox", sandboxName);
    } else {
      if (resume && session?.steps?.sandbox?.status === "complete") {
        if (webSearchConfigChanged) {
          note("  [resume] Web Search configuration changed; recreating sandbox.");
          if (sandboxName) {
            registry.removeSandbox(sandboxName);
          }
        } else if (telegramConfigChanged) {
          note("  [resume] TELEGRAM_REQUIRE_MENTION changed; recreating sandbox.");
          if (sandboxName) {
            registry.removeSandbox(sandboxName);
          }
        } else if (sandboxGpuConfigChanged) {
          note("  [resume] Sandbox GPU settings changed; recreating sandbox.");
          if (sandboxName) {
            registry.removeSandbox(sandboxName);
          }
        } else if (messagingChannelConfigChanged) {
          note("  [resume] Messaging channel configuration changed; recreating sandbox.");
          if (sandboxName) {
            registry.removeSandbox(sandboxName);
          }
        } else if (sandboxReuseState === "not_ready") {
          note(
            `  [resume] Recorded sandbox '${sandboxName}' exists but is not ready; recreating it.`,
          );
          repairRecordedSandbox(sandboxName);
        } else {
          note("  [resume] Recorded sandbox state is unavailable; recreating it.");
          if (sandboxName) {
            registry.removeSandbox(sandboxName);
          }
        }
      }
      let nextWebSearchConfig = webSearchConfig;
      if (nextWebSearchConfig) {
        note("  [resume] Revalidating Brave Search configuration for sandbox recreation.");
        const braveApiKey = await ensureValidatedBraveSearchCredential();
        nextWebSearchConfig = braveApiKey ? { fetchEnabled: true } : null;
        if (nextWebSearchConfig) {
          note("  [resume] Reusing Brave Search configuration.");
        }
      } else {
        nextWebSearchConfig = await configureWebSearch(null, agent, webSearchSupportProbePath);
      }
      startRecordedStep("sandbox", { provider, model });
      const recordedMessagingChannels = getRecordedMessagingChannelsForResume(resume, session);
      if (recordedMessagingChannels) {
        selectedMessagingChannels = recordedMessagingChannels;
        if (selectedMessagingChannels.length > 0) {
          note(
            `  [resume] Reusing messaging channel configuration: ${selectedMessagingChannels.join(", ")}`,
          );
        }
      } else {
        selectedMessagingChannels = await setupMessagingChannels();
      }
      const messagingChannelConfig = readMessagingChannelConfigFromEnv();
      onboardSession.updateSession((current: Session) => {
        current.messagingChannels = selectedMessagingChannels;
        current.messagingChannelConfig = messagingChannelConfig;
        return current;
      });
      if (typeof model !== "string" || typeof provider !== "string") {
        console.error("  Inference selection is incomplete; cannot create sandbox.");
        process.exit(1);
      }
      sandboxName = await createSandbox(
        gpu,
        model,
        provider,
        preferredInferenceApi,
        sandboxName,
        nextWebSearchConfig,
        selectedMessagingChannels,
        fromDockerfile,
        agent,
        opts.controlUiPort || null,
        sandboxGpuConfig,
      );
      webSearchConfig = nextWebSearchConfig;
      // Persist model and provider after the sandbox entry exists in the registry.
      // updateSandbox() silently no-ops when the entry is missing, so this must
      // run after createSandbox() / registerSandbox() — not before. Fixes #1881.
      registry.updateSandbox(sandboxName, {
        model,
        provider,
        ...getSandboxAgentRegistryFields(agent, !fromDockerfile),
      });
      registry.setDefault(sandboxName);
      onboardSession.markStepComplete(
        "sandbox",
        toSessionUpdates({
          sandboxName,
          provider,
          model,
          nimContainer,
          webSearchConfig,
          messagingChannelConfig,
        }),
      );
    }

    if (
      typeof sandboxName !== "string" ||
      typeof provider !== "string" ||
      typeof model !== "string"
    ) {
      console.error("  Onboarding state is incomplete after sandbox setup.");
      process.exit(1);
    }

    if (agent) {
      await agentOnboard.handleAgentSetup(sandboxName, model, provider, agent, resume, session, {
        step,
        runCaptureOpenshell,
        openshellShellCommand,
        openshellBinary: getOpenshellBinary(),
        buildSandboxConfigSyncScript,
        writeSandboxConfigSyncFile,
        cleanupTempDir,
        startRecordedStep,
        skippedStepMessage,
      });
      ensureAgentDashboardForward(sandboxName, agent);
      onboardSession.markStepSkipped("openclaw");
    } else {
      const resumeOpenclaw = resume && sandboxName && isOpenclawReady(sandboxName);
      if (resumeOpenclaw) {
        skippedStepMessage("openclaw", sandboxName);
        onboardSession.markStepComplete(
          "openclaw",
          toSessionUpdates({ sandboxName, provider, model, hermesAuthMethod }),
        );
      } else {
        startRecordedStep("openclaw", { sandboxName, provider, model });
        await setupOpenclaw(sandboxName, model, provider);
        onboardSession.markStepComplete(
          "openclaw",
          toSessionUpdates({ sandboxName, provider, model, hermesAuthMethod }),
        );
      }
      onboardSession.markStepSkipped("agent_setup");
    }

    const latestSession = onboardSession.loadSession();
    const recordedPolicyPresets = Array.isArray(latestSession?.policyPresets)
      ? latestSession.policyPresets
      : null;
    const recordedMessagingChannels = Array.isArray(latestSession?.messagingChannels)
      ? latestSession.messagingChannels
      : [];
    const activeMessagingChannels = registry.getSandbox(sandboxName)?.messagingChannels;
    verifyCompatibleEndpointSandboxSmoke({
      sandboxName,
      provider,
      model,
      endpointUrl,
      credentialEnv,
      messagingChannels: Array.isArray(activeMessagingChannels) ? activeMessagingChannels : [],
      agent,
    });
    const policyPresetSupportOptions = { webSearchSupported };
    const recordedPolicyPresetsForSupport = policies.clampSetupPolicyPresetNames(
      recordedPolicyPresets || [],
      [
        ...policies.listSetupPolicyPresets(sandboxName, policyPresetSupportOptions),
        ...policies.getAppliedPresets(sandboxName).map((name) => ({ name })),
      ],
      policyPresetSupportOptions,
      new Set(
        policies.listCustomPresets(sandboxName).map((p: { name: string }) => p.name),
      ),
    );
    const recordedPolicyPresetsHaveUnsupported =
      Array.isArray(recordedPolicyPresets) &&
      recordedPolicyPresetsForSupport.length !== recordedPolicyPresets.length;
    const resumePolicies =
      resume &&
      sandboxName &&
      !recordedPolicyPresetsHaveUnsupported &&
      arePolicyPresetsApplied(sandboxName, recordedPolicyPresetsForSupport);
    if (resumePolicies) {
      skippedStepMessage("policies", recordedPolicyPresetsForSupport.join(", "));
      onboardSession.markStepComplete(
        "policies",
        toSessionUpdates({
          sandboxName,
          provider,
          model,
          policyPresets: recordedPolicyPresetsForSupport,
        }),
      );
    } else {
      startRecordedStep("policies", {
        sandboxName,
        provider,
        model,
        policyPresets: recordedPolicyPresetsForSupport,
      });
      const appliedPolicyPresets = await setupPoliciesWithSelection(sandboxName, {
        selectedPresets:
          Array.isArray(recordedPolicyPresets)
            ? recordedPolicyPresetsForSupport
            : null,
        enabledChannels:
          selectedMessagingChannels.length > 0
            ? selectedMessagingChannels
            : recordedMessagingChannels,
        webSearchConfig,
        provider,
        webSearchSupported,
        onSelection: (policyPresets) => {
          onboardSession.updateSession((current: Session) => {
            current.policyPresets = policyPresets;
            return current;
          });
        },
      });
      onboardSession.markStepComplete(
        "policies",
        toSessionUpdates({ sandboxName, provider, model, policyPresets: appliedPolicyPresets }),
      );
    }

    if (agent) {
      ensureAgentDashboardForward(sandboxName, agent);
    }

    onboardSession.completeSession(
      toSessionUpdates({ sandboxName, provider, model, hermesAuthMethod }),
    );
    completed = true;
    // Onboarding finished successfully. Delete the legacy plaintext
    // credentials.json only when every staged *value* was actually pushed
    // to the gateway in this run. A successful upsert under the same
    // env-key name with a different value (e.g. vllm-local upserting
    // `OPENAI_API_KEY: "dummy"` while the legacy file held a real
    // `sk-…` cloud key) does not count as a migration — the gateway
    // never received the legacy secret, so unlinking the file would
    // strand the user's only copy.
    const allStagedMigrated =
      stagedLegacyKeys.length > 0 && stagedLegacyKeys.every((k) => migratedLegacyKeys.has(k));
    if (allStagedMigrated) {
      removeLegacyCredentialsFile();
    } else if (stagedLegacyKeys.length > 0) {
      const unmigrated = stagedLegacyKeys.filter((k) => !migratedLegacyKeys.has(k));
      console.error(
        `  Kept ~/.nemoclaw/credentials.json: ${String(unmigrated.length)} ` +
          `legacy credential(s) were not migrated verbatim to the gateway in this run ` +
          `(${unmigrated.join(", ")}). Re-run onboard with the relevant ` +
          `providers/channels enabled to migrate them, then the file is removed automatically.`,
      );
    }
    // Sweep stale host files left over from older NemoClaw versions —
    // e.g. an empty/orphaned ~/.nemoclaw/credentials.json from upgrades
    // before the credentials-gateway move (issue #3105). Each registered
    // entry enforces its own safety guards; this call is a no-op when
    // every target is already clean.
    cleanupStaleHostFiles();

    // Post-deployment verification — confirm the full delivery chain is
    // operational before telling the user "YOUR AGENT IS LIVE". Fixes #2342.
    const verifyDeploymentModule: typeof import("./verify-deployment") = require("./verify-deployment");
    const _verifyChatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${DASHBOARD_PORT}`;
    const verifyChain = buildChain({ chatUiUrl: _verifyChatUiUrl, isWsl: isWsl(), wslHostAddress: getWslHostAddress() });
    const verificationResult = verifyDeploymentModule.verifyDeployment(
      sandboxName,
      verifyChain,
      {
        executeSandboxCommand: (name: string, script: string) => {
          return executeSandboxCommandForVerification(name, script);
        },
        probeHostPort: (port: number, probePath: string) => {
          const result = runCapture(
            ["curl", "-so", "/dev/null", "-w", "%{http_code}", "--max-time", "3",
              `http://127.0.0.1:${port}${probePath}`],
            { ignoreError: true },
          );
          return parseInt(result.trim(), 10) || 0;
        },
        captureForwardList: () => {
          const output = runCaptureOpenshell(["forward", "list"], { ignoreError: true });
          return output || null;
        },
        getMessagingChannels: (_name: string) => selectedMessagingChannels || [],
        providerExistsInGateway: (providerName: string) => providerExistsInGateway(providerName),
      },
    );

    // Print verification diagnostics
    const diagLines = verifyDeploymentModule.formatVerificationDiagnostics(verificationResult);
    for (const line of diagLines) {
      console.log(line);
    }

    printDashboard(sandboxName, model, provider, nimContainer, agent);
  } finally {
    releaseOnboardLock();
  }
}

module.exports = {
  buildOrphanedSandboxRollbackMessage,
  buildProviderArgs,
  buildGatewayBootstrapSecretsScript,
  buildCompatibleEndpointSandboxSmokeCommand,
  buildCompatibleEndpointSandboxSmokeScript,
  buildSandboxConfigSyncScript,
  buildSandboxGpuCreateArgs,
  buildDirectGpuPolicyYaml,
  buildDirectSandboxGpuProofCommands,
  compactText,
  copyBuildContextDir,
  classifySandboxCreateFailure,
  configureWebSearch,
  createSandbox,
  ensureValidatedBraveSearchCredential,
  formatEnvAssignment,
  getFutureShellPathHint,
  areRequiredDockerDriverBinariesPresent,
  shouldRequireDockerDriverEnv,
  getGatewayBootstrapRepairPlan,
  getGatewayLocalEndpoint,
  getGatewayStartEnv,
  getDockerDriverGatewayEnv,
  getDockerDriverGatewayRuntimeDriftFromSnapshot,
  getGatewayClusterContainerState,
  getGatewayHealthWaitConfig,
  getGatewayReuseHealthWaitConfig,
  getGatewayReuseState,
  isDockerDriverGatewayPortListener,
  isGatewayHttpReady,
  waitForGatewayHttpReady,
  handleFinalGatewayStartFailure,
  getNavigationChoice,
  getSandboxInferenceConfig,
  getInstalledOpenshellVersion,
  getBlueprintMinOpenshellVersion,
  getBlueprintMaxOpenshellVersion,
  isLinuxDockerDriverGatewayEnabled,
  findReadableNvidiaCdiSpecFiles,
  parseDockerCdiSpecDirs,
  getResumeSandboxGpuOverrides,
  resolveSandboxGpuConfig,
  shouldAllowOpenshellAboveBlueprintMax,
  pullAndResolveBaseImageDigest,
  SANDBOX_BASE_IMAGE,
  SANDBOX_BASE_TAG,
  versionGte,
  getRequestedModelHint,
  getRequestedProviderHint,
  getStableGatewayImageRef,
  getResumeConfigConflicts,
  isGatewayHealthy,
  hasStaleGateway,
  getRequestedSandboxNameHint,
  getResumeSandboxConflict,
  getSandboxReuseState,
  getSandboxStateFromOutputs,
  getPortConflictServiceHints,
  classifyValidationFailure,
  isSandboxReady,
  isLoopbackHostname,
  normalizeProviderBaseUrl,
  onboard,
  onboardSession,
  printSandboxCreateRecoveryHints,
  promptYesNoOrDefault,
  providerExistsInGateway,
  parsePolicyPresetEnv,
  parseSandboxStatus,
  pruneStaleSandboxEntry,
  repairRecordedSandbox,
  recoverGatewayRuntime,
  buildChain,
  buildControlUiUrls,

  startGateway,
  findDashboardForwardOwner,
  startGatewayForRecovery,
  openshellArgv,
  runCaptureOpenshell,
  agentSupportsWebSearch,
  setupInference,
  setupMessagingChannels,
  MESSAGING_CHANNELS,
  selectOnboardAgent,
  setupNim,
  providerNameToOptionKey,
  readRecordedProvider,
  readRecordedModel,
  readRecordedNimContainer,
  formatOnboardConfigSummary,
  formatSandboxBuildEstimateNote,
  isInferenceRouteReady,
  shouldRunCompatibleEndpointSandboxSmoke,
  isNonInteractive,
  isOpenclawReady,
  arePolicyPresetsApplied,
  getSuggestedPolicyPresets,
  computeSetupPresetSuggestions,
  filterSetupPolicyPresets: policies.filterSetupPolicyPresets,
  LOCAL_INFERENCE_PROVIDERS,
  presetsCheckboxSelector,
  selectPolicyTier,
  selectTierPresetsAndAccess,
  setupPoliciesWithSelection,
  summarizeCurlFailure,
  summarizeProbeFailure,
  hasResponsesToolCall,
  hasChatCompletionsToolCall,
  hasChatCompletionsToolCallLeak,
  upsertProvider,
  normalizeHermesAuthMethod,
  hashCredential,
  detectMessagingCredentialRotation,
  getDefaultSandboxNameForAgent,
  getSandboxPromptDefault,
  getRequestedSandboxAgentName,
  normalizeSandboxAgentName,
  hydrateCredentialEnv,
  pruneKnownHostsEntries,
  shouldIncludeBuildContextPath,
  writeSandboxConfigSyncFile,
  patchStagedDockerfile,
  ensureOllamaAuthProxy,
  fetchGatewayAuthTokenFromSandbox,
  getProbeAuthMode,
  getValidationProbeCurlArgs,
  checkTelegramReachability,
  TELEGRAM_NETWORK_CURL_CODES,
  verifyCompatibleEndpointSandboxSmoke,
};
