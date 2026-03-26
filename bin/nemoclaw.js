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

const { ROOT, SCRIPTS, run, runCapture: _runCapture, runInteractive, shellQuote, validateName } = require("./lib/runner");
const { resolveOpenshell } = require("./lib/resolve-openshell");
const { startGatewayForRecovery } = require("./lib/onboard");
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

// ── Global commands ──────────────────────────────────────────────

const GLOBAL_COMMANDS = new Set([
  "onboard", "list", "deploy", "setup", "setup-spark",
  "start", "stop", "status", "debug", "uninstall",
  "help", "--help", "-h", "--version", "-v",
]);

const REMOTE_UNINSTALL_URL = "https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh";
let OPENSHELL_BIN = null;

function getOpenshellBinary() {
  if (!OPENSHELL_BIN) {
    OPENSHELL_BIN = resolveOpenshell();
  }
  if (!OPENSHELL_BIN) {
    console.error("openshell CLI not found. Install OpenShell before using sandbox commands.");
    process.exit(1);
  }
  return OPENSHELL_BIN;
}

function runOpenshell(args, opts = {}) {
  const result = spawnSync(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    encoding: "utf-8",
    stdio: opts.stdio ?? "inherit",
  });
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(`  Command failed (exit ${result.status}): openshell ${args.join(" ")}`);
    process.exit(result.status || 1);
  }
  return result;
}

function captureOpenshell(args, opts = {}) {
  const result = spawnSync(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout || ""}${opts.ignoreError ? "" : result.stderr || ""}`.trim(),
  };
}

function stripAnsi(value = "") {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/\x1b\[[0-9;]*m/g, "");
}

function hasNamedGateway(output = "") {
  return stripAnsi(output).includes("Gateway: nemoclaw");
}

function getActiveGatewayName(output = "") {
  const match = stripAnsi(output).match(/^\s*Gateway:\s+(.+?)\s*$/m);
  return match ? match[1].trim() : "";
}

function getNamedGatewayLifecycleState() {
  const status = captureOpenshell(["status"]);
  const gatewayInfo = captureOpenshell(["gateway", "info", "-g", "nemoclaw"]);
  const cleanStatus = stripAnsi(status.output);
  const activeGateway = getActiveGatewayName(status.output);
  const connected = /Connected/i.test(cleanStatus);
  const named = hasNamedGateway(gatewayInfo.output);
  const refusing = /Connection refused|client error \(Connect\)|tcp connect error/i.test(cleanStatus);
  if (connected && activeGateway === "nemoclaw" && named) {
    return { state: "healthy_named", status: status.output, gatewayInfo: gatewayInfo.output };
  }
  if (activeGateway === "nemoclaw" && named && refusing) {
    return { state: "named_unreachable", status: status.output, gatewayInfo: gatewayInfo.output };
  }
  if (activeGateway === "nemoclaw" && named) {
    return { state: "named_unhealthy", status: status.output, gatewayInfo: gatewayInfo.output };
  }
  if (connected) {
    return { state: "connected_other", status: status.output, gatewayInfo: gatewayInfo.output };
  }
  return { state: "missing_named", status: status.output, gatewayInfo: gatewayInfo.output };
}

async function recoverNamedGatewayRuntime() {
  const before = getNamedGatewayLifecycleState();
  if (before.state === "healthy_named") {
    return { recovered: true, before, after: before, attempted: false };
  }

  runOpenshell(["gateway", "select", "nemoclaw"], { ignoreError: true });
  let after = getNamedGatewayLifecycleState();
  if (after.state === "healthy_named") {
    process.env.OPENSHELL_GATEWAY = "nemoclaw";
    return { recovered: true, before, after, attempted: true, via: "select" };
  }

  const shouldStartGateway = [before.state, after.state].some((state) =>
    ["named_unhealthy", "named_unreachable", "connected_other"].includes(state)
  );

  if (shouldStartGateway) {
    try {
      await startGatewayForRecovery();
    } catch {
      // Fall through to the lifecycle re-check below so we preserve the
      // existing recovery result shape and emit the correct classification.
    }
    runOpenshell(["gateway", "select", "nemoclaw"], { ignoreError: true });
    after = getNamedGatewayLifecycleState();
    if (after.state === "healthy_named") {
      process.env.OPENSHELL_GATEWAY = "nemoclaw";
      return { recovered: true, before, after, attempted: true, via: "start" };
    }
  }

  return { recovered: false, before, after, attempted: true };
}

function getSandboxGatewayState(sandboxName) {
  const result = captureOpenshell(["sandbox", "get", sandboxName]);
  const output = result.output;
  if (result.status === 0) {
    return { state: "present", output };
  }
  if (/NotFound|sandbox not found/i.test(output)) {
    return { state: "missing", output };
  }
  if (/transport error|Connection refused|handshake verification failed|Missing gateway auth token|device identity required/i.test(output)) {
    return { state: "gateway_error", output };
  }
  return { state: "unknown_error", output };
}

function printGatewayLifecycleHint(output = "", sandboxName = "", writer = console.error) {
  const cleanOutput = stripAnsi(output);
  if (/No gateway configured/i.test(cleanOutput)) {
    writer("  The selected NemoClaw gateway is no longer configured or its metadata/runtime has been lost.");
    writer("  Start the gateway again with `openshell gateway start --name nemoclaw` before expecting existing sandboxes to reconnect.");
    writer("  If the gateway has to be rebuilt from scratch, recreate the affected sandbox afterward.");
    return;
  }
  if (/Connection refused|client error \(Connect\)|tcp connect error/i.test(cleanOutput) && /Gateway:\s+nemoclaw/i.test(cleanOutput)) {
    writer("  The selected NemoClaw gateway exists in metadata, but its API is refusing connections after restart.");
    writer("  This usually means the gateway runtime did not come back cleanly after the restart.");
    writer("  Retry `openshell gateway start --name nemoclaw`; if it stays in this state, rebuild the gateway before expecting existing sandboxes to reconnect.");
    return;
  }
  if (/handshake verification failed/i.test(cleanOutput)) {
    writer("  This looks like gateway identity drift after restart.");
    writer("  Existing sandboxes may still be recorded locally, but the current gateway no longer trusts their prior connection state.");
    writer("  Try re-establishing the NemoClaw gateway/runtime first. If the sandbox is still unreachable, recreate just that sandbox with `nemoclaw onboard`.");
    return;
  }
  if (/Connection refused|transport error/i.test(cleanOutput)) {
    writer(`  The sandbox '${sandboxName}' may still exist, but the current gateway/runtime is not reachable.`);
    writer("  Check `openshell status`, verify the active gateway, and retry.");
    return;
  }
  if (/Missing gateway auth token|device identity required/i.test(cleanOutput)) {
    writer("  The gateway is reachable, but the current auth or device identity state is not usable.");
    writer("  Verify the active gateway and retry after re-establishing the runtime.");
  }
}

async function getReconciledSandboxGatewayState(sandboxName) {
  let lookup = getSandboxGatewayState(sandboxName);
  if (lookup.state === "present") {
    return lookup;
  }
  if (lookup.state === "missing") {
    return lookup;
  }

  if (lookup.state === "gateway_error") {
    const recovery = await recoverNamedGatewayRuntime();
    if (recovery.recovered) {
      const retried = getSandboxGatewayState(sandboxName);
      if (retried.state === "present" || retried.state === "missing") {
        return { ...retried, recoveredGateway: true, recoveryVia: recovery.via || null };
      }
      if (/handshake verification failed/i.test(retried.output)) {
        return {
          state: "identity_drift",
          output: retried.output,
          recoveredGateway: true,
          recoveryVia: recovery.via || null,
        };
      }
      return { ...retried, recoveredGateway: true, recoveryVia: recovery.via || null };
    }
    const latestLifecycle = getNamedGatewayLifecycleState();
    const latestStatus = stripAnsi(latestLifecycle.status || "");
    if (/No gateway configured/i.test(latestStatus)) {
      return {
        state: "gateway_missing_after_restart",
        output: latestLifecycle.status || lookup.output,
      };
    }
    if (/Connection refused|client error \(Connect\)|tcp connect error/i.test(latestStatus) && /Gateway:\s+nemoclaw/i.test(latestStatus)) {
      return {
        state: "gateway_unreachable_after_restart",
        output: latestLifecycle.status || lookup.output,
      };
    }
    if (recovery.after?.state === "named_unreachable" || recovery.before?.state === "named_unreachable") {
      return {
        state: "gateway_unreachable_after_restart",
        output: recovery.after?.status || recovery.before?.status || lookup.output,
      };
    }
    return { ...lookup, gatewayRecoveryFailed: true };
  }

  return lookup;
}

async function ensureLiveSandboxOrExit(sandboxName) {
  const lookup = await getReconciledSandboxGatewayState(sandboxName);
  if (lookup.state === "present") {
    return lookup;
  }
  if (lookup.state === "missing") {
    registry.removeSandbox(sandboxName);
    console.error(`  Sandbox '${sandboxName}' is not present in the live OpenShell gateway.`);
    console.error("  Removed stale local registry entry.");
    console.error("  Run `nemoclaw list` to confirm the remaining sandboxes, or `nemoclaw onboard` to create a new one.");
    process.exit(1);
  }
  if (lookup.state === "identity_drift") {
    console.error(`  Sandbox '${sandboxName}' is recorded locally, but the gateway trust material rotated after restart.`);
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error("  Existing sandbox connections cannot be reattached safely after this gateway identity change.");
    console.error("  Recreate this sandbox with `nemoclaw onboard` once the gateway runtime is stable.");
    process.exit(1);
  }
  if (lookup.state === "gateway_unreachable_after_restart") {
    console.error(`  Sandbox '${sandboxName}' may still exist, but the selected NemoClaw gateway is still refusing connections after restart.`);
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error("  Retry `openshell gateway start --name nemoclaw` and verify `openshell status` is healthy before reconnecting.");
    console.error("  If the gateway never becomes healthy, rebuild the gateway and then recreate the affected sandbox.");
    process.exit(1);
  }
  if (lookup.state === "gateway_missing_after_restart") {
    console.error(`  Sandbox '${sandboxName}' may still exist locally, but the NemoClaw gateway is no longer configured after restart/rebuild.`);
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error("  Start the gateway again with `openshell gateway start --name nemoclaw` before retrying.");
    console.error("  If the gateway had to be rebuilt from scratch, recreate the affected sandbox afterward.");
    process.exit(1);
  }
  console.error(`  Unable to verify sandbox '${sandboxName}' against the live OpenShell gateway.`);
  if (lookup.output) {
    console.error(lookup.output);
  }
  printGatewayLifecycleHint(lookup.output, sandboxName);
  console.error("  Check `openshell status` and the active gateway, then retry.");
  process.exit(1);
}

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
  run(`rsync -az --delete --exclude node_modules --exclude .git --exclude src -e "ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR" "${ROOT}/scripts" "${ROOT}/Dockerfile" "${ROOT}/nemoclaw" "${ROOT}/nemoclaw-blueprint" "${ROOT}/bin" "${ROOT}/package.json" ${qname}:/home/ubuntu/nemoclaw/`);

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

async function sandboxConnect(sandboxName) {
  await ensureLiveSandboxOrExit(sandboxName);
  // Ensure port forward is alive before connecting
  runOpenshell(["forward", "start", "--background", "18789", sandboxName], { ignoreError: true });
  const result = spawnSync(getOpenshellBinary(), ["sandbox", "connect", sandboxName], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });
  exitWithSpawnResult(result);
}

async function sandboxStatus(sandboxName) {
  const sb = registry.getSandbox(sandboxName);
  const live = parseGatewayInference(
    captureOpenshell(["inference", "get"], { ignoreError: true }).output
  );
  if (sb) {
    console.log("");
    console.log(`  Sandbox: ${sb.name}`);
    console.log(`    Model:    ${(live && live.model) || sb.model || "unknown"}`);
    console.log(`    Provider: ${(live && live.provider) || sb.provider || "unknown"}`);
    console.log(`    GPU:      ${sb.gpuEnabled ? "yes" : "no"}`);
    console.log(`    Policies: ${(sb.policies || []).join(", ") || "none"}`);
  }

  const lookup = await getReconciledSandboxGatewayState(sandboxName);
  if (lookup.state === "present") {
    console.log("");
    if (lookup.recoveredGateway) {
      console.log(`  Recovered NemoClaw gateway runtime via ${lookup.recoveryVia || "gateway reattach"}.`);
      console.log("");
    }
    console.log(lookup.output);
  } else if (lookup.state === "missing") {
    registry.removeSandbox(sandboxName);
    console.log("");
    console.log(`  Sandbox '${sandboxName}' is not present in the live OpenShell gateway.`);
    console.log("  Removed stale local registry entry.");
  } else if (lookup.state === "identity_drift") {
    console.log("");
    console.log(`  Sandbox '${sandboxName}' is recorded locally, but the gateway trust material rotated after restart.`);
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log("  Existing sandbox connections cannot be reattached safely after this gateway identity change.");
    console.log("  Recreate this sandbox with `nemoclaw onboard` once the gateway runtime is stable.");
  } else if (lookup.state === "gateway_unreachable_after_restart") {
    console.log("");
    console.log(`  Sandbox '${sandboxName}' may still exist, but the selected NemoClaw gateway is still refusing connections after restart.`);
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log("  Retry `openshell gateway start --name nemoclaw` and verify `openshell status` is healthy before reconnecting.");
    console.log("  If the gateway never becomes healthy, rebuild the gateway and then recreate the affected sandbox.");
  } else if (lookup.state === "gateway_missing_after_restart") {
    console.log("");
    console.log(`  Sandbox '${sandboxName}' may still exist locally, but the NemoClaw gateway is no longer configured after restart/rebuild.`);
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log("  Start the gateway again with `openshell gateway start --name nemoclaw` before retrying.");
    console.log("  If the gateway had to be rebuilt from scratch, recreate the affected sandbox afterward.");
  } else {
    console.log("");
    console.log(`  Could not verify sandbox '${sandboxName}' against the live OpenShell gateway.`);
    if (lookup.output) {
      console.log(lookup.output);
    }
    printGatewayLifecycleHint(lookup.output, sandboxName, console.log);
  }

  // NIM health
  const nimStat = sb && sb.nimContainer ? nim.nimStatusByName(sb.nimContainer) : nim.nimStatus(sandboxName);
  console.log(`    NIM:      ${nimStat.running ? `running (${nimStat.container})` : "not running"}`);
  if (nimStat.running) {
    console.log(`    Healthy:  ${nimStat.healthy ? "yes" : "no"}`);
  }
  console.log("");
}

function sandboxLogs(sandboxName, follow) {
  const args = ["logs", sandboxName];
  if (follow) args.push("--follow");
  runOpenshell(args);
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
  runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });

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
    nemoclaw setup-spark             Set up on DGX Spark ${D}(fixes cgroup v2 + Docker)${R}

  ${G}Sandbox Management:${R}
    ${B}nemoclaw list${R}                    List all sandboxes
    nemoclaw <name> connect          Shell into a running sandbox
    nemoclaw <name> status           Sandbox health + NIM status
    nemoclaw <name> logs ${D}[--follow]${R}  Stream sandbox logs
    nemoclaw <name> destroy          Stop NIM + delete sandbox ${D}(--yes to skip prompt)${R}

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
      case "onboard":     await onboard(args); break;
      case "setup":       await setup(); break;
      case "setup-spark": await setupSpark(); break;
      case "deploy":      await deploy(args[0]); break;
      case "start":       await start(); break;
      case "stop":        stop(); break;
      case "status":      showStatus(); break;
      case "debug":       debug(args); break;
      case "uninstall":   uninstall(args); break;
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
      case "connect":     await sandboxConnect(cmd); break;
      case "status":      await sandboxStatus(cmd); break;
      case "logs":        sandboxLogs(cmd, actionArgs.includes("--follow")); break;
      case "policy-add":  await sandboxPolicyAdd(cmd); break;
      case "policy-list": sandboxPolicyList(cmd); break;
      case "destroy":     await sandboxDestroy(cmd, actionArgs); break;
      default:
        console.error(`  Unknown action: ${action}`);
        console.error(`  Valid actions: connect, status, logs, policy-add, policy-list, destroy`);
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
