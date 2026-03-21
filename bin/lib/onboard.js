// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Interactive onboarding wizard — 7 steps from zero to running sandbox.
// Supports non-interactive mode via --non-interactive flag or
// NEMOCLAW_NON_INTERACTIVE=1 env var for CI/CD pipelines.

const fs = require("fs");
const path = require("path");
const { ROOT, SCRIPTS, run, runCapture } = require("./runner");
const {
  getDefaultOllamaModel,
  getLocalProviderBaseUrl,
  getOllamaModelOptions,
  getOllamaWarmupCommand,
  validateOllamaModel,
  validateLocalProvider,
} = require("./local-inference");
const {
  CLOUD_MODEL_OPTIONS,
  DEFAULT_CLOUD_MODEL,
  DEFAULT_OLLAMA_MODEL,
  getOpenClawPrimaryModel,
  getProviderSelectionConfig,
} = require("./inference-config");
const {
  inferContainerRuntime,
  isUnsupportedMacosRuntime,
  shouldPatchCoredns,
} = require("./platform");
const { prompt, ensureApiKey, getCredential } = require("./credentials");
const registry = require("./registry");
const nim = require("./nim");
const policies = require("./policies");
const { checkPortAvailable } = require("./preflight");
const EXPERIMENTAL = process.env.NEMOCLAW_EXPERIMENTAL === "1";
const DEFAULT_RUNTIME = "openclaw";
const SUPPORTED_RUNTIMES = new Set(["openclaw", "nullclaw"]);
const SUPPORTED_SURFACES = new Set(["openclaw-ui", "nullhub", "none"]);
const SURFACE_FORWARD_PORT = {
  "openclaw-ui": 18789,
  nullhub: 19800,
  none: 3000,
};
const RUNTIME_GATEWAY_PORT = {
  openclaw: 18789,
  nullclaw: 3000,
};
const NULLCLAW_DEFAULT_VERSION = "v2026.3.15";
const NULLCLAW_DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const NULLHUB_DEFAULT_INSTANCE = "default";

// Non-interactive mode: set by --non-interactive flag or env var.
// When active, all prompts use env var overrides or sensible defaults.
let NON_INTERACTIVE = false;

function isNonInteractive() {
  return NON_INTERACTIVE;
}

// Prompt wrapper: returns env var value or default in non-interactive mode,
// otherwise prompts the user interactively.
async function promptOrDefault(question, envVar, defaultValue) {
  if (isNonInteractive()) {
    const val = envVar ? process.env[envVar] : null;
    const result = val || defaultValue;
    console.log(`  [non-interactive] ${question.trim()} → ${result}`);
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
  return typeof gwInfoOutput === "string" && gwInfoOutput.length > 0 && gwInfoOutput.includes("nemoclaw");
}

function step(n, total, msg) {
  console.log("");
  console.log(`  [${n}/${total}] ${msg}`);
  console.log(`  ${"─".repeat(50)}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function pythonLiteralJson(value) {
  return JSON.stringify(JSON.stringify(value));
}

function onboardUsage() {
  console.log(`
  Usage: nemoclaw onboard [--non-interactive] [--runtime openclaw|nullclaw] [--surface openclaw-ui|nullhub|none]

  Runtime options:
    openclaw   Default NemoClaw flow with OpenClaw inside the sandbox
    nullclaw   Experimental runtime using NullClaw inside the sandbox

  Surface options:
    openclaw-ui  OpenClaw gateway UI (default for openclaw)
    nullhub      NullHub UI managing NullClaw (default for nullclaw)
    none         Headless NullClaw gateway only
`);
}

function defaultSurface(runtime) {
  return registry.defaultSurface(runtime);
}

function forwardPortFor(runtime, surface) {
  return registry.defaultForwardPort(runtime, surface);
}

function validateRuntimeSurface(runtime, surface) {
  if (runtime === "openclaw") {
    return surface === "openclaw-ui";
  }
  if (runtime === "nullclaw") {
    return surface === "nullhub" || surface === "none";
  }
  return false;
}

function parseOnboardArgs(args = []) {
  let runtime = DEFAULT_RUNTIME;
  let surface = null;
  let nonInteractive = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      onboardUsage();
      process.exit(0);
    }
    if (arg === "--non-interactive") {
      nonInteractive = true;
      continue;
    }
    if (arg === "--runtime") {
      runtime = args[i + 1];
      if (!runtime) {
        console.error("  Missing value for --runtime");
        onboardUsage();
        process.exit(1);
      }
      i += 1;
      continue;
    }
    if (arg === "--surface") {
      surface = args[i + 1];
      if (!surface) {
        console.error("  Missing value for --surface");
        onboardUsage();
        process.exit(1);
      }
      i += 1;
      continue;
    }

    console.error(`  Unknown onboard option: ${arg}`);
    onboardUsage();
    process.exit(1);
  }

  if (!SUPPORTED_RUNTIMES.has(runtime)) {
    console.error(`  Unsupported runtime: ${runtime}`);
    console.error(`  Supported runtimes: ${Array.from(SUPPORTED_RUNTIMES).join(", ")}`);
    process.exit(1);
  }

  surface = surface || defaultSurface(runtime);

  if (!SUPPORTED_SURFACES.has(surface)) {
    console.error(`  Unsupported surface: ${surface}`);
    console.error(`  Supported surfaces: ${Array.from(SUPPORTED_SURFACES).join(", ")}`);
    process.exit(1);
  }

  if (!validateRuntimeSurface(runtime, surface)) {
    console.error(`  Surface '${surface}' is not valid for runtime '${runtime}'.`);
    console.error("  Valid combinations: openclaw/openclaw-ui, nullclaw/nullhub, nullclaw/none");
    process.exit(1);
  }

  return { runtime, surface, nonInteractive };
}

function buildSandboxConfigSyncScript(selectionConfig) {
  const providerType =
    selectionConfig.profile === "inference-local"
      ? selectionConfig.model === DEFAULT_OLLAMA_MODEL
        ? "ollama-local"
        : "nvidia-nim"
      : selectionConfig.endpointType === "vllm"
        ? "vllm-local"
        : "nvidia-nim";
  const primaryModel = getOpenClawPrimaryModel(providerType, selectionConfig.model);
  const providerKey = "inference";
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
        contextWindow: 131072,
        maxTokens: 4096,
      },
    ],
  };
  return `
set -euo pipefail
mkdir -p ~/.nemoclaw ~/.openclaw
cat > ~/.nemoclaw/config.json <<'EOF_NEMOCLAW_CFG'
${JSON.stringify(selectionConfig, null, 2)}
EOF_NEMOCLAW_CFG
python3 - <<'PYCFG'
import json
import os

cfg_path = os.path.expanduser('~/.openclaw/openclaw.json')
cfg = {}
if os.path.exists(cfg_path):
    with open(cfg_path) as f:
        cfg = json.load(f)

cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = ${JSON.stringify(primaryModel)}
models_cfg = cfg.setdefault('models', {})
models_cfg.setdefault('mode', 'merge')
providers_cfg = models_cfg.setdefault('providers', {})
providers_cfg[${JSON.stringify(providerKey)}] = json.loads(${pythonLiteralJson(providerConfig)})

with open(cfg_path, 'w') as f:
    json.dump(cfg, f, indent=2)

os.chmod(cfg_path, 0o600)
PYCFG
openclaw models set ${shellQuote(primaryModel)} > /dev/null 2>&1 || true
exit
`.trim();
}

function writeSandboxSshConfig(sandboxName) {
  const sshConfig = runCapture(`openshell sandbox ssh-config ${shellQuote(sandboxName)}`);
  const confPath = path.join(require("os").tmpdir(), `nemoclaw-ssh-${process.pid}-${Date.now()}.conf`);
  fs.writeFileSync(confPath, sshConfig, { mode: 0o600 });
  return confPath;
}

function runSandboxCommand(sandboxName, remoteCmd) {
  const confPath = writeSandboxSshConfig(sandboxName);
  try {
    run(
      `ssh -F ${shellQuote(confPath)} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ` +
      `-o LogLevel=ERROR ${shellQuote(`openshell-${sandboxName}`)} ${shellQuote(remoteCmd)}`
    );
  } finally {
    try {
      fs.unlinkSync(confPath);
    } catch {}
  }
}

function syncNullclawConfig(sandboxName, model) {
  console.log("  Syncing NullClaw runtime config...");
  const remoteCmd = [
    "nullclaw onboard",
    `--api-key ${shellQuote("openshell-managed")}`,
    `--provider ${shellQuote("custom:https://inference.local/v1")}`,
    `--model ${shellQuote(model || NULLCLAW_DEFAULT_MODEL)}`,
    "> /tmp/nullclaw-onboard.log 2>&1",
  ].join(" ");

  runSandboxCommand(sandboxName, remoteCmd);
  console.log("  ✓ NullClaw runtime config updated");
}

function syncNullhubConfig(sandboxName, model) {
  console.log("  Syncing NullHub-managed NullClaw config...");
  const instanceHome = `"$HOME/.nullhub/instances/nullclaw/${NULLHUB_DEFAULT_INSTANCE}"`;
  const createPayload = JSON.stringify({
    instance_name: NULLHUB_DEFAULT_INSTANCE,
    version: NULLCLAW_DEFAULT_VERSION,
    provider: "custom:https://inference.local/v1",
    api_key: "openshell-managed",
    model: model || NULLCLAW_DEFAULT_MODEL,
    gateway_port: RUNTIME_GATEWAY_PORT.nullclaw,
  });
  const updatePayloadTemplate = JSON.stringify({
    home: "__INSTANCE_HOME__",
    provider: "custom:https://inference.local/v1",
    api_key: "openshell-managed",
    model: model || NULLCLAW_DEFAULT_MODEL,
    gateway_port: RUNTIME_GATEWAY_PORT.nullclaw,
  });
  const remoteCmd = `
set -euo pipefail
HUB_PORT=${SURFACE_FORWARD_PORT.nullhub}
INSTANCE=${shellQuote(NULLHUB_DEFAULT_INSTANCE)}
INSTANCE_HOME=${instanceHome}
if ! curl -sf "http://127.0.0.1:${SURFACE_FORWARD_PORT.nullhub}/api/status" > /dev/null 2>&1; then
  nohup nullhub serve --host 0.0.0.0 --port "$HUB_PORT" > /tmp/nullhub.log 2>&1 &
  for _ in $(seq 1 20); do
    if curl -sf "http://127.0.0.1:${SURFACE_FORWARD_PORT.nullhub}/api/status" > /dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi
if [ -d $INSTANCE_HOME ]; then
  UPDATE_PAYLOAD=${shellQuote(updatePayloadTemplate)}
  UPDATE_PAYLOAD="${UPDATE_PAYLOAD/__INSTANCE_HOME__/$INSTANCE_HOME}"
  nullclaw --from-json "$UPDATE_PAYLOAD" > /tmp/nullhub-sync.log 2>&1
  nullhub restart "nullclaw/$INSTANCE" > /tmp/nullhub-restart.log 2>&1 || nullhub start "nullclaw/$INSTANCE" > /tmp/nullhub-restart.log 2>&1
else
  curl -fsS \
    -H 'Content-Type: application/json' \
    --data ${shellQuote(createPayload)} \
    "http://127.0.0.1:${SURFACE_FORWARD_PORT.nullhub}/api/wizard/nullclaw" \
    > /tmp/nullhub-sync.log 2>&1
fi
`;

  runSandboxCommand(sandboxName, remoteCmd);
  console.log("  ✓ NullHub runtime config updated");
}

async function promptCloudModel() {
  console.log("");
  console.log("  Cloud models:");
  CLOUD_MODEL_OPTIONS.forEach((option, index) => {
    console.log(`    ${index + 1}) ${option.label} (${option.id})`);
  });
  console.log("");

  const choice = await prompt("  Choose model [1]: ");
  const index = parseInt(choice || "1", 10) - 1;
  return (CLOUD_MODEL_OPTIONS[index] || CLOUD_MODEL_OPTIONS[0]).id;
}

async function promptOllamaModel() {
  const options = getOllamaModelOptions(runCapture);
  const defaultModel = getDefaultOllamaModel(runCapture);
  const defaultIndex = Math.max(0, options.indexOf(defaultModel));

  console.log("");
  console.log("  Ollama models:");
  options.forEach((option, index) => {
    console.log(`    ${index + 1}) ${option}`);
  });
  console.log("");

  const choice = await prompt(`  Choose model [${defaultIndex + 1}]: `);
  const index = parseInt(choice || String(defaultIndex + 1), 10) - 1;
  return options[index] || options[defaultIndex] || defaultModel;
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
  try {
    runCapture("command -v openshell");
    return true;
  } catch {
    return false;
  }
}

function installOpenshell() {
  console.log("  Installing openshell CLI...");
  run(`bash "${path.join(SCRIPTS, "install-openshell.sh")}"`, { ignoreError: true });
  const localBin = process.env.XDG_BIN_HOME || path.join(process.env.HOME || "", ".local", "bin");
  if (fs.existsSync(path.join(localBin, "openshell")) && !process.env.PATH.split(path.delimiter).includes(localBin)) {
    process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH}`;
  }
  return isOpenshellInstalled();
}

function sleep(seconds) {
  require("child_process").spawnSync("sleep", [String(seconds)]);
}

function waitForSandboxReady(sandboxName, attempts = 10, delaySeconds = 2) {
  for (let i = 0; i < attempts; i += 1) {
    const exists = runCapture(`openshell sandbox get "${sandboxName}" 2>/dev/null`, { ignoreError: true });
    if (exists) return true;
    sleep(delaySeconds);
  }
  return false;
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

  const validProviders = new Set(["cloud", "ollama", "vllm", "nim"]);
  if (!validProviders.has(providerKey)) {
    console.error(`  Unsupported NEMOCLAW_PROVIDER: ${providerKey}`);
    console.error("  Valid values: cloud, ollama, vllm, nim");
    process.exit(1);
  }

  return providerKey;
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

async function preflight(runtime = DEFAULT_RUNTIME, surface = defaultSurface(runtime)) {
  step(1, 7, "Preflight checks");

  // Docker
  if (!isDockerRunning()) {
    console.error("  Docker is not running. Please start Docker and try again.");
    process.exit(1);
  }
  console.log("  ✓ Docker is running");

  const containerRuntime = getContainerRuntime();
  if (isUnsupportedMacosRuntime(containerRuntime)) {
    console.error("  Podman on macOS is not supported by NemoClaw at this time.");
    console.error("  OpenShell currently depends on Docker host-gateway behavior that Podman on macOS does not provide.");
    console.error("  Use Colima or Docker Desktop on macOS instead.");
    process.exit(1);
  }
  if (containerRuntime !== "unknown") {
    console.log(`  ✓ Container runtime: ${containerRuntime}`);
  }

  // OpenShell CLI
  if (!isOpenshellInstalled()) {
    console.log("  openshell CLI not found. Attempting to install...");
    if (!installOpenshell()) {
      console.error("  Failed to install openshell CLI.");
      console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
      process.exit(1);
    }
  }
  console.log(`  ✓ openshell CLI: ${runCapture("openshell --version 2>/dev/null || echo unknown", { ignoreError: true })}`);

  // Clean up stale NemoClaw session before checking ports.
  // A previous onboard run may have left the gateway container and port
  // forward running.  If a NemoClaw-owned gateway is still present, tear
  // it down so the port check below doesn't fail on our own leftovers.
  const gwInfo = runCapture("openshell gateway info -g nemoclaw 2>/dev/null", { ignoreError: true });
  if (hasStaleGateway(gwInfo)) {
    console.log("  Cleaning up previous NemoClaw session...");
    for (const port of new Set(Object.values(SURFACE_FORWARD_PORT))) {
      run(`openshell forward stop ${port} 2>/dev/null || true`, { ignoreError: true });
    }
    run("openshell gateway destroy -g nemoclaw 2>/dev/null || true", { ignoreError: true });
    console.log("  ✓ Previous session cleaned up");
  }

  await ensurePortAvailable(8080, "OpenShell gateway");

  // GPU
  const gpu = nim.detectGpu();
  if (gpu && gpu.type === "nvidia") {
    console.log(`  ✓ NVIDIA GPU detected: ${gpu.count} GPU(s), ${gpu.totalMemoryMB} MB VRAM`);
  } else if (gpu && gpu.type === "apple") {
    console.log(`  ✓ Apple GPU detected: ${gpu.name}${gpu.cores ? ` (${gpu.cores} cores)` : ""}, ${gpu.totalMemoryMB} MB unified memory`);
    console.log("  ⓘ NIM requires NVIDIA GPU — will use cloud inference");
  } else {
    console.log("  ⓘ No GPU detected — will use cloud inference");
  }

  return gpu;
}

function surfacePortLabel(surface) {
  if (surface === "nullhub") return "NullHub local surface";
  if (surface === "none") return "NullClaw gateway";
  return "NemoClaw dashboard";
}

async function ensurePortAvailable(port, label) {
  const portCheck = await checkPortAvailable(port);
  if (!portCheck.ok) {
    console.error("");
    console.error(`  !! Port ${port} is not available.`);
    console.error(`     ${label} needs this port.`);
    console.error("");
    if (portCheck.process && portCheck.process !== "unknown") {
      console.error(`     Blocked by: ${portCheck.process}${portCheck.pid ? ` (PID ${portCheck.pid})` : ""}`);
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

async function ensureSurfacePortAvailable(runtime, surface) {
  const forwardPort = forwardPortFor(runtime, surface);
  await ensurePortAvailable(forwardPort, surfacePortLabel(surface));
}

// ── Step 3: Gateway ──────────────────────────────────────────────

async function startGateway(gpu) {
  step(3, 7, "Starting OpenShell gateway");

  // Destroy old gateway
  run("openshell gateway destroy -g nemoclaw 2>/dev/null || true", { ignoreError: true });

  const gwArgs = ["--name", "nemoclaw"];
  // Do NOT pass --gpu here. On DGX Spark (and most GPU hosts), inference is
  // routed through a host-side provider (Ollama, vLLM, or cloud API) — the
  // sandbox itself does not need direct GPU access. Passing --gpu causes
  // FailedPrecondition errors when the gateway's k3s device plugin cannot
  // allocate GPUs. See: https://build.nvidia.com/spark/nemoclaw/instructions

  run(`openshell gateway start ${gwArgs.join(" ")}`, { ignoreError: false });

  // Verify health
  for (let i = 0; i < 5; i++) {
    const status = runCapture("openshell status 2>&1", { ignoreError: true });
    if (status.includes("Connected")) {
      console.log("  ✓ Gateway is healthy");
      break;
    }
    if (i === 4) {
      console.error("  Gateway failed to start. Run: openshell gateway info");
      process.exit(1);
    }
    sleep(2);
  }

  // CoreDNS fix — always run. k3s-inside-Docker has broken DNS on all platforms.
  const runtime = getContainerRuntime();
  if (shouldPatchCoredns(runtime)) {
    console.log("  Patching CoreDNS for Colima...");
    run(`bash "${path.join(SCRIPTS, "fix-coredns.sh")}" nemoclaw 2>&1 || true`, { ignoreError: true });
  }
  // Give DNS a moment to propagate
  sleep(5);
}

// ── Step 2: Sandbox ──────────────────────────────────────────────

async function prepareSandbox(runtime, surface) {
  step(2, 7, "Selecting sandbox");

  const nameAnswer = await promptOrDefault(
    "  Sandbox name (lowercase, numbers, hyphens) [my-assistant]: ",
    "NEMOCLAW_SANDBOX_NAME", "my-assistant"
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

  const existing = registry.getSandbox(sandboxName);
  if (existing) {
    const existingRuntime = existing.runtime || DEFAULT_RUNTIME;
    const existingSurface = existing.surface || defaultSurface(existingRuntime);
    if (isNonInteractive()) {
      if (process.env.NEMOCLAW_RECREATE_SANDBOX !== "1") {
        console.error(`  Sandbox '${sandboxName}' already exists.`);
        console.error("  Set NEMOCLAW_RECREATE_SANDBOX=1 to recreate it in non-interactive mode.");
        process.exit(1);
      }
      console.log(`  [non-interactive] Sandbox '${sandboxName}' exists — recreating`);
    } else {
      const recreate = await prompt(
        `  Sandbox '${sandboxName}' already exists (${existingRuntime}/${existingSurface}). Recreate? [y/N]: `
      );
      if (recreate.toLowerCase() !== "y") {
        console.log("  Keeping existing sandbox.");
        if (runtime !== existingRuntime) {
          console.log(`  Requested runtime '${runtime}' ignored; existing sandbox uses '${existingRuntime}'.`);
        }
        if (surface !== existingSurface) {
          console.log(`  Requested surface '${surface}' ignored; existing sandbox uses '${existingSurface}'.`);
        }
        return { sandboxName, reused: true, runtime: existingRuntime, surface: existingSurface, sandbox: existing };
      }
    }
    run(`openshell sandbox delete "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });
    registry.removeSandbox(sandboxName);
  }

  console.log(`  ✓ Runtime: ${runtime}`);
  console.log(`  ✓ Surface: ${surface}`);
  return { sandboxName, reused: false, runtime, surface };
}

function selectSandboxDockerfile(runtime, surface) {
  if (runtime === "openclaw") return "Dockerfile";
  if (surface === "nullhub") return "Dockerfile.nullhub";
  return "Dockerfile.nullclaw";
}

function stageOpenclawSandboxFiles(buildCtx) {
  run(`cp -r "${path.join(ROOT, "nemoclaw")}" "${buildCtx}/nemoclaw"`);
  run(`cp -r "${path.join(ROOT, "nemoclaw-blueprint")}" "${buildCtx}/nemoclaw-blueprint"`);
  run(`rm -rf "${buildCtx}/nemoclaw/node_modules"`, { ignoreError: true });
}

async function createSandbox({ sandboxName, gpu, runtime, surface, model, provider, nimContainer }) {
  const runtimeLabel = runtime === "nullclaw" ? "NullClaw" : "OpenClaw";
  const surfaceLabel = surface === "nullhub" ? "NullHub" : surface === "none" ? "headless" : "OpenClaw UI";
  step(4, 7, `Creating ${runtimeLabel} sandbox (${surfaceLabel})`);

  const buildCtx = fs.mkdtempSync(path.join(require("os").tmpdir(), "nemoclaw-build-"));
  const dockerfileName = selectSandboxDockerfile(runtime, surface);
  fs.copyFileSync(path.join(ROOT, dockerfileName), path.join(buildCtx, "Dockerfile"));
  run(`cp -r "${path.join(ROOT, "scripts")}" "${buildCtx}/scripts"`);

  if (runtime === "openclaw") {
    stageOpenclawSandboxFiles(buildCtx);
  }

  const basePolicyPath = path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
  const createArgs = [
    `--from "${buildCtx}/Dockerfile"`,
    `--name "${sandboxName}"`,
    `--policy "${basePolicyPath}"`,
  ];
  // --gpu is intentionally omitted. See comment in startGateway().

  const forwardPort = forwardPortFor(runtime, surface);
  console.log(`  Creating sandbox '${sandboxName}' (this takes a few minutes on first run)...`);

  let createResult;
  if (runtime === "nullclaw" && surface === "nullhub") {
    const envArgs = [
      `PUBLIC_PORT=${shellQuote(String(forwardPort))}`,
      `NULLHUB_PORT=${shellQuote(String(SURFACE_FORWARD_PORT.nullhub))}`,
      `NULLHUB_INSTANCE=${shellQuote(NULLHUB_DEFAULT_INSTANCE)}`,
      `NULLHUB_NULLCLAW_VERSION=${shellQuote(NULLCLAW_DEFAULT_VERSION)}`,
      `NULLCLAW_GATEWAY_PORT=${shellQuote(String(RUNTIME_GATEWAY_PORT.nullclaw))}`,
      `NULLCLAW_MODEL=${shellQuote(model || NULLCLAW_DEFAULT_MODEL)}`,
      `NULLCLAW_PROVIDER=${shellQuote("custom:https://inference.local/v1")}`,
      `NULLCLAW_API_KEY=${shellQuote("openshell-managed")}`,
    ];
    createResult = run(
      `openshell sandbox create ${createArgs.join(" ")} -- env ${envArgs.join(" ")} nullhub-start 2>&1`,
      { ignoreError: true }
    );
  } else if (runtime === "nullclaw") {
    const envArgs = [
      `PUBLIC_PORT=${shellQuote(String(forwardPort))}`,
      `NULLCLAW_MODEL=${shellQuote(model || NULLCLAW_DEFAULT_MODEL)}`,
      `NULLCLAW_PROVIDER=${shellQuote("custom:https://inference.local/v1")}`,
      `NULLCLAW_API_KEY=${shellQuote("openshell-managed")}`,
    ];
    createResult = run(
      `openshell sandbox create ${createArgs.join(" ")} -- env ${envArgs.join(" ")} nullclaw-start 2>&1`,
      { ignoreError: true }
    );
  } else {
    const chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${forwardPort}`;
    const envArgs = [`CHAT_UI_URL=${shellQuote(chatUiUrl)}`];
    if (process.env.NVIDIA_API_KEY) {
      envArgs.push(`NVIDIA_API_KEY=${shellQuote(process.env.NVIDIA_API_KEY)}`);
    }
    createResult = run(
      `openshell sandbox create ${createArgs.join(" ")} -- env ${envArgs.join(" ")} nemoclaw-start 2>&1`,
      { ignoreError: true }
    );
  }

  run(`rm -rf "${buildCtx}"`, { ignoreError: true });
  if (createResult.status !== 0) {
    run(`openshell sandbox delete "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });
    if (nimContainer) {
      nim.stopNimContainer(sandboxName);
    }
    console.error("");
    console.error(`  Sandbox creation failed (exit ${createResult.status || 1}).`);
    console.error("  Try:  openshell sandbox list        # check gateway state");
    console.error("  Try:  nemoclaw onboard              # retry from scratch");
    process.exit(createResult.status || 1);
  }

  // Wait for sandbox to reach Ready state in k3s before registering.
  // On WSL2 + Docker Desktop the pod can take longer to initialize;
  // without this gate, NemoClaw registers a phantom sandbox that
  // causes "sandbox not found" on every subsequent connect/status call.
  console.log("  Waiting for sandbox to become ready...");
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const list = runCapture("openshell sandbox list 2>&1", { ignoreError: true });
    if (isSandboxReady(list, sandboxName)) {
      ready = true;
      break;
    }
    require("child_process").spawnSync("sleep", ["2"]);
  }

  if (!ready) {
    // Clean up the orphaned sandbox so the next onboard retry with the same
    // name doesn't fail on "sandbox already exists".
    const delResult = run(`openshell sandbox delete "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });
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

  run(`openshell forward stop ${forwardPort} 2>/dev/null || true`, { ignoreError: true });
  run(`openshell forward start --background ${forwardPort} "${sandboxName}"`, { ignoreError: true });

  registry.registerSandbox({
    name: sandboxName,
    gpuEnabled: !!gpu,
    model,
    provider,
    nimContainer,
    runtime,
    surface,
    forwardPort,
  });

  console.log(`  ✓ Sandbox '${sandboxName}' created`);
  return sandboxName;
}

// ── Step 4: NIM ──────────────────────────────────────────────────

async function setupNim(sandboxName, gpu) {
  step(5, 7, "Selecting inference backend");

  let model = null;
  let provider = "nvidia-nim";
  let nimContainer = null;

  // Detect local inference options
  const hasOllama = !!runCapture("command -v ollama", { ignoreError: true });
  const ollamaRunning = !!runCapture("curl -sf http://localhost:11434/api/tags 2>/dev/null", { ignoreError: true });
  const vllmRunning = !!runCapture("curl -sf http://localhost:8000/v1/models 2>/dev/null", { ignoreError: true });
  const requestedProvider = isNonInteractive() ? getNonInteractiveProvider() : null;
  const requestedModel = isNonInteractive() ? getNonInteractiveModel(requestedProvider || "cloud") : null;
  // Build options list — only show local options with NEMOCLAW_EXPERIMENTAL=1
  const options = [];
  if (EXPERIMENTAL && gpu && gpu.nimCapable) {
    options.push({ key: "nim", label: "Local NIM container (NVIDIA GPU) [experimental]" });
  }
  options.push({
    key: "cloud",
    label:
      "NVIDIA Cloud API (build.nvidia.com)" +
      (!ollamaRunning && !(EXPERIMENTAL && vllmRunning) ? " (recommended)" : ""),
  });
  if (hasOllama || ollamaRunning) {
    options.push({
      key: "ollama",
      label:
        `Local Ollama (localhost:11434)${ollamaRunning ? " — running" : ""}` +
        (ollamaRunning ? " (suggested)" : ""),
    });
  }
  if (EXPERIMENTAL && vllmRunning) {
    options.push({
      key: "vllm",
      label: "Existing vLLM instance (localhost:8000) — running [experimental] (suggested)",
    });
  }

  // On macOS without Ollama, offer to install it
  if (!hasOllama && process.platform === "darwin") {
    options.push({ key: "install-ollama", label: "Install Ollama (macOS)" });
  }

  if (options.length > 1) {
    let selected;

    if (isNonInteractive()) {
      const providerKey = requestedProvider || "cloud";
      selected = options.find((o) => o.key === providerKey);
      if (!selected) {
        console.error(`  Requested provider '${providerKey}' is not available in this environment.`);
        process.exit(1);
      }
      console.log(`  [non-interactive] Provider: ${selected.key}`);
    } else {
      const suggestions = [];
      if (vllmRunning) suggestions.push("vLLM");
      if (ollamaRunning) suggestions.push("Ollama");
      if (suggestions.length > 0) {
        console.log(`  Detected local inference option${suggestions.length > 1 ? "s" : ""}: ${suggestions.join(", ")}`);
        console.log("  Select one explicitly to use it. Press Enter to keep the cloud default.");
        console.log("");
      }

      console.log("");
      console.log("  Inference options:");
      options.forEach((o, i) => {
        console.log(`    ${i + 1}) ${o.label}`);
      });
      console.log("");

      const defaultIdx = options.findIndex((o) => o.key === "cloud") + 1;
      const choice = await prompt(`  Choose [${defaultIdx}]: `);
      const idx = parseInt(choice || String(defaultIdx), 10) - 1;
      selected = options[idx] || options[defaultIdx - 1];
    }

    if (selected.key === "nim") {
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
          console.log(`  [non-interactive] NIM model: ${sel.name}`);
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

        console.log(`  Pulling NIM image for ${model}...`);
        nim.pullNimImage(model);

        console.log("  Starting NIM container...");
        nimContainer = nim.startNimContainer(sandboxName, model);

        console.log("  Waiting for NIM to become healthy...");
        if (!nim.waitForNimHealth()) {
          console.error("  NIM failed to start. Falling back to cloud API.");
          nim.stopNimContainer(sandboxName);
          model = null;
          nimContainer = null;
        } else {
          provider = "vllm-local";
        }
      }
    } else if (selected.key === "ollama") {
      if (!ollamaRunning) {
        console.log("  Starting Ollama...");
        run("OLLAMA_HOST=0.0.0.0:11434 ollama serve > /dev/null 2>&1 &", { ignoreError: true });
        sleep(2);
      }
      console.log("  ✓ Using Ollama on localhost:11434");
      provider = "ollama-local";
      if (isNonInteractive()) {
        model = requestedModel || getDefaultOllamaModel(runCapture);
      } else {
        model = await promptOllamaModel();
      }
    } else if (selected.key === "install-ollama") {
      console.log("  Installing Ollama via Homebrew...");
      run("brew install ollama", { ignoreError: true });
      console.log("  Starting Ollama...");
      run("OLLAMA_HOST=0.0.0.0:11434 ollama serve > /dev/null 2>&1 &", { ignoreError: true });
        sleep(2);
      console.log("  ✓ Using Ollama on localhost:11434");
      provider = "ollama-local";
      if (isNonInteractive()) {
        model = requestedModel || getDefaultOllamaModel(runCapture);
      } else {
        model = await promptOllamaModel();
      }
    } else if (selected.key === "vllm") {
      console.log("  ✓ Using existing vLLM on localhost:8000");
      provider = "vllm-local";
      model = "vllm-local";
    }
    // else: cloud — fall through to default below
  }

  if (provider === "nvidia-nim") {
    if (isNonInteractive()) {
      // In non-interactive mode, NVIDIA_API_KEY must be set via env var
      if (!process.env.NVIDIA_API_KEY) {
        console.error("  NVIDIA_API_KEY is required for cloud provider in non-interactive mode.");
        console.error("  Set it via: NVIDIA_API_KEY=nvapi-... nemoclaw onboard --non-interactive");
        process.exit(1);
      }
    } else {
      await ensureApiKey();
      model = model || (await promptCloudModel()) || DEFAULT_CLOUD_MODEL;
    }
    model = model || requestedModel || DEFAULT_CLOUD_MODEL;
    console.log(`  Using NVIDIA Cloud API with model: ${model}`);
  }

  registry.updateSandbox(sandboxName, { model, provider, nimContainer });
  return { model, provider, nimContainer };
}

// ── Step 6: Host inference route ─────────────────────────────────

async function setupInference(sandboxName, model, provider) {
  step(6, 7, "Configuring host inference route");

  if (provider === "nvidia-nim") {
    // Create nvidia-nim provider
    run(
      `openshell provider create --name nvidia-nim --type openai ` +
      `--credential "NVIDIA_API_KEY=${process.env.NVIDIA_API_KEY}" ` +
      `--config "OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1" 2>&1 || true`,
      { ignoreError: true }
    );
    run(
      `openshell inference set --no-verify --provider nvidia-nim --model ${model} 2>/dev/null || true`,
      { ignoreError: true }
    );
  } else if (provider === "vllm-local") {
    const validation = validateLocalProvider(provider, runCapture);
    if (!validation.ok) {
      console.error(`  ${validation.message}`);
      process.exit(1);
    }
    const baseUrl = getLocalProviderBaseUrl(provider);
    run(
      `openshell provider create --name vllm-local --type openai ` +
      `--credential "OPENAI_API_KEY=dummy" ` +
      `--config "OPENAI_BASE_URL=${baseUrl}" 2>&1 || ` +
      `openshell provider update vllm-local --credential "OPENAI_API_KEY=dummy" ` +
      `--config "OPENAI_BASE_URL=${baseUrl}" 2>&1 || true`,
      { ignoreError: true }
    );
    run(
      `openshell inference set --no-verify --provider vllm-local --model ${model} 2>/dev/null || true`,
      { ignoreError: true }
    );
  } else if (provider === "ollama-local") {
    const validation = validateLocalProvider(provider, runCapture);
    if (!validation.ok) {
      console.error(`  ${validation.message}`);
      console.error("  On macOS, local inference also depends on OpenShell host routing support.");
      process.exit(1);
    }
    const baseUrl = getLocalProviderBaseUrl(provider);
    run(
      `openshell provider create --name ollama-local --type openai ` +
      `--credential "OPENAI_API_KEY=ollama" ` +
      `--config "OPENAI_BASE_URL=${baseUrl}" 2>&1 || ` +
      `openshell provider update ollama-local --credential "OPENAI_API_KEY=ollama" ` +
      `--config "OPENAI_BASE_URL=${baseUrl}" 2>&1 || true`,
      { ignoreError: true }
    );
    run(
      `openshell inference set --no-verify --provider ollama-local --model ${model} 2>/dev/null || true`,
      { ignoreError: true }
    );
    console.log(`  Priming Ollama model: ${model}`);
    run(getOllamaWarmupCommand(model), { ignoreError: true });
    const probe = validateOllamaModel(model, runCapture);
    if (!probe.ok) {
      console.error(`  ${probe.message}`);
      process.exit(1);
    }
  }

  registry.updateSandbox(sandboxName, { model, provider });
  console.log(`  ✓ Inference route set: ${provider} / ${model}`);
}

// ── Step 6: OpenClaw ─────────────────────────────────────────────

async function setupOpenclaw(sandboxName, model, provider) {
  console.log("  Syncing OpenClaw runtime config...");

  const selectionConfig = getProviderSelectionConfig(provider, model);
  if (selectionConfig) {
    const sandboxConfig = {
      ...selectionConfig,
      onboardedAt: new Date().toISOString(),
    };
    const script = buildSandboxConfigSyncScript(sandboxConfig);
    run(`cat <<'EOF_NEMOCLAW_SYNC' | openshell sandbox connect "${sandboxName}"
${script}
EOF_NEMOCLAW_SYNC`, { stdio: ["ignore", "ignore", "inherit"] });
  }

  console.log("  ✓ OpenClaw gateway launched inside sandbox");
}
// ── Step 7: Policy presets ───────────────────────────────────────

async function setupPolicies(sandboxName) {
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

  console.log("");
  console.log("  Available policy presets:");
  allPresets.forEach((p) => {
    const marker = applied.includes(p.name) ? "●" : "○";
    const suggested = suggestions.includes(p.name) ? " (suggested)" : "";
    console.log(`    ${marker} ${p.name} — ${p.description}${suggested}`);
  });
  console.log("");

  if (isNonInteractive()) {
    const policyMode = (process.env.NEMOCLAW_POLICY_MODE || "suggested").trim().toLowerCase();
    let selectedPresets = suggestions;

    if (policyMode === "skip" || policyMode === "none" || policyMode === "no") {
      console.log("  [non-interactive] Skipping policy presets.");
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
    console.log(`  [non-interactive] Applying policy presets: ${selectedPresets.join(", ")}`);
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
    const answer = await prompt(`  Apply suggested presets (${suggestions.join(", ")})? [Y/n/list]: `);

    if (answer.toLowerCase() === "n") {
      console.log("  Skipping policy presets.");
      return;
    }

    if (answer.toLowerCase() === "list") {
      // Let user pick
      const picks = await prompt("  Enter preset names (comma-separated): ");
      const selected = picks.split(",").map((s) => s.trim()).filter(Boolean);
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

// ── Dashboard ────────────────────────────────────────────────────

function printDashboard(sandboxName, model, provider, runtime, surface, forwardPort) {
  const nimStat = nim.nimStatus(sandboxName);
  const nimLabel = nimStat.running ? "running" : "not running";

  let providerLabel = provider;
  if (provider === "nvidia-nim") providerLabel = "NVIDIA Cloud API";
  else if (provider === "vllm-local") providerLabel = "Local vLLM";
  else if (provider === "ollama-local") providerLabel = "Local Ollama";

  const runtimeLabel = runtime === "nullclaw" ? "NullClaw" : "OpenClaw";
  const surfaceLabel =
    surface === "nullhub"
      ? "NullHub"
      : surface === "none"
        ? "none (headless)"
        : "OpenClaw UI";
  const forwardedLabel =
    surface === "nullhub"
      ? `http://127.0.0.1:${forwardPort}/`
      : runtime === "nullclaw"
        ? `http://127.0.0.1:${forwardPort}/health`
        : `http://127.0.0.1:${forwardPort}/`;
  const insideLabel =
    runtime === "openclaw"
      ? "openclaw agent --agent main --local"
      : surface === "nullhub"
        ? "nullhub status  |  nullclaw agent"
        : "nullclaw agent";

  console.log("");
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  Runtime      ${runtimeLabel}`);
  console.log(`  Surface      ${surfaceLabel}`);
  console.log(`  Sandbox      ${sandboxName} (Landlock + seccomp + netns)`);
  console.log(`  Model        ${model} (${providerLabel})`);
  console.log(`  Forwarded    ${forwardedLabel}`);
  console.log(`  NIM          ${nimLabel}`);
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  Run:         nemoclaw ${sandboxName} connect`);
  console.log(`  Inside:      ${insideLabel}`);
  console.log(`  Status:      nemoclaw ${sandboxName} status`);
  console.log(`  Logs:        nemoclaw ${sandboxName} logs --follow`);
  console.log(`  ${"─".repeat(50)}`);
  console.log("");
}

// ── Main ─────────────────────────────────────────────────────────

async function onboard(args = []) {
  const {
    runtime: requestedRuntime,
    surface: requestedSurface,
    nonInteractive,
  } = parseOnboardArgs(args);
  NON_INTERACTIVE = nonInteractive || process.env.NEMOCLAW_NON_INTERACTIVE === "1";

  console.log("");
  console.log("  NemoClaw Onboarding");
  if (isNonInteractive()) console.log("  (non-interactive mode)");
  console.log("  ===================");

  const gpu = await preflight();
  const sandboxSelection = await prepareSandbox(requestedRuntime, requestedSurface);
  const runtime = sandboxSelection.runtime || requestedRuntime;
  const surface = sandboxSelection.surface || requestedSurface;
  const sandboxName = sandboxSelection.sandboxName;
  const forwardPort =
    sandboxSelection.sandbox?.forwardPort ||
    forwardPortFor(runtime, surface);

  await ensureSurfacePortAvailable(runtime, surface);
  await startGateway(gpu);

  if (sandboxSelection.reused) {
    run(`openshell forward start --background ${forwardPort} "${sandboxName}"`, { ignoreError: true });
  } else {
    await createSandbox({
      sandboxName,
      gpu,
      runtime,
      surface,
      model: null,
      provider: null,
      nimContainer: null,
    });
  }

  const { model, provider, nimContainer } = await setupNim(sandboxName, gpu);
  registry.updateSandbox(sandboxName, { model, provider, nimContainer, runtime, surface, forwardPort });
  await setupInference(sandboxName, model, provider);
  if (runtime === "openclaw") {
    await setupOpenclaw(sandboxName, model, provider);
  } else if (surface === "none") {
    syncNullclawConfig(sandboxName, model);
  } else if (surface === "nullhub") {
    syncNullhubConfig(sandboxName, model);
  }
  await setupPolicies(sandboxName);
  printDashboard(sandboxName, model, provider, runtime, surface, forwardPort);
}

module.exports = {
  buildSandboxConfigSyncScript,
  hasStaleGateway,
  isSandboxReady,
  onboard,
  selectSandboxDockerfile,
  setupNim,
  stageOpenclawSandboxFiles,
};
