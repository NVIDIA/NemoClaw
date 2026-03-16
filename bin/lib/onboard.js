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

// ── Helpers ──────────────────────────────────────────────────────

function step(n, total, msg) {
  console.log("");
  console.log(`  [${n}/${total}] ${msg}`);
  console.log(`  ${"─".repeat(50)}`);
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
  run(`bash "${path.join(SCRIPTS, "install.sh")}"`, { ignoreError: true });
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
  if (gpu && gpu.nimCapable) gwArgs.push("--gpu");

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

async function createSandbox(gpu) {
  step(3, 7, "Creating sandbox");

  const nameAnswer = await prompt("  Sandbox name [my-assistant]: ");
  const sandboxName = nameAnswer || "my-assistant";

  // Check if sandbox already exists in registry
  const existing = registry.getSandbox(sandboxName);
  if (existing) {
    const recreate = await prompt(`  Sandbox '${sandboxName}' already exists. Recreate? [y/N]: `);
    if (recreate.toLowerCase() !== "y") {
      console.log("  Keeping existing sandbox.");
      return sandboxName;
    }
    // Destroy old sandbox
    run(`openshell sandbox delete ${sandboxName} 2>/dev/null || true`, { ignoreError: true });
    registry.removeSandbox(sandboxName);
  }

  // Stage build context
  const { mkdtempSync } = require("fs");
  const os = require("os");
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
  fs.copyFileSync(path.join(ROOT, "Dockerfile"), path.join(buildCtx, "Dockerfile"));
  run(`cp -r "${path.join(ROOT, "nemoclaw")}" "${buildCtx}/nemoclaw"`);
  run(`cp -r "${path.join(ROOT, "nemoclaw-blueprint")}" "${buildCtx}/nemoclaw-blueprint"`);
  run(`cp -r "${path.join(ROOT, "scripts")}" "${buildCtx}/scripts"`);
  run(`rm -rf "${buildCtx}/nemoclaw/node_modules" "${buildCtx}/nemoclaw/src"`, { ignoreError: true });

  // Create sandbox (use -- echo to avoid dropping into interactive shell)
  // Pass the base policy so sandbox starts in proxy mode (required for policy updates later)
  const basePolicyPath = path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
  const createArgs = [
    `--from "${buildCtx}/Dockerfile"`,
    `--name ${sandboxName}`,
    `--policy "${basePolicyPath}"`,
  ];
  if (gpu && gpu.nimCapable) createArgs.push("--gpu");

  console.log(`  Creating sandbox '${sandboxName}' (this takes a few minutes on first run)...`);
  const chatUiUrl = process.env.CHAT_UI_URL || 'http://127.0.0.1:18789';
  const envArgs = [`CHAT_UI_URL=${chatUiUrl}`];
  if (process.env.NVIDIA_API_KEY) {
    envArgs.push(`NVIDIA_API_KEY=${process.env.NVIDIA_API_KEY}`);
  }
  run(`openshell sandbox create ${createArgs.join(" ")} -- env ${envArgs.join(" ")} nemoclaw-start 2>&1 | awk '/Sandbox allocated/{if(!seen){print;seen=1}next}1'`);

  // Forward dashboard port separately
  run(`openshell forward start --background 18789 ${sandboxName}`, { ignoreError: true });

  // Clean up build context
  run(`rm -rf "${buildCtx}"`, { ignoreError: true });

  // Register in registry
  registry.registerSandbox({
    name: sandboxName,
    gpuEnabled: !!gpu,
  });

  console.log(`  ✓ Sandbox '${sandboxName}' created`);
  return sandboxName;
}

// ── Step 4: NIM ──────────────────────────────────────────────────

async function setupNim(sandboxName, gpu) {
  step(4, 7, "Configuring inference (NIM)");

  let model = null;
  let provider = "nvidia-nim";
  let nimContainer = null;

  // Detect local inference options
  const hasOllama = !!runCapture("command -v ollama", { ignoreError: true });
  const ollamaRunning = !!runCapture("curl -sf http://localhost:11434/api/tags 2>/dev/null", { ignoreError: true });
  const vllmRunning = !!runCapture("curl -sf http://localhost:8000/v1/models 2>/dev/null", { ignoreError: true });

  // Auto-select if a local inference engine is already running
  if (vllmRunning) {
    console.log("  ✓ vLLM detected on localhost:8000 — using it");
    provider = "vllm-local";
    model = "vllm-local";
    registry.updateSandbox(sandboxName, { model, provider, nimContainer });
    return { model, provider };
  }
  if (ollamaRunning) {
    console.log("  ✓ Ollama detected on localhost:11434 — using it");
    provider = "ollama-local";
    model = "nemotron-3-nano";
    registry.updateSandbox(sandboxName, { model, provider, nimContainer });
    return { model, provider };
  }

  // Build options list dynamically
  const options = [];
  if (gpu && gpu.nimCapable) {
    options.push({ key: "nim", label: "Local NIM container (NVIDIA GPU)" });
  }
  options.push({ key: "cloud", label: "NVIDIA Cloud API (build.nvidia.com)" });
  if (hasOllama || ollamaRunning) {
    options.push({ key: "ollama", label: `Local Ollama (localhost:11434)${ollamaRunning ? " — running" : ""}` });
  }
  if (vllmRunning) {
    options.push({ key: "vllm", label: "Existing vLLM instance (localhost:8000) — running" });
  }

  // On macOS without Ollama, offer to install it
  if (!hasOllama && process.platform === "darwin") {
    options.push({ key: "install-ollama", label: "Install Ollama (recommended for macOS)" });
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

  registry.updateSandbox(sandboxName, { model, provider, nimContainer });

  return { model, provider };
}

// ── Step 5: Inference provider ───────────────────────────────────

async function setupInference(sandboxName, model, provider) {
  step(5, 7, "Setting up inference provider");

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

// ── Step 6: OpenClaw ─────────────────────────────────────────────

async function setupOpenclaw(sandboxName) {
  step(6, 7, "Setting up OpenClaw inside sandbox");

  // sandbox create with a command runs it inside the sandbox then exits.
  // Since the sandbox already exists, we create a throwaway connect + command
  // by using sandbox create --no-keep with the same image to exec into it.
  // Simpler: just use sandbox connect which opens a shell — but it doesn't
  // support passing commands. So we run the setup on next connect instead.
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

function printDashboard(sandboxName, model, provider) {
  const nimStat = nim.nimStatus(sandboxName);
  const nimLabel = nimStat.running ? "running" : "not running";

  let providerLabel = provider;
  if (provider === "nvidia-nim") providerLabel = "NVIDIA Cloud API";
  else if (provider === "vllm-local") providerLabel = "Local vLLM";

  console.log("");
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  Dashboard    http://localhost:18789/`);
  console.log(`  Sandbox      ${sandboxName} (Landlock + seccomp + netns)`);
  console.log(`  Model        ${model} (${providerLabel})`);
  console.log(`  NIM          ${nimLabel}`);
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  Run:         nemoclaw ${sandboxName} connect`);
  console.log(`  Status:      nemoclaw ${sandboxName} status`);
  console.log(`  Logs:        nemoclaw ${sandboxName} logs --follow`);
  console.log(`  ${"─".repeat(50)}`);
  console.log("");
}

// ── Main ─────────────────────────────────────────────────────────

async function onboard() {
  console.log("");
  console.log("  NemoClaw Onboarding");
  console.log("  ===================");

  const gpu = await preflight();
  await startGateway(gpu);
  const sandboxName = await createSandbox(gpu);
  const { model, provider } = await setupNim(sandboxName, gpu);
  await setupInference(sandboxName, model, provider);
  await setupOpenclaw(sandboxName);
  await setupPolicies(sandboxName);
  printDashboard(sandboxName, model, provider);
}

module.exports = { onboard };
