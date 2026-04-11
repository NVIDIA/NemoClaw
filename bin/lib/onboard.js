// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Interactive onboarding wizard — 7 steps from zero to running sandbox.
// Supports non-interactive mode via --non-interactive flag or
// NEMOCLAW_NON_INTERACTIVE=1 env var for CI/CD pipelines.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { ROOT, SCRIPTS, run, runCapture, shellQuote } = require("./runner");
const {
  getDefaultOllamaModel,
  getLocalProviderBaseUrl,
  getOllamaModelMetadata,
  resolveOllamaContainerRoute,
  resolveOllamaEndpoint,
  validateOllamaModel,
  validateOllamaOpenClawCompatibility,
  validateLocalProvider,
  DEFAULT_OLLAMA_MODEL,
} = require("./local-inference");
// Terminal color helpers for notes
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const {
  CLOUD_MODEL_OPTIONS,
  DEFAULT_CLOUD_MODEL,
  getOpenClawPrimaryModel,
  getProviderSelectionConfig,
} = require("./inference-config");
const {
  inferContainerRuntime,
  isUnsupportedMacosRuntime,
  shouldPatchCoredns,
} = require("./platform");
const { resolveOpenshell } = require("./resolve-openshell");
const { prompt, ensureApiKey, getCredential, saveCredential } = require("./credentials");
const registry = require("./registry");
const nim = require("./nim");
const _onboardSession = require("./onboard-session");
const policies = require("./policies");
const { checkPortAvailable } = require("./preflight");
const { getInferenceRuntimeStatus } = require("./inference-status");
const GATEWAY_NAME = "nemoclaw";
const DEFAULT_MANAGED_CONTEXT_WINDOW = 131072;
const DEFAULT_MANAGED_MAX_TOKENS = 4096;
const DEFAULT_OLLAMA_CONTEXT_WINDOW = 4096;

function resolveSelectionProviderType(selectionConfig) {
  if (selectionConfig.provider) {
    return selectionConfig.provider;
  }

  if (selectionConfig.profile === "inference-local") {
    return selectionConfig.model === DEFAULT_OLLAMA_MODEL ? "ollama-local" : "nvidia-nim";
  }

  if (selectionConfig.endpointType === "vllm") {
    return "vllm-local";
  }

  return "nvidia-nim";
}

function getManagedModelLimits(providerType, selectionConfig = {}) {
  if (Number.isFinite(selectionConfig.contextWindow) && selectionConfig.contextWindow > 0) {
    return {
      contextWindow: selectionConfig.contextWindow,
      maxTokens:
        Number.isFinite(selectionConfig.maxTokens) && selectionConfig.maxTokens > 0
          ? selectionConfig.maxTokens
          : DEFAULT_MANAGED_MAX_TOKENS,
    };
  }

  if (providerType === "ollama-local") {
    return {
      contextWindow: DEFAULT_OLLAMA_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MANAGED_MAX_TOKENS,
    };
  }

  return {
    contextWindow: DEFAULT_MANAGED_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MANAGED_MAX_TOKENS,
  };
}

function getOllamaProbeOutcome(model, probe, opts = {}) {
  if (probe?.ok) {
    return { fatal: false, message: null };
  }

  const message = probe?.message || `Selected Ollama model '${model}' failed the local probe.`;
  if (opts.allowWarmupFailure) {
    return {
      fatal: false,
      message: `${message} Continuing because the inference route is configured and the model may still be loading.`,
    };
  }

  return { fatal: true, message };
}

// Non-interactive mode: set by --non-interactive flag or env var.
// When active, all prompts use env var overrides or sensible defaults.
let NON_INTERACTIVE = false;

function isNonInteractive() {
  return NON_INTERACTIVE;
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

/**
 * Check if a sandbox is in Ready state from `openshell sandbox list` output.
 * Strips ANSI codes and exact-matches the sandbox name in the first column.
 */
function isSandboxReady(output, sandboxName) {
  // eslint-disable-next-line no-control-regex
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  return clean.split("\n").some((l) => {
    const cols = l.trim().split(/\s+/);
    return cols[0] === sandboxName && cols.includes("Ready") && !cols.includes("NotReady");
  });
}

/**
 * Determine whether stale NemoClaw gateway output indicates a previous
 * session that should be cleaned up before the port preflight check.
 * @param {string} gwInfoOutput - Raw output from `openshell gateway info -g nemoclaw`.
 * @returns {boolean}
 */
function hasStaleGateway(gwInfoOutput) {
  const cleanOutput =
    typeof gwInfoOutput === "string"
      ? // eslint-disable-next-line no-control-regex
        gwInfoOutput.replace(/\x1b\[[0-9;]*m/g, "")
      : "";
  return (
    cleanOutput.length > 0 &&
    cleanOutput.includes(`Gateway: ${GATEWAY_NAME}`) &&
    !cleanOutput.includes("No gateway metadata found")
  );
}

function getReportedGatewayName(output = "") {
  if (typeof output !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, "");
  const match = cleanOutput.match(/^\s*Gateway:\s+([^\s]+)/m);
  return match ? match[1] : null;
}

function isGatewayConnected(statusOutput = "") {
  return typeof statusOutput === "string" && statusOutput.includes("Connected");
}

function hasActiveGatewayInfo(activeGatewayInfoOutput = "") {
  return (
    typeof activeGatewayInfoOutput === "string" &&
    activeGatewayInfoOutput.includes("Gateway endpoint:") &&
    !activeGatewayInfoOutput.includes("No gateway metadata found")
  );
}

function getReportedGatewayEndpoint(output = "") {
  if (typeof output !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, "");
  const match = cleanOutput.match(/^\s*Gateway endpoint:\s+([^\s]+)/m);
  return match ? match[1] : null;
}

function isSelectedGateway(statusOutput = "", gatewayName = GATEWAY_NAME) {
  return getReportedGatewayName(statusOutput) === gatewayName;
}

function isGatewayHealthy(statusOutput = "", gwInfoOutput = "", activeGatewayInfoOutput = "") {
  const namedGatewayKnown = hasStaleGateway(gwInfoOutput);
  if (!namedGatewayKnown || !isGatewayConnected(statusOutput)) return false;

  const activeGatewayName =
    getReportedGatewayName(statusOutput) || getReportedGatewayName(activeGatewayInfoOutput);
  return activeGatewayName === GATEWAY_NAME;
}

function getGatewayReuseState(statusOutput = "", gwInfoOutput = "", activeGatewayInfoOutput = "") {
  if (isGatewayHealthy(statusOutput, gwInfoOutput, activeGatewayInfoOutput)) {
    return "healthy";
  }
  const connected = isGatewayConnected(statusOutput);
  const activeGatewayName =
    getReportedGatewayName(statusOutput) || getReportedGatewayName(activeGatewayInfoOutput);
  if (connected && activeGatewayName === GATEWAY_NAME) {
    return "active-unnamed";
  }
  if (connected && activeGatewayName && activeGatewayName !== GATEWAY_NAME) {
    return "foreign-active";
  }
  if (hasStaleGateway(gwInfoOutput)) {
    return "stale";
  }
  if (hasActiveGatewayInfo(activeGatewayInfoOutput)) {
    return "active-unnamed";
  }
  return "missing";
}

function countListedSandboxes(listOutput = "") {
  if (typeof listOutput !== "string" || !listOutput.trim()) return 0;
  // eslint-disable-next-line no-control-regex
  const cleanOutput = listOutput.replace(/\x1b\[[0-9;]*m/g, "");
  if (/No sandboxes found\./i.test(cleanOutput)) return 0;
  return cleanOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) => line && !/^NAME\s+/i.test(line) && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\s+/.test(line),
    ).length;
}

function getGatewayClusterContainerName(gatewayName = GATEWAY_NAME) {
  return `openshell-cluster-${gatewayName}`;
}

function listLocalGatewayNames(dockerPsOutput = "") {
  if (typeof dockerPsOutput !== "string" || !dockerPsOutput.trim()) return [];
  return dockerPsOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("openshell-cluster-"))
    .map((line) => line.slice("openshell-cluster-".length))
    .filter(Boolean);
}

function hasLocalGatewayContainer(gatewayName = GATEWAY_NAME, dockerPsOutput = "") {
  return listLocalGatewayNames(dockerPsOutput).includes(gatewayName);
}

async function promptForExistingGatewayAction(gatewayName, sandboxCount = 0) {
  const sandboxHint =
    sandboxCount > 0 ? ` with ${sandboxCount} sandbox${sandboxCount === 1 ? "" : "es"}` : "";
  const promptText = `  Found existing OpenShell gateway '${gatewayName}' on port 8080${sandboxHint}. NemoClaw must recreate this local gateway as '${GATEWAY_NAME}' before sandbox image upload can work. Recreate it now or abort? [recreate/abort]: `;

  while (true) {
    const answer = String(
      await promptOrDefault(promptText, "NEMOCLAW_EXISTING_GATEWAY_ACTION", "recreate"),
    )
      .trim()
      .toLowerCase();
    if (answer === "recreate" || answer === "r" || answer === "replace") return "recreate";
    if (answer === "abort" || answer === "a" || answer === "cancel") return "abort";
    console.log("  Please answer 'recreate' or 'abort'.");
    if (isNonInteractive()) {
      process.exit(1);
    }
  }
}

function getSandboxStateFromOutputs(sandboxName, getOutput = "", listOutput = "") {
  if (!sandboxName) return "missing";
  if (!getOutput) return "missing";
  return isSandboxReady(listOutput, sandboxName) ? "ready" : "not_ready";
}

function getSandboxReuseState(sandboxName) {
  if (!sandboxName) return "missing";
  const getOutput = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
  const listOutput = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
  return getSandboxStateFromOutputs(sandboxName, getOutput, listOutput);
}

function _repairRecordedSandbox(sandboxName) {
  if (!sandboxName) return;
  note(`  [resume] Cleaning up recorded sandbox '${sandboxName}' before recreating it.`);
  runOpenshell(["forward", "stop", "18789"], { ignoreError: true });
  runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
  registry.removeSandbox(sandboxName);
}

function streamSandboxCreate(command, env = process.env, options = {}) {
  const child = spawn("bash", ["-lc", command], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines = [];
  let pending = "";
  let lastPrintedLine = "";
  let sawProgress = false;
  let settled = false;
  let polling = false;
  const pollIntervalMs = options.pollIntervalMs || 2000;

  function finish(result) {
    if (settled) return;
    settled = true;
    if (pending) flushLine(pending);
    if (readyTimer) clearInterval(readyTimer);
    resolvePromise(result);
  }

  function detachChild() {
    child.stdout?.removeAllListeners?.("data");
    child.stderr?.removeAllListeners?.("data");
    child.stdout?.destroy?.();
    child.stderr?.destroy?.();
    child.removeAllListeners?.("error");
    child.removeAllListeners?.("close");
    child.unref?.();
  }

  function shouldShowLine(line) {
    return (
      /^ {2}Building image /.test(line) ||
      /^ {2}Context: /.test(line) ||
      /^ {2}Gateway: /.test(line) ||
      /^Successfully built /.test(line) ||
      /^Successfully tagged /.test(line) ||
      /^ {2}Built image /.test(line) ||
      /^ {2}Pushing image /.test(line) ||
      /^\s*\[progress\]/.test(line) ||
      /^ {2}Image .*available in the gateway/.test(line) ||
      /^Created sandbox: /.test(line) ||
      /^✓ /.test(line)
    );
  }

  function flushLine(rawLine) {
    const line = rawLine.replace(/\r/g, "").trimEnd();
    if (!line) return;
    lines.push(line);
    if (shouldShowLine(line) && line !== lastPrintedLine) {
      console.log(line);
      lastPrintedLine = line;
      sawProgress = true;
    }
  }

  function onChunk(chunk) {
    pending += chunk.toString();
    const parts = pending.split("\n");
    pending = parts.pop();
    parts.forEach(flushLine);
  }

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  let resolvePromise;
  const readyTimer = options.readyCheck
    ? setInterval(() => {
        if (settled || polling) return;
        polling = true;
        try {
          let ready = false;
          try {
            ready = !!options.readyCheck();
          } catch {
            return;
          }
          if (!ready) return;
          const detail = "Sandbox reported Ready before create stream exited; continuing.";
          lines.push(detail);
          if (detail !== lastPrintedLine) {
            console.log(`  ${detail}`);
            lastPrintedLine = detail;
          }
          try {
            child.kill("SIGTERM");
          } catch {
            // Best effort only — the child may have already exited.
          }
          detachChild();
          finish({ status: 0, output: lines.join("\n"), sawProgress: true, forcedReady: true });
        } finally {
          polling = false;
        }
      }, pollIntervalMs)
    : null;
  readyTimer?.unref?.();

  return new Promise((resolve) => {
    resolvePromise = resolve;
    child.on("error", (error) => {
      // @ts-expect-error — Node ErrnoException has .code but TS types Error
      const code = error && error.code;
      const detail = code
        ? `spawn failed: ${error.message} (${code})`
        : `spawn failed: ${error.message}`;
      lines.push(detail);
      finish({ status: 1, output: lines.join("\n"), sawProgress: false });
    });

    child.on("close", (code) => {
      finish({ status: code ?? 1, output: lines.join("\n"), sawProgress });
    });
  });
}

function step(n, total, msg) {
  console.log("");
  console.log(`  [${n}/${total}] ${msg}`);
  console.log(`  ${"─".repeat(50)}`);
}

function pythonLiteralJson(value) {
  return JSON.stringify(JSON.stringify(value));
}

function isWslEnvironment(env = process.env, platform = process.platform, release = os.release()) {
  if (platform !== "linux") return false;
  const normalizedRelease = String(release || "").toLowerCase();
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP) || normalizedRelease.includes("microsoft");
}

function getWslHostAddress(options = {}) {
  const {
    env = process.env,
    platform = process.platform,
    release = os.release(),
    runCapture: runCaptureFn = runCapture,
  } = options;
  if (!isWslEnvironment(env, platform, release)) return null;

  const output = runCaptureFn("hostname -I 2>/dev/null", { ignoreError: true });
  const candidates = String(output || "")
    .trim()
    .split(/\s+/)
    .filter((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value));
  return candidates[0] || null;
}

function getControlUiAllowedOrigins(options = {}) {
  const origins = ["http://127.0.0.1:18789", "http://localhost:18789"];
  const wslHostAddress = getWslHostAddress(options);
  if (wslHostAddress) {
    origins.push(`http://${wslHostAddress}:18789`);
  }
  return origins;
}

function getDashboardForwardPort(options = {}) {
  return isWslEnvironment(options.env, options.platform, options.release)
    ? "0.0.0.0:18789"
    : "18789";
}

function classifySandboxCreateFailure(output = "") {
  const text = String(output || "");
  const uploadedToGateway =
    /\[progress\]\s+Uploaded to gateway/i.test(text) ||
    /Image .*available in the gateway/i.test(text);

  if (/failed to read image export stream|Timeout error/i.test(text)) {
    return {
      kind: "image_transfer_timeout",
      uploadedToGateway,
    };
  }

  if (/Connection reset by peer/i.test(text)) {
    return {
      kind: "image_transfer_reset",
      uploadedToGateway,
    };
  }

  if (/Created sandbox:/i.test(text)) {
    return {
      kind: "sandbox_create_incomplete",
      uploadedToGateway: true,
    };
  }

  return {
    kind: "unknown",
    uploadedToGateway,
  };
}

function printSandboxCreateRecoveryHints(output = "") {
  const failure = classifySandboxCreateFailure(output);
  if (failure.kind === "image_transfer_timeout") {
    console.error("  Hint: image upload into the OpenShell gateway timed out.");
    console.error("  Recovery: nemoclaw onboard --resume");
    if (failure.uploadedToGateway) {
      console.error(
        "  Progress reached the gateway upload stage, so resume may be able to reuse existing gateway state.",
      );
    }
    console.error("  If this repeats, check Docker memory and retry on a host with more RAM.");
    return;
  }
  if (failure.kind === "image_transfer_reset") {
    console.error("  Hint: the image push/import stream was interrupted.");
    console.error("  Recovery: nemoclaw onboard --resume");
    if (failure.uploadedToGateway) {
      console.error("  The image appears to have reached the gateway before the stream failed.");
    }
    console.error("  If this repeats, restart Docker or the gateway and retry.");
    return;
  }
  if (failure.kind === "sandbox_create_incomplete") {
    console.error("  Hint: sandbox creation started but the create stream did not finish cleanly.");
    console.error("  Recovery: nemoclaw onboard --resume");
    console.error(
      "  Check: openshell sandbox list        # verify whether the sandbox became ready",
    );
    return;
  }
  console.error("  Recovery: nemoclaw onboard --resume");
  console.error("  Or:      nemoclaw onboard");
}

function getDashboardForwardStartCommand(sandboxName, options = {}) {
  return `openshell forward start --background ${getDashboardForwardPort(options)} "${sandboxName}"`;
}

function buildControlUiConfigSyncScript(controlUiAllowedOrigins = []) {
  const origins = Array.isArray(controlUiAllowedOrigins)
    ? controlUiAllowedOrigins.filter(
        (value) => typeof value === "string" && value.trim().length > 0,
      )
    : [];

  return `
python3 - <<'PY'
import json
import os
import signal

cfg_path = os.path.expanduser('~/.openclaw/openclaw.json')
state_dir = os.path.dirname(cfg_path)
cfg = {}
if os.path.exists(cfg_path):
    with open(cfg_path) as f:
        cfg = json.load(f)

# Ensuring agent directories exist (Fix for missing agents)
for agent in cfg.get('agents', {}).get('list', []):
    if not isinstance(agent, dict):
        continue
    for key in ('workspace', 'agentDir'):
        dir_path = agent.get(key, '')
        if isinstance(dir_path, str) and dir_path.strip():
            os.makedirs(dir_path.strip(), exist_ok=True)

# Ensure each agent has a webchat session so it appears in the Control UI
for agent in cfg.get('agents', {}).get('list', []):
    if not isinstance(agent, dict) or not agent.get('id'):
        continue
    agent_id = agent['id']
    sessions_dir = os.path.join(state_dir, 'agents', agent_id, 'sessions')
    os.makedirs(sessions_dir, exist_ok=True)
    store_path = os.path.join(sessions_dir, 'sessions.json')
    store = {}
    if os.path.exists(store_path):
        with open(store_path) as f:
            store = json.load(f)
    skey = f'agent:{agent_id}:main'
    entry = store.get(skey, {})
    if entry.get('lastChannel') != 'webchat':
        entry.setdefault('sessionId', f'init-{agent_id}')
        entry['chatType'] = 'direct'
        entry['deliveryContext'] = {'channel': 'webchat'}
        entry['lastChannel'] = 'webchat'
        entry['origin'] = {'provider': 'webchat', 'surface': 'webchat', 'chatType': 'direct'}
        store[skey] = entry
        with open(store_path, 'w') as f:
            json.dump(store, f)
        os.chmod(store_path, 0o600)

changed = False
control_ui_allowed_origins = json.loads(${pythonLiteralJson(origins)})
if control_ui_allowed_origins:
    control_ui_cfg = cfg.setdefault('gateway', {}).setdefault('controlUi', {})
    existing_origins = control_ui_cfg.setdefault('allowedOrigins', [])
    for origin in control_ui_allowed_origins:
        if isinstance(origin, str) and origin and origin not in existing_origins:
            existing_origins.append(origin)
            changed = True

if changed:
    with open(cfg_path, 'w') as f:
        json.dump(cfg, f, indent=2)
    os.chmod(cfg_path, 0o600)

    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            with open(f'/proc/{entry}/cmdline', 'rb') as f:
            cmdline = f.read().replace(b'\\x00', b' ').decode('utf-8', 'ignore')
        except OSError:
            continue
        if 'openclaw' in cmdline and 'gateway run' in cmdline:
            try:
                os.kill(int(entry), signal.SIGUSR1)
            except OSError:
                pass
            break
PY
exit
`.trim();
}

function syncSandboxControlUiConfig(sandboxName, options = {}) {
  const runCaptureFn = options.runCapture || runCapture;
  const controlUiAllowedOrigins = getControlUiAllowedOrigins(options);
  const script = buildControlUiConfigSyncScript(controlUiAllowedOrigins);
  return runCaptureFn(
    `cat <<'EOF_NEMOCLAW_CONTROL_UI_SYNC' | openshell sandbox connect "${sandboxName}"
${script}
EOF_NEMOCLAW_CONTROL_UI_SYNC`,
    { ignoreError: true },
  );
}

function buildAuthenticatedDashboardUrl(origin, token) {
  if (!origin || !token) return null;

  const dashboardUrl = new URL(`${origin}/`);
  const gatewayUrl = origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  dashboardUrl.searchParams.set("gatewayUrl", gatewayUrl);
  dashboardUrl.hash = `token=${encodeURIComponent(token)}`;
  return dashboardUrl.toString();
}

function getSandboxGatewayToken(sandboxName, runCaptureFn = runCapture) {
  const script = `
python3 - <<'PY'
import json
import os

cfg_path = os.path.expanduser('~/.openclaw/openclaw.json')
token = ''
if os.path.exists(cfg_path):
    with open(cfg_path) as f:
        cfg = json.load(f)
    token = cfg.get('gateway', {}).get('auth', {}).get('token', '')

print(f'NEMOCLAW_GATEWAY_TOKEN={token}')
PY
exit
`.trim();
  const output = runCaptureFn(
    `cat <<'EOF_NEMOCLAW_TOKEN' | openshell sandbox connect "${sandboxName}"
${script}
EOF_NEMOCLAW_TOKEN`,
    { ignoreError: true },
  );
  const matches = [...String(output || "").matchAll(/NEMOCLAW_GATEWAY_TOKEN=([A-Za-z0-9._-]+)/g)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1] || null;
}

function getDashboardAccessInfo(sandboxName, options = {}) {
  const runCaptureFn = options.runCapture || runCapture;
  const token = getSandboxGatewayToken(sandboxName, runCaptureFn);
  const dashboardUrl =
    buildAuthenticatedDashboardUrl("http://127.0.0.1:18789", token) || "http://127.0.0.1:18789/";
  const dashboardAccess = [{ label: "Dashboard", url: dashboardUrl }];
  const allowedOrigins = getControlUiAllowedOrigins({ ...options, runCapture: runCaptureFn });
  const wslOrigin = allowedOrigins.find(
    (origin) => origin !== "http://127.0.0.1:18789" && origin !== "http://localhost:18789",
  );
  if (!wslOrigin) return dashboardAccess;

  const authenticatedUrl = buildAuthenticatedDashboardUrl(wslOrigin, token);
  if (authenticatedUrl) {
    dashboardAccess.push({ label: "VS Code/WSL", url: authenticatedUrl });
  }

  return dashboardAccess;
}

function getDashboardGuidanceLines(dashboardAccess = [], options = {}) {
  const guidance = [];
  const isWsl = isWslEnvironment(options.env, options.platform, options.release);
  const wslAccess = dashboardAccess.find((access) => access && access.label === "VS Code/WSL");

  if (isWsl && wslAccess) {
    guidance.push(
      "WSL/Win     If Windows cannot load http://127.0.0.1:18789/, use the VS Code/WSL URL above exactly as printed.",
    );
    guidance.push(
      "WSL path    Use the direct WSL host IP URL above from Windows. Do not replace it with localhost.",
    );
  }

  return guidance;
}

function buildSandboxConfigSyncScript(selectionConfig, options = {}) {
  const providerType = resolveSelectionProviderType(selectionConfig);
  const modelLimits = getManagedModelLimits(providerType, selectionConfig);
  const primaryModel = getOpenClawPrimaryModel(providerType, selectionConfig.model);
  const providerKey = "inference";
  const runtimeConfigPath = "/tmp/nemoclaw/openclaw.json";
  const controlUiAllowedOrigins = Array.isArray(options.controlUiAllowedOrigins)
    ? options.controlUiAllowedOrigins.filter(
        (value) => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const providerConfig = {
    baseUrl: selectionConfig.endpointUrl,
    apiKey: "unused",
    api: "openai-completions",
    models: [
      {
        id: selectionConfig.model,
        name: selectionConfig.model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: modelLimits.contextWindow,
        maxTokens: modelLimits.maxTokens,
      },
    ],
  };
  return `
set -eu
mkdir -p ~/.nemoclaw
cat > ~/.nemoclaw/config.json <<'EOF_NEMOCLAW_CFG'
${JSON.stringify(selectionConfig, null, 2)}
EOF_NEMOCLAW_CFG
python3 - <<'PYCFG'
import json
import os

runtime_cfg_path = ${JSON.stringify(runtimeConfigPath)}
default_cfg_path = os.path.expanduser('~/.openclaw/openclaw.json')
cfg_path = runtime_cfg_path if os.path.exists(runtime_cfg_path) else default_cfg_path
source_cfg_path = cfg_path if os.path.exists(cfg_path) else default_cfg_path
state_dir = os.path.dirname(default_cfg_path)
cfg = {}
if os.path.exists(source_cfg_path):
  with open(source_cfg_path) as f:
        cfg = json.load(f)

cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = ${JSON.stringify(primaryModel)}
models_cfg = cfg.setdefault('models', {})
models_cfg.setdefault('mode', 'merge')
providers_cfg = models_cfg.setdefault('providers', {})
providers_cfg[${JSON.stringify(providerKey)}] = json.loads(${pythonLiteralJson(providerConfig)})

control_ui_allowed_origins = json.loads(${pythonLiteralJson(controlUiAllowedOrigins)})
if control_ui_allowed_origins:
  control_ui_cfg = cfg.setdefault('gateway', {}).setdefault('controlUi', {})
  existing_origins = control_ui_cfg.setdefault('allowedOrigins', [])
  for origin in control_ui_allowed_origins:
    if isinstance(origin, str) and origin and origin not in existing_origins:
      existing_origins.append(origin)

wrote_cfg = False
try:
  os.makedirs(os.path.dirname(cfg_path), exist_ok=True)
  with open(cfg_path, 'w') as f:
    json.dump(cfg, f, indent=2)
  os.chmod(cfg_path, 0o600)
  wrote_cfg = True
except OSError as err:
  print(f"[nemoclaw] Warning: cannot update {cfg_path}: {err}")

for agent in cfg.get('agents', {}).get('list', []):
    if not isinstance(agent, dict):
        continue
    for key in ('workspace', 'agentDir'):
        dir_path = agent.get(key, '')
        if isinstance(dir_path, str) and dir_path.strip():
            os.makedirs(dir_path.strip(), exist_ok=True)

# Ensure each agent has a webchat session so it appears in the Control UI
for agent in cfg.get('agents', {}).get('list', []):
    if not isinstance(agent, dict) or not agent.get('id'):
        continue
    agent_id = agent['id']
    sessions_dir = os.path.join(state_dir, 'agents', agent_id, 'sessions')
    os.makedirs(sessions_dir, exist_ok=True)
    store_path = os.path.join(sessions_dir, 'sessions.json')
    store = {}
    if os.path.exists(store_path):
        with open(store_path) as f:
            store = json.load(f)
    skey = f'agent:{agent_id}:main'
    entry = store.get(skey, {})
    if entry.get('lastChannel') != 'webchat':
        entry.setdefault('sessionId', f'init-{agent_id}')
        entry['chatType'] = 'direct'
        entry['deliveryContext'] = {'channel': 'webchat'}
        entry['lastChannel'] = 'webchat'
        entry['origin'] = {'provider': 'webchat', 'surface': 'webchat', 'chatType': 'direct'}
        store[skey] = entry
        with open(store_path, 'w') as f:
          json.dump(store, f)
        os.chmod(store_path, 0o600)
PYCFG
openclaw models set ${shellQuote(primaryModel)} > /dev/null 2>&1 || true
exit
`.trim();
}

function isDockerRunning() {
  try {
    runCapture("docker info", { ignoreError: false });
    return true;
  } catch {
    return false;
  }
}

function getContainerRuntime() {
  const info = runCapture("docker info 2>/dev/null", { ignoreError: true });
  return inferContainerRuntime(info);
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

function installOpenshell() {
  const result = spawnSync("bash", [path.join(SCRIPTS, "install-openshell.sh")], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
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
  runOpenshell(["gateway", "destroy", "-g", GATEWAY_NAME], { ignoreError: true });
  // openshell gateway destroy doesn't remove Docker volumes, which leaves
  // corrupted cluster state that breaks the next gateway start. Clean them up.
  run(
    `docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | grep . && docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | xargs docker volume rm || true`,
    { ignoreError: true },
  );
}

async function _ensureNamedCredential(envName, label, helpUrl = null) {
  let key = getCredential(envName);
  if (key) {
    process.env[envName] = key;
    return key;
  }

  if (helpUrl) {
    console.log("");
    console.log(`  Get your ${label} from: ${helpUrl}`);
    console.log("");
  }

  key = await prompt(`  ${label}: `, { secret: true });
  if (!key) {
    console.error(`  ${label} is required.`);
    process.exit(1);
  }

  saveCredential(envName, key);
  process.env[envName] = key;
  console.log("");
  console.log(`  Key saved to ~/.nemoclaw/credentials.json (mode 600)`);
  console.log("");
  return key;
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

function getSandboxState(sandboxName) {
  const registryEntry = registry.getSandbox(sandboxName);
  const output = runCapture(`openshell sandbox get "${sandboxName}"`, {
    ignoreError: true,
  });
  const liveSandboxExists = !!output;

  return {
    registryEntry,
    liveSandboxExists,
    hasStaleRegistryEntry: !!registryEntry && !liveSandboxExists,
    shouldHydrateRegistry: liveSandboxExists && !registryEntry,
  };
}

function parsePolicyPresetEnv(value) {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isSafeModelId(value) {
  return /^[A-Za-z0-9._:/-]+$/.test(value);
}

function getNonInteractiveProvider() {
  const providerKey = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
  if (!providerKey) return null;

  const aliases = {
    cloud: "nvidia-prod",
    ollama: "ollama-local",
    vllm: "vllm-local",
    nim: "nvidia-nim",
  };
  const normalized = aliases[providerKey] || providerKey;
  const validProviders = new Set([
    "nvidia-prod",
    "nvidia-nim",
    "openai-api",
    "anthropic-prod",
    "gemini-api",
    "compatible-endpoint",
    "compatible-anthropic-endpoint",
    "ollama-local",
    "vllm-local",
  ]);
  if (!validProviders.has(normalized)) {
    console.error(`  Unsupported NEMOCLAW_PROVIDER: ${providerKey}`);
    console.error(
      "  Valid values: nvidia-prod, openai-api, anthropic-prod, gemini-api, compatible-endpoint, compatible-anthropic-endpoint, ollama-local, vllm-local",
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

function getCurlTimingArgs() {
  return ["--connect-timeout 5", "--max-time 20"];
}

function normalizeBaseUrl(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

function runCurlJson(url, opts = {}) {
  const bodyPath = path.join(
    os.tmpdir(),
    `nemoclaw-curl-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  const timingArgs = getCurlTimingArgs().flatMap((entry) => entry.split(" "));
  const args = ["-sS", "-o", bodyPath, ...timingArgs, "-w", "%{http_code}"];
  if (opts.method) args.push("-X", opts.method);
  if (opts.headers) {
    for (const header of opts.headers) {
      args.push("-H", header);
    }
  }
  if (opts.body !== undefined) {
    args.push("-d", typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
  }
  args.push(url);

  const result = spawnSync("curl", args, {
    cwd: ROOT,
    encoding: "utf-8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let responseBody;
  try {
    responseBody = fs.readFileSync(bodyPath, "utf-8");
  } catch {
    responseBody = "";
  }
  fs.rmSync(bodyPath, { force: true });

  const statusCode = parseInt(String(result.stdout || "").trim() || "0", 10);
  let parsed;
  try {
    parsed = responseBody ? JSON.parse(responseBody) : null;
  } catch {
    parsed = null;
  }

  return {
    ok: result.status === 0 && statusCode >= 200 && statusCode < 300,
    statusCode,
    body: responseBody,
    json: parsed,
  };
}

let OPENSHELL_BIN = null;

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

function openshellShellCommand(args) {
  return [shellQuote(getOpenshellBinary()), ...args.map((arg) => shellQuote(arg))].join(" ");
}

function runOpenshell(args, opts = {}) {
  return run(openshellShellCommand(args), opts);
}

function runCaptureOpenshell(args, opts = {}) {
  return runCapture(openshellShellCommand(args), opts);
}

function getInstalledOpenshellVersion() {
  const output = runCaptureOpenshell(["--version"], { ignoreError: true });
  if (!output) return null;
  const match = output.trim().match(/(\d+\.\d+\.\d+\S*)/);
  return match ? match[1] : null;
}

// ── Step 1: Preflight ────────────────────────────────────────────

// eslint-disable-next-line complexity
async function preflight() {
  step(1, 7, "Preflight checks");

  // Docker
  if (!isDockerRunning()) {
    console.error("  Docker is not running. Please start Docker and try again.");
    process.exit(1);
  }
  console.log("  ✓ Docker is running");

  const runtime = getContainerRuntime();
  if (isUnsupportedMacosRuntime(runtime)) {
    console.error("  Podman on macOS is not supported by NemoClaw at this time.");
    console.error(
      "  OpenShell currently depends on Docker host-gateway behavior that Podman on macOS does not provide.",
    );
    console.error("  Use Colima or Docker Desktop on macOS instead.");
    process.exit(1);
  }
  if (runtime !== "unknown") {
    console.log(`  ✓ Container runtime: ${runtime}`);
  }

  // OpenShell CLI
  let openshellInstall = { localBin: null, futureShellPathHint: null };
  if (!isOpenshellInstalled()) {
    console.log("  openshell CLI not found. Installing...");
    openshellInstall = installOpenshell();
    if (!openshellInstall.installed) {
      console.error("  Failed to install openshell CLI.");
      console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
      process.exit(1);
    }
  }
  console.log(
    `  ✓ openshell CLI: ${runCaptureOpenshell(["--version"], { ignoreError: true }) || "unknown"}`,
  );
  if (openshellInstall.futureShellPathHint) {
    console.log(
      `  Note: openshell was installed to ${openshellInstall.localBin} for this onboarding run.`,
    );
    console.log(`  Future shells may still need: ${openshellInstall.futureShellPathHint}`);
    console.log(
      "  Add that export to your shell profile, or open a new terminal before running openshell directly.",
    );
  }

  // Gateway cleanup/reuse logic
  const gwInfo = runCapture("openshell gateway info -g nemoclaw 2>/dev/null", {
    ignoreError: true,
  });
  const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
  const dockerGatewayContainers = runCapture("docker ps -a --format '{{.Names}}' 2>/dev/null", {
    ignoreError: true,
  });
  let reusingGateway = false;

  if (hasStaleGateway(gwInfo)) {
    // Check if the existing gateway is actually running (owning port 8080)
    // If it is, we prefer to reuse it to preserve sandboxes.
    const port8080 = await checkPortAvailable(8080);
    if (!port8080.ok && hasLocalGatewayContainer(GATEWAY_NAME, dockerGatewayContainers)) {
      // Port 8080 is in use by the expected local NemoClaw gateway container.
      console.log(
        "  Found active NemoClaw gateway. Reusing existing session to preserve sandboxes.",
      );
      reusingGateway = true;
    } else if (!port8080.ok) {
      // Metadata exists but the expected local container does not. This usually
      // means a foreign local gateway was aliased as 'nemoclaw', which cannot
      // be reused for image upload because OpenShell still expects the local
      // Docker container name to match the gateway name.
      const sandboxList = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      const localGatewayNames = listLocalGatewayNames(dockerGatewayContainers);
      const foreignGatewayName =
        localGatewayNames.find((name) => name !== GATEWAY_NAME) ||
        getReportedGatewayName(gatewayStatus) ||
        "existing";
      console.log(
        `  Found NemoClaw gateway metadata, but local container '${getGatewayClusterContainerName(GATEWAY_NAME)}' does not exist.`,
      );
      const action = await promptForExistingGatewayAction(
        foreignGatewayName,
        countListedSandboxes(sandboxList),
      );
      if (action === "abort") {
        console.log("  Cancelled.");
        process.exit(1);
      }
      console.log(`  Recreating existing gateway '${foreignGatewayName}' for NemoClaw...`);
      run("openshell forward stop 18789 2>/dev/null || true", { ignoreError: true });
      if (foreignGatewayName && foreignGatewayName !== GATEWAY_NAME) {
        runOpenshell(["gateway", "destroy", "-g", foreignGatewayName], { ignoreError: true });
      }
      runOpenshell(["gateway", "destroy", "-g", GATEWAY_NAME], { ignoreError: true });
      console.log(
        `  ✓ Removed stale gateway metadata and existing gateway '${foreignGatewayName}'`,
      );
    } else {
      // Gateway exists in config but port 8080 is free, so it's stopped or broken.
      console.log("  Cleaning up stopped/stale NemoClaw session...");
      run("openshell forward stop 18789 2>/dev/null || true", { ignoreError: true });
      run("openshell gateway destroy -g nemoclaw 2>/dev/null || true", { ignoreError: true });
      console.log("  ✓ Previous session cleaned up");
    }
  }

  const activeGatewayName = getReportedGatewayName(gatewayStatus);
  if (!reusingGateway && activeGatewayName && activeGatewayName !== GATEWAY_NAME) {
    const activeGatewayInfo = runCaptureOpenshell(["gateway", "info", "-g", activeGatewayName], {
      ignoreError: true,
    });
    const port8080 = await checkPortAvailable(8080);
    if (!port8080.ok && hasActiveGatewayInfo(activeGatewayInfo)) {
      const sandboxList = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      const action = await promptForExistingGatewayAction(
        activeGatewayName,
        countListedSandboxes(sandboxList),
      );
      if (action === "abort") {
        console.log("  Cancelled.");
        process.exit(1);
      }
      console.log(`  Recreating existing gateway '${activeGatewayName}' for NemoClaw...`);
      run("openshell forward stop 18789 2>/dev/null || true", { ignoreError: true });
      runOpenshell(["gateway", "destroy", "-g", activeGatewayName], { ignoreError: true });
      console.log(`  ✓ Removed existing gateway '${activeGatewayName}'`);
    }
  }

  // Required ports — gateway (8080) and dashboard (18789)
  const requiredPorts = [
    { port: 8080, label: "OpenShell gateway" },
    { port: 18789, label: "NemoClaw dashboard" },
  ];
  for (const { port, label } of requiredPorts) {
    // If reusing gateway, we expect port 8080 to be taken by us.
    if (reusingGateway && port === 8080) {
      console.log(`  ✓ Port ${port} is active (reusing gateway)`);
      continue;
    }

    const portCheck = await checkPortAvailable(port);
    if (!portCheck.ok) {
      if ((port === 8080 || port === 18789) && reusingGateway) {
        console.log(`  ✓ Port ${port} already owned by healthy NemoClaw runtime (${label})`);
        continue;
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
          console.error(`       lsof -i :${port} -sTCP:LISTEN -P -n`);
        }
        console.error("       # or, if it's a systemd service:");
        console.error("       systemctl --user stop openclaw-gateway.service");
      } else {
        console.error(`     Could not identify the process using port ${port}.`);
        console.error(`     Run: lsof -i :${port} -sTCP:LISTEN`);
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
  } else if (gpu && gpu.type === "apple") {
    console.log(
      `  ✓ Apple GPU detected: ${gpu.name}${gpu.cores ? ` (${gpu.cores} cores)` : ""}, ${gpu.totalMemoryMB} MB unified memory`,
    );
    console.log("  ⓘ NIM requires NVIDIA GPU — will use cloud inference");
  } else {
    console.log("  ⓘ No GPU detected — will use cloud inference");
  }

  return { gpu, reusingGateway };
}

// ── Step 2: Gateway ──────────────────────────────────────────────

async function startGatewayWithOptions(_gpu, { exitOnFailure = true } = {}) {
  step(3, 7, "Starting OpenShell gateway");

  const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
  const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
    ignoreError: true,
  });
  if (isGatewayHealthy(gatewayStatus, gwInfo)) {
    console.log("  ✓ Reusing existing gateway");
    runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
    process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
    return;
  }

  if (hasStaleGateway(gwInfo)) {
    runOpenshell(["gateway", "destroy", "-g", GATEWAY_NAME], { ignoreError: true });
  }

  const gwArgs = ["--name", GATEWAY_NAME];
  const gatewayEnv = {};
  const openshellVersion = getInstalledOpenshellVersion();
  const stableGatewayImage = openshellVersion
    ? `ghcr.io/nvidia/openshell/cluster:${openshellVersion}`
    : null;
  if (stableGatewayImage && openshellVersion) {
    gatewayEnv.OPENSHELL_CLUSTER_IMAGE = stableGatewayImage;
    gatewayEnv.IMAGE_TAG = openshellVersion;
    console.log(`  Using pinned OpenShell gateway image: ${stableGatewayImage}`);
  }

  const startResult = runOpenshell(["gateway", "start", ...gwArgs], {
    ignoreError: true,
    env: gatewayEnv,
  });
  if (startResult.status !== 0) {
    console.error("  Gateway failed to start. Cleaning up stale state...");
    destroyGateway();
    if (exitOnFailure) {
      console.error("  Stale state removed. Please rerun: nemoclaw onboard");
      process.exit(1);
    }
    throw new Error("Gateway failed to start");
  }

  // Verify health
  for (let i = 0; i < 5; i++) {
    const status = runCaptureOpenshell(["status"], { ignoreError: true });
    const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
      ignoreError: true,
    });
    if (isGatewayHealthy(status, gwInfo)) {
      console.log("  ✓ Gateway is healthy");
      break;
    }
    if (i === 4) {
      console.error("  Gateway health check failed. Cleaning up stale state...");
      destroyGateway();
      if (exitOnFailure) {
        console.error("  Stale state removed. Please rerun: nemoclaw onboard");
        process.exit(1);
      }
      throw new Error("Gateway failed to start");
    }
    sleep(2);
  }

  const runtime = getContainerRuntime();
  if (shouldPatchCoredns(runtime)) {
    console.log("  Patching CoreDNS for Colima...");
    run(`bash "${path.join(SCRIPTS, "fix-coredns.sh")}" ${GATEWAY_NAME} 2>&1 || true`, {
      ignoreError: true,
    });
  }
  sleep(5);
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
  process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
}

async function startGateway(_gpu, _reusingGateway = false) {
  return startGatewayWithOptions(_gpu, { exitOnFailure: true });
}

async function _startGatewayForRecovery(_gpu, _reusingGateway = false) {
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

async function _recoverGatewayRuntime() {
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
  let status = runCaptureOpenshell(["status"], { ignoreError: true });
  if (status.includes("Connected") && isSelectedGateway(status)) {
    process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
    return true;
  }

  runOpenshell(["gateway", "start", "--name", GATEWAY_NAME], {
    ignoreError: true,
    env: getGatewayStartEnv(),
  });
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });

  for (let i = 0; i < 5; i++) {
    status = runCaptureOpenshell(["status"], { ignoreError: true });
    if (status.includes("Connected") && isSelectedGateway(status)) {
      process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
      const runtime = getContainerRuntime();
      if (shouldPatchCoredns(runtime)) {
        run(`bash "${path.join(SCRIPTS, "fix-coredns.sh")}" ${GATEWAY_NAME} 2>&1 || true`, {
          ignoreError: true,
        });
      }
      return true;
    }
    sleep(2);
  }

  return false;
}

function shouldIncludeBuildContextPath(sourceRoot, candidatePath) {
  const relative = path.relative(sourceRoot, candidatePath);
  if (!relative || relative === "") return true;

  const segments = relative.split(path.sep);
  const basename = path.basename(candidatePath);
  const excludedSegments = new Set([
    ".venv",
    ".ruff_cache",
    ".pytest_cache",
    ".mypy_cache",
    "__pycache__",
    "node_modules",
    ".git",
  ]);

  if (basename === ".DS_Store" || basename.startsWith("._")) {
    return false;
  }

  return !segments.some((segment) => excludedSegments.has(segment));
}

function copyBuildContextDir(sourceDir, destinationDir) {
  fs.cpSync(sourceDir, destinationDir, {
    recursive: true,
    filter: (candidatePath) => shouldIncludeBuildContextPath(sourceDir, candidatePath),
  });
}

function sandboxExistsInGateway(sandboxName) {
  const output = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
  return Boolean(output);
}

function pruneStaleSandboxEntry(sandboxName) {
  const existing = registry.getSandbox(sandboxName);
  const liveExists = sandboxExistsInGateway(sandboxName);
  if (existing && !liveExists) {
    console.log(
      `  Detected stale local sandbox entry for '${sandboxName}'. OpenShell does not have this sandbox, so NemoClaw will recreate it.`,
    );
    registry.removeSandbox(sandboxName);
  }
  return liveExists;
}

// ── Step 3: Sandbox ──────────────────────────────────────────────

async function promptValidatedSandboxName() {
  const nameAnswer = await promptOrDefault(
    "  Sandbox name (lowercase, numbers, hyphens) [my-assistant]: ",
    "NEMOCLAW_SANDBOX_NAME",
    "my-assistant",
  );
  const sandboxName = (nameAnswer || "my-assistant").trim().toLowerCase();

  // Validate: RFC 1123 subdomain — lowercase alphanumeric and hyphens,
  // must start and end with alphanumeric (required by Kubernetes/OpenShell)
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName)) {
    console.error(`  Invalid sandbox name: '${sandboxName}'`);
    console.error("  Names must be lowercase, contain only letters, numbers, and hyphens,");
    console.error("  and must start and end with a letter or number.");
    process.exit(1);
  }

  return sandboxName;
}

async function createSandbox(
  gpu,
  model,
  provider,
  _preferredInferenceApi = null,
  sandboxNameOverride = null,
) {
  step(5, 7, "Creating sandbox");

  const sandboxName = sandboxNameOverride || (await promptValidatedSandboxName());

  // Reconcile local registry state with the live OpenShell gateway state.
  const liveExists = pruneStaleSandboxEntry(sandboxName);

  if (liveExists) {
    if (!registry.getSandbox(sandboxName)) {
      console.log(
        `  Found existing OpenShell sandbox '${sandboxName}'. Syncing local NemoClaw state before continuing.`,
      );
      registry.registerSandbox({
        name: sandboxName,
        gpuEnabled: !!gpu,
      });
    }

    const existingSandboxState = getSandboxReuseState(sandboxName);
    if (existingSandboxState === "ready" && process.env.NEMOCLAW_RECREATE_SANDBOX !== "1") {
      if (isNonInteractive()) {
        note(`  [non-interactive] Sandbox '${sandboxName}' exists and is ready — reusing it`);
      } else {
        console.log(`  Sandbox '${sandboxName}' already exists and is ready.`);
        console.log("  Reusing existing sandbox.");
        console.log("  Set NEMOCLAW_RECREATE_SANDBOX=1 to recreate it instead.");
      }
      return sandboxName;
    }

    if (existingSandboxState === "ready") {
      note(`  Sandbox '${sandboxName}' exists and is ready — recreating by explicit request.`);
    } else {
      note(`  Sandbox '${sandboxName}' exists but is not ready — recreating it.`);
    }
    // Destroy old sandbox
    runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    registry.removeSandbox(sandboxName);
  }

  // Stage build context
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  fs.copyFileSync(path.join(ROOT, "Dockerfile"), stagedDockerfile);
  copyBuildContextDir(path.join(ROOT, "nemoclaw"), path.join(buildCtx, "nemoclaw"));
  copyBuildContextDir(
    path.join(ROOT, "nemoclaw-blueprint"),
    path.join(buildCtx, "nemoclaw-blueprint"),
  );
  copyBuildContextDir(path.join(ROOT, "scripts"), path.join(buildCtx, "scripts"));

  const controlUiOrigins = getControlUiAllowedOrigins();
  const wslControlUiOrigin = controlUiOrigins.find(
    (origin) => origin !== "http://127.0.0.1:18789" && origin !== "http://localhost:18789",
  );
  const chatUiUrl = process.env.CHAT_UI_URL || wslControlUiOrigin || "http://127.0.0.1:18789";

  // openclaw.json is generated at image build-time from Dockerfile ARGs.
  // Update CHAT_UI_URL in the staged Dockerfile so allowedOrigins includes
  // the Win11-reachable WSL host origin when onboarding under WSL.
  const stagedDockerfileText = fs.readFileSync(stagedDockerfile, "utf-8");
  const patchedDockerfileText = stagedDockerfileText.replace(
    /^ARG CHAT_UI_URL=.*$/m,
    `ARG CHAT_UI_URL=${chatUiUrl}`,
  );
  fs.writeFileSync(stagedDockerfile, patchedDockerfileText, "utf-8");

  // Create sandbox (use -- echo to avoid dropping into interactive shell)
  // Pass the base policy so sandbox starts in proxy mode (required for policy updates later)
  const basePolicyPath = path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
  const createArgs = [
    "--from",
    `${buildCtx}/Dockerfile`,
    "--name",
    sandboxName,
    "--policy",
    basePolicyPath,
  ];
  // --gpu is intentionally omitted. See comment in startGateway().

  console.log(`  Creating sandbox '${sandboxName}' (this takes a few minutes on first run)...`);
  const sandboxEnv = { ...process.env };
  sandboxEnv.CHAT_UI_URL = chatUiUrl;

  // Run without piping through awk — the pipe masked non-zero exit codes
  // from openshell because bash returns the status of the last pipeline
  // command (awk, always 0) unless pipefail is set. Removing the pipe
  // lets the real exit code flow through to run().
  // Launch nemoclaw-start in the background and return immediately so
  // `openshell sandbox create` can finish once the sandbox is ready.
  // Passing a foreground gateway command here causes the create stream to hang.
  const backgroundStart = shellQuote(
    `nohup /usr/local/bin/nemoclaw-start >/tmp/gateway.log 2>&1 &`,
  );
  const createCommand = `openshell sandbox create ${createArgs.join(" ")} -- env CHAT_UI_URL=${shellQuote(chatUiUrl)} bash -lc ${backgroundStart} 2>&1`;
  const createResult = await streamSandboxCreate(createCommand, sandboxEnv, { ignoreError: true });
  // Clean up build context regardless of outcome
  run(`rm -rf "${buildCtx}"`, { ignoreError: true });

  if (createResult.status !== 0) {
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
    require("child_process").spawnSync("sleep", ["2"]);
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

  // Release any stale forward on port 18789 before claiming it for the new sandbox.
  // A previous onboard run may have left the port forwarded to a different sandbox,
  // which would silently prevent the new sandbox's dashboard from being reachable.
  runOpenshell(["forward", "stop", "18789"], { ignoreError: true });
  // Forward dashboard port to the new sandbox
  run(getDashboardForwardStartCommand(sandboxName), { ignoreError: true });

  // Register only after confirmed ready — prevents phantom entries
  registry.registerSandbox({
    name: sandboxName,
    gpuEnabled: !!gpu,
  });

  console.log(`  ✓ Sandbox '${sandboxName}' created`);
  return sandboxName;
}

// ── Step 4: NIM ──────────────────────────────────────────────────

// eslint-disable-next-line complexity
async function setupNim(sandboxName, _gpu) {
  step(4, 7, "Configuring inference (NIM)");

  let model;
  let provider;
  let nimContainer = null;
  let providerBaseUrl;
  let endpointUrl;
  let preferredInferenceApi;
  let ollamaEndpoint = resolveOllamaEndpoint(runCapture);

  // Detect local inference options
  const hasOllama = !!runCapture("command -v ollama", { ignoreError: true });
  const ollamaRunning = !!ollamaEndpoint;
  const vllmRunning = !!runCapture("curl -sf http://localhost:8000/v1/models 2>/dev/null", {
    ignoreError: true,
  });
  const requestedProvider = isNonInteractive() ? getNonInteractiveProvider() : null;
  const requestedModel = isNonInteractive()
    ? getNonInteractiveModel(requestedProvider || "nvidia-prod")
    : null;

  const providerOptions = [
    { key: "nvidia-prod", label: "NVIDIA Endpoints" },
    { key: "openai-api", label: "OpenAI" },
    { key: "compatible-endpoint", label: "Other OpenAI-compatible endpoint" },
    { key: "anthropic-prod", label: "Anthropic" },
    { key: "compatible-anthropic-endpoint", label: "Other Anthropic-compatible endpoint" },
    { key: "gemini-api", label: "Google Gemini" },
    { key: "ollama-local", label: "Local Ollama" },
    { key: "vllm-local", label: "Local vLLM" },
  ];

  const parseModelIds = (payload) => {
    if (!payload || !Array.isArray(payload.data)) return [];
    return payload.data.map((item) => item && item.id).filter(Boolean);
  };

  const validateModelInCatalog = (catalogUrl, authHeader, modelId, providerLabel) => {
    const probe = runCurlJson(catalogUrl, {
      method: "GET",
      headers: [authHeader],
    });
    const ids = parseModelIds(probe.json);
    if (!ids.includes(modelId)) {
      console.log(`  '${modelId}' is not available from ${providerLabel}. Please try again.`);
      return false;
    }
    return true;
  };

  while (true) {
    let selected;

    if (isNonInteractive()) {
      selected =
        providerOptions.find((option) => option.key === (requestedProvider || "nvidia-prod")) ||
        providerOptions[0];
      console.log(`  [non-interactive] Provider: ${selected.key}`);
    } else {
      const suggestions = [];
      if (vllmRunning) suggestions.push("vLLM");
      if (ollamaRunning || hasOllama) suggestions.push("Ollama");
      if (suggestions.length > 0) {
        console.log(
          `  Detected local inference option${suggestions.length > 1 ? "s" : ""}: ${suggestions.join(", ")}`,
        );
        console.log("  Press Enter to keep NVIDIA Endpoints.");
        console.log("");
      }

      console.log("  Inference options:");
      providerOptions.forEach((option, index) => {
        console.log(`    ${index + 1}) ${option.label}`);
      });
      console.log("");

      const choice = await prompt("  Choose [1]: ");
      const index = parseInt(choice || "1", 10) - 1;
      selected = providerOptions[index] || providerOptions[0];
    }

    if (selected.key === "nvidia-prod") {
      provider = "nvidia-prod";
      preferredInferenceApi = "openai-responses";
      endpointUrl = "https://integrate.api.nvidia.com/v1";
      if (!isNonInteractive()) await ensureApiKey();
      const cloudModels = [...CLOUD_MODEL_OPTIONS, { id: null, label: "Other..." }];
      if (!isNonInteractive()) {
        console.log("  Cloud models:");
        cloudModels.forEach((option, index) => {
          console.log(`    ${index + 1}) ${option.label}${option.id ? ` (${option.id})` : ""}`);
        });
        console.log("");
      }

      if (isNonInteractive()) {
        model = requestedModel || DEFAULT_CLOUD_MODEL;
      } else {
        const modelChoice = await prompt("  Choose model [1]: ");
        const modelIndex = parseInt(modelChoice || "1", 10) - 1;
        const selection = cloudModels[modelIndex] || cloudModels[0];
        if (selection.id) {
          model = selection.id;
        } else {
          while (true) {
            const manual = await prompt("  NVIDIA Endpoints model id: ");
            if (!isSafeModelId(manual)) continue;
            if (
              validateModelInCatalog(
                "https://integrate.api.nvidia.com/v1/models",
                `Authorization: Bearer ${process.env.NVIDIA_API_KEY || ""}`,
                manual,
                "NVIDIA Endpoints",
              )
            ) {
              model = manual;
              break;
            }
          }
        }
      }
      if (!model) model = DEFAULT_CLOUD_MODEL;
      console.log("  Responses API available");
      break;
    }

    if (selected.key === "openai-api") {
      provider = "openai-api";
      preferredInferenceApi = "openai-responses";
      endpointUrl = "https://api.openai.com/v1";
      const openAiModels = [
        { id: "gpt-5.4", label: "GPT-5.4" },
        { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
        { id: "gpt-4.1", label: "GPT-4.1" },
        { id: "gpt-4o", label: "GPT-4o" },
        { id: null, label: "Other..." },
      ];
      if (!isNonInteractive()) {
        console.log("  OpenAI models:");
        openAiModels.forEach((option, index) => {
          console.log(`    ${index + 1}) ${option.label}${option.id ? ` (${option.id})` : ""}`);
        });
        console.log("");
      }

      if (isNonInteractive()) {
        model = requestedModel || openAiModels[0].id;
      } else {
        const modelChoice = await prompt("  Choose model [1]: ");
        const modelIndex = parseInt(modelChoice || "1", 10) - 1;
        const selection = openAiModels[modelIndex] || openAiModels[0];
        if (selection.id) {
          model = selection.id;
        } else {
          while (true) {
            const manual = await prompt("  OpenAI model id: ");
            if (!isSafeModelId(manual)) continue;
            if (
              validateModelInCatalog(
                "https://api.openai.com/v1/models",
                `Authorization: Bearer ${process.env.OPENAI_API_KEY || ""}`,
                manual,
                "OpenAI",
              )
            ) {
              model = manual;
              break;
            }
          }
        }
      }

      const validation = runCurlJson("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: [
          `Authorization: Bearer ${process.env.OPENAI_API_KEY || ""}`,
          "Content-Type: application/json",
        ],
        body: { model, input: "ping" },
      });
      if (!validation.ok && !isNonInteractive()) {
        console.error("  OpenAI endpoint validation failed");
        console.error("  Please choose a provider/model again");
        continue;
      }
      console.log("  Responses API available");
      break;
    }

    if (selected.key === "compatible-endpoint") {
      provider = "compatible-endpoint";
      preferredInferenceApi = "openai-responses";
      const baseUrl = normalizeBaseUrl(await prompt("  OpenAI-compatible base URL: "));
      endpointUrl = baseUrl;
      while (true) {
        const manual = await prompt("  Other OpenAI-compatible endpoint model: ");
        if (!isSafeModelId(manual)) continue;
        const validation = runCurlJson(`${baseUrl}/responses`, {
          method: "POST",
          headers: [
            `Authorization: Bearer ${process.env.COMPATIBLE_API_KEY || ""}`,
            "Content-Type: application/json",
          ],
          body: { model: manual, input: "ping" },
        });
        if (validation.ok) {
          model = manual;
          break;
        }
        if (isNonInteractive()) {
          console.error("  Other OpenAI-compatible endpoint endpoint validation failed");
          process.exit(1);
        }
        console.error("  Other OpenAI-compatible endpoint endpoint validation failed");
        console.error("  Please enter a different Other OpenAI-compatible endpoint model name.");
      }
      break;
    }

    if (selected.key === "anthropic-prod") {
      provider = "anthropic-prod";
      preferredInferenceApi = "anthropic-messages";
      endpointUrl = "https://api.anthropic.com";
      const anthropicModels = [
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
        { id: "claude-3-opus-20240229", label: "Claude 3 Opus" },
        { id: null, label: "Other..." },
      ];

      if (!isNonInteractive()) {
        console.log("  Anthropic models:");
        anthropicModels.forEach((option, index) => {
          console.log(`    ${index + 1}) ${option.label}${option.id ? ` (${option.id})` : ""}`);
        });
        console.log("");
      }

      if (isNonInteractive()) {
        model = requestedModel || anthropicModels[0].id;
      } else {
        const modelChoice = await prompt("  Choose model [1]: ");
        const modelIndex = parseInt(modelChoice || "1", 10) - 1;
        const selection = anthropicModels[modelIndex] || anthropicModels[0];
        if (selection.id) {
          model = selection.id;
        } else {
          while (true) {
            const manual = await prompt("  Anthropic model id: ");
            if (!isSafeModelId(manual)) continue;
            if (
              validateModelInCatalog(
                "https://api.anthropic.com/v1/models",
                `x-api-key: ${process.env.ANTHROPIC_API_KEY || ""}`,
                manual,
                "Anthropic",
              )
            ) {
              model = manual;
              break;
            }
          }
        }
      }

      const validation = runCurlJson("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: [
          `x-api-key: ${process.env.ANTHROPIC_API_KEY || ""}`,
          "anthropic-version: 2023-06-01",
          "Content-Type: application/json",
        ],
        body: {
          model,
          max_tokens: 16,
          messages: [{ role: "user", content: "ping" }],
        },
      });
      if (!validation.ok && !isNonInteractive()) {
        console.error("  Anthropic endpoint validation failed");
        console.error("  Please choose a provider/model again");
        continue;
      }
      break;
    }

    if (selected.key === "compatible-anthropic-endpoint") {
      provider = "compatible-anthropic-endpoint";
      preferredInferenceApi = "anthropic-messages";
      const baseUrl = normalizeBaseUrl(await prompt("  Anthropic-compatible base URL: "));
      endpointUrl = baseUrl;
      while (true) {
        const manual = await prompt("  Other Anthropic-compatible endpoint model: ");
        if (!isSafeModelId(manual)) continue;
        const validation = runCurlJson(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: [
            `x-api-key: ${process.env.COMPATIBLE_ANTHROPIC_API_KEY || ""}`,
            "anthropic-version: 2023-06-01",
            "Content-Type: application/json",
          ],
          body: {
            model: manual,
            max_tokens: 16,
            messages: [{ role: "user", content: "ping" }],
          },
        });
        if (validation.ok) {
          model = manual;
          console.log("  Anthropic Messages API available");
          break;
        }
        if (isNonInteractive()) {
          console.error("  Other Anthropic-compatible endpoint endpoint validation failed");
          process.exit(1);
        }
        console.error("  Other Anthropic-compatible endpoint endpoint validation failed");
        console.error("  Please enter a different Other Anthropic-compatible endpoint model name.");
      }
      break;
    }

    if (selected.key === "gemini-api") {
      provider = "gemini-api";
      endpointUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
      const geminiModels = [
        { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
        { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
        { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
        { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
        { id: "gemini-1.0-pro", label: "Gemini 1.0 Pro" },
        { id: "gemini-1.0-pro-vision", label: "Gemini 1.0 Pro Vision" },
        { id: null, label: "Other..." },
      ];
      if (!isNonInteractive()) {
        console.log("  Google Gemini models:");
        geminiModels.forEach((option, index) => {
          console.log(`    ${index + 1}) ${option.label}${option.id ? ` (${option.id})` : ""}`);
        });
        console.log("");
      }
      if (isNonInteractive()) {
        model = requestedModel || geminiModels[0].id;
      } else {
        const modelChoice = await prompt("  Choose model [5]: ");
        const modelIndex = parseInt(modelChoice || "5", 10) - 1;
        const selection = geminiModels[modelIndex] || geminiModels[4];
        if (selection.id) {
          model = selection.id;
        } else {
          while (true) {
            const manual = await prompt("  Google Gemini model id: ");
            if (!isSafeModelId(manual)) continue;
            model = manual;
            break;
          }
        }
      }

      const responsesProbe = runCurlJson(
        "https://generativelanguage.googleapis.com/v1beta/openai/responses",
        {
          method: "POST",
          headers: [
            `Authorization: Bearer ${process.env.GEMINI_API_KEY || ""}`,
            "Content-Type: application/json",
          ],
          body: { model, input: "ping" },
        },
      );
      if (responsesProbe.ok) {
        preferredInferenceApi = "openai-responses";
        console.log("  Responses API available");
        break;
      }

      const completionsProbe = runCurlJson(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        {
          method: "POST",
          headers: [
            `Authorization: Bearer ${process.env.GEMINI_API_KEY || ""}`,
            "Content-Type: application/json",
          ],
          body: {
            model,
            messages: [{ role: "user", content: "ping" }],
          },
        },
      );
      if (!completionsProbe.ok && !isNonInteractive()) {
        console.error("  Gemini endpoint validation failed");
        console.error("  Please choose a provider/model again");
        continue;
      }
      preferredInferenceApi = "openai-completions";
      console.log("  Chat Completions API available");
      break;
    }

    if (selected.key === "ollama-local") {
      provider = "ollama-local";
      preferredInferenceApi = "openai-responses";
      ollamaEndpoint = resolveOllamaEndpoint(runCapture) || ollamaEndpoint;
      const ollamaHostBase = ollamaEndpoint?.hostUrl || "http://localhost:11434";
      endpointUrl = ollamaEndpoint?.openaiBaseUrl || `${ollamaHostBase}/v1`;

      let ollamaModels;
      try {
        const tagsRaw = runCapture(
          `curl -sf ${shellQuote(`${ollamaHostBase}/api/tags`)} 2>/dev/null`,
          { ignoreError: true },
        );
        const tags = tagsRaw ? JSON.parse(tagsRaw) : { models: [] };
        ollamaModels = Array.isArray(tags.models)
          ? tags.models.map((entry) => entry && entry.name).filter(Boolean)
          : [];
      } catch {
        ollamaModels = [];
      }
      if (ollamaModels.length === 0) {
        console.log("  No local Ollama models are installed yet");
        const starterModels = ["qwen2.5:7b", "Other..."];
        while (true) {
          console.log("  Ollama starter models:");
          starterModels.forEach((entry, index) => {
            console.log(`    ${index + 1}) ${entry}`);
          });
          const starterChoice = await prompt("  Choose model [1]: ");
          const starterIndex = parseInt(starterChoice || "1", 10) - 1;
          const starterSelection = starterModels[starterIndex] || starterModels[0];
          const candidate =
            starterSelection === "Other..."
              ? await prompt("  Ollama model id: ")
              : starterSelection;
          if (!isSafeModelId(candidate)) continue;
          console.log(`  Pulling Ollama model: ${candidate}`);
          const pullResult = run(`ollama pull ${shellQuote(candidate)}`, { ignoreError: true });
          if (pullResult.status !== 0) {
            console.error(`  Failed to pull Ollama model '${candidate}'`);
            console.error("  Choose a different Ollama model or select Other.");
            continue;
          }
          model = candidate;
          break;
        }
      } else {
        console.log("  Ollama models:");
        ollamaModels.forEach((entry, index) => {
          console.log(`    ${index + 1}) ${entry}`);
        });
        const modelChoice = await prompt("  Choose model [1]: ");
        const modelIndex = parseInt(modelChoice || "1", 10) - 1;
        model =
          ollamaModels[modelIndex] ||
          ollamaModels[0] ||
          getDefaultOllamaModel(runCapture, { endpoint: ollamaEndpoint });
      }
      console.log(`  Loading Ollama model: ${model}`);
      run(
        `curl -sS ${getCurlTimingArgs().join(" ")} -X POST ${shellQuote(`${ollamaHostBase}/api/generate`)} -H 'Content-Type: application/json' -d '${JSON.stringify({ model, prompt: "hello", stream: false })}' > /dev/null 2>&1`,
        { ignoreError: true },
      );
      providerBaseUrl = endpointUrl;
      break;
    }

    if (selected.key === "vllm-local") {
      provider = "vllm-local";
      preferredInferenceApi = "openai-responses";
      endpointUrl = "http://localhost:8000/v1";
      model = requestedModel || "vllm-local";
      providerBaseUrl = endpointUrl;
      break;
    }
  }

  if (!model) model = requestedModel || DEFAULT_CLOUD_MODEL;

  registry.updateSandbox(sandboxName, {
    model,
    provider,
    nimContainer,
    providerBaseUrl: providerBaseUrl || endpointUrl || null,
  });

  return {
    model,
    provider,
    ollamaEndpoint,
    providerBaseUrl: providerBaseUrl || endpointUrl || null,
    preferredInferenceApi,
    endpointUrl,
  };
}

// ── Step 5: Inference provider ───────────────────────────────────

async function setupInference(sandboxName, model, provider, opts = {}) {
  step(5, 7, "Setting up inference provider");

  let modelMetadata = opts.modelMetadata || null;

  const upsertProvider = (name, type, credentialEnv, configArg) => {
    const createArgs = ["openshell", "provider", "create", "--name", name, "--type", type];
    if (credentialEnv) {
      createArgs.push("--credential", credentialEnv);
    }
    createArgs.push("--config", configArg);

    const updateArgs = ["openshell", "provider", "update", "--config", configArg];
    if (credentialEnv) {
      updateArgs.push("--credential", credentialEnv);
    }
    updateArgs.push(name);

    const createCommand = createArgs.map((arg) => shellQuote(arg)).join(" ");
    const updateCommand = updateArgs.map((arg) => shellQuote(arg)).join(" ");
    run(`${createCommand} 2>&1 || ${updateCommand} 2>&1 || true`, { ignoreError: true });
  };

  if (provider === "nvidia-nim" || provider === "nvidia-prod") {
    upsertProvider(
      "nvidia-nim",
      "openai",
      "NVIDIA_API_KEY",
      "OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1",
    );
    run(
      `openshell inference set --no-verify --provider nvidia-nim --model ${model} 2>/dev/null || true`,
      { ignoreError: true },
    );
  } else if (provider === "vllm-local") {
    const validation = validateLocalProvider(provider, runCapture);
    if (!validation.ok) {
      console.error(`  ${validation.message}`);
      process.exit(1);
    }
    const baseUrl = getLocalProviderBaseUrl(provider);
    upsertProvider("vllm-local", "openai", "OPENAI_API_KEY=unused", `OPENAI_BASE_URL=${baseUrl}`);
    run(
      `openshell inference set --no-verify --provider vllm-local --model ${model} 2>/dev/null || true`,
      { ignoreError: true },
    );
  } else if (provider === "ollama-local") {
    const validation = validateLocalProvider(provider, runCapture, {
      endpoint: opts.ollamaEndpoint,
      returnEndpoint: true,
    });
    if (!validation.ok) {
      console.error(`  ${validation.message}`);
      console.error("  On macOS, local inference also depends on OpenShell host routing support.");
      process.exit(1);
    }
    const runtimeEndpoint =
      validation.endpoint ||
      resolveOllamaContainerRoute(opts.ollamaEndpoint, runCapture) ||
      opts.ollamaEndpoint;
    const baseUrl = getLocalProviderBaseUrl(provider, { endpoint: runtimeEndpoint, runCapture });
    upsertProvider("ollama-local", "openai", "OPENAI_API_KEY=unused", `OPENAI_BASE_URL=${baseUrl}`);
    run(
      `openshell inference set --no-verify --provider ollama-local --model ${model} 2>/dev/null || true`,
      { ignoreError: true },
    );
    modelMetadata = getOllamaModelMetadata(runCapture, model, { endpoint: opts.ollamaEndpoint });
    const compatibility = validateOllamaOpenClawCompatibility(model, modelMetadata);
    if (!compatibility.ok) {
      console.error(`  ${compatibility.message}`);
      process.exit(1);
    }
    console.log(`  Priming Ollama model: ${model}`);
    const probe = validateOllamaModel(model, runCapture, { endpoint: opts.ollamaEndpoint });
    const probeOutcome = getOllamaProbeOutcome(model, probe, opts);
    if (probeOutcome.message) {
      const log = probeOutcome.fatal ? console.error : console.warn;
      log(`  ${probeOutcome.message}`);
    }
    if (probeOutcome.fatal) {
      process.exit(1);
    }
  }

  registry.updateSandbox(sandboxName, {
    model,
    provider,
    providerBaseUrl:
      provider === "ollama-local"
        ? getLocalProviderBaseUrl(provider, { endpoint: opts.ollamaEndpoint, runCapture })
        : opts.providerBaseUrl || null,
  });
  console.log(`  ✓ Inference route set: ${provider} / ${model}`);

  return { modelMetadata };
}

async function syncSandboxInferenceConfig(sandboxName, model, provider, opts = {}) {
  const selectionConfig = getProviderSelectionConfig(provider, model);
  if (!selectionConfig) {
    return false;
  }

  const sandboxConfig = {
    ...selectionConfig,
    ...(opts.modelMetadata || {}),
    onboardedAt: new Date().toISOString(),
  };
  const script = buildSandboxConfigSyncScript(sandboxConfig, {
    controlUiAllowedOrigins: getControlUiAllowedOrigins(),
  });
  run(`cat <<'EOF_NEMOCLAW_SYNC' | openshell sandbox connect "${sandboxName}"
${script}
EOF_NEMOCLAW_SYNC`);
  return true;
}

// ── Step 6: OpenClaw ─────────────────────────────────────────────

async function setupOpenclaw(sandboxName, model, provider, opts = {}) {
  step(6, 7, "Setting up OpenClaw inside sandbox");
  await syncSandboxInferenceConfig(sandboxName, model, provider, opts);

  console.log("  ✓ OpenClaw gateway launched inside sandbox");
}

// ── Step 7: Policy presets ───────────────────────────────────────

// eslint-disable-next-line complexity
async function _setupPolicies(sandboxName) {
  step(7, 7, "Policy presets");

  const suggestions = ["pypi", "npm"];

  // Auto-detect based on env tokens
  if (getCredential("TELEGRAM_BOT_TOKEN")) {
    suggestions.push("telegram");
    console.log("  Auto-detected: TELEGRAM_BOT_TOKEN → suggesting telegram preset");
  }
  if (getCredential("SLACK_BOT_TOKEN") || process.env.SLACK_BOT_TOKEN) {
    suggestions.push("slack");
    console.log("  Auto-detected: SLACK_BOT_TOKEN → suggesting slack preset");
  }
  if (getCredential("DISCORD_BOT_TOKEN") || process.env.DISCORD_BOT_TOKEN) {
    suggestions.push("discord");
    console.log("  Auto-detected: DISCORD_BOT_TOKEN → suggesting discord preset");
  }

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
          if (message.includes("Unimplemented")) {
            console.error("  OpenShell policy updates are not supported by this gateway build.");
            console.error("  This is a known issue tracked in NemoClaw #536.");
            throw err;
          }
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
      const marker = applied.includes(p.name) ? "●" : "○";
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
        try {
          policies.applyPreset(sandboxName, name);
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          if (message.includes("Unimplemented")) {
            console.error("  OpenShell policy updates are not supported by this gateway build.");
            console.error("  This is a known issue tracked in NemoClaw #536.");
          }
          throw err;
        }
      }
    } else {
      // Apply suggested
      for (const name of suggestions) {
        try {
          policies.applyPreset(sandboxName, name);
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          if (message.includes("Unimplemented")) {
            console.error("  OpenShell policy updates are not supported by this gateway build.");
            console.error("  This is a known issue tracked in NemoClaw #536.");
          }
          throw err;
        }
      }
    }
  }

  console.log("  ✓ Policies applied");
}

function _arePolicyPresetsApplied(sandboxName, selectedPresets = []) {
  if (!Array.isArray(selectedPresets) || selectedPresets.length === 0) return false;
  const applied = new Set(policies.getAppliedPresets(sandboxName));
  return selectedPresets.every((preset) => applied.has(preset));
}

// eslint-disable-next-line complexity
async function setupPoliciesWithSelection(sandboxName, options = {}) {
  const selectedPresets = Array.isArray(options.selectedPresets) ? options.selectedPresets : null;
  const onSelection = typeof options.onSelection === "function" ? options.onSelection : null;

  step(7, 7, "Policy presets");

  const suggestions = ["pypi", "npm"];
  if (getCredential("TELEGRAM_BOT_TOKEN")) suggestions.push("telegram");
  if (getCredential("SLACK_BOT_TOKEN") || process.env.SLACK_BOT_TOKEN) suggestions.push("slack");
  if (getCredential("DISCORD_BOT_TOKEN") || process.env.DISCORD_BOT_TOKEN)
    suggestions.push("discord");

  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);
  let chosen = selectedPresets;

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
      if (envPresets.length > 0) {
        chosen = envPresets;
      }
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
          if (message.includes("Unimplemented")) {
            console.error("  OpenShell policy updates are not supported by this gateway build.");
            console.error("  This is a known issue tracked in NemoClaw #536.");
            throw err;
          }
          if (!message.includes("sandbox not found") || attempt === 2) {
            throw err;
          }
          sleep(2);
        }
      }
    }
    return chosen;
  }

  console.log("");
  console.log("  Available policy presets:");
  allPresets.forEach((p) => {
    const marker = applied.includes(p.name) ? "●" : "○";
    const suggested = suggestions.includes(p.name) ? " (suggested)" : "";
    console.log(`    ${marker} ${p.name} — ${p.description}${suggested}`);
  });
  console.log("");

  const answer = await prompt(
    `  Apply suggested presets (${suggestions.join(", ")})? [Y/n/list]: `,
  );

  if (answer.toLowerCase() === "n") {
    console.log("  Skipping policy presets.");
    return [];
  }

  let interactiveChoice = suggestions;
  if (answer.toLowerCase() === "list") {
    const custom = await prompt("  Enter preset names (comma-separated): ");
    interactiveChoice = parsePolicyPresetEnv(custom);
  }

  const knownPresets = new Set(allPresets.map((p) => p.name));
  const invalidPresets = interactiveChoice.filter((name) => !knownPresets.has(name));
  if (invalidPresets.length > 0) {
    console.error(`  Unknown policy preset(s): ${invalidPresets.join(", ")}`);
    process.exit(1);
  }

  if (onSelection) onSelection(interactiveChoice);
  if (!waitForSandboxReady(sandboxName)) {
    console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
    process.exit(1);
  }

  for (const name of interactiveChoice) {
    policies.applyPreset(sandboxName, name);
  }
  return interactiveChoice;
}

// ── Dashboard ────────────────────────────────────────────────────

function printDashboard(sandboxName, model, provider) {
  // Refresh the dashboard forward before printing URLs so links are live.
  runOpenshell(["forward", "stop", "18789", sandboxName], { ignoreError: true });
  run(getDashboardForwardStartCommand(sandboxName), { ignoreError: true });

  const sandbox = registry.getSandbox(sandboxName) || { name: sandboxName, provider };
  const runtimeLines =
    getInferenceRuntimeStatus(sandbox, (name) => {
      const status = nim.nimStatus(name) || {};
      return {
        running: Boolean(status["running"]),
        healthy: typeof status["healthy"] === "boolean" ? status["healthy"] : false,
      };
    }) || [];
  const dashboardAccess = getDashboardAccessInfo(sandboxName);
  const dashboardGuidance = getDashboardGuidanceLines(dashboardAccess);

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

  console.log("");
  console.log(`  ${"─".repeat(50)}`);
  for (const access of dashboardAccess) {
    console.log(`  ${access.label.padEnd(12)}${access.url}`);
  }
  for (const guidance of dashboardGuidance) {
    console.log(`  ${guidance}`);
  }
  console.log(`  Sandbox      ${sandboxName} (Landlock + seccomp + netns)`);
  console.log(`  Model        ${model} (${providerLabel})`);
  for (const line of runtimeLines) {
    if (line && typeof line.label === "string" && typeof line.value !== "undefined") {
      console.log(`  ${line.label.padEnd(12)}${line.value}`);
    }
  }
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  Run:         nemoclaw ${sandboxName} connect`);
  console.log(`  Status:      nemoclaw ${sandboxName} status`);
  console.log(`  Logs:        nemoclaw ${sandboxName} logs --follow`);
  console.log(`  ${"─".repeat(50)}`);
  console.log("");
}

// ── Main ─────────────────────────────────────────────────────────

async function onboard(opts = {}) {
  NON_INTERACTIVE = opts.nonInteractive || process.env.NEMOCLAW_NON_INTERACTIVE === "1";

  console.log("");
  console.log("  NemoClaw Onboarding");
  if (isNonInteractive()) console.log("  (non-interactive mode)");
  console.log("  ===================");

  const { gpu, reusingGateway } = await preflight();
  await startGateway(gpu, reusingGateway);
  const sandboxName = await createSandbox(gpu);
  const { model, provider, ollamaEndpoint, providerBaseUrl } = await setupNim(sandboxName, gpu);
  const { modelMetadata } = await setupInference(sandboxName, model, provider, {
    ollamaEndpoint,
    providerBaseUrl,
  });
  delete process.env.NVIDIA_API_KEY;
  await setupOpenclaw(sandboxName, model, provider, { modelMetadata });
  await setupPoliciesWithSelection(sandboxName);
  printDashboard(sandboxName, model, provider);
}

module.exports = {
  buildAuthenticatedDashboardUrl,
  buildControlUiConfigSyncScript,
  buildSandboxConfigSyncScript,
  classifySandboxCreateFailure,
  countListedSandboxes,
  createSandbox,
  getControlUiAllowedOrigins,
  getDashboardForwardPort,
  getDashboardForwardStartCommand,
  getDashboardAccessInfo,
  getDashboardGuidanceLines,
  getGatewayClusterContainerName,
  getGatewayReuseState,
  getReportedGatewayEndpoint,
  getReportedGatewayName,
  getSandboxState,
  hasLocalGatewayContainer,
  hasStaleGateway,
  isSandboxReady,
  isWslEnvironment,
  listLocalGatewayNames,
  onboard,
  promptForExistingGatewayAction,
  getOllamaProbeOutcome,
  setupInference,
  setupNim,
  syncSandboxInferenceConfig,
  syncSandboxControlUiConfig,
};
