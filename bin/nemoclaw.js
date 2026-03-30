#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execFileSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ---------------------------------------------------------------------------
// Color / style — respects NO_COLOR and non-TTY environments.
// Uses exact NVIDIA green #76B900 on truecolor terminals; 256-color otherwise.
// ---------------------------------------------------------------------------
const _useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const _tc = _useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const G = _useColor ? (_tc ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const B = _useColor ? "\x1b[1m" : "";
const D = _useColor ? "\x1b[2m" : "";
const R = _useColor ? "\x1b[0m" : "";
const _RD = _useColor ? "\x1b[1;31m" : "";
const YW = _useColor ? "\x1b[1;33m" : "";

const { ROOT, SCRIPTS, run, runCapture, runInteractive, shellQuote, validateName } = require("./lib/runner");
const {
  ensureApiKey,
  ensureGithubToken,
  getCredential,
  isRepoPrivate,
} = require("./lib/credentials");
const registry = require("./lib/registry");
const nim = require("./lib/nim");
const policies = require("./lib/policies");
const { parseGatewayInference } = require("./lib/inference-config");
const { sandboxResume: sandboxResumeImpl, DASHBOARD_PORT } = require("./lib/sandbox-resume");
const { addGpuAgent: addGpuAgentImpl } = require("./lib/sandbox-add-gpu-agent");

// ── Global commands ──────────────────────────────────────────────

const GLOBAL_COMMANDS = new Set([
  "onboard", "list", "deploy", "setup", "setup-spark",
  "start", "stop", "status", "debug", "uninstall", "sandbox-init",
  "add-gpu-agent", "resume",
  "help", "--help", "-h", "--version", "-v",
]);

const REMOTE_UNINSTALL_URL = "https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh";

function resolveUninstallScript() {
  const candidates = [
    path.join(ROOT, "uninstall.sh"),
    path.join(__dirname, "..", "uninstall.sh"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function exitWithSpawnResult(result) {
  if (result.status !== null) {
    process.exit(result.status);
  }

  if (result.signal) {
    const signalNumber = os.constants.signals[result.signal];
    process.exit(signalNumber ? 128 + signalNumber : 1);
  }

  process.exit(1);
}

// ── Commands ─────────────────────────────────────────────────────

async function onboard(args) {
  const { onboard: runOnboard } = require("./lib/onboard");
  const allowedArgs = new Set(["--non-interactive"]);
  const unknownArgs = args.filter((arg) => !allowedArgs.has(arg));
  if (unknownArgs.length > 0) {
    console.error(`  Unknown onboard option(s): ${unknownArgs.join(", ")}`);
    console.error("  Usage: nemoclaw onboard [--non-interactive]");
    process.exit(1);
  }
  const nonInteractive = args.includes("--non-interactive");
  await runOnboard({ nonInteractive });
}

async function addGpuAgentCmd(args) {
  let agentName = null;
  let parentName = null;
  let model = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      console.log([
        "",
        "  Usage: nemoclaw add-gpu-agent <agent-name> [--parent <parent-name>]",
        "",
        "  Create a GPU-enabled agent sandbox and register it in the parent agent's",
        "  openclaw dashboard. Enables GPU time-slicing if only one physical GPU is",
        "  available so multiple agents can share it.",
        "",
        "  Options:",
        "    --parent <name>    Parent sandbox to register under (default: defaultSandbox)",
        "    --model <key>      Model key to assign to this agent (e.g. anthropic-prod/claude-sonnet-4-6)",
        "",
        "  Examples:",
        "    nemoclaw add-gpu-agent jarvis",
        "    nemoclaw add-gpu-agent jarvis --parent cortana",
        "    nemoclaw add-gpu-agent jarvis --model anthropic-prod/claude-sonnet-4-6",
        "",
      ].join("\n"));
      process.exit(0);
    } else if (a === "--parent") {
      parentName = args[++i];
      if (!parentName) {
        console.error("  --parent requires a value");
        process.exit(1);
      }
    } else if (a === "--model") {
      model = args[++i];
      if (!model) {
        console.error("  --model requires a value");
        process.exit(1);
      }
    } else if (!a.startsWith("--")) {
      agentName = a;
    } else {
      console.error(`  Unknown option: ${a}`);
      console.error("  Usage: nemoclaw add-gpu-agent <agent-name> [--parent <name>]");
      process.exit(1);
    }
  }

  if (!agentName) {
    console.error("  Usage: nemoclaw add-gpu-agent <agent-name> [--parent <name>]");
    console.error("  Run 'nemoclaw add-gpu-agent --help' for details.");
    process.exit(1);
  }

  validateName(agentName, "agent name");
  if (parentName) validateName(parentName, "parent name");

  const result = await addGpuAgentImpl(agentName, { parentName: parentName || undefined, model: model || undefined });
  if (!result.success) process.exit(1);
}

async function sandboxInitCmd(args) {
  const { sandboxInit } = require("./lib/sandbox-init");

  // Parse arguments
  let sandboxName = null;
  let agentName = null;
  let agentId = null;
  let soulFile = null;
  let identityFile = null;
  let agentsFile = null;
  let userFile = null;
  let extraPolicies = [];
  let skipGithub = false;
  let parentAgentId = null;
  let nonInteractive = false;
  let enableDocker = false;
  let model = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--agent-name")       { agentName = args[++i]; }
    else if (a === "--agent-id")    { agentId = args[++i]; }
    else if (a === "--soul")        { soulFile = args[++i]; }
    else if (a === "--identity")    { identityFile = args[++i]; }
    else if (a === "--agents")      { agentsFile = args[++i]; }
    else if (a === "--user")        { userFile = args[++i]; }
    else if (a === "--policy")      { extraPolicies.push(args[++i]); }
    else if (a === "--no-github")   { skipGithub = true; }
    else if (a === "--parent-agent") { parentAgentId = args[++i]; }
    else if (a === "--non-interactive") { nonInteractive = true; }
    else if (a === "--docker")      { enableDocker = true; }
    else if (a === "--model")       { model = args[++i]; }
    else if (a === "--help" || a === "-h") {
      console.log([
        "",
        "  nemoclaw sandbox-init <sandbox-name> [options]",
        "",
        "  Idempotently bootstrap an existing sandbox with workspace files,",
        "  network policies, Git credentials, and an agent config entry.",
        "",
        "  Options:",
        "    --agent-name <name>        Display name for the agent  (default: sandbox name)",
        "    --agent-id   <id>          Agent identifier            (default: sandbox name)",
        "    --soul       <file>        Path to a custom SOUL.md to upload",
        "    --identity   <file>        Path to a custom IDENTITY.md to upload",
        "    --agents     <file>        Path to a custom AGENTS.md to upload",
        "    --user       <file>        Path to a custom USER.md to upload",
        "    --policy     <preset>      Extra policy preset to apply (repeatable)",
        "    --no-github                Skip GitHub policy + credential setup",
        "    --docker                   Apply docker + docker-proxy policies (enables Docker/Compose)",
        "    --parent-agent <id>        Register as subagent of another agent",
        "    --model <key>              Model key for this agent (e.g. anthropic-prod/claude-sonnet-4-6)",
        "    --non-interactive          Never prompt; fail if required info is missing",
        "",
        "  Examples:",
        "    nemoclaw sandbox-init cortana",
        '    nemoclaw sandbox-init robotics-team --agent-name "Robotics Team" --parent-agent cortana',
        "    nemoclaw sandbox-init my-agent --soul ./my-soul.md --policy npm --no-github",
        "    nemoclaw sandbox-init jarvis --model anthropic-prod/claude-sonnet-4-6",
        "",
      ].join("\n"));
      process.exit(0);
    }
    else if (!a.startsWith("--"))   { sandboxName = a; }
    else {
      console.error(`  Unknown option: ${a}`);
      console.error("  Usage: nemoclaw sandbox-init <sandbox-name> [options]");
      console.error("  Run 'nemoclaw sandbox-init --help' for details.");
      process.exit(1);
    }
  }

  if (!sandboxName) {
    console.error("  Usage: nemoclaw sandbox-init <sandbox-name> [options]");
    console.error("  Run 'nemoclaw sandbox-init --help' for details.");
    process.exit(1);
  }

  validateName(sandboxName, "sandbox name");

  await sandboxInit(sandboxName, {
    agentName: agentName || sandboxName,
    agentId: agentId || sandboxName,
    soulFile,
    identityFile,
    agentsFile,
    userFile,
    extraPolicies,
    skipGithub,
    parentAgentId,
    nonInteractive,
    enableDocker,
    model,
  });
}

async function setup() {
  console.log("");
  console.log("  ⚠  `nemoclaw setup` is deprecated. Use `nemoclaw onboard` instead.");
  console.log("     Running legacy setup.sh for backwards compatibility...");
  console.log("");
  await ensureApiKey();
  const { defaultSandbox } = registry.listSandboxes();
  const safeName = defaultSandbox && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(defaultSandbox) ? defaultSandbox : "";
  run(`bash "${SCRIPTS}/setup.sh" ${shellQuote(safeName)}`);
}

async function setupSpark() {
  // setup-spark.sh configures Docker cgroups — it does not use NVIDIA_API_KEY.
  run(`sudo bash "${SCRIPTS}/setup-spark.sh"`);
}

async function deploy(instanceName) {
  if (!instanceName) {
    console.error("  Usage: nemoclaw deploy <instance-name>");
    console.error("");
    console.error("  Examples:");
    console.error("    nemoclaw deploy my-gpu-box");
    console.error("    nemoclaw deploy nemoclaw-prod");
    console.error("    nemoclaw deploy nemoclaw-test");
    process.exit(1);
  }
  await ensureApiKey();
  if (isRepoPrivate("NVIDIA/OpenShell")) {
    await ensureGithubToken();
  }
  validateName(instanceName, "instance name");
  const name = instanceName;
  const qname = shellQuote(name);
  const gpu = process.env.NEMOCLAW_GPU || "a2-highgpu-1g:nvidia-tesla-a100:1";

  console.log("");
  console.log(`  Deploying NemoClaw to Brev instance: ${name}`);
  console.log("");

  try {
    execFileSync("which", ["brev"], { stdio: "ignore" });
  } catch {
    console.error("brev CLI not found. Install: https://brev.nvidia.com");
    process.exit(1);
  }

  let exists = false;
  try {
    const out = execFileSync("brev", ["ls"], { encoding: "utf-8" });
    exists = out.includes(name);
  } catch (err) {
    if (err.stdout && err.stdout.includes(name)) exists = true;
    if (err.stderr && err.stderr.includes(name)) exists = true;
  }

  if (!exists) {
    console.log(`  Creating Brev instance '${name}' (${gpu})...`);
    run(`brev create ${qname} --gpu ${shellQuote(gpu)}`);
  } else {
    console.log(`  Brev instance '${name}' already exists.`);
  }

  run(`brev refresh`, { ignoreError: true });

  process.stdout.write(`  Waiting for SSH `);
  for (let i = 0; i < 60; i++) {
    try {
      execFileSync("ssh", ["-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", name, "echo", "ok"], { encoding: "utf-8", stdio: "ignore" });
      process.stdout.write(` ${G}✓${R}\n`);
      break;
    } catch {
      if (i === 59) {
        process.stdout.write("\n");
        console.error(`  Timed out waiting for SSH to ${name}`);
        process.exit(1);
      }
      process.stdout.write(".");
      spawnSync("sleep", ["3"]);
    }
  }

  console.log("  Syncing NemoClaw to VM...");
  run(`ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'mkdir -p /home/ubuntu/nemoclaw'`);
  run(`rsync -az --delete --exclude node_modules --exclude .git --exclude .venv --exclude src -e "ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR" "${ROOT}/scripts" "${ROOT}/Dockerfile" "${ROOT}/nemoclaw" "${ROOT}/nemoclaw-blueprint" "${ROOT}/bin" "${ROOT}/package.json" ${qname}:/home/ubuntu/nemoclaw/`);

  const envLines = [`NVIDIA_API_KEY=${shellQuote(process.env.NVIDIA_API_KEY || "")}`];
  const ghToken = process.env.GITHUB_TOKEN;
  if (ghToken) envLines.push(`GITHUB_TOKEN=${shellQuote(ghToken)}`);
  const tgToken = getCredential("TELEGRAM_BOT_TOKEN");
  if (tgToken) envLines.push(`TELEGRAM_BOT_TOKEN=${shellQuote(tgToken)}`);
  const discordToken = getCredential("DISCORD_BOT_TOKEN");
  if (discordToken) envLines.push(`DISCORD_BOT_TOKEN=${shellQuote(discordToken)}`);
  const slackToken = getCredential("SLACK_BOT_TOKEN");
  if (slackToken) envLines.push(`SLACK_BOT_TOKEN=${shellQuote(slackToken)}`);
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-"));
  const envTmp = path.join(envDir, "env");
  fs.writeFileSync(envTmp, envLines.join("\n") + "\n", { mode: 0o600 });
  try {
    run(`scp -q -o StrictHostKeyChecking=no -o LogLevel=ERROR ${shellQuote(envTmp)} ${qname}:/home/ubuntu/nemoclaw/.env`);
    run(`ssh -q -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'chmod 600 /home/ubuntu/nemoclaw/.env'`);
  } finally {
    try { fs.unlinkSync(envTmp); } catch { /* ignored */ }
    try { fs.rmdirSync(envDir); } catch { /* ignored */ }
  }

  console.log("  Running setup...");
  runInteractive(`ssh -t -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && bash scripts/brev-setup.sh'`);

  if (tgToken) {
    console.log("  Starting services...");
    run(`ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && bash scripts/start-services.sh'`);
  }

  console.log("");
  console.log("  Connecting to sandbox...");
  console.log("");
  runInteractive(`ssh -t -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && openshell sandbox connect nemoclaw'`);
}

async function start() {
  await ensureApiKey();
  const { defaultSandbox } = registry.listSandboxes();
  const safeName = defaultSandbox && /^[a-zA-Z0-9._-]+$/.test(defaultSandbox) ? defaultSandbox : null;
  const sandboxEnv = safeName ? `SANDBOX_NAME=${shellQuote(safeName)}` : "";
  run(`${sandboxEnv} bash "${SCRIPTS}/start-services.sh"`);
}

function stop() {
  run(`bash "${SCRIPTS}/start-services.sh" --stop`);
}

function debug(args) {
  const result = spawnSync("bash", [path.join(SCRIPTS, "debug.sh"), ...args], {
    stdio: "inherit",
    cwd: ROOT,
    env: {
      ...process.env,
      SANDBOX_NAME: registry.listSandboxes().defaultSandbox || "",
    },
  });
  exitWithSpawnResult(result);
}

function uninstall(args) {
  const localScript = resolveUninstallScript();
  if (localScript) {
    console.log(`  Running local uninstall script: ${localScript}`);
    const result = spawnSync("bash", [localScript, ...args], {
      stdio: "inherit",
      cwd: ROOT,
      env: process.env,
    });
    exitWithSpawnResult(result);
  }

  console.log(`  Local uninstall script not found; falling back to ${REMOTE_UNINSTALL_URL}`);
  const forwardedArgs = args.map(shellQuote).join(" ");
  const command = forwardedArgs.length > 0
    ? `curl -fsSL ${shellQuote(REMOTE_UNINSTALL_URL)} | bash -s -- ${forwardedArgs}`
    : `curl -fsSL ${shellQuote(REMOTE_UNINSTALL_URL)} | bash`;
  const result = spawnSync("bash", ["-c", command], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });
  exitWithSpawnResult(result);
}

function showStatus() {
  // Show sandbox registry
  const { sandboxes, defaultSandbox } = registry.listSandboxes();
  if (sandboxes.length > 0) {
    console.log("");
    console.log("  Sandboxes:");
    for (const sb of sandboxes) {
      const def = sb.name === defaultSandbox ? " *" : "";
      const model = sb.model ? ` (${sb.model})` : "";
      console.log(`    ${sb.name}${def}${model}`);
    }
    console.log("");
  }

  // Show service status
  run(`bash "${SCRIPTS}/start-services.sh" --status`);
}

function listSandboxes() {
  const { sandboxes, defaultSandbox } = registry.listSandboxes();
  if (sandboxes.length === 0) {
    console.log("");
    console.log("  No sandboxes registered. Run `nemoclaw onboard` to get started.");
    console.log("");
    return;
  }

  console.log("");
  console.log("  Sandboxes:");
  for (const sb of sandboxes) {
    const def = sb.name === defaultSandbox ? " *" : "";
    const model = sb.model || "unknown";
    const provider = sb.provider || "unknown";
    const gpu = sb.gpuEnabled ? "GPU" : "CPU";
    const presets = sb.policies && sb.policies.length > 0 ? sb.policies.join(", ") : "none";
    console.log(`    ${sb.name}${def}`);
    console.log(`      model: ${model}  provider: ${provider}  ${gpu}  policies: ${presets}`);
  }
  console.log("");
  console.log("  * = default sandbox");
  console.log("");
}

// ── Sandbox-scoped actions ───────────────────────────────────────

function sandboxConnect(sandboxName) {
  const qn = shellQuote(sandboxName);
  // Ensure port forward is alive before connecting
  run(`openshell forward start --background 18789 ${qn} 2>/dev/null || true`, { ignoreError: true });
  runInteractive(`openshell sandbox connect ${qn}`);
}

/**
 * Ensure the openclaw gateway is running inside the sandbox.
 * If it's not running, starts it. Then (re-)establishes the port forward
 * and prints the dashboard URL with auth token.
 */
function sandboxResume(sandboxName) {
  const result = sandboxResumeImpl(sandboxName);

  if (result.error) {
    process.exit(1);
  }

  console.log("");
  console.log(`  ${G}${B}Dashboard:${R}`);
  if (result.token) {
    console.log(`    http://127.0.0.1:${DASHBOARD_PORT}/#token=${result.token}`);
  } else {
    console.log(`    http://127.0.0.1:${DASHBOARD_PORT}/`);
  }
  console.log("");
}

function sandboxStatus(sandboxName) {
  const sb = registry.getSandbox(sandboxName);
  const live = parseGatewayInference(
    runCapture("openshell inference get 2>/dev/null", { ignoreError: true })
  );
  if (sb) {
    console.log("");
    console.log(`  Sandbox: ${sb.name}`);
    console.log(`    Model:    ${(live && live.model) || sb.model || "unknown"}`);
    console.log(`    Provider: ${(live && live.provider) || sb.provider || "unknown"}`);
    console.log(`    GPU:      ${sb.gpuEnabled ? "yes" : "no"}`);
    console.log(`    Policies: ${(sb.policies || []).join(", ") || "none"}`);
  }

  // openshell info
  run(`openshell sandbox get ${shellQuote(sandboxName)} 2>/dev/null || true`, { ignoreError: true });

  // NIM health
  const nimStat = sb && sb.nimContainer ? nim.nimStatusByName(sb.nimContainer) : nim.nimStatus(sandboxName);
  console.log(`    NIM:      ${nimStat.running ? `running (${nimStat.container})` : "not running"}`);
  if (nimStat.running) {
    console.log(`    Healthy:  ${nimStat.healthy ? "yes" : "no"}`);
  }

  // Dashboard URL + auth token
  const { DASHBOARD_PORT } = require("./lib/sandbox-resume");
  const token = runCapture(
    `openshell doctor exec -- kubectl exec ${sandboxName} -n openshell -- ` +
      `bash -c "HOME=/sandbox python3 -c \\"import json; cfg=json.load(open('/sandbox/.openclaw/openclaw.json')); print(cfg.get('gateway',{}).get('auth',{}).get('token',''))\\""`,
    { ignoreError: true }
  ) || null;
  const tokenStr = token ? token.trim() : null;
  const hash = tokenStr ? `#token=${tokenStr}` : "";
  console.log(`    Dashboard: http://127.0.0.1:${DASHBOARD_PORT}/${hash}`);
  if (!tokenStr) {
    console.log(`    Token:     run 'nemoclaw ${sandboxName} resume' to start the gateway and retrieve token`);
  }
  console.log("");
}

function sandboxLogs(sandboxName, follow) {
  const followFlag = follow ? " --tail" : "";
  run(`openshell logs ${shellQuote(sandboxName)}${followFlag}`);
}

async function sandboxPolicyAdd(sandboxName) {
  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  console.log("");
  console.log("  Available presets:");
  allPresets.forEach((p) => {
    const marker = applied.includes(p.name) ? "●" : "○";
    console.log(`    ${marker} ${p.name} — ${p.description}`);
  });
  console.log("");

  const { prompt: askPrompt } = require("./lib/credentials");
  const answer = await askPrompt("  Preset to apply: ");
  if (!answer) return;

  const confirm = await askPrompt(`  Apply '${answer}' to sandbox '${sandboxName}'? [Y/n]: `);
  if (confirm.toLowerCase() === "n") return;

  policies.applyPreset(sandboxName, answer);
}

function sandboxPolicyList(sandboxName) {
  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  console.log("");
  console.log(`  Policy presets for sandbox '${sandboxName}':`);
  allPresets.forEach((p) => {
    const marker = applied.includes(p.name) ? "●" : "○";
    console.log(`    ${marker} ${p.name} — ${p.description}`);
  });
  console.log("");
}

function sandboxMount(sandboxName, actionArgs) {
  const mountPoint = actionArgs[0]
    ? shellQuote(actionArgs[0])
    : shellQuote(path.join(os.homedir(), "nemoclaw-sandbox", sandboxName));
  run(`bash "${SCRIPTS}/mount-sandbox.sh" mount ${shellQuote(sandboxName)} ${mountPoint}`);
}

function sandboxUnmount(sandboxName, actionArgs) {
  const mountPoint = actionArgs[0]
    ? shellQuote(actionArgs[0])
    : shellQuote(path.join(os.homedir(), "nemoclaw-sandbox", sandboxName));
  run(`bash "${SCRIPTS}/mount-sandbox.sh" unmount ${shellQuote(sandboxName)} ${mountPoint}`);
}

function sandboxBackup(sandboxName) {
  run(`bash "${SCRIPTS}/backup-workspace.sh" backup ${shellQuote(sandboxName)}`);
}

function sandboxRestore(sandboxName, actionArgs) {
  const timestamp = actionArgs[0] ? shellQuote(actionArgs[0]) : "";
  run(`bash "${SCRIPTS}/backup-workspace.sh" restore ${shellQuote(sandboxName)} ${timestamp}`);
}

function resume(args) {
  const name = args[0] || registry.listSandboxes().defaultSandbox;
  if (!name) {
    console.error(`  Usage: nemoclaw resume <sandbox-name>`);
    console.error(`  No sandbox name given and no default sandbox registered.`);
    process.exit(1);
  }
  validateName(name, "sandbox name");
  const envParts = [];
  if (args.includes("--port")) {
    const idx = args.indexOf("--port");
    if (args[idx + 1]) envParts.push(`DASHBOARD_PORT=${shellQuote(args[idx + 1])}`);
  }
  if (args.includes("--mount-point")) {
    const idx = args.indexOf("--mount-point");
    if (args[idx + 1]) envParts.push(`MOUNT_POINT=${shellQuote(args[idx + 1])}`);
  }
  const envPrefix = envParts.length > 0 ? envParts.join(" ") + " " : "";
  run(`${envPrefix}bash "${SCRIPTS}/resume.sh" ${shellQuote(name)}`);
}

async function sandboxDestroy(sandboxName, args = []) {
  const skipConfirm = args.includes("--yes") || args.includes("--force");
  if (!skipConfirm) {
    const { prompt: askPrompt } = require("./lib/credentials");
    const answer = await askPrompt(
      `  ${YW}Destroy sandbox '${sandboxName}'?${R} This cannot be undone. [y/N]: `,
    );
    if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
      console.log("  Cancelled.");
      return;
    }
  }

  console.log(`  Stopping NIM for '${sandboxName}'...`);
  const sb = registry.getSandbox(sandboxName);
  if (sb && sb.nimContainer) nim.stopNimContainerByName(sb.nimContainer);
  else nim.stopNimContainer(sandboxName);

  console.log(`  Deleting sandbox '${sandboxName}'...`);
  run(`openshell sandbox delete ${shellQuote(sandboxName)} 2>/dev/null || true`, { ignoreError: true });

  registry.removeSandbox(sandboxName);
  console.log(`  ${G}✓${R} Sandbox '${sandboxName}' destroyed`);
}

// ── Help ─────────────────────────────────────────────────────────

function help() {
  const pkg = require(path.join(__dirname, "..", "package.json"));
  console.log(`
  ${B}${G}NemoClaw${R}  ${D}v${pkg.version}${R}
  ${D}Deploy more secure, always-on AI assistants with a single command.${R}

  ${G}Getting Started:${R}
    ${B}nemoclaw onboard${R}                 Configure inference endpoint and credentials
    ${B}nemoclaw sandbox-init <name>${R}     Bootstrap workspace files, policies, and agent config
    nemoclaw setup-spark             Set up on DGX Spark ${D}(fixes cgroup v2 + Docker)${R}

  ${G}Sandbox Management:${R}
    ${B}nemoclaw list${R}                    List all sandboxes           ${B}nemoclaw add-gpu-agent <name>${R}   Create a GPU-enabled agent + register in parent dashboard    nemoclaw <name> connect          Shell into a running sandbox
    ${B}nemoclaw <name> resume${R}           Ensure gateway is running + forward port 18789
    nemoclaw <name> status           Sandbox health + NIM status
    nemoclaw <name> logs ${D}[--follow]${R}  Stream sandbox logs
    nemoclaw <name> destroy          Stop NIM + delete sandbox ${D}(--yes to skip prompt)${R}

  ${G}Data & Filesystem:${R}
    nemoclaw <name> mount ${D}[path]${R}     Mount sandbox data via SSHFS
    nemoclaw <name> unmount ${D}[path]${R}   Unmount sandbox data
    nemoclaw <name> backup           Back up all sandbox data locally
    nemoclaw <name> restore ${D}[ts]${R}     Restore from a backup ${D}(latest if no timestamp)${R}
    ${B}nemoclaw resume ${D}[name]${R}            Resume sandbox after reboot ${D}(backup + restore + mount)${R}

  ${G}Policy Presets:${R}
    nemoclaw <name> policy-add       Add a network or filesystem policy preset
    nemoclaw <name> policy-list      List presets ${D}(● = applied)${R}

  ${G}Deploy:${R}
    nemoclaw deploy <instance>       Deploy to a Brev VM and start services

  ${G}Services:${R}
    nemoclaw start                   Start auxiliary services ${D}(Telegram, tunnel)${R}
    nemoclaw stop                    Stop all services
    nemoclaw status                  Show sandbox list and service status

  Troubleshooting:
    nemoclaw debug [--quick]         Collect diagnostics for bug reports
    nemoclaw debug --output FILE     Save diagnostics tarball for GitHub issues

  Cleanup:
    nemoclaw uninstall [flags]       Run uninstall.sh (local first, curl fallback)

  ${G}Uninstall flags:${R}
    --yes                            Skip the confirmation prompt
    --keep-openshell                 Leave the openshell binary installed
    --delete-models                  Remove NemoClaw-pulled Ollama models

  ${D}Powered by NVIDIA OpenShell · Nemotron · Agent Toolkit
  Credentials saved in ~/.nemoclaw/credentials.json (mode 600)${R}
  ${D}https://www.nvidia.com/nemoclaw${R}
`);
}

// ── Dispatch ─────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

(async () => {
  // No command → help
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help();
    return;
  }

  // Global commands
  if (GLOBAL_COMMANDS.has(cmd)) {
    switch (cmd) {
      case "onboard":       await onboard(args); break;
      case "sandbox-init":  await sandboxInitCmd(args); break;
      case "add-gpu-agent": await addGpuAgentCmd(args); break;
      case "setup":         await setup(); break;
      case "setup-spark": await setupSpark(); break;
      case "deploy":      await deploy(args[0]); break;
      case "start":       await start(); break;
      case "stop":        stop(); break;
      case "status":      showStatus(); break;
      case "debug":       debug(args); break;
      case "uninstall":   uninstall(args); break;
      case "resume":      resume(args); break;
      case "list":        listSandboxes(); break;
      case "--version":
      case "-v": {
        const pkg = require(path.join(__dirname, "..", "package.json"));
        console.log(`nemoclaw v${pkg.version}`);
        break;
      }
      default:            help(); break;
    }
    return;
  }

  // Sandbox-scoped commands: nemoclaw <name> <action>
  const sandbox = registry.getSandbox(cmd);
  if (sandbox) {
    validateName(cmd, "sandbox name");
    const action = args[0] || "connect";
    const actionArgs = args.slice(1);

    switch (action) {
      case "connect":     sandboxConnect(cmd); break;
      case "resume":      sandboxResume(cmd); break;
      case "status":      sandboxStatus(cmd); break;
      case "logs":        sandboxLogs(cmd, actionArgs.includes("--follow")); break;
      case "policy-add":  await sandboxPolicyAdd(cmd); break;
      case "policy-list": sandboxPolicyList(cmd); break;
      case "mount":       sandboxMount(cmd, actionArgs); break;
      case "unmount":     sandboxUnmount(cmd, actionArgs); break;
      case "backup":      sandboxBackup(cmd); break;
      case "restore":     sandboxRestore(cmd, actionArgs); break;
      case "destroy":     await sandboxDestroy(cmd, actionArgs); break;
      default:
        console.error(`  Unknown action: ${action}`);
        console.error(`  Valid actions: connect, resume, status, logs, mount, unmount, backup, restore, policy-add, policy-list, destroy`);
        process.exit(1);
    }
    return;
  }

  // Unknown command — suggest
  console.error(`  Unknown command: ${cmd}`);
  console.error("");

  // Check if it looks like a sandbox name with missing action
  const allNames = registry.listSandboxes().sandboxes.map((s) => s.name);
  if (allNames.length > 0) {
    console.error(`  Registered sandboxes: ${allNames.join(", ")}`);
    console.error(`  Try: nemoclaw <sandbox-name> connect`);
    console.error("");
  }

  console.error(`  Run 'nemoclaw help' for usage.`);
  process.exit(1);
})();
