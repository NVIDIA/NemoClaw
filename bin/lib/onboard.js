// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Interactive onboarding wizard — 7 steps from zero to running sandbox.

const fs = require("fs");
const path = require("path");
const { ROOT, SCRIPTS, run, runCapture } = require("./runner");
const { prompt, ensureApiKey, getCredential } = require("./credentials");
const registry = require("./registry");
const nim = require("./nim");
const policies = require("./policies");
const { checkCgroupConfig } = require("./preflight");
const HOST_GATEWAY_URL = "http://host.openshell.internal";
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

// ── Helpers ──────────────────────────────────────────────────────

function step(n, total, msg) {
  console.log("");
  console.log(`  [${n}/${total}] ${msg}`);
  console.log(`  ${"─".repeat(50)}`);
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function onboardUsage() {
  console.log(`
  Usage: nemoclaw onboard [--runtime openclaw|nullclaw] [--surface openclaw-ui|nullhub|none]

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

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      onboardUsage();
      process.exit(0);
    }
    if (arg === "--runtime") {
      runtime = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--surface") {
      surface = args[i + 1];
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

  return { runtime, surface };
}

function writeSandboxSshConfig(sandboxName) {
  const sshConfig = runCapture(`openshell sandbox ssh-config ${shQuote(sandboxName)}`);
  const confPath = path.join(require("os").tmpdir(), `nemoclaw-ssh-${process.pid}-${Date.now()}.conf`);
  fs.writeFileSync(confPath, sshConfig, { mode: 0o600 });
  return confPath;
}

function runSandboxCommand(sandboxName, remoteCmd) {
  const confPath = writeSandboxSshConfig(sandboxName);
  try {
    run(
      `ssh -F ${shQuote(confPath)} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ` +
      `-o LogLevel=ERROR ${shQuote(`openshell-${sandboxName}`)} ${shQuote(remoteCmd)}`
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
    `--api-key ${shQuote("openshell-managed")}`,
    `--provider ${shQuote("custom:https://inference.local/v1")}`,
    `--model ${shQuote(model || NULLCLAW_DEFAULT_MODEL)}`,
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
  const updatePayload = JSON.stringify({
    home: `$HOME/.nullhub/instances/nullclaw/${NULLHUB_DEFAULT_INSTANCE}`,
    provider: "custom:https://inference.local/v1",
    api_key: "openshell-managed",
    model: model || NULLCLAW_DEFAULT_MODEL,
    gateway_port: RUNTIME_GATEWAY_PORT.nullclaw,
  });
  const remoteCmd = `
set -euo pipefail
HUB_PORT=${SURFACE_FORWARD_PORT.nullhub}
INSTANCE=${shQuote(NULLHUB_DEFAULT_INSTANCE)}
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
  nullclaw --from-json ${shQuote(updatePayload)} > /tmp/nullhub-sync.log 2>&1
  nullhub restart "nullclaw/$INSTANCE" > /tmp/nullhub-restart.log 2>&1 || nullhub start "nullclaw/$INSTANCE" > /tmp/nullhub-restart.log 2>&1
else
  curl -fsS \
    -H 'Content-Type: application/json' \
    --data ${shQuote(createPayload)} \
    "http://127.0.0.1:${SURFACE_FORWARD_PORT.nullhub}/api/wizard/nullclaw" \
    > /tmp/nullhub-sync.log 2>&1
fi
`;

  runSandboxCommand(sandboxName, remoteCmd);
  console.log("  ✓ NullHub runtime config updated");
}

function isDockerRunning() {
  try {
    runCapture("docker info", { ignoreError: false });
    return true;
  } catch {
    return false;
  }
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
  return isOpenshellInstalled();
}

// ── Step 1: Preflight ────────────────────────────────────────────

async function preflight() {
  step(1, 7, "Preflight checks");

  // Docker
  if (!isDockerRunning()) {
    console.error("  Docker is not running. Please start Docker and try again.");
    process.exit(1);
  }
  console.log("  ✓ Docker is running");

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

  // cgroup v2 + Docker cgroupns
  const cgroup = checkCgroupConfig();
  if (!cgroup.ok) {
    console.error("");
    console.error("  !! cgroup v2 detected but Docker is not configured for cgroupns=host.");
    console.error("     OpenShell's gateway runs k3s inside Docker, which will fail with:");
    console.error("");
    console.error("       openat2 /sys/fs/cgroup/kubepods/pids.max: no such file or directory");
    console.error("");
    console.error("     To fix, run:");
    console.error("");
    console.error("       nemoclaw setup-spark");
    console.error("");
    console.error("     This adds \"default-cgroupns-mode\": \"host\" to /etc/docker/daemon.json");
    console.error("     (preserving any existing settings) and restarts Docker.");
    console.error("");
    console.error(`     Detail: ${cgroup.reason}`);
    process.exit(1);
  }
  console.log("  ✓ cgroup configuration OK");

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

// ── Step 2: Gateway ──────────────────────────────────────────────

async function startGateway(gpu) {
  step(2, 7, "Starting OpenShell gateway");

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
    require("child_process").spawnSync("sleep", ["2"]);
  }

  // CoreDNS fix — always run. k3s-inside-Docker has broken DNS on all platforms.
  const home = process.env.HOME || "/tmp";
  const colimaSocket = [
    path.join(home, ".colima/default/docker.sock"),
    path.join(home, ".config/colima/default/docker.sock"),
  ].find((s) => fs.existsSync(s));
  if (colimaSocket) {
    console.log("  Patching CoreDNS for Colima...");
    run(`bash "${path.join(SCRIPTS, "fix-coredns.sh")}" 2>&1 || true`, { ignoreError: true });
  }
  // Give DNS a moment to propagate
  require("child_process").spawnSync("sleep", ["5"]);

}

// ── Step 3: Sandbox ──────────────────────────────────────────────

async function prepareSandbox(runtime, surface) {
  step(3, 7, "Selecting sandbox");

  const nameAnswer = await prompt("  Sandbox name (lowercase, numbers, hyphens) [my-assistant]: ");
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
    run(`openshell sandbox delete "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });
    registry.removeSandbox(sandboxName);
  }

  console.log(`  ✓ Runtime: ${runtime}`);
  console.log(`  ✓ Surface: ${surface}`);
  return { sandboxName, reused: false, runtime, surface };
}

async function createSandbox({ sandboxName, gpu, runtime, surface, model, provider, nimContainer }) {
  const runtimeLabel = runtime === "nullclaw" ? "NullClaw" : "OpenClaw";
  const surfaceLabel = surface === "nullhub" ? "NullHub" : surface === "none" ? "headless" : "OpenClaw UI";
  step(4, 7, `Creating ${runtimeLabel} sandbox (${surfaceLabel})`);

  const buildCtx = fs.mkdtempSync(path.join(require("os").tmpdir(), "nemoclaw-build-"));
  const dockerfileName =
    runtime === "openclaw"
      ? "Dockerfile"
      : surface === "nullhub"
        ? "Dockerfile.nullhub"
        : "Dockerfile.nullclaw";
  fs.copyFileSync(path.join(ROOT, dockerfileName), path.join(buildCtx, "Dockerfile"));
  run(`cp -r "${path.join(ROOT, "scripts")}" "${buildCtx}/scripts"`);

  if (runtime === "openclaw") {
    run(`cp -r "${path.join(ROOT, "nemoclaw")}" "${buildCtx}/nemoclaw"`);
    run(`cp -r "${path.join(ROOT, "nemoclaw-blueprint")}" "${buildCtx}/nemoclaw-blueprint"`);
    run(`rm -rf "${buildCtx}/nemoclaw/node_modules" "${buildCtx}/nemoclaw/src"`, { ignoreError: true });
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
      `PUBLIC_PORT=${shQuote(String(forwardPort))}`,
      `NULLHUB_PORT=${shQuote(String(SURFACE_FORWARD_PORT.nullhub))}`,
      `NULLHUB_INSTANCE=${shQuote(NULLHUB_DEFAULT_INSTANCE)}`,
      `NULLHUB_NULLCLAW_VERSION=${shQuote(NULLCLAW_DEFAULT_VERSION)}`,
      `NULLCLAW_GATEWAY_PORT=${shQuote(String(RUNTIME_GATEWAY_PORT.nullclaw))}`,
      `NULLCLAW_MODEL=${shQuote(model || NULLCLAW_DEFAULT_MODEL)}`,
      `NULLCLAW_PROVIDER=${shQuote("custom:https://inference.local/v1")}`,
      `NULLCLAW_API_KEY=${shQuote("openshell-managed")}`,
    ];
    createResult = run(
      `openshell sandbox create ${createArgs.join(" ")} -- env ${envArgs.join(" ")} nullhub-start 2>&1 | awk '/Sandbox allocated/{if(!seen){print;seen=1}next}1'`,
      { ignoreError: true }
    );
  } else if (runtime === "nullclaw") {
    const envArgs = [
      `PUBLIC_PORT=${shQuote(String(forwardPort))}`,
      `NULLCLAW_MODEL=${shQuote(model || NULLCLAW_DEFAULT_MODEL)}`,
    ];
    createResult = run(
      `set -o pipefail; openshell sandbox create ${createArgs.join(" ")} -- env ${envArgs.join(" ")} nullclaw-start 2>&1 | awk '/Sandbox allocated/{if(!seen){print;seen=1}next}1'`,
      { ignoreError: true }
    );
  } else {
    const chatUiUrl = process.env.CHAT_UI_URL || "http://127.0.0.1:18789";
    const envArgs = [`CHAT_UI_URL=${shQuote(chatUiUrl)}`];
    if (process.env.NVIDIA_API_KEY) {
      envArgs.push(`NVIDIA_API_KEY=${shQuote(process.env.NVIDIA_API_KEY)}`);
    }
    createResult = run(
      `set -o pipefail; openshell sandbox create ${createArgs.join(" ")} -- env ${envArgs.join(" ")} nemoclaw-start 2>&1 | awk '/Sandbox allocated/{if(!seen){print;seen=1}next}1'`,
      { ignoreError: true }
    );
  }

  if (createResult.status !== 0) {
    run(`openshell sandbox delete "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });
    if (nimContainer) {
      nim.stopNimContainer(sandboxName);
    }
    run(`rm -rf "${buildCtx}"`, { ignoreError: true });
    console.error(`  Failed to create sandbox '${sandboxName}'.`);
    process.exit(createResult.status || 1);
  }
  run(`openshell forward stop ${forwardPort} 2>/dev/null || true`, { ignoreError: true });
  run(`openshell forward start --background ${forwardPort} "${sandboxName}"`, { ignoreError: true });
  run(`rm -rf "${buildCtx}"`, { ignoreError: true });

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

  // Auto-select only with NEMOCLAW_EXPERIMENTAL=1 (prevents silent misconfiguration)
  if (EXPERIMENTAL) {
    if (vllmRunning) {
      console.log("  ✓ vLLM detected on localhost:8000 — using it [experimental]");
      provider = "vllm-local";
      model = "vllm-local";
      return { model, provider, nimContainer };
    }
    if (ollamaRunning) {
      console.log("  ✓ Ollama detected on localhost:11434 — using it [experimental]");
      provider = "ollama-local";
      model = "nemotron-3-nano";
      return { model, provider, nimContainer };
    }
  }

  // Build options list — only show local options with NEMOCLAW_EXPERIMENTAL=1
  const options = [];
  if (EXPERIMENTAL && gpu && gpu.nimCapable) {
    options.push({ key: "nim", label: "Local NIM container (NVIDIA GPU) [experimental]" });
  }
  options.push({ key: "cloud", label: "NVIDIA Cloud API (build.nvidia.com)" });
  if (EXPERIMENTAL && (hasOllama || ollamaRunning)) {
    options.push({ key: "ollama", label: `Local Ollama (localhost:11434)${ollamaRunning ? " — running" : ""} [experimental]` });
  }
  if (EXPERIMENTAL && vllmRunning) {
    options.push({ key: "vllm", label: "Existing vLLM instance (localhost:8000) — running [experimental]" });
  }

  // On macOS without Ollama, offer to install it
  if (EXPERIMENTAL && !hasOllama && process.platform === "darwin") {
    options.push({ key: "install-ollama", label: "Install Ollama (macOS) [experimental]" });
  }

  if (options.length > 1) {
    console.log("");
    console.log("  Inference options:");
    options.forEach((o, i) => {
      console.log(`    ${i + 1}) ${o.label}`);
    });
    console.log("");

    const defaultIdx = options.findIndex((o) => o.key === "cloud") + 1;
    const choice = await prompt(`  Choose [${defaultIdx}]: `);
    const idx = parseInt(choice || String(defaultIdx), 10) - 1;
    const selected = options[idx] || options[defaultIdx - 1];

    if (selected.key === "nim") {
      // List models that fit GPU VRAM
      const models = nim.listModels().filter((m) => m.minGpuMemoryMB <= gpu.totalMemoryMB);
      if (models.length === 0) {
        console.log("  No NIM models fit your GPU VRAM. Falling back to cloud API.");
      } else {
        console.log("");
        console.log("  Models that fit your GPU:");
        models.forEach((m, i) => {
          console.log(`    ${i + 1}) ${m.name} (min ${m.minGpuMemoryMB} MB)`);
        });
        console.log("");

        const modelChoice = await prompt(`  Choose model [1]: `);
        const midx = parseInt(modelChoice || "1", 10) - 1;
        const sel = models[midx] || models[0];
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
        require("child_process").spawnSync("sleep", ["2"]);
      }
      console.log("  ✓ Using Ollama on localhost:11434");
      provider = "ollama-local";
      model = "nemotron-3-nano";
    } else if (selected.key === "install-ollama") {
      console.log("  Installing Ollama via Homebrew...");
      run("brew install ollama", { ignoreError: true });
      console.log("  Starting Ollama...");
      run("OLLAMA_HOST=0.0.0.0:11434 ollama serve > /dev/null 2>&1 &", { ignoreError: true });
      require("child_process").spawnSync("sleep", ["2"]);
      console.log("  ✓ Using Ollama on localhost:11434");
      provider = "ollama-local";
      model = "nemotron-3-nano";
    } else if (selected.key === "vllm") {
      console.log("  ✓ Using existing vLLM on localhost:8000");
      provider = "vllm-local";
      model = "vllm-local";
    }
    // else: cloud — fall through to default below
  }

  if (provider === "nvidia-nim") {
    await ensureApiKey();
    model = model || "nvidia/nemotron-3-super-120b-a12b";
    console.log(`  Using NVIDIA Cloud API with model: ${model}`);
  }

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
    run(
      `openshell provider create --name vllm-local --type openai ` +
      `--credential "OPENAI_API_KEY=dummy" ` +
      `--config "OPENAI_BASE_URL=${HOST_GATEWAY_URL}:8000/v1" 2>&1 || ` +
      `openshell provider update vllm-local --credential "OPENAI_API_KEY=dummy" ` +
      `--config "OPENAI_BASE_URL=${HOST_GATEWAY_URL}:8000/v1" 2>&1 || true`,
      { ignoreError: true }
    );
    run(
      `openshell inference set --no-verify --provider vllm-local --model ${model} 2>/dev/null || true`,
      { ignoreError: true }
    );
  } else if (provider === "ollama-local") {
    run(
      `openshell provider create --name ollama-local --type openai ` +
      `--credential "OPENAI_API_KEY=ollama" ` +
      `--config "OPENAI_BASE_URL=${HOST_GATEWAY_URL}:11434/v1" 2>&1 || ` +
      `openshell provider update ollama-local --credential "OPENAI_API_KEY=ollama" ` +
      `--config "OPENAI_BASE_URL=${HOST_GATEWAY_URL}:11434/v1" 2>&1 || true`,
      { ignoreError: true }
    );
    run(
      `openshell inference set --no-verify --provider ollama-local --model ${model} 2>/dev/null || true`,
      { ignoreError: true }
    );
  }

  registry.updateSandbox(sandboxName, { model, provider });
  console.log(`  ✓ Inference route set: ${provider} / ${model}`);
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
  const { runtime: requestedRuntime, surface: requestedSurface } = parseOnboardArgs(args);

  console.log("");
  console.log("  NemoClaw Onboarding");
  console.log("  ===================");

  const gpu = await preflight();
  await startGateway(gpu);
  const sandboxSelection = await prepareSandbox(requestedRuntime, requestedSurface);
  const runtime = sandboxSelection.runtime || requestedRuntime;
  const surface = sandboxSelection.surface || requestedSurface;
  const sandboxName = sandboxSelection.sandboxName;
  const forwardPort =
    sandboxSelection.sandbox?.forwardPort ||
    forwardPortFor(runtime, surface);

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
  if (runtime === "nullclaw" && surface === "none") {
    syncNullclawConfig(sandboxName, model);
  } else if (runtime === "nullclaw" && surface === "nullhub") {
    syncNullhubConfig(sandboxName, model);
  }
  await setupPolicies(sandboxName);
  printDashboard(sandboxName, model, provider, runtime, surface, forwardPort);
}

module.exports = { onboard };
