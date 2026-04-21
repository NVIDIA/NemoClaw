// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Interactive onboarding wizard — 8 steps from zero to running sandbox.
// Supports non-interactive mode via --non-interactive flag or
// NEMOCLAW_NON_INTERACTIVE=1 env var for CI/CD pipelines.

const crypto = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const pRetry = require("p-retry");

/** Parse a numeric env var, returning `fallback` when unset or non-finite. */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
}
/** Inference timeout (seconds) for local providers (Ollama, vLLM, NIM). */
const LOCAL_INFERENCE_TIMEOUT_SECS = envInt("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", 180);

/** Strip ANSI escape sequences before printing process output to the terminal.
 *  Covers CSI (color, erase, cursor), OSC, and C1 two-byte escapes per ECMA-48. */
const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;
const { ROOT, SCRIPTS, redact, run, runCapture, runFile, shellQuote, validateName } = require("./runner");
const { stageOptimizedSandboxBuildContext } = require("./sandbox-build-context");
const { buildSubprocessEnv } = require("./subprocess-env");
const { DASHBOARD_PORT, GATEWAY_PORT, VLLM_PORT, OLLAMA_PORT, OLLAMA_PROXY_PORT } = require("./ports");
const {
  getDefaultOllamaModel,
  getBootstrapOllamaModelOptions,
  getLocalProviderBaseUrl,
  getLocalProviderValidationBaseUrl,
  getOllamaModelOptions,
  getOllamaWarmupCommand,
  validateOllamaModel,
  validateLocalProvider,
} = require("./local-inference");
const {
  DEFAULT_CLOUD_MODEL,
  getProviderSelectionConfig,
  parseGatewayInference,
} = require("./inference-config");

// Providers that run on the host and need the local-inference policy preset.
// Shared constant so getSuggestedPolicyPresets() and setupPoliciesWithSelection()
// stay in sync.
const LOCAL_INFERENCE_PROVIDERS = ["ollama-local", "vllm-local"];
const { inferContainerRuntime, isWsl, shouldPatchCoredns } = require("./platform");
const { resolveOpenshell } = require("./resolve-openshell");
const {
  prompt,
  ensureApiKey,
  getCredential,
  normalizeCredentialValue,
  saveCredential,
} = require("./credentials");
const registry = require("./registry");
const nim = require("./nim");
const onboardSession = require("./onboard-session");
const policies = require("./policies");
const shields = require("./shields");
const tiers = require("./tiers");
const { ensureUsageNoticeConsent } = require("./usage-notice");
const {
  assessHost,
  checkPortAvailable,
  ensureSwap,
  getMemoryInfo,
  planHostRemediation,
} = require("./preflight");
const agentOnboard = require("./agent-onboard");
const agentDefs = require("./agent-defs");

const gatewayState = require("./gateway-state");
const sandboxState = require("./sandbox-state");
const validation = require("./validation");
const urlUtils = require("./url-utils");
const buildContext = require("./build-context");
const dashboard = require("./dashboard");
const httpProbe = require("./http-probe");
const modelPrompts = require("./model-prompts");
const providerModels = require("./provider-models");
const sandboxCreateStream = require("./sandbox-create-stream");
const validationRecovery = require("./validation-recovery");
const webSearch = require("./web-search");

import { listChannels } from "./sandbox-channels";

/**
 * Create a temp file inside a directory with a cryptographically random name.
 * Uses fs.mkdtempSync (OS-level mkdtemp) to avoid predictable filenames that
 * could be exploited via symlink attacks on shared /tmp.
 * Ref: https://github.com/NVIDIA/NemoClaw/issues/1093
 */
function secureTempFile(prefix, ext = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(dir, `${prefix}${ext}`);
}

/**
 * Safely remove a mkdtemp-created directory.  Guards against accidentally
 * deleting the system temp root if a caller passes os.tmpdir() itself.
 */
function cleanupTempDir(filePath, expectedPrefix) {
  const parentDir = path.dirname(filePath);
  if (parentDir !== os.tmpdir() && path.basename(parentDir).startsWith(`${expectedPrefix}-`)) {
    fs.rmSync(parentDir, { recursive: true, force: true });
  }
}

const EXPERIMENTAL = process.env.NEMOCLAW_EXPERIMENTAL === "1";
const USE_COLOR = !process.env.NO_COLOR && !!process.stdout.isTTY;
const DIM = USE_COLOR ? "\x1b[2m" : "";
const RESET = USE_COLOR ? "\x1b[0m" : "";
let OPENSHELL_BIN = null;
const GATEWAY_NAME = "nemoclaw";
const GATEWAY_BOOTSTRAP_SECRET_NAMES = [
  "openshell-server-tls",
  "openshell-server-client-ca",
  "openshell-client-tls",
  "openshell-ssh-handshake",
];
const BACK_TO_SELECTION = "__NEMOCLAW_BACK_TO_SELECTION__";

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
  const result = run(
    `docker inspect --type container --format '{{.State.Running}}' ${containerName}`,
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

const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";
const OPENAI_ENDPOINT_URL = "https://api.openai.com/v1";
const ANTHROPIC_ENDPOINT_URL = "https://api.anthropic.com";
const GEMINI_ENDPOINT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const BRAVE_SEARCH_HELP_URL = "https://brave.com/search/api/";

const REMOTE_PROVIDER_CONFIG = {
  build: {
    label: "NVIDIA Endpoints",
    providerName: "nvidia-prod",
    providerType: "nvidia",
    credentialEnv: "NVIDIA_API_KEY",
    endpointUrl: BUILD_ENDPOINT_URL,
    helpUrl: "https://build.nvidia.com/settings/api-keys",
    modelMode: "catalog",
    defaultModel: DEFAULT_CLOUD_MODEL,
    skipVerify: true,
  },
  openai: {
    label: "OpenAI",
    providerName: "openai-api",
    providerType: "openai",
    credentialEnv: "OPENAI_API_KEY",
    endpointUrl: OPENAI_ENDPOINT_URL,
    helpUrl: "https://platform.openai.com/api-keys",
    modelMode: "curated",
    defaultModel: "gpt-5.4",
    skipVerify: true,
  },
  anthropic: {
    label: "Anthropic",
    providerName: "anthropic-prod",
    providerType: "anthropic",
    credentialEnv: "ANTHROPIC_API_KEY",
    endpointUrl: ANTHROPIC_ENDPOINT_URL,
    helpUrl: "https://console.anthropic.com/settings/keys",
    modelMode: "curated",
    defaultModel: "claude-sonnet-4-6",
  },
  anthropicCompatible: {
    label: "Other Anthropic-compatible endpoint",
    providerName: "compatible-anthropic-endpoint",
    providerType: "anthropic",
    credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    endpointUrl: "",
    helpUrl: null,
    modelMode: "input",
    defaultModel: "",
  },
  gemini: {
    label: "Google Gemini",
    providerName: "gemini-api",
    providerType: "openai",
    credentialEnv: "GEMINI_API_KEY",
    endpointUrl: GEMINI_ENDPOINT_URL,
    helpUrl: "https://aistudio.google.com/app/apikey",
    modelMode: "curated",
    defaultModel: "gemini-2.5-flash",
    skipVerify: true,
  },
  custom: {
    label: "Other OpenAI-compatible endpoint",
    providerName: "compatible-endpoint",
    providerType: "openai",
    credentialEnv: "COMPATIBLE_API_KEY",
    endpointUrl: "",
    helpUrl: null,
    modelMode: "input",
    defaultModel: "",
    skipVerify: true,
  },
};

const DISCORD_SNOWFLAKE_RE = /^[0-9]{17,19}$/;

// Non-interactive mode: set by --non-interactive flag or env var.
// When active, all prompts use env var overrides or sensible defaults.
let NON_INTERACTIVE = false;
let RECREATE_SANDBOX = false;

function isNonInteractive() {
  return NON_INTERACTIVE || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
}

function isRecreateSandbox() {
  return RECREATE_SANDBOX || process.env.NEMOCLAW_RECREATE_SANDBOX === "1";
}

function note(message) {
  console.log(`${DIM}${message}${RESET}`);
}

// Prompt wrapper: returns env var value or default in non-interactive mode,
// otherwise prompts the user interactively.
async function promptOrDefault(question, envVar, defaultValue) {
  if (isNonInteractive()) {
    const val = envVar ? process.env[envVar] : null;
    const result = val || defaultValue;
    note(`  [non-interactive] ${question.trim()} → ${result}`);
    return result;
  }
  return prompt(question);
}

// ── Helpers ──────────────────────────────────────────────────────

// Gateway state functions — delegated to src/lib/gateway-state.ts
const {
  isSandboxReady,
  hasStaleGateway,
  isSelectedGateway,
  isGatewayHealthy,
  getGatewayReuseState,
  getSandboxStateFromOutputs,
} = gatewayState;

/**
 * Remove known_hosts lines whose host field contains an openshell-* entry.
 * Preserves blank lines and comments. Returns the cleaned string.
 */
function pruneKnownHostsEntries(contents) {
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

function getSandboxReuseState(sandboxName) {
  if (!sandboxName) return "missing";
  const getOutput = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
  const listOutput = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
  return getSandboxStateFromOutputs(sandboxName, getOutput, listOutput);
}

function repairRecordedSandbox(sandboxName) {
  if (!sandboxName) return;
  note(`  [resume] Cleaning up recorded sandbox '${sandboxName}' before recreating it.`);
  runOpenshell(["forward", "stop", String(DASHBOARD_PORT)], { ignoreError: true });
  runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
  registry.removeSandbox(sandboxName);
}

const { streamSandboxCreate } = sandboxCreateStream;

/** Spawn `openshell gateway start` and stream its output with progress heartbeats. */
function streamGatewayStart(command, env = process.env) {
  const child = spawn("bash", ["-lc", command], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines = [];
  let pending = "";
  let settled = false;
  let resolvePromise;
  let lastPrintedLine = "";
  let currentPhase = "cluster";
  let lastHeartbeatBucket = -1;
  let lastOutputAt = Date.now();
  const startedAt = Date.now();

  function getDisplayWidth() {
    return Math.max(60, Number(process.stdout.columns || 100));
  }

  function trimDisplayLine(line) {
    const width = getDisplayWidth();
    const maxLen = Math.max(40, width - 4);
    if (line.length <= maxLen) return line;
    return `${line.slice(0, Math.max(0, maxLen - 3))}...`;
  }

  function printProgressLine(line) {
    const display = trimDisplayLine(line);
    if (display !== lastPrintedLine) {
      console.log(display);
      lastPrintedLine = display;
    }
  }

  function elapsedSeconds() {
    return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  }

  function setPhase(nextPhase) {
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

  function classifyLine(line) {
    if (/ApplyJob|helm-install-openshell|Applying HelmChart/i.test(line)) return "install";
    if (
      /openshell-0|Observed pod startup duration|MountVolume\.MountDevice succeeded/i.test(line)
    ) {
      return "pod";
    }
    if (/Gateway .* ready\.?$/i.test(line)) return "health";
    return null;
  }

  function flushLine(rawLine) {
    const line = rawLine.replace(/\r/g, "").trimEnd();
    if (!line) return;
    lines.push(line);
    lastOutputAt = Date.now();
    const nextPhase = classifyLine(line);
    if (nextPhase) setPhase(nextPhase);
  }

  function onChunk(chunk) {
    pending += chunk.toString();
    const parts = pending.split("\n");
    pending = parts.pop();
    parts.forEach(flushLine);
  }

  function finish(result) {
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

  return new Promise((resolve) => {
    resolvePromise = resolve;
    child.on("error", (error) => {
      clearTimeout(killTimer);
      const detail = error?.message || String(error);
      lines.push(detail);
      finish({ status: 1, output: lines.join("\n") });
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      const exitCode = killedByTimeout ? 1 : (code ?? 1);
      finish({ status: exitCode, output: lines.join("\n") });
    });
  });
}

function step(n, total, msg) {
  console.log("");
  console.log(`  [${n}/${total}] ${msg}`);
  console.log(`  ${"─".repeat(50)}`);
}

function getInstalledOpenshellVersion(versionOutput = null) {
  const openshellBin = resolveOpenshell();
  if (!versionOutput && !openshellBin) return null;
  const output = String(
    versionOutput ?? runCapture([openshellBin, "-V"], { ignoreError: true }),
  ).trim();
  const match = output.match(/openshell\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
  if (!match) return null;
  return match[1];
}

/**
 * Compare two semver-like x.y.z strings. Returns true iff `left >= right`.
 * Non-numeric or missing components are treated as 0.
 */
function versionGte(left = "0.0.0", right = "0.0.0") {
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
function getBlueprintVersionField(field, rootDir = ROOT) {
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

function getBlueprintMinOpenshellVersion(rootDir = ROOT) {
  return getBlueprintVersionField("min_openshell_version", rootDir);
}

function getBlueprintMaxOpenshellVersion(rootDir = ROOT) {
  return getBlueprintVersionField("max_openshell_version", rootDir);
}

// ── Base image digest resolution ────────────────────────────────
// Pulls the sandbox-base image from GHCR and inspects it to get the
// actual repo digest. This avoids the registry mismatch that broke
// e2e tests in #1937 — the digest always comes from the same registry
// we're pinning to. See #1904.

const SANDBOX_BASE_IMAGE = "ghcr.io/nvidia/nemoclaw/sandbox-base";
const SANDBOX_BASE_TAG = "latest";

/**
 * Pull sandbox-base:latest from GHCR and resolve its repo digest.
 * Returns { digest, ref } on success, or null when the pull or
 * inspect fails (offline, GHCR outage, local-only build).
 */
function pullAndResolveBaseImageDigest() {
  const imageWithTag = `${SANDBOX_BASE_IMAGE}:${SANDBOX_BASE_TAG}`;
  try {
    run(["docker", "pull", imageWithTag], { suppressOutput: true });
  } catch {
    // Pull failed — caller should fall back to unpin :latest
    return null;
  }

  let inspectOutput;
  try {
    inspectOutput = runCapture(
      ["docker", "inspect", "--format", "{{json .RepoDigests}}", imageWithTag],
      { ignoreError: false },
    );
  } catch {
    return null;
  }

  // RepoDigests is a JSON array like ["ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abc..."].
  // Filter to the entry matching our registry — index ordering is not guaranteed.
  let repoDigests;
  try {
    repoDigests = JSON.parse(inspectOutput || "[]");
  } catch {
    return null;
  }
  const repoDigest = Array.isArray(repoDigests)
    ? repoDigests.find((entry) => entry.startsWith(`${SANDBOX_BASE_IMAGE}@sha256:`))
    : null;
  if (!repoDigest) return null;

  const digest = repoDigest.slice(repoDigest.indexOf("@") + 1);
  const ref = `${SANDBOX_BASE_IMAGE}@${digest}`;
  return { digest, ref };
}

function getStableGatewayImageRef(versionOutput = null) {
  const version = getInstalledOpenshellVersion(versionOutput);
  if (!version) return null;
  return `ghcr.io/nvidia/openshell/cluster:${version}`;
}

function getOpenshellBinary() {
  if (OPENSHELL_BIN) return OPENSHELL_BIN;
  const resolved = resolveOpenshell();
  if (!resolved) {
    console.error("  openshell CLI not found.");
    console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
    process.exit(1);
  }
  OPENSHELL_BIN = resolved;
  return OPENSHELL_BIN;
}

function openshellShellCommand(args, options = {}) {
  const openshellBinary = options.openshellBinary || getOpenshellBinary();
  return [shellQuote(openshellBinary), ...args.map((arg) => shellQuote(arg))].join(" ");
}

function openshellArgv(args, options = {}) {
  const openshellBinary = options.openshellBinary || getOpenshellBinary();
  return [openshellBinary, ...args];
}

function runOpenshell(args, opts = {}) {
  return run(openshellArgv(args, opts), opts);
}

function runCaptureOpenshell(args, opts = {}) {
  return runCapture(openshellArgv(args, opts), opts);
}

// URL/string utilities — delegated to src/lib/url-utils.ts
const {
  compactText,
  normalizeProviderBaseUrl,
  isLoopbackHostname,
  formatEnvAssignment,
  parsePolicyPresetEnv,
} = urlUtils;

function hydrateCredentialEnv(envName) {
  if (!envName) return null;
  const value = getCredential(envName);
  if (value) {
    process.env[envName] = value;
  }
  return value || null;
}

const {
  getCurlTimingArgs,
  summarizeCurlFailure,
  summarizeProbeFailure,
  runCurlProbe,
  runStreamingEventProbe,
} = httpProbe;

function getNavigationChoice(value = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "back") return "back";
  if (normalized === "exit" || normalized === "quit") return "exit";
  return null;
}

function exitOnboardFromPrompt() {
  console.log("  Exiting onboarding.");
  process.exit(1);
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

async function replaceNamedCredential(envName, label, helpUrl = null, validator = null) {
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
    console.log(`  Key saved to ~/.nemoclaw/credentials.json (mode 600)`);
    console.log("");
    return key;
  }
}

async function promptValidationRecovery(label, recovery, credentialEnv = null, helpUrl = null) {
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
    const validator = credentialEnv === "NVIDIA_API_KEY" ? validateNvidiaApiKeyValue : null;
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
    console.log(getTransportRecoveryMessage(recovery.failure || {}));
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

/**
 * Build the argument array for an `openshell provider create` or `update` command.
 * @param {"create"|"update"} action - Whether to create or update.
 * @param {string} name - Provider name.
 * @param {string} type - Provider type (e.g. "openai", "anthropic", "generic").
 * @param {string} credentialEnv - Credential environment variable name.
 * @param {string|null} baseUrl - Optional base URL for API-compatible endpoints.
 * @returns {string[]} Argument array for runOpenshell().
 */
function buildProviderArgs(action, name, type, credentialEnv, baseUrl) {
  const args =
    action === "create"
      ? ["provider", "create", "--name", name, "--type", type, "--credential", credentialEnv]
      : ["provider", "update", name, "--credential", credentialEnv];
  if (baseUrl && type === "openai") {
    args.push("--config", `OPENAI_BASE_URL=${baseUrl}`);
  } else if (baseUrl && type === "anthropic") {
    args.push("--config", `ANTHROPIC_BASE_URL=${baseUrl}`);
  }
  return args;
}

/**
 * Create or update an OpenShell provider in the gateway.
 *
 * Checks whether the provider already exists via `openshell provider get`;
 * uses `create` for new providers and `update` for existing ones.
 * @param {string} name - Provider name (e.g. "discord-bridge", "inference").
 * @param {string} type - Provider type ("openai", "anthropic", "generic").
 * @param {string} credentialEnv - Environment variable name for the credential.
 * @param {string|null} baseUrl - Optional base URL for the provider endpoint.
 * @param {Record<string, string>} [env={}] - Environment variables for the openshell command.
 * @returns {{ ok: boolean, status?: number, message?: string }}
 */
function upsertProvider(name, type, credentialEnv, baseUrl, env = {}) {
  const exists = providerExistsInGateway(name);
  const action = exists ? "update" : "create";
  const args = buildProviderArgs(action, name, type, credentialEnv, baseUrl);
  const runOpts = { ignoreError: true, env, stdio: ["ignore", "pipe", "pipe"] };
  const result = runOpenshell(args, runOpts);
  if (result.status !== 0) {
    const output =
      compactText(redact(`${result.stderr || ""}`)) ||
      compactText(redact(`${result.stdout || ""}`)) ||
      `Failed to ${action} provider '${name}'.`;
    return { ok: false, status: result.status || 1, message: output };
  }
  return { ok: true };
}

/**
 * Upsert all messaging providers that have tokens configured.
 * Returns the list of provider names that were successfully created/updated.
 * Exits the process if any upsert fails.
 * @param {Array<{name: string, envKey: string, token: string|null}>} tokenDefs
 * @returns {string[]} Provider names that were upserted.
 */
function upsertMessagingProviders(tokenDefs) {
  const providers = [];
  for (const { name, envKey, token } of tokenDefs) {
    if (!token) continue;
    const result = upsertProvider(name, "generic", envKey, null, { [envKey]: token });
    if (!result.ok) {
      console.error(`\n  ✗ Failed to create messaging provider '${name}': ${result.message}`);
      process.exit(1);
    }
    providers.push(name);
  }
  return providers;
}

/**
 * Check whether an OpenShell provider exists in the gateway.
 *
 * Queries the gateway-level provider registry via `openshell provider get`.
 * Does NOT verify that the provider is attached to a specific sandbox —
 * OpenShell CLI does not currently expose a sandbox-scoped provider query.
 * @param {string} name - Provider name to look up (e.g. "discord-bridge").
 * @returns {boolean} True if the provider exists in the gateway.
 */
function providerExistsInGateway(name) {
  const result = runOpenshell(["provider", "get", name], {
    ignoreError: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

/**
 * Compute a SHA-256 hash of a credential value for change detection.
 * Stored in the sandbox registry so we can detect rotation on reuse
 * without needing to read the credential back from OpenShell.
 * @param {string} value - Credential value to hash.
 * @returns {string|null} Hex-encoded SHA-256 hash, or null if value is falsy.
 */
function hashCredential(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(String(value).trim()).digest("hex");
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
function detectMessagingCredentialRotation(sandboxName, tokenDefs) {
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
  let gatewayAlive = null;
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
    providerExists: (name) => {
      if (!isGatewayAlive()) return "error";
      return providerExistsInGateway(name) ? "present" : "absent";
    },
  };
}

function verifyInferenceRoute(_provider, _model) {
  const output = runCaptureOpenshell(["inference", "get"], { ignoreError: true });
  if (!output || /Gateway inference:\s*[\r\n]+\s*Not configured/i.test(output)) {
    console.error("  OpenShell inference route was not configured.");
    process.exit(1);
  }
}

function isInferenceRouteReady(provider, model) {
  const live = parseGatewayInference(
    runCaptureOpenshell(["inference", "get"], { ignoreError: true }),
  );
  return Boolean(live && live.provider === provider && live.model === model);
}

function sandboxExistsInGateway(sandboxName) {
  const output = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
  return Boolean(output);
}

function pruneStaleSandboxEntry(sandboxName) {
  const existing = registry.getSandbox(sandboxName);
  const liveExists = sandboxExistsInGateway(sandboxName);
  if (existing && !liveExists) {
    registry.removeSandbox(sandboxName);
  }
  return liveExists;
}

function buildSandboxConfigSyncScript(selectionConfig) {
  // openclaw.json is immutable (root:root 444, Landlock read-only) — never
  // write to it at runtime.  Model routing is handled by the host-side
  // gateway (`openshell inference set` in Step 5), not from inside the
  // sandbox.  We only write the NemoClaw selection config (~/.nemoclaw/).
  return `
set -euo pipefail
mkdir -p ~/.nemoclaw
cat > ~/.nemoclaw/config.json <<'EOF_NEMOCLAW_CFG'
${JSON.stringify(selectionConfig, null, 2)}
EOF_NEMOCLAW_CFG
exit
`.trim();
}

function isOpenclawReady(sandboxName) {
  return Boolean(fetchGatewayAuthTokenFromSandbox(sandboxName));
}

function writeSandboxConfigSyncFile(script) {
  const scriptFile = secureTempFile("nemoclaw-sync", ".sh");
  fs.writeFileSync(scriptFile, `${script}\n`, { mode: 0o600 });
  return scriptFile;
}

function encodeDockerJsonArg(value) {
  return Buffer.from(JSON.stringify(value || {}), "utf8").toString("base64");
}

function isAffirmativeAnswer(value) {
  return ["y", "yes"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function validateBraveSearchApiKey(apiKey) {
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

async function promptBraveSearchRecovery(validation) {
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

async function promptBraveSearchApiKey() {
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

async function ensureValidatedBraveSearchCredential(nonInteractive = isNonInteractive()) {
  const savedApiKey = getCredential(webSearch.BRAVE_API_KEY_ENV);
  let apiKey = savedApiKey || normalizeCredentialValue(process.env[webSearch.BRAVE_API_KEY_ENV]);
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
        validation.message ||
          "Brave Search API key validation failed in non-interactive mode.",
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

async function configureWebSearch(existingConfig = null) {
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
      console.error("  Brave Search API key validation failed.");
      if (validation.message) {
        console.error(`  ${validation.message}`);
      }
      process.exit(1);
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

function getSandboxInferenceConfig(model, provider = null, preferredInferenceApi = null) {
  let providerKey;
  let primaryModelRef;
  let inferenceBaseUrl = "https://inference.local/v1";
  let inferenceApi = preferredInferenceApi || "openai-completions";
  let inferenceCompat = null;

  switch (provider) {
    case "openai-api":
      providerKey = "openai";
      primaryModelRef = `openai/${model}`;
      break;
    case "anthropic-prod":
    case "compatible-anthropic-endpoint":
      providerKey = "anthropic";
      primaryModelRef = `anthropic/${model}`;
      inferenceBaseUrl = "https://inference.local";
      inferenceApi = "anthropic-messages";
      break;
    case "gemini-api":
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      inferenceCompat = {
        supportsStore: false,
      };
      break;
    case "compatible-endpoint":
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      inferenceCompat = {
        supportsStore: false,
      };
      break;
    case "nvidia-prod":
    case "nvidia-nim":
    default:
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      break;
  }

  return { providerKey, primaryModelRef, inferenceBaseUrl, inferenceApi, inferenceCompat };
}

function patchStagedDockerfile(
  dockerfilePath,
  model,
  chatUiUrl,
  buildId = String(Date.now()),
  provider = null,
  preferredInferenceApi = null,
  webSearchConfig = null,
  messagingChannels = [],
  messagingAllowedIds = {},
  discordGuilds = {},
  baseImageRef = null,
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
    dockerfile = dockerfile.replace(/^ARG BASE_IMAGE=(.*)$/m, (line, currentValue) => {
      const trimmed = String(currentValue).trim();
      if (trimmed.startsWith(`${SANDBOX_BASE_IMAGE}:`) || trimmed.startsWith(`${SANDBOX_BASE_IMAGE}@`)) {
        return `ARG BASE_IMAGE=${baseImageRef}`;
      }
      return line;
    });
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
  // Honor NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT exported in the host
  // shell so the sandbox-side nemoclaw-start.sh sees them via $ENV at runtime.
  // Without this, the host export is silently dropped at image build time and
  // the sandbox falls back to the default 10.200.0.1:3128 proxy. See #1409.
  const PROXY_HOST_RE = /^[A-Za-z0-9._:-]+$/;
  const PROXY_PORT_RE = /^[0-9]{1,5}$/;
  const proxyHostEnv = process.env.NEMOCLAW_PROXY_HOST;
  if (proxyHostEnv && PROXY_HOST_RE.test(proxyHostEnv)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_PROXY_HOST=.*$/m,
      `ARG NEMOCLAW_PROXY_HOST=${proxyHostEnv}`,
    );
  }
  const proxyPortEnv = process.env.NEMOCLAW_PROXY_PORT;
  if (proxyPortEnv && PROXY_PORT_RE.test(proxyPortEnv)) {
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
  fs.writeFileSync(dockerfilePath, dockerfile);
}

function parseJsonObject(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function hasResponsesToolCall(body) {
  const parsed = parseJsonObject(body);
  if (!parsed || !Array.isArray(parsed.output)) return false;

  const stack = [...parsed.output];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call" || item.type === "tool_call") return true;
    if (Array.isArray(item.content)) {
      stack.push(...item.content);
    }
  }

  return false;
}

function shouldRequireResponsesToolCalling(provider) {
  return (
    provider === "nvidia-prod" || provider === "gemini-api" || provider === "compatible-endpoint"
  );
}

// The Gemini OpenAI-compat endpoint at /v1beta/openai/ requires
// `Authorization: Bearer <KEY>` and rejects `?key=<KEY>` with HTTP 400
// "Missing or invalid Authorization header." The dual-auth rejection
// described in #1960 applies to the native /v1beta/models/...:generateContent
// endpoint, which the onboarder probes do not use. Both callers of this
// helper (probeOpenAiLikeEndpoint, probeResponsesToolCalling) target the
// OpenAI-compat URL, so returning undefined for every provider is correct:
// probes default to Bearer auth and Gemini onboarding succeeds.
function getProbeAuthMode(_provider) {
  return undefined;
}

// shouldSkipResponsesProbe and isNvcfFunctionNotFoundForAccount /
// nvcfFunctionNotFoundMessage — see validation import above. They live in
// src/lib/validation.ts so they can be unit-tested independently.

// Per-validation-probe curl timing. Tighter than the default 60s in
// getCurlTimingArgs() because validation must not hang the wizard for a
// minute on a misbehaving model. See issue #1601 (Bug 3).
function getValidationProbeCurlArgs(opts) {
  if (isWsl(opts)) {
    return ["--connect-timeout", "20", "--max-time", "30"];
  }
  return ["--connect-timeout", "10", "--max-time", "15"];
}

function probeResponsesToolCalling(endpointUrl, model, apiKey, options = {}) {
  const useQueryParam = options.authMode === "query-param";
  const normalizedKey = apiKey ? normalizeCredentialValue(apiKey) : "";
  const baseUrl = String(endpointUrl).replace(/\/+$/, "");
  const authHeader = !useQueryParam && normalizedKey
    ? ["-H", `Authorization: Bearer ${normalizedKey}`]
    : [];
  const url = useQueryParam && normalizedKey
    ? `${baseUrl}/responses?key=${encodeURIComponent(normalizedKey)}`
    : `${baseUrl}/responses`;
  const result = runCurlProbe([
    "-sS",
    ...getValidationProbeCurlArgs(),
    "-H",
    "Content-Type: application/json",
    ...authHeader,
    "-d",
    JSON.stringify({
      model,
      input: "Call the emit_ok function with value OK. Do not answer with plain text.",
      tool_choice: "required",
      tools: [
        {
          type: "function",
          name: "emit_ok",
          description: "Returns the probe value for validation.",
          parameters: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
    }),
    url,
  ]);

  if (!result.ok) {
    return result;
  }
  if (hasResponsesToolCall(result.body)) {
    return result;
  }
  return {
    ok: false,
    httpStatus: result.httpStatus,
    curlStatus: result.curlStatus,
    body: result.body,
    stderr: result.stderr,
    message: `HTTP ${result.httpStatus}: Responses API did not return a tool call`,
  };
}

function probeOpenAiLikeEndpoint(endpointUrl, model, apiKey, options = {}) {
  const useQueryParam = options.authMode === "query-param";
  const normalizedKey = apiKey ? normalizeCredentialValue(apiKey) : "";
  const baseUrl = String(endpointUrl).replace(/\/+$/, "");
  const authHeader = !useQueryParam && normalizedKey
    ? ["-H", `Authorization: Bearer ${normalizedKey}`]
    : [];
  const appendKey = (path) =>
    useQueryParam && normalizedKey ? `${baseUrl}${path}?key=${encodeURIComponent(normalizedKey)}` : `${baseUrl}${path}`;

  const responsesProbe =
    options.requireResponsesToolCalling === true
      ? {
          name: "Responses API with tool calling",
          api: "openai-responses",
          execute: () => probeResponsesToolCalling(endpointUrl, model, apiKey, { authMode: options.authMode }),
        }
      : {
          name: "Responses API",
          api: "openai-responses",
          execute: () =>
            runCurlProbe([
              "-sS",
              ...getValidationProbeCurlArgs(),
              "-H",
              "Content-Type: application/json",
              ...authHeader,
              "-d",
              JSON.stringify({
                model,
                input: "Reply with exactly: OK",
              }),
              appendKey("/responses"),
            ]),
        };

  const chatCompletionsProbe = {
    name: "Chat Completions API",
    api: "openai-completions",
    execute: () =>
      runCurlProbe([
        "-sS",
        ...getValidationProbeCurlArgs(),
        "-H",
        "Content-Type: application/json",
        ...authHeader,
        "-d",
        JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
        }),
        appendKey("/chat/completions"),
      ]),
  };

  // NVIDIA Build does not expose /v1/responses; probing it always returns
  // "404 page not found" and only adds noise to error messages. Skip it
  // entirely for that provider. See issue #1601.
  const probes = options.skipResponsesProbe
    ? [chatCompletionsProbe]
    : [responsesProbe, chatCompletionsProbe];

  const failures = [];
  for (const probe of probes) {
    const result = probe.execute();
    if (result.ok) {
      // Streaming event validation — catch backends like SGLang that return
      // valid non-streaming responses but emit incomplete SSE events in
      // streaming mode. Only run for /responses probes on custom endpoints
      // where probeStreaming was requested.
      if (probe.api === "openai-responses" && options.probeStreaming === true) {
        const streamResult = runStreamingEventProbe([
          "-sS",
          ...getValidationProbeCurlArgs(),
          "-H",
          "Content-Type: application/json",
          ...authHeader,
          "-d",
          JSON.stringify({
            model,
            input: "Reply with exactly: OK",
            stream: true,
          }),
          appendKey("/responses"),
        ]);
        if (!streamResult.ok && streamResult.missingEvents.length > 0) {
          // Backend responds but lacks required streaming events — fall back
          // to /chat/completions silently.
          console.log(`  ℹ ${streamResult.message}`);
          failures.push({
            name: probe.name + " (streaming)",
            httpStatus: 0,
            curlStatus: 0,
            message: streamResult.message,
            body: "",
          });
          continue;
        }
        if (!streamResult.ok) {
          // Transport or execution failure — surface as a hard error instead
          // of silently switching APIs.
          return {
            ok: false,
            message: `${probe.name} (streaming): ${streamResult.message}`,
            failures: [
              {
                name: probe.name + " (streaming)",
                httpStatus: 0,
                curlStatus: 0,
                message: streamResult.message,
                body: "",
              },
            ],
          };
        }
      }
      return { ok: true, api: probe.api, label: probe.name };
    }
    // Preserve the raw response body alongside the summarized message so the
    // NVCF "Function not found for account" detector below can fall back to
    // the raw body if summarizeProbeError ever stops surfacing the marker
    // through `message`.
    failures.push({
      name: probe.name,
      httpStatus: result.httpStatus,
      curlStatus: result.curlStatus,
      message: result.message,
      body: result.body,
    });
  }

  // Single retry with doubled timeouts on timeout/connection failure.
  // WSL2's virtualized network stack can cause the initial probe to time out
  // before the TLS handshake completes. See issue #987.
  const isTimeoutOrConnFailure = (cs) => cs === 28 || cs === 6 || cs === 7;
  let retriedAfterTimeout = false;
  if (failures.length > 0 && isTimeoutOrConnFailure(failures[0].curlStatus)) {
    retriedAfterTimeout = true;
    const baseArgs = getValidationProbeCurlArgs();
    const doubledArgs = baseArgs.map((arg) =>
      /^\d+$/.test(arg) ? String(Number(arg) * 2) : arg,
    );
    const retryResult = runCurlProbe([
      "-sS",
      ...doubledArgs,
      "-H",
      "Content-Type: application/json",
      ...(apiKey ? ["-H", `Authorization: Bearer ${normalizeCredentialValue(apiKey)}`] : []),
      "-d",
      JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
      }),
      `${String(endpointUrl).replace(/\/+$/, "")}/chat/completions`,
    ]);
    if (retryResult.ok) {
      return { ok: true, api: "openai-completions", label: "Chat Completions API" };
    }
  }

  // Detect the NVCF "Function not found for account" error and reframe it
  // with an actionable next step instead of dumping the raw NVCF body.
  // See issue #1601 (Bug 2).
  const accountFailure = failures.find(
    (failure) =>
      isNvcfFunctionNotFoundForAccount(failure.message) ||
      isNvcfFunctionNotFoundForAccount(failure.body),
  );
  if (accountFailure) {
    return {
      ok: false,
      message: nvcfFunctionNotFoundMessage(model),
      failures,
    };
  }

  const baseMessage = failures.map((failure) => `${failure.name}: ${failure.message}`).join(" | ");
  const wslHint =
    isWsl() && retriedAfterTimeout
      ? " · WSL2 detected \u2014 network verification may be slower than expected. " +
        "Run `nemoclaw onboard` with the `--skip-verify` flag if this endpoint is known to be reachable."
      : "";
  return {
    ok: false,
    message: baseMessage + wslHint,
    failures,
  };
}

function probeAnthropicEndpoint(endpointUrl, model, apiKey) {
  const result = runCurlProbe([
    "-sS",
    ...getCurlTimingArgs(),
    "-H",
    `x-api-key: ${normalizeCredentialValue(apiKey)}`,
    "-H",
    "anthropic-version: 2023-06-01",
    "-H",
    "content-type: application/json",
    "-d",
    JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    }),
    `${String(endpointUrl).replace(/\/+$/, "")}/v1/messages`,
  ]);
  if (result.ok) {
    return { ok: true, api: "anthropic-messages", label: "Anthropic Messages API" };
  }
  return {
    ok: false,
    message: result.message,
    failures: [
      {
        name: "Anthropic Messages API",
        httpStatus: result.httpStatus,
        curlStatus: result.curlStatus,
        message: result.message,
      },
    ],
  };
}

async function validateOpenAiLikeSelection(
  label,
  endpointUrl,
  model,
  credentialEnv = null,
  retryMessage = "Please choose a provider/model again.",
  helpUrl = null,
  options = {},
) {
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
  console.log(`  ${probe.label} available — OpenClaw will use ${probe.api}.`);
  return { ok: true, api: probe.api };
}

async function validateAnthropicSelectionWithRetryMessage(
  label,
  endpointUrl,
  model,
  credentialEnv,
  retryMessage = "Please choose a provider/model again.",
  helpUrl = null,
) {
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
  console.log(`  ${probe.label} available — OpenClaw will use ${probe.api}.`);
  return { ok: true, api: probe.api };
}

async function validateCustomOpenAiLikeSelection(
  label,
  endpointUrl,
  model,
  credentialEnv,
  helpUrl = null,
) {
  const apiKey = getCredential(credentialEnv);
  const probe = probeOpenAiLikeEndpoint(endpointUrl, model, apiKey, {
    requireResponsesToolCalling: true,
    skipResponsesProbe: shouldForceCompletionsApi(process.env.NEMOCLAW_PREFERRED_API),
    probeStreaming: true,
  });
  if (probe.ok) {
    console.log(`  ${probe.label} available — OpenClaw will use ${probe.api}.`);
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

async function validateCustomAnthropicSelection(
  label,
  endpointUrl,
  model,
  credentialEnv,
  helpUrl = null,
) {
  const apiKey = getCredential(credentialEnv);
  const probe = probeAnthropicEndpoint(endpointUrl, model, apiKey);
  if (probe.ok) {
    console.log(`  ${probe.label} available — OpenClaw will use ${probe.api}.`);
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

// Build context helpers — delegated to src/lib/build-context.ts
const { shouldIncludeBuildContextPath, copyBuildContextDir, printSandboxCreateRecoveryHints } =
  buildContext;
// classifySandboxCreateFailure — see validation import above

// ---------------------------------------------------------------------------
// Ollama auth proxy — keeps Ollama on localhost, exposes a token-gated proxy
// on 0.0.0.0 so containers can reach it without exposing Ollama to the network.
// Token is persisted to ~/.nemoclaw/ollama-proxy-token so the proxy can be
// restarted after a host reboot without re-running onboard.
// ---------------------------------------------------------------------------

const PROXY_STATE_DIR = path.join(os.homedir(), ".nemoclaw");
const PROXY_TOKEN_PATH = path.join(PROXY_STATE_DIR, "ollama-proxy-token");
const PROXY_PID_PATH = path.join(PROXY_STATE_DIR, "ollama-auth-proxy.pid");

let ollamaProxyToken: string | null = null;

function ensureProxyStateDir(): void {
  if (!fs.existsSync(PROXY_STATE_DIR)) {
    fs.mkdirSync(PROXY_STATE_DIR, { recursive: true });
  }
}

function persistProxyToken(token: string): void {
  ensureProxyStateDir();
  fs.writeFileSync(PROXY_TOKEN_PATH, token, { mode: 0o600 });
  // mode only applies on creation; ensure permissions on existing files too
  fs.chmodSync(PROXY_TOKEN_PATH, 0o600);
}

function loadPersistedProxyToken(): string | null {
  try {
    if (fs.existsSync(PROXY_TOKEN_PATH)) {
      const token = fs.readFileSync(PROXY_TOKEN_PATH, "utf-8").trim();
      return token || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function persistProxyPid(pid: number | null | undefined): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  ensureProxyStateDir();
  fs.writeFileSync(PROXY_PID_PATH, `${pid}\n`, { mode: 0o600 });
  fs.chmodSync(PROXY_PID_PATH, 0o600);
}

function loadPersistedProxyPid(): number | null {
  try {
    if (!fs.existsSync(PROXY_PID_PATH)) return null;
    const raw = fs.readFileSync(PROXY_PID_PATH, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearPersistedProxyPid(): void {
  try {
    if (fs.existsSync(PROXY_PID_PATH)) {
      fs.unlinkSync(PROXY_PID_PATH);
    }
  } catch {
    /* ignore */
  }
}

function isOllamaProxyProcess(pid: number | null | undefined): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const cmdline = runCapture(["ps", "-p", String(pid), "-o", "args="], { ignoreError: true });
  return Boolean(cmdline && cmdline.includes("ollama-auth-proxy.js"));
}

function spawnOllamaAuthProxy(token: string): number | null {
  const child = spawn(process.execPath, [path.join(SCRIPTS, "ollama-auth-proxy.js")], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      OLLAMA_PROXY_TOKEN: token,
      OLLAMA_PROXY_PORT: String(OLLAMA_PROXY_PORT),
      OLLAMA_BACKEND_PORT: String(OLLAMA_PORT),
    },
  });
  child.unref();
  persistProxyPid(child.pid);
  return child.pid ?? null;
}

function killStaleProxy(): void {
  try {
    const persistedPid = loadPersistedProxyPid();
    if (isOllamaProxyProcess(persistedPid)) {
      run(["kill", String(persistedPid)], { ignoreError: true, suppressOutput: true });
    }
    clearPersistedProxyPid();

    // Best-effort cleanup for older proxy processes created before the PID file
    // existed. Only kill processes that are actually the auth proxy, not
    // unrelated services that happen to use the same port.
    const pidOutput = runCapture(["lsof", "-ti", `:${OLLAMA_PROXY_PORT}`], { ignoreError: true });
    if (pidOutput && pidOutput.trim()) {
      for (const pid of pidOutput.trim().split(/\s+/)) {
        if (isOllamaProxyProcess(Number.parseInt(pid, 10))) {
          run(["kill", pid], { ignoreError: true, suppressOutput: true });
        }
      }
      sleep(1);
    }
  } catch {
    /* ignore */
  }
}

function startOllamaAuthProxy(): boolean {
  const crypto = require("crypto");
  killStaleProxy();

  ollamaProxyToken = crypto.randomBytes(24).toString("hex");
  // Don't persist yet — wait until provider is confirmed in setupInference.
  // If the user backs out to a different provider, the token stays in memory
  // only and is discarded.
  const pid = spawnOllamaAuthProxy(ollamaProxyToken);
  sleep(1);
  if (!isOllamaProxyProcess(pid)) {
    console.error(`  Error: Ollama auth proxy failed to start on :${OLLAMA_PROXY_PORT}`);
    console.error(`  Containers will not be able to reach Ollama without the proxy.`);
    console.error(`  Check if port ${OLLAMA_PROXY_PORT} is already in use: lsof -ti :${OLLAMA_PROXY_PORT}`);
    return false;
  }
  return true;
}

/**
 * Ensure the auth proxy is running — called on sandbox connect to recover
 * from host reboots where the background proxy process was lost.
 */
function ensureOllamaAuthProxy(): void {
  // Try to load persisted token first — if none, this isn't an Ollama setup.
  const token = loadPersistedProxyToken();
  if (!token) return;

  const pid = loadPersistedProxyPid();
  if (isOllamaProxyProcess(pid)) {
    ollamaProxyToken = token;
    return;
  }

  // Proxy not running — restart it with the persisted token.
  killStaleProxy();
  ollamaProxyToken = token;
  spawnOllamaAuthProxy(token);
  sleep(1);
}

function getOllamaProxyToken(): string | null {
  if (ollamaProxyToken) return ollamaProxyToken;
  // Fall back to persisted token (resume / reconnect scenario)
  ollamaProxyToken = loadPersistedProxyToken();
  return ollamaProxyToken;
}

async function promptOllamaModel(gpu = null) {
  const installed = getOllamaModelOptions();
  const options = installed.length > 0 ? installed : getBootstrapOllamaModelOptions(gpu);
  const defaultModel = getDefaultOllamaModel(gpu);
  const defaultIndex = Math.max(0, options.indexOf(defaultModel));

  console.log("");
  console.log(installed.length > 0 ? "  Ollama models:" : "  Ollama starter models:");
  options.forEach((option, index) => {
    console.log(`    ${index + 1}) ${option}`);
  });
  console.log(`    ${options.length + 1}) Other...`);
  if (installed.length === 0) {
    console.log("");
    console.log("  No local Ollama models are installed yet. Choose one to pull and load now.");
  }
  console.log("");

  const choice = await prompt(`  Choose model [${defaultIndex + 1}]: `);
  const index = parseInt(choice || String(defaultIndex + 1), 10) - 1;
  if (index >= 0 && index < options.length) {
    return options[index];
  }
  return promptManualModelId("  Ollama model id: ", "Ollama");
}

function printOllamaExposureWarning() {
  console.log("");
  console.log("  ⚠ Ollama is binding to 0.0.0.0 so the sandbox can reach it via Docker.");
  console.log("    This exposes the Ollama API to your local network (no auth required).");
  console.log("    On public WiFi, any device on the same network can send prompts to your GPU.");
  console.log("    See: CNVD-2025-04094, CVE-2024-37032");
  console.log("");
}

function pullOllamaModel(model) {
  const result = spawnSync("ollama", ["pull", model], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
    timeout: 600_000,
    env: { ...process.env },
  });
  if (result.signal === "SIGTERM") {
    console.error(
      `  Model pull timed out after 10 minutes. Try a smaller model or check your network connection.`,
    );
    return false;
  }
  return result.status === 0;
}

function prepareOllamaModel(model, installedModels = []) {
  const alreadyInstalled = installedModels.includes(model);
  if (!alreadyInstalled) {
    console.log(`  Pulling Ollama model: ${model}`);
    if (!pullOllamaModel(model)) {
      return {
        ok: false,
        message:
          `Failed to pull Ollama model '${model}'. ` +
          "Check the model name and that Ollama can access the registry, then try another model.",
      };
    }
  }

  console.log(`  Loading Ollama model: ${model}`);
  run(getOllamaWarmupCommand(model), { ignoreError: true });
  return validateOllamaModel(model);
}

function getRequestedSandboxNameHint() {
  const raw = process.env.NEMOCLAW_SANDBOX_NAME;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return normalized || null;
}

function getResumeSandboxConflict(session) {
  const requestedSandboxName = getRequestedSandboxNameHint();
  if (!requestedSandboxName || !session?.sandboxName) {
    return null;
  }
  return requestedSandboxName !== session.sandboxName
    ? { requestedSandboxName, recordedSandboxName: session.sandboxName }
    : null;
}

function getRequestedProviderHint(nonInteractive = isNonInteractive()) {
  return nonInteractive ? getNonInteractiveProvider() : null;
}

function getRequestedModelHint(nonInteractive = isNonInteractive()) {
  if (!nonInteractive) return null;
  const providerKey = getRequestedProviderHint(nonInteractive) || "cloud";
  return getNonInteractiveModel(providerKey);
}

function getEffectiveProviderName(providerKey) {
  if (!providerKey) return null;
  if (REMOTE_PROVIDER_CONFIG[providerKey]) {
    return REMOTE_PROVIDER_CONFIG[providerKey].providerName;
  }

  switch (providerKey) {
    case "nim-local":
      return "nvidia-nim";
    case "ollama":
      return "ollama-local";
    case "vllm":
      return "vllm-local";
    default:
      return providerKey;
  }
}

function getResumeConfigConflicts(session, opts = {}) {
  const conflicts = [];
  const nonInteractive = opts.nonInteractive ?? isNonInteractive();

  const sandboxConflict = getResumeSandboxConflict(session);
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

function getContainerRuntime() {
  const info = runCapture(["docker", "info"], { ignoreError: true });
  return inferContainerRuntime(info);
}

function printRemediationActions(actions) {
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

function isOpenshellInstalled() {
  return resolveOpenshell() !== null;
}

function getFutureShellPathHint(binDir, pathValue = process.env.PATH || "") {
  if (String(pathValue).split(path.delimiter).includes(binDir)) {
    return null;
  }
  return `export PATH="${binDir}:$PATH"`;
}

function getPortConflictServiceHints(platform = process.platform) {
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

function installOpenshell() {
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
  return {
    installed: OPENSHELL_BIN !== null,
    localBin,
    futureShellPathHint,
  };
}

function sleep(seconds) {
  require("child_process").spawnSync("sleep", [String(seconds)]);
}

function destroyGateway() {
  const destroyResult = runOpenshell(["gateway", "destroy", "-g", GATEWAY_NAME], {
    ignoreError: true,
  });
  // Clear the local registry so `nemoclaw list` stays consistent with OpenShell state. (#532)
  if (destroyResult.status === 0) {
    registry.clearAll();
  }
  // openshell gateway destroy doesn't remove Docker volumes, which leaves
  // corrupted cluster state that breaks the next gateway start. Clean them up.
  // Shell required: pipe (|), && chaining, || fallback.
  run(
    `docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | grep . && docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | xargs docker volume rm || true`,
    { ignoreError: true },
  );
}

function getGatewayClusterContainerState() {
  const containerName = getGatewayClusterContainerName();
  const state = runCapture(
    `docker inspect --type container --format '{{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{end}}' ${shellQuote(containerName)} 2>/dev/null`,
    { ignoreError: true },
  )
    .trim()
    .toLowerCase();
  return state || "missing";
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

function getGatewayClusterContainerName() {
  return `openshell-cluster-${GATEWAY_NAME}`;
}

function getGatewayLocalEndpoint() {
  return `https://127.0.0.1:${GATEWAY_PORT}`;
}

function getGatewayBootstrapRepairPlan(missingSecrets = []) {
  const allowed = new Set(GATEWAY_BOOTSTRAP_SECRET_NAMES);
  const normalized = [...new Set((missingSecrets || []).map((name) => String(name).trim()).filter(Boolean))]
    .filter((name) => allowed.has(name));
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

function buildGatewayBootstrapSecretsScript(missingSecrets = []) {
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

function runGatewayClusterCapture(script, opts = {}) {
  const containerName = getGatewayClusterContainerName();
  return runCapture(
    `docker exec ${shellQuote(containerName)} sh -lc ${shellQuote(script)}`,
    opts,
  );
}

function runGatewayCluster(script, opts = {}) {
  const containerName = getGatewayClusterContainerName();
  return run(
    `docker exec ${shellQuote(containerName)} sh -lc ${shellQuote(script)}`,
    opts,
  );
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

function gatewayClusterHealthcheckPassed() {
  const result = runGatewayCluster("/usr/local/bin/cluster-healthcheck.sh", {
    ignoreError: true,
    suppressOutput: true,
  });
  return result.status === 0;
}

function repairGatewayBootstrapSecrets() {
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

function attachGatewayMetadataIfNeeded({ forceRefresh = false } = {}) {
  const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], { ignoreError: true });
  // runCaptureOpenshell may return stale-but-present gateway metadata. When
  // hasStaleGateway(gwInfo) is truthy we skip runOpenshell unless a repair
  // flow explicitly forces a refresh after recreating bootstrap secrets.
  if (!forceRefresh && hasStaleGateway(gwInfo)) return true;

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

async function ensureNamedCredential(envName, label, helpUrl = null) {
  let key = getCredential(envName);
  if (key) {
    process.env[envName] = key;
    return key;
  }
  return replaceNamedCredential(envName, label, helpUrl);
}

function waitForSandboxReady(sandboxName, attempts = 10, delaySeconds = 2) {
  for (let i = 0; i < attempts; i += 1) {
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

function getNonInteractiveProvider() {
  const providerKey = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
  if (!providerKey) return null;
  const aliases = {
    cloud: "build",
    nim: "nim-local",
    vllm: "vllm",
    anthropiccompatible: "anthropicCompatible",
  };
  const normalized = aliases[providerKey] || providerKey;
  const validProviders = new Set([
    "build",
    "openai",
    "anthropic",
    "anthropicCompatible",
    "gemini",
    "ollama",
    "custom",
    "nim-local",
    "vllm",
  ]);
  if (!validProviders.has(normalized)) {
    console.error(`  Unsupported NEMOCLAW_PROVIDER: ${providerKey}`);
    console.error(
      "  Valid values: build, openai, anthropic, anthropicCompatible, gemini, ollama, custom, nim-local, vllm",
    );
    process.exit(1);
  }

  return normalized;
}

function getNonInteractiveModel(providerKey) {
  const model = (process.env.NEMOCLAW_MODEL || "").trim();
  if (!model) return null;
  if (!isSafeModelId(model)) {
    console.error(`  Invalid NEMOCLAW_MODEL for provider '${providerKey}': ${model}`);
    console.error("  Model values may only contain letters, numbers, '.', '_', ':', '/', and '-'.");
    process.exit(1);
  }
  return model;
}

// ── Step 1: Preflight ────────────────────────────────────────────

// eslint-disable-next-line complexity
async function preflight() {
  step(1, 8, "Preflight checks");

  const host = assessHost();

  // Docker / runtime
  if (!host.dockerReachable) {
    console.error("  Docker is not reachable. Please fix Docker and try again.");
    printRemediationActions(planHostRemediation(host));
    process.exit(1);
  }
  console.log("  ✓ Docker is running");

  if (host.runtime !== "unknown") {
    console.log(`  ✓ Container runtime: ${host.runtime}`);
  }
  // Podman is now supported — no unsupported runtime warning needed.
  if (host.notes.includes("Running under WSL")) {
    console.log("  ⓘ Running under WSL");
  }

  // OpenShell CLI — install if missing, upgrade if below minimum version.
  // MIN_VERSION in install-openshell.sh handles the version gate; calling it
  // when openshell already exists is safe (it exits early if version is OK).
  let openshellInstall = { localBin: null, futureShellPathHint: null };
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
      const parts = currentVersion.split(".").map(Number);
      const minParts = [0, 0, 24]; // must match MIN_VERSION in scripts/install-openshell.sh
      const needsUpgrade =
        parts[0] < minParts[0] ||
        (parts[0] === minParts[0] && parts[1] < minParts[1]) ||
        (parts[0] === minParts[0] && parts[1] === minParts[1] && parts[2] < minParts[2]);
      if (needsUpgrade) {
        console.log(
          `  openshell ${currentVersion} is below minimum required version. Upgrading...`,
        );
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
    !versionGte(maxOpenshellVersion, installedOpenshellVersion)
  ) {
    console.error("");
    console.error(
      `  ✗ openshell ${installedOpenshellVersion} is above the maximum supported by this NemoClaw release.`,
    );
    console.error(`    blueprint.yaml max_openshell_version: ${maxOpenshellVersion}`);
    console.error("");
    console.error("    Upgrade NemoClaw to a version that supports your OpenShell release,");
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
  // tearing it down here. If some other gateway is active, do not treat it
  // as NemoClaw state; let the port checks surface the conflict instead.
  const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
  const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
    ignoreError: true,
  });
  const activeGatewayInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
  let gatewayReuseState = getGatewayReuseState(gatewayStatus, gwInfo, activeGatewayInfo);

  // Verify the gateway container is actually running — openshell CLI metadata
  // can be stale after a manual `docker rm`. See #2020.
  if (gatewayReuseState === "healthy") {
    const containerState = verifyGatewayContainerRunning();
    if (containerState === "missing") {
      console.log("  Gateway metadata is stale (container not running). Cleaning up...");
      runOpenshell(["forward", "stop", String(DASHBOARD_PORT)], { ignoreError: true });
      destroyGateway();
      registry.clearAll();
      gatewayReuseState = "missing";
      console.log("  ✓ Stale gateway metadata cleaned up");
    } else if (containerState === "unknown") {
      console.log("  Warning: could not verify gateway container state (Docker may be unavailable). Proceeding with cached health status.");
    }
  }

  if (gatewayReuseState === "stale" || gatewayReuseState === "active-unnamed") {
    console.log("  Cleaning up previous NemoClaw session...");
    runOpenshell(["forward", "stop", String(DASHBOARD_PORT)], { ignoreError: true });
    const destroyResult = runOpenshell(["gateway", "destroy", "-g", GATEWAY_NAME], {
      ignoreError: true,
    });
    // Sandboxes under the destroyed gateway no longer exist in OpenShell —
    // clear the local registry so `nemoclaw list` stays consistent. (#532)
    if (destroyResult.status === 0) {
      registry.clearAll();
    }
    console.log("  ✓ Previous session cleaned up");
  }

  // Clean up orphaned Docker containers from interrupted onboard (e.g. Ctrl+C
  // during gateway start). The container may still be running even though
  // OpenShell has no metadata for it (gatewayReuseState === "missing").
  if (gatewayReuseState === "missing") {
    const containerName = `openshell-cluster-${GATEWAY_NAME}`;
    const inspectResult = run(
      ["docker", "inspect", "--type", "container", "--format", "{{.State.Status}}", containerName],
      { ignoreError: true, suppressOutput: true },
    );
    if (inspectResult.status === 0) {
      console.log("  Cleaning up orphaned gateway container...");
      run(["docker", "stop", containerName], {
        ignoreError: true,
        suppressOutput: true,
      });
      run(["docker", "rm", containerName], {
        ignoreError: true,
        suppressOutput: true,
      });
      const postInspectResult = run(
        ["docker", "inspect", "--type", "container", containerName],
        {
          ignoreError: true,
          suppressOutput: true,
        },
      );
      if (postInspectResult.status !== 0) {
        run(
          `docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | grep . && docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | xargs docker volume rm 2>/dev/null || true`,
          { ignoreError: true, suppressOutput: true },
        );
        registry.clearAll();
        console.log("  ✓ Orphaned gateway container removed");
      } else {
        console.warn("  ! Found an orphaned gateway container, but automatic cleanup failed.");
      }
    }
  }

  // Required ports — gateway and the dashboard port
  const requiredPorts = [
    { port: GATEWAY_PORT, label: "OpenShell gateway" },
    { port: DASHBOARD_PORT, label: "NemoClaw dashboard" },
  ];
  for (const { port, label } of requiredPorts) {
    let portCheck = await checkPortAvailable(port);
    if (!portCheck.ok) {
      if ((port === GATEWAY_PORT || port === DASHBOARD_PORT) && gatewayReuseState === "healthy") {
        console.log(`  ✓ Port ${port} already owned by healthy NemoClaw runtime (${label})`);
        continue;
      }
      // Auto-cleanup orphaned SSH port-forward from a previous NemoClaw session
      // (e.g. dashboard forward left behind after destroy). Only kill the process
      // if its command line contains "openshell" to avoid killing unrelated SSH
      // tunnels the user may have set up on the same port. (#1950)
      if (port === DASHBOARD_PORT && portCheck.process === "ssh" && portCheck.pid) {
        // Use `ps` to get the command line — works on Linux, macOS, and WSL.
        const cmdline = runCapture(
          `ps -p ${portCheck.pid} -o args= 2>/dev/null`,
          { ignoreError: true },
        ).trim();
        if (cmdline.includes("openshell")) {
          console.log(`  Cleaning up orphaned SSH port-forward on port ${port} (PID ${portCheck.pid})...`);
          run(`kill ${portCheck.pid} 2>/dev/null || true`, { ignoreError: true });
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
      console.error(`     Detail: ${portCheck.reason}`);
      process.exit(1);
    }
    console.log(`  ✓ Port ${port} available (${label})`);
  }

  // GPU
  const gpu = nim.detectGpu();
  if (gpu && gpu.type === "nvidia") {
    console.log(`  ✓ NVIDIA GPU detected: ${gpu.count} GPU(s), ${gpu.totalMemoryMB} MB VRAM`);
    if (!gpu.nimCapable) {
      console.log("  ⓘ GPU VRAM too small for local NIM — will use cloud inference");
    }
  } else if (gpu && gpu.type === "apple") {
    console.log(
      `  ✓ Apple GPU detected: ${gpu.name}${gpu.cores ? ` (${gpu.cores} cores)` : ""}, ${gpu.totalMemoryMB} MB unified memory`,
    );
    console.log("  ⓘ NIM requires NVIDIA GPU — will use cloud inference");
  } else {
    console.log("  ⓘ No GPU detected — will use cloud inference");
  }

  // Memory / swap check (Linux only)
  if (process.platform === "linux") {
    const mem = getMemoryInfo();
    if (mem) {
      if (mem.totalMB < 12000) {
        console.log(
          `  ⚠ Low memory detected (${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap = ${mem.totalMB} MB total)`,
        );

        let proceedWithSwap = false;
        if (!isNonInteractive()) {
          const answer = await prompt(
            "  Create a 4 GB swap file to prevent OOM during sandbox build? (requires sudo) [y/N]: ",
          );
          proceedWithSwap = answer && answer.toLowerCase().startsWith("y");
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
async function startGatewayWithOptions(_gpu, { exitOnFailure = true } = {}) {
  step(2, 8, "Starting OpenShell gateway");

  const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
  const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
    ignoreError: true,
  });
  const activeGatewayInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
  if (isGatewayHealthy(gatewayStatus, gwInfo, activeGatewayInfo)) {
    console.log("  ✓ Reusing existing gateway");
    runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
    process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
    return;
  }

  // When a stale gateway is detected (metadata exists but container is gone,
  // e.g. after a Docker/Colima restart), skip the destroy — `gateway start`
  // can recover the container without wiping metadata and mTLS certs.
  // The retry loop below will destroy only if start genuinely fails.
  if (hasStaleGateway(gwInfo)) {
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
  // Do NOT pass --gpu here. On DGX Spark (and most GPU hosts), inference is
  // routed through a host-side provider (Ollama, vLLM, or cloud API) — the
  // sandbox itself does not need direct GPU access. Passing --gpu causes
  // FailedPrecondition errors when the gateway's k3s device plugin cannot
  // allocate GPUs. See: https://build.nvidia.com/spark/nemoclaw/instructions
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
          if (isGatewayHealthy(status, namedInfo, currentInfo)) {
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
        onFailedAttempt: (err) => {
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
      console.error(`  Gateway failed to start after ${retries + 1} attempts.`);
      console.error("  Gateway state preserved for diagnostics.");
      console.error("");
      try {
        const logs = redact(
          runCaptureOpenshell(["doctor", "logs", "--name", GATEWAY_NAME], {
            ignoreError: true,
          }),
        );
        if (logs) {
          console.error("  Gateway logs:");
          for (const line of String(logs)
            .split("\n")
            .map((l) => l.replace(/\r/g, "").replace(ANSI_RE, ""))
            .filter(Boolean)) {
            console.error(`    ${line}`);
          }
          console.error("");
        }
      } catch {
        // doctor logs unavailable — fall through to manual instructions
      }
      console.error("  Troubleshooting:");
      console.error("    openshell doctor logs --name nemoclaw");
      console.error("    openshell doctor check");
      process.exit(1);
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

async function startGateway(_gpu) {
  return startGatewayWithOptions(_gpu, { exitOnFailure: true });
}

async function startGatewayForRecovery(_gpu) {
  return startGatewayWithOptions(_gpu, { exitOnFailure: false });
}

function getGatewayStartEnv() {
  const gatewayEnv = {};
  const openshellVersion = getInstalledOpenshellVersion();
  const stableGatewayImage = openshellVersion
    ? `ghcr.io/nvidia/openshell/cluster:${openshellVersion}`
    : null;
  if (stableGatewayImage && openshellVersion) {
    gatewayEnv.OPENSHELL_CLUSTER_IMAGE = stableGatewayImage;
    gatewayEnv.IMAGE_TAG = openshellVersion;
  }
  return gatewayEnv;
}

async function recoverGatewayRuntime() {
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
  let status = runCaptureOpenshell(["status"], { ignoreError: true });
  if (status.includes("Connected") && isSelectedGateway(status)) {
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
    startResult.status,
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
    if (status.includes("Connected") && isSelectedGateway(status)) {
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

async function promptValidatedSandboxName() {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const nameAnswer = await promptOrDefault(
      "  Sandbox name (lowercase, starts with letter, hyphens ok) [my-assistant]: ",
      "NEMOCLAW_SANDBOX_NAME",
      "my-assistant",
    );
    const sandboxName = (nameAnswer || "my-assistant").trim();

    try {
      const validatedSandboxName = validateName(sandboxName, "sandbox name");
      // Reject names that collide with global CLI commands.
      // A sandbox named 'status' makes 'nemoclaw status connect' route to
      // the global status command instead of the sandbox.
      const RESERVED_NAMES = new Set([
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
        "credentials",
        "help",
      ]);
      if (RESERVED_NAMES.has(sandboxName)) {
        console.error(`  Reserved name: '${sandboxName}' is a NemoClaw CLI command.`);
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
      console.error(`  ${error.message}`);
    }

    if (/^[0-9]/.test(sandboxName)) {
      console.error("  Names must start with a letter, not a digit.");
    } else {
      console.error("  Names must be lowercase, contain only letters, numbers, and hyphens,");
      console.error("  must start with a letter, and end with a letter or number.");
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

// eslint-disable-next-line complexity
async function createSandbox(
  gpu,
  model,
  provider,
  preferredInferenceApi = null,
  sandboxNameOverride = null,
  webSearchConfig = null,
  enabledChannels = null,
  fromDockerfile = null,
  agent = null,
  dangerouslySkipPermissions = false,
) {
  step(6, 8, "Creating sandbox");

  const sandboxName = validateName(
    sandboxNameOverride ?? (await promptValidatedSandboxName()),
    "sandbox name",
  );
  const effectivePort = agent ? agent.forwardPort : CONTROL_UI_PORT;
  const chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${effectivePort}`;

  // Check whether messaging providers will be needed — this must happen before
  // the sandbox reuse decision so we can detect stale sandboxes that were created
  // without provider attachments (security: prevents legacy raw-env-var leaks).
  const getMessagingToken = (envKey) =>
    getCredential(envKey) || normalizeCredentialValue(process.env[envKey]) || null;

  // The UI toggle list can include channels the user toggled on but then
  // skipped the token prompt for. Only channels with a real token will have a
  // provider attached, so the conflict check must filter out the skipped ones
  // (otherwise we warn about phantom channels that will never poll).
  const conflictCheckChannels: string[] = Array.isArray(enabledChannels)
    ? enabledChannels.filter((name) => {
        const def = MESSAGING_CHANNELS.find((c) => c.name === name);
        return def ? !!getMessagingToken(def.envKey) : false;
      })
    : [];

  // Messaging channels like Telegram (getUpdates), Discord (gateway), and Slack
  // (Socket Mode) enforce one consumer per bot token. Two sandboxes sharing
  // a token silently break both bridges (see #1953). Warn before we commit.
  if (conflictCheckChannels.length > 0) {
    const {
      backfillMessagingChannels,
      findChannelConflicts,
    } = require("./messaging-conflict");
    backfillMessagingChannels(registry, makeConflictProbe());
    const conflicts = findChannelConflicts(sandboxName, conflictCheckChannels, registry);
    if (conflicts.length > 0) {
      for (const { channel, sandbox } of conflicts) {
        console.log(
          `  ⚠ Sandbox '${sandbox}' already has ${channel} enabled. Bot tokens only allow one sandbox to poll — continuing will break both bridges.`,
        );
      }
      if (isNonInteractive()) {
        console.error(
          "  Aborting: resolve the messaging channel conflict above or run `nemoclaw <sandbox> destroy` on the other sandbox.",
        );
        process.exit(1);
      }
      const answer = (await promptOrDefault("  Continue anyway? [y/N]: ", null, "n"))
        .trim()
        .toLowerCase();
      if (answer !== "y" && answer !== "yes") {
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
  ].filter(({ envKey }) => !enabledEnvKeys || enabledEnvKeys.has(envKey));

  if (webSearchConfig) {
    messagingTokenDefs.push({
      name: `${sandboxName}-brave-search`,
      envKey: webSearch.BRAVE_API_KEY_ENV,
      token: getCredential(webSearch.BRAVE_API_KEY_ENV),
    });
  }
  const hasMessagingTokens = messagingTokenDefs.some(({ token }) => !!token);

  // Reconcile local registry state with the live OpenShell gateway state.
  const liveExists = pruneStaleSandboxEntry(sandboxName);

  // Declared outside the liveExists block so it is accessible during
  // post-creation restore (the sandbox create path runs after the block).
  let pendingStateRestore = null;

  if (liveExists) {
    const existingSandboxState = getSandboxReuseState(sandboxName);

    // Check whether messaging providers are missing from the gateway. Only
    // force recreation when at least one required provider doesn't exist yet —
    // this avoids destroying sandboxes already created with provider attachments.
    const needsProviderMigration =
      hasMessagingTokens &&
      messagingTokenDefs.some(({ name, token }) => token && !providerExistsInGateway(name));

    // Detect whether any messaging credential has been rotated since the
    // sandbox was created. Provider credentials are resolved once at sandbox
    // startup, so a rotated token requires a rebuild to take effect.
    const credentialRotation = hasMessagingTokens
      ? detectMessagingCredentialRotation(sandboxName, messagingTokenDefs)
      : { changed: false, changedProviders: [] };

    if (!isRecreateSandbox() && !needsProviderMigration && !credentialRotation.changed) {
      if (isNonInteractive()) {
        if (existingSandboxState === "ready") {
          // Upsert messaging providers even on reuse so credential changes take
          // effect without requiring a full sandbox recreation.
          upsertMessagingProviders(messagingTokenDefs);
          note(`  [non-interactive] Sandbox '${sandboxName}' exists and is ready — reusing it`);
          note("  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to force recreation.");
          ensureDashboardForward(sandboxName, chatUiUrl);
          return sandboxName;
        }
        console.error(`  Sandbox '${sandboxName}' already exists but is not ready.`);
        console.error("  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to overwrite.");
        process.exit(1);
      }

      if (existingSandboxState === "ready") {
        console.log(`  Sandbox '${sandboxName}' already exists.`);
        console.log("  Choosing 'n' will delete the existing sandbox and create a new one.");
        const answer = await promptOrDefault("  Reuse existing sandbox? [Y/n]: ", null, "y");
        const normalizedAnswer = answer.trim().toLowerCase();
        if (normalizedAnswer !== "n" && normalizedAnswer !== "no") {
          upsertMessagingProviders(messagingTokenDefs);
          ensureDashboardForward(sandboxName, chatUiUrl);
          return sandboxName;
        }
      } else {
        console.log(`  Sandbox '${sandboxName}' exists but is not ready.`);
        console.log("  Selecting 'n' will abort onboarding.");
        const answer = await promptOrDefault(
          "  Delete it and create a new one? [Y/n]: ",
          null,
          "y",
        );
        const normalizedAnswer = answer.trim().toLowerCase();
        if (normalizedAnswer === "n" || normalizedAnswer === "no") {
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
          note(`  ✓ State backed up (${backup.backedUpDirs.length} directories)`);
          pendingStateRestore = backup;
        } else {
          console.error("  State backup failed — aborting rebuild to prevent data loss.");
          console.error("  Pass --recreate-sandbox to force recreation without backup.");
          upsertMessagingProviders(messagingTokenDefs);
          // Update stored hashes so the next onboard doesn't re-detect rotation.
          const abortHashes = {};
          for (const { envKey, token } of messagingTokenDefs) {
            if (token) abortHashes[envKey] = hashCredential(token);
          }
          if (Object.keys(abortHashes).length > 0) {
            registry.updateSandbox(sandboxName, { providerCredentialHashes: abortHashes });
          }
          ensureDashboardForward(sandboxName, chatUiUrl);
          return sandboxName;
        }
      } catch (err) {
        console.error(`  State backup threw: ${err.message} — aborting rebuild.`);
        console.error("  Pass --recreate-sandbox to force recreation without backup.");
        upsertMessagingProviders(messagingTokenDefs);
        const abortHashes = {};
        for (const { envKey, token } of messagingTokenDefs) {
          if (token) abortHashes[envKey] = hashCredential(token);
        }
        if (Object.keys(abortHashes).length > 0) {
          registry.updateSandbox(sandboxName, { providerCredentialHashes: abortHashes });
        }
        ensureDashboardForward(sandboxName, chatUiUrl);
        return sandboxName;
      }
    }

    if (needsProviderMigration) {
      console.log(`  Sandbox '${sandboxName}' exists but messaging providers are not attached.`);
      console.log("  Recreating to ensure credentials flow through the provider pipeline.");
    } else if (credentialRotation.changed) {
      // Message already printed above during backup.
    } else if (existingSandboxState === "ready") {
      note(`  Sandbox '${sandboxName}' exists and is ready — recreating by explicit request.`);
    } else {
      note(`  Sandbox '${sandboxName}' exists but is not ready — recreating it.`);
    }

    const previousEntry = registry.getSandbox(sandboxName);
    if (previousEntry?.policies?.length > 0) {
      onboardSession.updateSession((current) => {
        current.policyPresets = previousEntry.policies;
        return current;
      });
    }

    note(`  Deleting and recreating sandbox '${sandboxName}'...`);

    // Destroy old sandbox
    runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    registry.removeSandbox(sandboxName);
  }

  // Stage build context — use the custom Dockerfile path when provided,
  // otherwise use the optimised default that only sends what the build needs.
  let buildCtx, stagedDockerfile;
  if (fromDockerfile) {
    const fromResolved = path.resolve(fromDockerfile);
    if (!fs.existsSync(fromResolved)) {
      console.error(`  Custom Dockerfile not found: ${fromResolved}`);
      process.exit(1);
    }
    buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
    stagedDockerfile = path.join(buildCtx, "Dockerfile");
    // Copy the entire parent directory as build context.
    try {
      fs.cpSync(path.dirname(fromResolved), buildCtx, {
        recursive: true,
        filter: (src) => {
          const base = path.basename(src);
          return !["node_modules", ".git", ".venv", "__pycache__"].includes(base);
        },
      });
    } catch (err) {
      if (err.code === "EACCES") {
        console.error(
          `  Permission denied while copying build context from: ${path.dirname(fromResolved)}`,
        );
        console.error(
          "  The --from flag uses the Dockerfile's parent directory as the Docker build context.",
        );
        console.error("  Move your Dockerfile to a dedicated directory and retry.");
        process.exit(1);
      }
      throw err;
    }
    // If the caller pointed at a file not named "Dockerfile", copy it to the
    // location openshell expects (buildCtx/Dockerfile).
    if (path.basename(fromResolved) !== "Dockerfile") {
      fs.copyFileSync(fromResolved, stagedDockerfile);
    }
    console.log(`  Using custom Dockerfile: ${fromResolved}`);
  } else if (agent) {
    const agentBuild = agentOnboard.createAgentSandbox(agent);
    buildCtx = agentBuild.buildCtx;
    stagedDockerfile = agentBuild.stagedDockerfile;
  } else {
    ({ buildCtx, stagedDockerfile } = stageOptimizedSandboxBuildContext(ROOT));
  }

  // Create sandbox (use -- echo to avoid dropping into interactive shell)
  // Pass the base policy so sandbox starts in proxy mode (required for policy updates later)
  const globalPermissivePath = path.join(
    ROOT,
    "nemoclaw-blueprint",
    "policies",
    "openclaw-sandbox-permissive.yaml",
  );
  let basePolicyPath;
  if (dangerouslySkipPermissions) {
    // Permissive mode: use agent-specific permissive policy if available,
    // otherwise fall back to the global permissive policy.
    const agentPermissive = agent && agentOnboard.getAgentPermissivePolicyPath(agent);
    basePolicyPath = agentPermissive || globalPermissivePath;
  } else {
    const defaultPolicyPath = path.join(
      ROOT,
      "nemoclaw-blueprint",
      "policies",
      "openclaw-sandbox.yaml",
    );
    basePolicyPath = (agent && agentOnboard.getAgentPolicyPath(agent)) || defaultPolicyPath;
  }
  const createArgs = [
    "--from",
    `${buildCtx}/Dockerfile`,
    "--name",
    sandboxName,
    "--policy",
    basePolicyPath,
  ];
  // --gpu is intentionally omitted. See comment in startGateway().

  // Create OpenShell providers for messaging credentials so they flow through
  // the provider/placeholder system instead of raw env vars. The L7 proxy
  // rewrites Authorization headers (Bearer/Bot) and URL-path segments
  // (/bot{TOKEN}/) with real secrets at egress (OpenShell ≥ 0.0.20).
  const messagingProviders = upsertMessagingProviders(messagingTokenDefs);
  for (const p of messagingProviders) {
    createArgs.push("--provider", p);
  }

  console.log(`  Creating sandbox '${sandboxName}' (this takes a few minutes on first run)...`);
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
    ...new Set(
      messagingTokenDefs
        .filter(({ token }) => !!token)
        .map(({ envKey }) => {
          if (envKey === "DISCORD_BOT_TOKEN") return "discord";
          if (envKey === "SLACK_BOT_TOKEN") return "slack";
          // SLACK_APP_TOKEN alone does not enable slack; bot token is required.
          if (envKey === "SLACK_APP_TOKEN")
            return tokensByEnvKey["SLACK_BOT_TOKEN"] ? "slack" : null;
          if (envKey === "TELEGRAM_BOT_TOKEN") return "telegram";
          return null;
        })
        .filter(Boolean),
    ),
  ];
  // Build allowed sender IDs map from env vars set during the messaging prompt.
  // Each channel with a userIdEnvKey in MESSAGING_CHANNELS may have a
  // comma-separated list of IDs (e.g. TELEGRAM_ALLOWED_IDS="123,456").
  const messagingAllowedIds = {};
  const enabledTokenEnvKeys = new Set(messagingTokenDefs.map(({ envKey }) => envKey));
  for (const ch of MESSAGING_CHANNELS) {
    if (
      enabledTokenEnvKeys.has(ch.envKey) &&
      ch.allowIdsMode === "dm" &&
      ch.userIdEnvKey &&
      process.env[ch.userIdEnvKey]
    ) {
      const ids = process.env[ch.userIdEnvKey]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length > 0) messagingAllowedIds[ch.name] = ids;
    }
  }
  const discordGuilds = {};
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
  // Pull the base image and resolve its digest so the Dockerfile is pinned to
  // exactly what we just fetched. This prevents stale :latest tags from
  // silently reusing a cached old image after NemoClaw upgrades (#1904).
  const resolved = pullAndResolveBaseImageDigest();
  if (resolved) {
    console.log(`  Pinning base image to ${resolved.digest.slice(0, 19)}...`);
  } else {
    // Check if the image exists locally before falling back to unpinned :latest.
    // On a first-time install behind a firewall with no cached image, warn early
    // so the user knows the build will likely fail.
    const localCheck = runCapture(
      ["docker", "image", "inspect", `${SANDBOX_BASE_IMAGE}:${SANDBOX_BASE_TAG}`],
      { ignoreError: true },
    );
    if (localCheck) {
      console.warn("  Warning: could not pull base image from registry; using cached :latest.");
    } else {
      console.warn(`  Warning: base image ${SANDBOX_BASE_IMAGE}:${SANDBOX_BASE_TAG} is not available locally.`);
      console.warn("  The build will fail unless Docker can pull the image during build.");
      console.warn("  If offline, pull the image manually first:");
      console.warn(`    docker pull ${SANDBOX_BASE_IMAGE}:${SANDBOX_BASE_TAG}`);
    }
  }
  patchStagedDockerfile(
    stagedDockerfile,
    model,
    chatUiUrl,
    String(Date.now()),
    provider,
    preferredInferenceApi,
    webSearchConfig,
    activeMessagingChannels,
    messagingAllowedIds,
    discordGuilds,
    resolved ? resolved.ref : null,
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
  // Pass the configured dashboard port into the sandbox so nemoclaw-start.sh
  // can unconditionally override CHAT_UI_URL even when the Docker image was
  // built with a different default. Without this, the baked-in Docker ENV
  // value takes precedence and the gateway starts on the wrong port. (#1925)
  if (process.env.NEMOCLAW_DASHBOARD_PORT) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_DASHBOARD_PORT", String(DASHBOARD_PORT)));
  }
  if (webSearchConfig?.fetchEnabled) {
    const braveKey =
      getCredential(webSearch.BRAVE_API_KEY_ENV) || process.env[webSearch.BRAVE_API_KEY_ENV];
    if (braveKey) {
      envArgs.push(formatEnvAssignment(webSearch.BRAVE_API_KEY_ENV, braveKey));
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

  // Clean up build context regardless of outcome
  run(["rm", "-rf", buildCtx], { ignoreError: true });

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
  for (let i = 0; i < 30; i++) {
    const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
    if (isSandboxReady(list, sandboxName)) {
      ready = true;
      break;
    }
    sleep(2);
  }

  if (!ready) {
    // Clean up the orphaned sandbox so the next onboard retry with the same
    // name doesn't fail on "sandbox already exists".
    const delResult = runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    console.error("");
    console.error(`  Sandbox '${sandboxName}' was created but did not become ready within 60s.`);
    if (delResult.status === 0) {
      console.error("  The orphaned sandbox has been removed — you can safely retry.");
    } else {
      console.error(`  Could not remove the orphaned sandbox. Manual cleanup:`);
      console.error(`    openshell sandbox delete "${sandboxName}"`);
    }
    console.error("  Retry: nemoclaw onboard");
    process.exit(1);
  }

  // Wait for NemoClaw dashboard to become fully ready (web server live)
  // This prevents port forwards from connecting to a non-existent port
  // or seeing 502/503 errors during initial load.
  console.log("  Waiting for NemoClaw dashboard to become ready...");
  const openshellBin = getOpenshellBinary();
  for (let i = 0; i < 15; i++) {
    const readyMatch = runCaptureOpenshell(
      ["sandbox", "exec", sandboxName, "curl", "-sf", `http://localhost:${effectivePort}/`],
      { ignoreError: true },
    );
    if (readyMatch) {
      console.log("  ✓ Dashboard is live");
      break;
    }
    if (i === 14) {
      console.warn("  Dashboard taking longer than expected to start. Continuing...");
    } else {
      sleep(2);
    }
  }

  // Release any stale forward on the dashboard port before claiming it for the new sandbox.
  // A previous onboard run may have left the port forwarded to a different sandbox,
  // which would silently prevent the new sandbox's dashboard from being reachable.
  ensureDashboardForward(sandboxName, chatUiUrl);

  // Register only after confirmed ready — prevents phantom entries
  const effectiveAgent = agent || agentDefs.loadAgent("openclaw");
  const providerCredentialHashes = {};
  for (const { envKey, token } of messagingTokenDefs) {
    if (token) {
      providerCredentialHashes[envKey] = hashCredential(token);
    }
  }
  registry.registerSandbox({
    name: sandboxName,
    model: model || null,
    provider: provider || null,
    gpuEnabled: !!gpu,
    agent: agent ? agent.name : null,
    agentVersion: fromDockerfile ? null : effectiveAgent.expectedVersion || null,
    dangerouslySkipPermissions: dangerouslySkipPermissions || undefined,
    providerCredentialHashes:
      Object.keys(providerCredentialHashes).length > 0 ? providerCredentialHashes : undefined,
    messagingChannels: activeMessagingChannels,
  });

  // Restore workspace state if we backed it up during credential rotation.
  if (pendingStateRestore?.success) {
    note("  Restoring workspace state after credential rotation...");
    const restore = sandboxState.restoreSandboxState(
      sandboxName,
      pendingStateRestore.manifest.backupPath,
    );
    if (restore.success) {
      note(`  ✓ State restored (${restore.restoredDirs.length} directories)`);
    } else {
      console.error(
        `  Warning: partial restore. Manual recovery: ${pendingStateRestore.manifest.backupPath}`,
      );
    }
  }

  // DNS proxy — run a forwarder in the sandbox pod so the isolated
  // sandbox namespace can resolve hostnames (fixes #626).
  console.log("  Setting up sandbox DNS proxy...");
  runFile("bash", [path.join(SCRIPTS, "setup-dns-proxy.sh"), GATEWAY_NAME, sandboxName], {
    ignoreError: true,
  });

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
      const vmKernel = runCapture(["docker", "info", "--format", "{{.KernelVersion}}"], { ignoreError: true }).trim();
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

// eslint-disable-next-line complexity
async function setupNim(gpu) {
  step(3, 8, "Configuring inference (NIM)");

  let model = null;
  let provider = REMOTE_PROVIDER_CONFIG.build.providerName;
  let nimContainer = null;
  let endpointUrl = REMOTE_PROVIDER_CONFIG.build.endpointUrl;
  let credentialEnv = REMOTE_PROVIDER_CONFIG.build.credentialEnv;
  let preferredInferenceApi = null;

  // Detect local inference options
  // "command -v" is a shell builtin — must go through bash.
  const hasOllama = !!runCapture("command -v ollama", { ignoreError: true });
  const ollamaRunning = !!runCapture(["curl", "-sf", `http://127.0.0.1:${OLLAMA_PORT}/api/tags`], {
    ignoreError: true,
  });
  const vllmRunning = !!runCapture(["curl", "-sf", `http://127.0.0.1:${VLLM_PORT}/v1/models`], {
    ignoreError: true,
  });
  const requestedProvider = isNonInteractive() ? getNonInteractiveProvider() : null;
  const requestedModel = isNonInteractive()
    ? getNonInteractiveModel(requestedProvider || "build")
    : null;
  const options = [];
  options.push({ key: "build", label: "NVIDIA Endpoints" });
  options.push({ key: "openai", label: "OpenAI" });
  options.push({ key: "custom", label: "Other OpenAI-compatible endpoint" });
  options.push({ key: "anthropic", label: "Anthropic" });
  options.push({ key: "anthropicCompatible", label: "Other Anthropic-compatible endpoint" });
  options.push({ key: "gemini", label: "Google Gemini" });
  if (hasOllama || ollamaRunning) {
    options.push({
      key: "ollama",
      label:
        `Local Ollama (localhost:${OLLAMA_PORT})${ollamaRunning ? " — running" : ""}` +
        (ollamaRunning ? " (suggested)" : ""),
    });
  }
  if (EXPERIMENTAL && gpu && gpu.nimCapable) {
    options.push({ key: "nim-local", label: "Local NVIDIA NIM [experimental]" });
  }
  if (EXPERIMENTAL && vllmRunning) {
    options.push({
      key: "vllm",
      label: "Local vLLM [experimental] — running",
    });
  }
  // On macOS without Ollama, offer to install it
  if (!hasOllama && process.platform === "darwin") {
    options.push({ key: "install-ollama", label: "Install Ollama (macOS)" });
  }

  if (options.length > 1) {
    selectionLoop: while (true) {
      let selected;

      if (isNonInteractive()) {
        const providerKey = requestedProvider || "build";
        selected = options.find((o) => o.key === providerKey);
        if (!selected) {
          console.error(
            `  Requested provider '${providerKey}' is not available in this environment.`,
          );
          process.exit(1);
        }
        note(`  [non-interactive] Provider: ${selected.key}`);
      } else {
        const suggestions = [];
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

        if (selected.key === "build") {
          // Allow NEMOCLAW_PROVIDER_KEY as a fallback for NVIDIA_API_KEY
          const _nvProviderKey = (process.env.NEMOCLAW_PROVIDER_KEY || "").trim();
          if (_nvProviderKey && !process.env.NVIDIA_API_KEY) {
            process.env.NVIDIA_API_KEY = _nvProviderKey;
          }
          if (isNonInteractive()) {
            if (!process.env.NVIDIA_API_KEY) {
              console.error(
                "  NVIDIA_API_KEY (or NEMOCLAW_PROVIDER_KEY) is required for NVIDIA Endpoints in non-interactive mode.",
              );
              process.exit(1);
            }
            const keyError = validateNvidiaApiKeyValue(process.env.NVIDIA_API_KEY);
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
          const _providerKeyHint = (process.env.NEMOCLAW_PROVIDER_KEY || "").trim();
          if (_providerKeyHint && !process.env[credentialEnv]) {
            process.env[credentialEnv] = _providerKeyHint;
          }

          if (isNonInteractive()) {
            if (!process.env[credentialEnv]) {
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
          const defaultModel = requestedModel || _envModelRemote || remoteConfig.defaultModel;
          let modelValidator = null;
          if (selected.key === "openai" || selected.key === "gemini") {
            const modelAuthMode = getProbeAuthMode(provider);
            modelValidator = (candidate) =>
              validateOpenAiLikeModel(
                remoteConfig.label,
                endpointUrl,
                candidate,
                getCredential(credentialEnv),
                ...(modelAuthMode ? [{ authMode: modelAuthMode }] : []),
              );
          } else if (selected.key === "anthropic") {
            modelValidator = (candidate) =>
              validateAnthropicModel(
                endpointUrl || ANTHROPIC_ENDPOINT_URL,
                candidate,
                getCredential(credentialEnv),
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
                endpointUrl,
                model,
                credentialEnv,
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
                if (explicitApi && explicitApi !== "openai-completions" && explicitApi !== "chat-completions") {
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
                credentialEnv,
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
                  credentialEnv,
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
                  credentialEnv,
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
        // List models that fit GPU VRAM
        const models = nim.listModels().filter((m) => m.minGpuMemoryMB <= gpu.totalMemoryMB);
        if (models.length === 0) {
          console.log("  No NIM models fit your GPU VRAM. Falling back to cloud API.");
        } else {
          let sel;
          if (isNonInteractive()) {
            if (requestedModel) {
              sel = models.find((m) => m.name === requestedModel);
              if (!sel) {
                console.error(`  Unsupported NEMOCLAW_MODEL for NIM: ${requestedModel}`);
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
            let ngcKey = normalizeCredentialValue(await prompt("  NGC API Key: ", { secret: true }));
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
          }

          console.log(`  Pulling NIM image for ${model}...`);
          nim.pullNimImage(model);

          console.log("  Starting NIM container...");
          nimContainer = nim.startNimContainerByName(nim.containerName(GATEWAY_NAME), model);

          console.log("  Waiting for NIM to become healthy...");
          if (!nim.waitForNimHealth()) {
            console.error("  NIM failed to start. Falling back to cloud API.");
            model = null;
            nimContainer = null;
          } else {
            provider = "vllm-local";
            credentialEnv = "OPENAI_API_KEY";
            endpointUrl = getLocalProviderBaseUrl(provider);
            const validation = await validateOpenAiLikeSelection(
              "Local NVIDIA NIM",
              endpointUrl,
              model,
              credentialEnv,
            );
            if (
              validation.retry === "selection" ||
              validation.retry === "back" ||
              validation.retry === "model"
            ) {
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
        if (!ollamaRunning) {
          console.log("  Starting Ollama...");
          // On WSL2, binding to 0.0.0.0 creates a dual-stack socket that Docker
          // cannot reach via host-gateway. The default 127.0.0.1 binding works
          // because WSL2 relays IPv4-only sockets to the Windows host.
          // Shell required: backgrounding (&), env var prefix, output redirection.
          const ollamaEnv = isWsl() ? "" : `OLLAMA_HOST=0.0.0.0:${OLLAMA_PORT} `;
          run(`${ollamaEnv}ollama serve > /dev/null 2>&1 &`, { ignoreError: true });
          sleep(2);
          if (!isWsl()) printOllamaExposureWarning();
        }
        if (isWsl()) {
          // WSL2 doesn't need the proxy — Docker can reach the host directly.
          console.log(`  ✓ Using Ollama on localhost:${OLLAMA_PORT}`);
        } else {
          if (!startOllamaAuthProxy()) {
            process.exit(1);
          }
          console.log(`  ✓ Using Ollama on localhost:${OLLAMA_PORT} (proxy on :${OLLAMA_PROXY_PORT})`);
        }
        provider = "ollama-local";
        credentialEnv = "OPENAI_API_KEY";
        endpointUrl = getLocalProviderBaseUrl(provider);
        while (true) {
          const installedModels = getOllamaModelOptions();
          if (isNonInteractive()) {
            model = requestedModel || getDefaultOllamaModel(gpu);
          } else {
            model = await promptOllamaModel(gpu);
          }
          if (model === BACK_TO_SELECTION) {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
          const probe = prepareOllamaModel(model, installedModels);
          if (!probe.ok) {
            console.error(`  ${probe.message}`);
            if (isNonInteractive()) {
              process.exit(1);
            }
            console.log("  Choose a different Ollama model or select Other.");
            console.log("");
            continue;
          }
          const validation = await validateOpenAiLikeSelection(
            "Local Ollama",
            getLocalProviderValidationBaseUrl(provider),
            model,
            null,
            "Choose a different Ollama model or select Other.",
          );
          if (validation.retry === "selection" || validation.retry === "back") {
            continue selectionLoop;
          }
          if (!validation.ok) {
            continue;
          }
          // Ollama's /v1/responses endpoint does not produce correctly
          // formatted tool calls — force chat completions like vLLM/NIM.
          if (validation.api !== "openai-completions") {
            console.log(
              "  ℹ Using chat completions API (Ollama tool calls require /v1/chat/completions)",
            );
          }
          preferredInferenceApi = "openai-completions";
          break;
        }
        break;
      } else if (selected.key === "install-ollama") {
        // macOS only — this option is gated by process.platform === "darwin" above
        console.log("  Installing Ollama via Homebrew...");
        run(["brew", "install", "ollama"], { ignoreError: true });
        console.log("  Starting Ollama...");
        // Shell required: backgrounding (&), env var prefix, output redirection.
        run(`OLLAMA_HOST=0.0.0.0:${OLLAMA_PORT} ollama serve > /dev/null 2>&1 &`, { ignoreError: true });
        sleep(2);
        if (!startOllamaAuthProxy()) {
          process.exit(1);
        }
        console.log(`  ✓ Using Ollama on localhost:${OLLAMA_PORT} (proxy on :${OLLAMA_PROXY_PORT})`);
        provider = "ollama-local";
        credentialEnv = "OPENAI_API_KEY";
        endpointUrl = getLocalProviderBaseUrl(provider);
        while (true) {
          const installedModels = getOllamaModelOptions();
          if (isNonInteractive()) {
            model = requestedModel || getDefaultOllamaModel(gpu);
          } else {
            model = await promptOllamaModel(gpu);
          }
          if (model === BACK_TO_SELECTION) {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
          const probe = prepareOllamaModel(model, installedModels);
          if (!probe.ok) {
            console.error(`  ${probe.message}`);
            if (isNonInteractive()) {
              process.exit(1);
            }
            console.log("  Choose a different Ollama model or select Other.");
            console.log("");
            continue;
          }
          const validation = await validateOpenAiLikeSelection(
            "Local Ollama",
            getLocalProviderValidationBaseUrl(provider),
            model,
            null,
            "Choose a different Ollama model or select Other.",
          );
          if (validation.retry === "selection" || validation.retry === "back") {
            continue selectionLoop;
          }
          if (!validation.ok) {
            continue;
          }
          // Ollama's /v1/responses endpoint does not produce correctly
          // formatted tool calls — force chat completions like vLLM/NIM.
          if (validation.api !== "openai-completions") {
            console.log(
              "  ℹ Using chat completions API (Ollama tool calls require /v1/chat/completions)",
            );
          }
          preferredInferenceApi = "openai-completions";
          break;
        }
        break;
      } else if (selected.key === "vllm") {
        console.log(`  ✓ Using existing vLLM on localhost:${VLLM_PORT}`);
        provider = "vllm-local";
        credentialEnv = "OPENAI_API_KEY";
        endpointUrl = getLocalProviderBaseUrl(provider);
        // Query vLLM for the actual model ID
        const vllmModelsRaw = runCapture(["curl", "-sf", `http://127.0.0.1:${VLLM_PORT}/v1/models`], {
          ignoreError: true,
        });
        try {
          const vllmModels = JSON.parse(vllmModelsRaw);
          if (vllmModels.data && vllmModels.data.length > 0) {
            model = vllmModels.data[0].id;
            if (!isSafeModelId(model)) {
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
        const validation = await validateOpenAiLikeSelection(
          "Local vLLM",
          getLocalProviderValidationBaseUrl(provider),
          model,
          credentialEnv,
        );
        if (
          validation.retry === "selection" ||
          validation.retry === "back" ||
          validation.retry === "model"
        ) {
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
      }
    }
  }

  return { model, provider, endpointUrl, credentialEnv, preferredInferenceApi, nimContainer };
}

// ── Step 4: Inference provider ───────────────────────────────────

// eslint-disable-next-line complexity
async function setupInference(
  sandboxName,
  model,
  provider,
  endpointUrl = null,
  credentialEnv = null,
) {
  step(4, 8, "Setting up inference provider");
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });

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
      console.error(`  ${validation.message}`);
      process.exit(1);
    }
    const baseUrl = getLocalProviderBaseUrl(provider);
    const providerResult = upsertProvider("vllm-local", "openai", "OPENAI_API_KEY", baseUrl, {
      OPENAI_API_KEY: "dummy",
    });
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
  } else if (provider === "ollama-local") {
    const validation = validateLocalProvider(provider);
    if (!validation.ok) {
      console.error(`  ${validation.message}`);
      if (process.platform === "darwin") {
        console.error("  On macOS, local inference also depends on OpenShell host routing support.");
      }
      process.exit(1);
    }
    const baseUrl = getLocalProviderBaseUrl(provider);
    let ollamaCredential = "ollama";
    if (!isWsl()) {
      ensureOllamaAuthProxy();
      const proxyToken = getOllamaProxyToken();
      if (!proxyToken) {
        console.error("  Ollama auth proxy token is not set. Re-run onboard to initialize the proxy.");
        process.exit(1);
      }
      ollamaCredential = proxyToken;
      // Persist token now that ollama-local is confirmed as the provider.
      // Not persisted earlier in case the user backs out to a different provider.
      persistProxyToken(proxyToken);
    }
    const providerResult = upsertProvider("ollama-local", "openai", "OPENAI_API_KEY", baseUrl, {
      OPENAI_API_KEY: ollamaCredential,
    });
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
  }

  verifyInferenceRoute(provider, model);
  registry.updateSandbox(sandboxName, { model, provider });
  console.log(`  ✓ Inference route set: ${provider} / ${model}`);
  return { ok: true };
}

// ── Step 6: Messaging channels ───────────────────────────────────

const MESSAGING_CHANNELS = listChannels();

// Curl exit codes that indicate a network-level failure (not a token problem).
// 35 (TLS handshake failure) covers corporate proxies that MITM HTTPS.
const TELEGRAM_NETWORK_CURL_CODES = new Set([6, 7, 28, 35, 52, 56]);

async function checkTelegramReachability(token: string) {
  const result = runCurlProbe([
    "-sS",
    "--connect-timeout", "5",
    "--max-time", "10",
    `https://api.telegram.org/bot${token}/getMe`,
  ]);

  // HTTP 200 with "ok":true — Telegram is reachable and token is valid.
  if (result.ok) return;

  // HTTP 401 or 404 — token was rejected by Telegram (not a network issue).
  if (result.httpStatus === 401 || result.httpStatus === 404) {
    console.log(
      "  ⚠ Bot token was rejected by Telegram — verify the token is correct.",
    );
    return;
  }

  // Network-level failure — Telegram is unreachable from this host.
  if (result.curlStatus && TELEGRAM_NETWORK_CURL_CODES.has(result.curlStatus)) {
    console.log("");
    console.log("  ⚠ api.telegram.org is not reachable from this host.");
    console.log("    Telegram integration requires outbound HTTPS access to api.telegram.org.");
    console.log("    This is commonly blocked by corporate network proxies.");

    if (isNonInteractive()) {
      console.error("  Aborting onboarding in non-interactive mode due to Telegram network reachability failure.");
      process.exit(1);
    } else {
      const answer = (await promptOrDefault("    Continue anyway? [y/N]: ", null, "n"))
        .trim()
        .toLowerCase();
      if (answer !== "y" && answer !== "yes") {
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

async function setupMessagingChannels() {
  step(5, 8, "Messaging channels");

  const getMessagingToken = (envKey) =>
    getCredential(envKey) || normalizeCredentialValue(process.env[envKey]) || null;

  // Non-interactive: skip prompt, tokens come from env/credentials
  if (isNonInteractive() || process.env.NEMOCLAW_NON_INTERACTIVE === "1") {
    const found = MESSAGING_CHANNELS.filter((c) => getMessagingToken(c.envKey)).map((c) => c.name);
    if (found.length > 0) {
      note(`  [non-interactive] Messaging tokens detected: ${found.join(", ")}`);
      if (found.includes("telegram")) {
        await checkTelegramReachability(getMessagingToken("TELEGRAM_BOT_TOKEN"));
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

  await new Promise((resolve, reject) => {
    const input = process.stdin;
    let rawModeEnabled = false;
    let finished = false;

    function cleanup() {
      input.removeListener("data", onData);
      if (rawModeEnabled && typeof input.setRawMode === "function") {
        input.setRawMode(false);
      }
    }

    function finish() {
      if (finished) return;
      finished = true;
      cleanup();
      output.write("\n");
      resolve();
    }

    function onData(chunk) {
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
    if (ch.serverIdEnvKey) {
      const existingServerIds = process.env[ch.serverIdEnvKey] || "";
      if (existingServerIds) {
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
    if (ch.requireMentionEnvKey && ch.serverIdEnvKey && process.env[ch.serverIdEnvKey]) {
      const existingRequireMention = process.env[ch.requireMentionEnvKey];
      if (existingRequireMention === "0" || existingRequireMention === "1") {
        const mode = existingRequireMention === "0" ? "all messages" : "@mentions only";
        console.log(`  ✓ ${ch.name} — reply mode already set: ${mode}`);
      } else {
        console.log(`  ${ch.requireMentionHelp}`);
        const answer = (await prompt("  Reply only when @mentioned? [Y/n]: ")).trim().toLowerCase();
        process.env[ch.requireMentionEnvKey] = answer === "n" || answer === "no" ? "0" : "1";
        const mode =
          process.env[ch.requireMentionEnvKey] === "0" ? "all messages" : "@mentions only";
        console.log(`  ✓ ${ch.name} reply mode saved: ${mode}`);
      }
    }
    // Prompt for user/sender ID when the channel supports allowlisting
    if (ch.userIdEnvKey && (!ch.serverIdEnvKey || process.env[ch.serverIdEnvKey])) {
      const existingIds = process.env[ch.userIdEnvKey] || "";
      if (existingIds) {
        console.log(`  ✓ ${ch.name} — allowed IDs already set: ${existingIds}`);
      } else {
        console.log(`  ${ch.userIdHelp}`);
        const userId = (await prompt(`  ${ch.userIdLabel}: `)).trim();
        if (userId) {
          process.env[ch.userIdEnvKey] = userId;
          console.log(`  ✓ ${ch.name} user ID saved`);
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
  if (
    !isNonInteractive() &&
    enabled.has("telegram") &&
    getMessagingToken("TELEGRAM_BOT_TOKEN")
  ) {
    await checkTelegramReachability(getMessagingToken("TELEGRAM_BOT_TOKEN"));
  }

  return Array.from(enabled);
}

function getSuggestedPolicyPresets({ enabledChannels = null, webSearchConfig = null, provider = null } = {}) {
  const suggestions = ["pypi", "npm"];

  // Auto-suggest local-inference preset when a local provider is selected
  if (provider && LOCAL_INFERENCE_PROVIDERS.includes(provider)) {
    suggestions.push("local-inference");
  }
  const usesExplicitMessagingSelection = Array.isArray(enabledChannels);

  const maybeSuggestMessagingPreset = (channel, envKey) => {
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

async function setupOpenclaw(sandboxName, model, provider) {
  step(7, 8, "Setting up OpenClaw inside sandbox");

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
      run(
        openshellArgv(["sandbox", "connect", sandboxName]),
        { stdio: ["pipe", "ignore", "inherit"], input: scriptContent },
      );
    } finally {
      cleanupTempDir(scriptFile, "nemoclaw-sync");
    }
  }

  console.log("  ✓ OpenClaw gateway launched inside sandbox");
}

// ── Step 7: Policy presets ───────────────────────────────────────

// eslint-disable-next-line complexity
async function _setupPolicies(sandboxName, options = {}) {
  step(8, 8, "Policy presets");
  const suggestions = getSuggestedPolicyPresets(options);

  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  if (isNonInteractive()) {
    const policyMode = (process.env.NEMOCLAW_POLICY_MODE || "suggested").trim().toLowerCase();
    let selectedPresets = suggestions;

    if (policyMode === "skip" || policyMode === "none" || policyMode === "no") {
      note("  [non-interactive] Skipping policy presets.");
      return;
    }

    if (policyMode === "custom" || policyMode === "list") {
      selectedPresets = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
      if (selectedPresets.length === 0) {
        console.error("  NEMOCLAW_POLICY_PRESETS is required when NEMOCLAW_POLICY_MODE=custom.");
        process.exit(1);
      }
    } else if (policyMode === "suggested" || policyMode === "default" || policyMode === "auto") {
      const envPresets = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
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
          const message = err && err.message ? err.message : String(err);
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

function arePolicyPresetsApplied(sandboxName, selectedPresets = []) {
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
async function selectPolicyTier() {
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

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.removeListener("SIGTERM", onSigterm);
    };

    const onSigterm = () => {
      cleanup();
      process.exit(1);
    };
    process.once("SIGTERM", onSigterm);

    const onData = (key) => {
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
async function selectTierPresetsAndAccess(tierName, allPresets, extraSelected = []) {
  const tierDef = tiers.getTier(tierName);
  const tierPresetMap = {};
  if (tierDef) {
    for (const p of tierDef.presets) {
      tierPresetMap[p.name] = p.access;
    }
  }

  // Tier presets first (in tier order), then the rest in their original order.
  const tierNames = tierDef ? tierDef.presets.map((p) => p.name) : [];
  const tierSet = new Set(tierNames);
  const ordered = [
    ...tierNames.map((name) => allPresets.find((p) => p.name === name)).filter(Boolean),
    ...allPresets.filter((p) => !tierSet.has(p.name)),
  ];

  // Initial inclusion: tier presets + any already-applied extras.
  const included = new Set([
    ...tierNames,
    ...extraSelected.filter((n) => ordered.find((p) => p.name === n)),
  ]);

  // Access levels: tier defaults for tier presets, read-write default for others.
  const accessModes = {};
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

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.removeListener("SIGTERM", onSigterm);
    };

    const onSigterm = () => {
      cleanup();
      process.exit(1);
    };
    process.once("SIGTERM", onSigterm);

    const onData = (key) => {
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
        const name = ordered[cursor].name;
        if (included.has(name)) {
          included.delete(name);
        } else {
          included.add(name);
        }
        redraw();
      } else if (key === "r" || key === "R") {
        const name = ordered[cursor].name;
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
async function presetsCheckboxSelector(allPresets, initialSelected) {
  const selected = new Set(initialSelected);
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

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.removeListener("SIGTERM", onSigterm);
    };

    const onSigterm = () => {
      cleanup();
      process.exit(1);
    };
    process.once("SIGTERM", onSigterm);

    const onData = (key) => {
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
        const name = allPresets[cursor].name;
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

function computeSetupPresetSuggestions(tierName, options = {}) {
  const { enabledChannels = null, webSearchConfig = null, provider = null } = options;
  const known = Array.isArray(options.knownPresetNames) ? new Set(options.knownPresetNames) : null;
  const suggestions = tiers.resolveTierPresets(tierName).map((p) => p.name);
  const add = (name) => {
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

// eslint-disable-next-line complexity
async function setupPoliciesWithSelection(sandboxName, options = {}) {
  const selectedPresets = Array.isArray(options.selectedPresets) ? options.selectedPresets : null;
  const onSelection = typeof options.onSelection === "function" ? options.onSelection : null;
  const webSearchConfig = options.webSearchConfig || null;
  const enabledChannels = Array.isArray(options.enabledChannels) ? options.enabledChannels : null;
  const provider = options.provider || null;

  step(8, 8, "Policy presets");

  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);
  let chosen = selectedPresets;

  // Resume path: caller supplies the preset list from a previous run.
  if (chosen && chosen.length > 0) {
    if (onSelection) onSelection(chosen);
    if (!waitForSandboxReady(sandboxName)) {
      console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
      process.exit(1);
    }
    note(`  [resume] Reapplying policy presets: ${chosen.join(", ")}`);
    for (const name of chosen) {
      if (applied.includes(name)) continue;
      policies.applyPreset(sandboxName, name);
    }
    return chosen;
  }

  // Tier selection — determines the default preset list for this install.
  const tierName = await selectPolicyTier();
  registry.updateSandbox(sandboxName, { policyTier: tierName });
  const suggestions = computeSetupPresetSuggestions(tierName, {
    enabledChannels,
    webSearchConfig,
    provider,
    knownPresetNames: allPresets.map((p) => p.name),
  });

  if (isNonInteractive()) {
    const policyMode = (process.env.NEMOCLAW_POLICY_MODE || "suggested").trim().toLowerCase();
    chosen = suggestions;

    if (policyMode === "skip" || policyMode === "none" || policyMode === "no") {
      note("  [non-interactive] Skipping policy presets.");
      return [];
    }

    if (policyMode === "custom" || policyMode === "list") {
      chosen = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
      if (chosen.length === 0) {
        console.error("  NEMOCLAW_POLICY_PRESETS is required when NEMOCLAW_POLICY_MODE=custom.");
        process.exit(1);
      }
    } else if (policyMode === "suggested" || policyMode === "default" || policyMode === "auto") {
      const envPresets = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
      if (envPresets.length > 0) chosen = envPresets;
    } else {
      console.error(`  Unsupported NEMOCLAW_POLICY_MODE: ${policyMode}`);
      console.error("  Valid values: suggested, custom, skip");
      process.exit(1);
    }

    const knownPresets = new Set(allPresets.map((p) => p.name));
    const invalidPresets = chosen.filter((name) => !knownPresets.has(name));
    if (invalidPresets.length > 0) {
      console.error(`  Unknown policy preset(s): ${invalidPresets.join(", ")}`);
      process.exit(1);
    }

    if (onSelection) onSelection(chosen);
    if (!waitForSandboxReady(sandboxName)) {
      console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
      process.exit(1);
    }
    note(`  [non-interactive] Applying policy presets: ${chosen.join(", ")}`);
    for (const name of chosen) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          policies.applyPreset(sandboxName, name);
          break;
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          if (!message.includes("sandbox not found") || attempt === 2) {
            throw err;
          }
          sleep(2);
        }
      }
    }
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

  const accessByName = {};
  for (const p of resolvedPresets) accessByName[p.name] = p.access;
  const newlySelected = interactiveChoice.filter((name) => !applied.includes(name));
  const deselected = applied.filter((name) => !interactiveChoice.includes(name));

  for (const name of deselected) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (!policies.removePreset(sandboxName, name)) {
          throw new Error(`Failed to remove preset '${name}'.`);
        }
        break;
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (!message.includes("sandbox not found") || attempt === 2) {
          throw err;
        }
        sleep(2);
      }
    }
  }

  for (const name of newlySelected) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // Pass access mode so applyPreset can distinguish read vs read-write
        // when preset infrastructure supports it.
        policies.applyPreset(sandboxName, name, { access: accessByName[name] });
        break;
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (!message.includes("sandbox not found") || attempt === 2) {
          throw err;
        }
        sleep(2);
      }
    }
  }
  return interactiveChoice;
}

// ── Dashboard ────────────────────────────────────────────────────

const CONTROL_UI_PORT = DASHBOARD_PORT;

// Dashboard helpers — delegated to src/lib/dashboard.ts
// isLoopbackHostname — see urlUtils import above
const { resolveDashboardForwardTarget, buildControlUiUrls } = dashboard;

function ensureDashboardForward(sandboxName, chatUiUrl = `http://127.0.0.1:${CONTROL_UI_PORT}`) {
  const portToStop = getDashboardForwardPort(chatUiUrl);
  const forwardTarget = getDashboardForwardTarget(chatUiUrl);
  // Detect port already claimed by a different sandbox and fail fast with an
  // actionable message rather than silently stealing that sandbox's forward.
  // (Same sandbox is always allowed — covers reconnect and resume paths.)
  const existingForwards = runCaptureOpenshell(["forward", "list"], { ignoreError: true });
  // Parse line-by-line to avoid false positives from substring matches.
  // openshell forward list columns: SANDBOX  BIND  PORT  PID  STATUS
  // Port is at column index 2; sandbox name is at column index 0.
  const portLine = existingForwards
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => {
      const parts = l.split(/\s+/);
      return parts[2] === portToStop;
    });
  const portOwner = portLine ? (portLine.split(/\s+/)[0] ?? null) : null;
  if (portOwner !== null && portOwner !== sandboxName) {
    throw new Error(
      `Port ${portToStop} is already forwarded for sandbox '${portOwner}'. ` +
        `Set CHAT_UI_URL to a different local port (e.g. http://127.0.0.1:18790) ` +
        `before onboarding a second sandbox.`,
    );
  }
  runOpenshell(["forward", "stop", portToStop], { ignoreError: true });
  // Use stdio "ignore" to prevent spawnSync from waiting on inherited pipe fds.
  // The --background flag forks a child that inherits stdout/stderr; if those are
  // pipes, spawnSync blocks until the background process exits (never).
  const fwdResult = runOpenshell(["forward", "start", "--background", forwardTarget, sandboxName], {
    ignoreError: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  // A non-zero exit from the parent means forward start rejected before forking —
  // typically because the port is already bound by another process (e.g. a local
  // Docker test container with -p PORT:PORT). The error is otherwise swallowed by
  // ignoreError + stdio:ignore, leaving the dashboard URL silently unreachable (#1925).
  if (fwdResult && fwdResult.status !== 0) {
    console.warn(`! Port ${portToStop} forward did not start — port may be in use by another process.`);
    console.warn(`  Check: docker ps --format 'table {{.Names}}\\t{{.Ports}}' | grep ${portToStop}`);
    console.warn(`  Free the port, then reconnect: nemoclaw ${sandboxName} connect`);
  }
}

function findOpenclawJsonPath(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found = findOpenclawJsonPath(p);
      if (found) return found;
    } else if (e.name === "openclaw.json") {
      return p;
    }
  }
  return null;
}

/**
 * Pull gateway.auth.token from the sandbox image via openshell sandbox download
 * so onboard can print copy-paste Control UI URLs with #token= (same idea as nemoclaw-start.sh).
 */
function fetchGatewayAuthTokenFromSandbox(sandboxName) {
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

// buildControlUiUrls — see dashboard import above

function getDashboardForwardPort(
  chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
) {
  const forwardTarget = resolveDashboardForwardTarget(chatUiUrl);
  return forwardTarget.includes(":")
    ? (forwardTarget.split(":").pop() ?? String(CONTROL_UI_PORT))
    : forwardTarget;
}

function getDashboardForwardTarget(
  chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
  options = {},
) {
  const port = getDashboardForwardPort(chatUiUrl);
  return isWsl(options) ? `0.0.0.0:${port}` : resolveDashboardForwardTarget(chatUiUrl);
}

function getDashboardForwardStartCommand(sandboxName, options = {}) {
  const chatUiUrl =
    options.chatUiUrl || process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`;
  const forwardTarget = getDashboardForwardTarget(chatUiUrl, options);
  return `${openshellShellCommand(
    ["forward", "start", "--background", forwardTarget, sandboxName],
    options,
  )}`;
}

function buildAuthenticatedDashboardUrl(baseUrl, token = null) {
  if (!token) return baseUrl;
  return `${baseUrl}#token=${encodeURIComponent(token)}`;
}

function getWslHostAddress(options = {}) {
  if (options.wslHostAddress) {
    return options.wslHostAddress;
  }
  if (!isWsl(options)) {
    return null;
  }
  const runCaptureFn = options.runCapture || runCapture;
  const output = runCaptureFn("hostname -I 2>/dev/null", { ignoreError: true });
  const candidates = String(output || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return candidates[0] || null;
}

function getDashboardAccessInfo(sandboxName, options = {}) {
  const token = Object.prototype.hasOwnProperty.call(options, "token")
    ? options.token
    : fetchGatewayAuthTokenFromSandbox(sandboxName);
  const chatUiUrl =
    options.chatUiUrl || process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`;
  const dashboardPort = Number(getDashboardForwardPort(chatUiUrl));
  const dashboardAccess = buildControlUiUrls(token, dashboardPort).map((url, index) => ({
    label: index === 0 ? "Dashboard" : `Alt ${index}`,
    url: buildAuthenticatedDashboardUrl(url, null),
  }));

  const wslHostAddress = getWslHostAddress(options);
  if (wslHostAddress) {
    const wslUrl = buildAuthenticatedDashboardUrl(
      `http://${wslHostAddress}:${dashboardPort}/`,
      token,
    );
    if (!dashboardAccess.some((access) => access.url === wslUrl)) {
      dashboardAccess.push({ label: "VS Code/WSL", url: wslUrl });
    }
  }

  return dashboardAccess;
}

function getDashboardGuidanceLines(dashboardAccess = [], options = {}) {
  const dashboardPort = getDashboardForwardPort(
    options.chatUiUrl || process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
  );
  const guidance = [`Port ${dashboardPort} must be forwarded before opening these URLs.`];
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

function printDashboard(sandboxName, model, provider, nimContainer = null, agent = null) {
  const nimStat = nimContainer ? nim.nimStatusByName(nimContainer) : nim.nimStatus(sandboxName);
  const nimLabel = nimStat.running ? "running" : "not running";

  let providerLabel = provider;
  if (provider === "nvidia-prod" || provider === "nvidia-nim") providerLabel = "NVIDIA Endpoints";
  else if (provider === "openai-api") providerLabel = "OpenAI";
  else if (provider === "anthropic-prod") providerLabel = "Anthropic";
  else if (provider === "compatible-anthropic-endpoint")
    providerLabel = "Other Anthropic-compatible endpoint";
  else if (provider === "gemini-api") providerLabel = "Google Gemini";
  else if (provider === "compatible-endpoint") providerLabel = "Other OpenAI-compatible endpoint";
  else if (provider === "vllm-local") providerLabel = "Local vLLM";
  else if (provider === "ollama-local") providerLabel = "Local Ollama";

  const token = fetchGatewayAuthTokenFromSandbox(sandboxName);
  const dashboardAccess = getDashboardAccessInfo(sandboxName, { token });
  const guidanceLines = getDashboardGuidanceLines(dashboardAccess);

  console.log("");
  console.log(`  ${"─".repeat(50)}`);
  // console.log(`  Dashboard    http://localhost:${DASHBOARD_PORT}/`);
  console.log(`  Sandbox      ${sandboxName} (Landlock + seccomp + netns)`);
  console.log(`  Model        ${model} (${providerLabel})`);
  console.log(`  NIM          ${nimLabel}`);
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  Run:         nemoclaw ${sandboxName} connect`);
  console.log(`  Status:      nemoclaw ${sandboxName} status`);
  console.log(`  Logs:        nemoclaw ${sandboxName} logs --follow`);
  console.log("");
  if (agent) {
    agentOnboard.printDashboardUi(sandboxName, token, agent, {
      note,
      buildControlUiUrls: (tokenValue, port) => {
        const urls = buildControlUiUrls(tokenValue, port);
        const wslHostAddress = getWslHostAddress();
        if (wslHostAddress) {
          const wslUrl = buildAuthenticatedDashboardUrl(
            `http://${wslHostAddress}:${port}/`,
            tokenValue,
          );
          if (!urls.includes(wslUrl)) {
            urls.push(wslUrl);
          }
        }
        return urls;
      },
    });
  } else if (token) {
    console.log("  OpenClaw UI (tokenized URL; treat it like a password)");
    for (const line of guidanceLines) {
      console.log(`  ${line}`);
    }
    for (const entry of dashboardAccess) {
      console.log(`  ${entry.label}: ${entry.url}`);
    }
  } else {
    note("  Could not read gateway token from the sandbox (download failed).");
    console.log("  OpenClaw UI");
    for (const line of guidanceLines) {
      console.log(`  ${line}`);
    }
    for (const entry of dashboardAccess) {
      console.log(`  ${entry.label}: ${entry.url}`);
    }
    console.log(
      `  Token:       nemoclaw ${sandboxName} connect  →  jq -r '.gateway.auth.token' /sandbox/.openclaw/openclaw.json`,
    );
    console.log(
      `               append  #token=<token>  to the URL, or see /tmp/gateway.log inside the sandbox.`,
    );
  }
  console.log(`  ${"─".repeat(50)}`);
  console.log("");
}

function startRecordedStep(stepName, updates = {}) {
  onboardSession.markStepStarted(stepName);
  if (Object.keys(updates).length > 0) {
    onboardSession.updateSession((session) => {
      if (typeof updates.sandboxName === "string") session.sandboxName = updates.sandboxName;
      if (typeof updates.provider === "string") session.provider = updates.provider;
      if (typeof updates.model === "string") session.model = updates.model;
      return session;
    });
  }
}

const ONBOARD_STEP_INDEX = {
  preflight: { number: 1, title: "Preflight checks" },
  gateway: { number: 2, title: "Starting OpenShell gateway" },
  provider_selection: { number: 3, title: "Configuring inference (NIM)" },
  inference: { number: 4, title: "Setting up inference provider" },
  messaging: { number: 5, title: "Messaging channels" },
  sandbox: { number: 6, title: "Creating sandbox" },
  openclaw: { number: 7, title: "Setting up OpenClaw inside sandbox" },
  policies: { number: 8, title: "Policy presets" },
};

function skippedStepMessage(stepName, detail, reason = "resume") {
  const stepInfo = ONBOARD_STEP_INDEX[stepName];
  if (stepInfo) {
    step(stepInfo.number, 8, stepInfo.title);
  }
  const prefix = reason === "reuse" ? "[reuse]" : "[resume]";
  console.log(`  ${prefix} Skipping ${stepName}${detail ? ` (${detail})` : ""}`);
}

// ── Main ─────────────────────────────────────────────────────────

// eslint-disable-next-line complexity
async function onboard(opts = {}) {
  NON_INTERACTIVE = opts.nonInteractive || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
  RECREATE_SANDBOX = opts.recreateSandbox || process.env.NEMOCLAW_RECREATE_SANDBOX === "1";
  const dangerouslySkipPermissions =
    opts.dangerouslySkipPermissions || process.env.NEMOCLAW_DANGEROUSLY_SKIP_PERMISSIONS === "1";
  if (dangerouslySkipPermissions) {
    console.error("");
    console.error(
      "  \u26a0  --dangerously-skip-permissions: sandbox security restrictions disabled.",
    );
    console.error("     Network:    all known endpoints open (no method/path filtering)");
    console.error("     Filesystem: sandbox home directory is writable");
    console.error("     Use for development/testing only.");
    console.error("");
  }
  delete process.env.OPENSHELL_GATEWAY;
  const resume = opts.resume === true;
  // In non-interactive mode also accept the env var so CI pipelines can set it.
  // This is the explicitly requested value; on resume it may be absent and the
  // session-recorded path is used instead (see below).
  const requestedFromDockerfile =
    opts.fromDockerfile ||
    (isNonInteractive() ? process.env.NEMOCLAW_FROM_DOCKERFILE || null : null);
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
    `nemoclaw onboard${resume ? " --resume" : ""}${isNonInteractive() ? " --non-interactive" : ""}${requestedFromDockerfile ? ` --from ${requestedFromDockerfile}` : ""}`,
  );
  if (!lockResult.acquired) {
    console.error("  Another NemoClaw onboarding run is already in progress.");
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

  let lockReleased = false;
  const releaseOnboardLock = () => {
    if (lockReleased) return;
    lockReleased = true;
    onboardSession.releaseOnboardLock();
  };
  process.once("exit", releaseOnboardLock);

  try {
    let session;
    let selectedMessagingChannels = [];
    // Merged, absolute fromDockerfile: explicit flag/env takes precedence; on
    // resume falls back to what the original session recorded so the same image
    // is used even when --from is omitted from the resume invocation.
    let fromDockerfile;
    if (resume) {
      session = onboardSession.loadSession();
      if (!session || session.resumable === false) {
        console.error("  No resumable onboarding session was found.");
        console.error("  Run: nemoclaw onboard");
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
        console.error("  Run: nemoclaw onboard              # start a fresh onboarding session");
        console.error("  Or rerun with the original settings to continue that session.");
        process.exit(1);
      }
      onboardSession.updateSession((current) => {
        current.mode = isNonInteractive() ? "non-interactive" : "interactive";
        current.failure = null;
        current.status = "in_progress";
        return current;
      });
      session = onboardSession.loadSession();
    } else {
      fromDockerfile = requestedFromDockerfile ? path.resolve(requestedFromDockerfile) : null;
      session = onboardSession.saveSession(
        onboardSession.createSession({
          mode: isNonInteractive() ? "non-interactive" : "interactive",
          metadata: { gatewayName: "nemoclaw", fromDockerfile: fromDockerfile || null },
        }),
      );
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

    console.log("");
    console.log("  NemoClaw Onboarding");
    if (isNonInteractive()) note("  (non-interactive mode)");
    if (resume) note("  (resume mode)");
    console.log("  ===================");

    const agent = agentOnboard.resolveAgent({ agentFlag: opts.agent, session });
    if (agent) {
      onboardSession.updateSession((s) => {
        s.agent = agent.name;
        return s;
      });
    }

    let gpu;
    const resumePreflight = resume && session?.steps?.preflight?.status === "complete";
    if (resumePreflight) {
      skippedStepMessage("preflight", "cached");
      gpu = nim.detectGpu();
    } else {
      startRecordedStep("preflight");
      gpu = await preflight();
      onboardSession.markStepComplete("preflight");
    }

    const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
    const gatewayInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
      ignoreError: true,
    });
    const activeGatewayInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
    let gatewayReuseState = getGatewayReuseState(gatewayStatus, gatewayInfo, activeGatewayInfo);

    // Verify the gateway container is actually running — openshell CLI metadata
    // can be stale after a manual `docker rm`. See #2020.
    if (gatewayReuseState === "healthy") {
      const containerState = verifyGatewayContainerRunning();
      if (containerState === "missing") {
        console.log("  Gateway metadata is stale (container not running). Cleaning up...");
        runOpenshell(["forward", "stop", String(DASHBOARD_PORT)], { ignoreError: true });
        destroyGateway();
        registry.clearAll();
        gatewayReuseState = "missing";
        console.log("  ✓ Stale gateway metadata cleaned up");
      } else if (containerState === "unknown") {
        console.log("  Warning: could not verify gateway container state (Docker may be unavailable). Proceeding with cached health status.");
      }
    }

    const canReuseHealthyGateway = gatewayReuseState === "healthy";
    const resumeGateway =
      resume && session?.steps?.gateway?.status === "complete" && canReuseHealthyGateway;
    if (resumeGateway) {
      skippedStepMessage("gateway", "running");
    } else if (!resume && canReuseHealthyGateway) {
      skippedStepMessage("gateway", "running", "reuse");
      note("  Reusing healthy NemoClaw gateway.");
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
      startRecordedStep("gateway");
      await startGateway(gpu);
      onboardSession.markStepComplete("gateway");
    }

    let sandboxName = session?.sandboxName || null;
    let model = session?.model || null;
    let provider = session?.provider || null;
    let endpointUrl = session?.endpointUrl || null;
    let credentialEnv = session?.credentialEnv || null;
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
        startRecordedStep("provider_selection", { sandboxName });
        const selection = await setupNim(gpu);
        model = selection.model;
        provider = selection.provider;
        endpointUrl = selection.endpointUrl;
        credentialEnv = selection.credentialEnv;
        preferredInferenceApi = selection.preferredInferenceApi;
        nimContainer = selection.nimContainer;
        onboardSession.markStepComplete("provider_selection", {
          sandboxName,
          provider,
          model,
          endpointUrl,
          credentialEnv,
          preferredInferenceApi,
          nimContainer,
        });
      }

      process.env.NEMOCLAW_OPENSHELL_BIN = getOpenshellBinary();
      const resumeInference =
        !forceProviderSelection &&
        resume &&
        typeof provider === "string" &&
        typeof model === "string" &&
        isInferenceRouteReady(provider, model);
      if (resumeInference) {
        skippedStepMessage("inference", `${provider} / ${model}`);
        if (nimContainer) {
          registry.updateSandbox(sandboxName, { nimContainer });
        }
        onboardSession.markStepComplete("inference", {
          sandboxName,
          provider,
          model,
          nimContainer,
        });
        break;
      }

      startRecordedStep("inference", { sandboxName, provider, model });
      const inferenceResult = await setupInference(
        sandboxName,
        model,
        provider,
        endpointUrl,
        credentialEnv,
      );
      delete process.env.NVIDIA_API_KEY;
      if (inferenceResult?.retry === "selection") {
        forceProviderSelection = true;
        continue;
      }
      if (nimContainer) {
        registry.updateSandbox(sandboxName, { nimContainer });
      }
      onboardSession.markStepComplete("inference", { sandboxName, provider, model, nimContainer });
      break;
    }

    const sandboxReuseState = getSandboxReuseState(sandboxName);
    const webSearchConfigChanged = Boolean(session?.webSearchConfig) !== Boolean(webSearchConfig);
    const resumeSandbox =
      resume &&
      !webSearchConfigChanged &&
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
        nextWebSearchConfig = await configureWebSearch(null);
      }
      startRecordedStep("sandbox", { sandboxName, provider, model });
      selectedMessagingChannels = await setupMessagingChannels();
      onboardSession.updateSession((current) => {
        current.messagingChannels = selectedMessagingChannels;
        return current;
      });
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
        dangerouslySkipPermissions,
      );
      webSearchConfig = nextWebSearchConfig;
      // Persist model and provider after the sandbox entry exists in the registry.
      // updateSandbox() silently no-ops when the entry is missing, so this must
      // run after createSandbox() / registerSandbox() — not before. Fixes #1881.
      registry.updateSandbox(sandboxName, { model, provider });
      onboardSession.markStepComplete("sandbox", {
        sandboxName,
        provider,
        model,
        nimContainer,
        webSearchConfig,
      });
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
      onboardSession.markStepSkipped("openclaw");
    } else {
      const resumeOpenclaw = resume && sandboxName && isOpenclawReady(sandboxName);
      if (resumeOpenclaw) {
        skippedStepMessage("openclaw", sandboxName);
        onboardSession.markStepComplete("openclaw", { sandboxName, provider, model });
      } else {
        startRecordedStep("openclaw", { sandboxName, provider, model });
        await setupOpenclaw(sandboxName, model, provider);
        onboardSession.markStepComplete("openclaw", { sandboxName, provider, model });
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
    if (dangerouslySkipPermissions) {
      step(8, 8, "Policy presets");
      if (!waitForSandboxReady(sandboxName)) {
        console.error(`\n  ✗ Sandbox '${sandboxName}' not ready after creation. Giving up.`);
        process.exit(1);
      }
      shields.shieldsDownPermanent(sandboxName);
      onboardSession.markStepComplete("policies", {
        sandboxName,
        provider,
        model,
        policyPresets: [],
      });
    } else {
      const resumePolicies =
        resume && sandboxName && arePolicyPresetsApplied(sandboxName, recordedPolicyPresets || []);
      if (resumePolicies) {
        skippedStepMessage("policies", (recordedPolicyPresets || []).join(", "));
        onboardSession.markStepComplete("policies", {
          sandboxName,
          provider,
          model,
          policyPresets: recordedPolicyPresets || [],
        });
      } else {
        startRecordedStep("policies", {
          sandboxName,
          provider,
          model,
          policyPresets: recordedPolicyPresets || [],
        });
        const appliedPolicyPresets = await setupPoliciesWithSelection(sandboxName, {
          selectedPresets:
            Array.isArray(recordedPolicyPresets) && recordedPolicyPresets.length > 0
              ? recordedPolicyPresets
              : null,
          enabledChannels:
            selectedMessagingChannels.length > 0
              ? selectedMessagingChannels
              : recordedMessagingChannels,
          webSearchConfig,
          provider,
          onSelection: (policyPresets) => {
            onboardSession.updateSession((current) => {
              current.policyPresets = policyPresets;
              return current;
            });
          },
        });
        onboardSession.markStepComplete("policies", {
          sandboxName,
          provider,
          model,
          policyPresets: appliedPolicyPresets,
        });
      }
    }

    onboardSession.completeSession({ sandboxName, provider, model });
    completed = true;
    printDashboard(sandboxName, model, provider, nimContainer, agent);
  } finally {
    releaseOnboardLock();
  }
}

module.exports = {
  buildProviderArgs,
  buildGatewayBootstrapSecretsScript,
  buildSandboxConfigSyncScript,
  compactText,
  copyBuildContextDir,
  classifySandboxCreateFailure,
  configureWebSearch,
  createSandbox,
  ensureValidatedBraveSearchCredential,
  formatEnvAssignment,
  getFutureShellPathHint,
  getGatewayBootstrapRepairPlan,
  getGatewayLocalEndpoint,
  getGatewayStartEnv,
  getGatewayClusterContainerState,
  getGatewayHealthWaitConfig,
  getGatewayReuseState,
  getNavigationChoice,
  getSandboxInferenceConfig,
  getInstalledOpenshellVersion,
  getBlueprintMinOpenshellVersion,
  getBlueprintMaxOpenshellVersion,
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
  providerExistsInGateway,
  parsePolicyPresetEnv,
  pruneStaleSandboxEntry,
  repairRecordedSandbox,
  recoverGatewayRuntime,
  resolveDashboardForwardTarget,
  startGateway,
  buildAuthenticatedDashboardUrl,
  getDashboardAccessInfo,
  getDashboardForwardPort,
  getDashboardForwardStartCommand,
  getDashboardGuidanceLines,
  startGatewayForRecovery,
  runCaptureOpenshell,
  setupInference,
  setupMessagingChannels,
  setupNim,
  isInferenceRouteReady,
  isNonInteractive,
  isOpenclawReady,
  arePolicyPresetsApplied,
  getSuggestedPolicyPresets,
  computeSetupPresetSuggestions,
  LOCAL_INFERENCE_PROVIDERS,
  presetsCheckboxSelector,
  selectPolicyTier,
  selectTierPresetsAndAccess,
  setupPoliciesWithSelection,
  summarizeCurlFailure,
  summarizeProbeFailure,
  hasResponsesToolCall,
  upsertProvider,
  hashCredential,
  detectMessagingCredentialRotation,
  hydrateCredentialEnv,
  pruneKnownHostsEntries,
  shouldIncludeBuildContextPath,
  writeSandboxConfigSyncFile,
  patchStagedDockerfile,
  ensureOllamaAuthProxy,
  getProbeAuthMode,
  getValidationProbeCurlArgs,
  checkTelegramReachability,
  TELEGRAM_NETWORK_CURL_CODES,
};
