#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execFileSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const {
  ROOT,
  SCRIPTS,
  run,
  runCapture,
  runInteractive,
  shellQuote,
  validateName,
} = require("./lib/runner");
const {
  ensureApiKey,
  ensureGithubToken,
  getCredential,
  isRepoPrivate,
} = require("./lib/credentials");
const registry = require("./lib/registry");
const nim = require("./lib/nim");
const policies = require("./lib/policies");
const backupStore = require("./lib/sandbox-backup");
const { getInferenceRuntimeStatus } = require("./lib/inference-status");
const { runTelegramProbe } = require("./lib/telegram-diagnostics");
const { runDiscordProbe } = require("./lib/discord-diagnostics");
const {
  createSandbox,
  getDashboardForwardStartCommand,
  getDashboardAccessInfo,
  getDashboardGuidanceLines,
  setupInference,
  syncSandboxInferenceConfig,
  syncSandboxControlUiConfig,
} = require("./lib/onboard");

const { resolveOpenshell } = require("./lib/resolve-openshell");

// Color / style — respects NO_COLOR and non-TTY environments.
// Uses exact NVIDIA green #76B900 on truecolor terminals; 256-color otherwise.
// ---------------------------------------------------------------------------
const _useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const _tc =
  _useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const G = _useColor ? (_tc ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const B = _useColor ? "\x1b[1m" : "";
const D = _useColor ? "\x1b[2m" : "";
const R = _useColor ? "\x1b[0m" : "";
const _RD = _useColor ? "\x1b[1;31m" : "";
// const YW = _useColor ? "\x1b[1;33m" : "";

// ── Global commands ──────────────────────────────────────────────

const GLOBAL_COMMANDS = new Set([
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
  "help",
  "--help",
  "-h",
  "--version",
  "-v",
]);

const REMOTE_UNINSTALL_URL =
  "https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh";
const GATEWAY_NAME = "nemoclaw";

function stripAnsi(value) {
  // eslint-disable-next-line no-control-regex
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function getGatewayClusterContainerName(gatewayName = GATEWAY_NAME) {
  return `openshell-cluster-${gatewayName}`;
}

function isGatewayConnected(statusOutput) {
  return /Status:\s+Connected/i.test(stripAnsi(statusOutput));
}

function hasGatewayConnectFailure(statusOutput) {
  return /(client error \(Connect\)|transport error|tcp connect error|Connection refused|Connection reset by peer)/i.test(
    stripAnsi(statusOutput),
  );
}

function hasSandboxAttachHandshakeFailure(logOutput) {
  return /handshake verification failed/i.test(stripAnsi(logOutput));
}

function getServiceSandboxEnv(listSandboxes = () => registry.listSandboxes()) {
  const { defaultSandbox } = listSandboxes();
  const safeName =
    defaultSandbox && /^[a-zA-Z0-9._-]+$/.test(defaultSandbox) ? defaultSandbox : null;
  return safeName ? `SANDBOX_NAME="${safeName}" ` : "";
}

function isOpenShellSandboxAvailable(name, runCaptureFn = runCapture) {
  if (!name) return false;
  const output = runCaptureFn(`openshell sandbox get ${shellQuote(name)} 2>/dev/null`, {
    ignoreError: true,
  });
  return String(output || "").trim().length > 0;
}

function getStatusSandboxes(_options = {}) {
  const listSandboxesFn = _options.listSandboxes || (() => registry.listSandboxes());
  const runCaptureFn = _options.runCapture || runCapture;
  const { sandboxes, defaultSandbox } = listSandboxesFn();
  return {
    defaultSandbox,
    sandboxes: sandboxes.map((sandbox) => ({
      ...sandbox,
      isLive: isOpenShellSandboxAvailable(sandbox.name, runCaptureFn),
    })),
  };
}

function getStaleSandboxWarningLines() {
  return [
    "[stale] present in the local NemoClaw registry only; OpenShell cannot load it.",
    "        Workspace files such as SOUL.md, USER.md, IDENTITY.md, AGENTS.md, and MEMORY.md are no longer available unless you restored a backup.",
    "        Recreate the sandbox with `nemoclaw onboard` or restore workspace files from backup before continuing.",
  ];
}

function printStaleSandboxWarning(sandboxName, action, _options = {}) {
  const errorFn = _options.error || console.error;
  const lines = [
    `  Sandbox '${sandboxName}' is stale; OpenShell cannot ${action} it.`,
    ...getStaleSandboxWarningLines().map((line) => `  ${line}`),
  ];
  for (const line of lines) {
    errorFn(line);
  }
}

function ensureLiveSandboxForAction(sandboxName, action, _options = {}) {
  const isAvailable =
    _options.isAvailable ??
    isOpenShellSandboxAvailable(sandboxName, _options.runCapture || runCapture);
  if (isAvailable) return true;
  printStaleSandboxWarning(sandboxName, action, _options);
  return false;
}

function resolveUninstallScript() {
  const candidates = [path.join(ROOT, "uninstall.sh"), path.join(__dirname, "..", "uninstall.sh")];

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

function waitForGatewayConnection(attempts = 15, delaySeconds = 2) {
  for (let i = 0; i < attempts; i += 1) {
    const status = runCapture("openshell status 2>&1", { ignoreError: true });
    if (isGatewayConnected(status)) {
      return true;
    }
    spawnSync("sleep", [String(delaySeconds)]);
  }
  return false;
}

function resumeStoppedGateway() {
  const containerName = getGatewayClusterContainerName();
  const containers = runCapture("docker ps -a --format '{{.Names}}\t{{.Status}}'", {
    ignoreError: true,
  });
  const containerLine = containers
    .split("\n")
    .find((line) => line.startsWith(`${containerName}\t`));

  if (!containerLine) {
    return false;
  }

  if (containerLine.includes("\tUp ")) {
    return waitForGatewayConnection();
  }

  if (!/(\tExited|\tCreated|\tDead)/.test(containerLine)) {
    return false;
  }

  const startResult = spawnSync("docker", ["start", containerName], {
    cwd: ROOT,
    env: process.env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (startResult.status !== 0) {
    return false;
  }

  return waitForGatewayConnection();
}

function ensureSandboxGatewayReachable() {
  const status = runCapture("openshell status 2>&1", { ignoreError: true });
  if (isGatewayConnected(status)) {
    return;
  }

  if (hasGatewayConnectFailure(status) && resumeStoppedGateway()) {
    console.log(`  ✓ Resumed OpenShell gateway '${GATEWAY_NAME}'`);
    return;
  }

  console.error("");
  console.error(`  OpenShell gateway '${GATEWAY_NAME}' is not reachable.`);
  console.error("  NemoClaw cannot connect to a sandbox until the local gateway is healthy.");
  console.error("");
  console.error(`  Check:       openshell status`);
  console.error(`  Recover:     docker start ${getGatewayClusterContainerName()}`);
  console.error(`  Fallback:    openshell gateway start --name ${GATEWAY_NAME}`);
  console.error("");
  if (status) {
    console.error("  OpenShell reported:");
    console.error(
      status
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
    );
  }
  process.exit(1);
}

function ensureSandboxGatewayForRestore(options = {}) {
  const errorFn = options.error || console.error;
  const status = runCapture("openshell status 2>&1", { ignoreError: true });
  if (isGatewayConnected(status)) {
    return true;
  }

  if (hasGatewayConnectFailure(status) && resumeStoppedGateway()) {
    console.log(`  ✓ Resumed OpenShell gateway '${GATEWAY_NAME}'`);
    return true;
  }

  const startResult = run(`openshell gateway start --name ${GATEWAY_NAME} 2>&1`, {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (startResult.status === 0 && waitForGatewayConnection()) {
    console.log(`  ✓ Started OpenShell gateway '${GATEWAY_NAME}'`);
    return true;
  }

  const output = [status, startResult.stdout, startResult.stderr].filter(Boolean).join("\n").trim();
  errorFn(`  Could not start OpenShell gateway '${GATEWAY_NAME}' for restore.`);
  if (output) {
    errorFn(
      output
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
    );
  }
  throw new Error(`OpenShell gateway '${GATEWAY_NAME}' is not reachable.`);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function parseBackupActionArgs(args) {
  const parsed = { label: null, list: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--list") {
      parsed.list = true;
      continue;
    }
    if (arg === "--label") {
      const label = args[i + 1];
      if (!label) {
        throw new Error("Missing value for --label.");
      }
      parsed.label = label;
      i += 1;
      continue;
    }
    throw new Error(`Unknown backup option: ${arg}`);
  }
  return parsed;
}

function parseRestoreActionArgs(args) {
  if (args.length > 1) {
    throw new Error("Usage: nemoclaw <name> restore [backup-id]");
  }
  if (args[0] && args[0].startsWith("-")) {
    throw new Error(`Unknown restore option: ${args[0]}`);
  }
  return { backupId: args[0] || null };
}

function hydrateRestoreCredentialEnv(provider) {
  const credentialMap = {
    "nvidia-nim": "NVIDIA_API_KEY",
    "nvidia-prod": "NVIDIA_API_KEY",
  };
  const credentialName = credentialMap[provider];
  if (!credentialName) return;
  const credentialValue = getCredential(credentialName);
  if (credentialValue) {
    process.env[credentialName] = credentialValue;
  }
}

function getRestoreGithubToken() {
  const credentialToken = getCredential("GITHUB_TOKEN") || getCredential("GH_TOKEN");
  if (credentialToken) {
    return credentialToken;
  }
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) {
    return envToken;
  }
  try {
    const ghToken = execFileSync("gh", ["auth", "token"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return ghToken || null;
  } catch {
    return null;
  }
}

function syncSandboxGithubTokenEnv(sandboxName, _options = {}) {
  const logFn = _options.log || console.log;
  const warnFn = _options.warn || console.warn;
  const runFn = _options.run || run;
  const token = _options.githubToken !== undefined ? _options.githubToken : getRestoreGithubToken();
  if (!token) {
    return false;
  }

  const startupSourceLine =
    "[ -f /sandbox/.nemoclaw/agent-env.sh ] && . /sandbox/.nemoclaw/agent-env.sh";
  const script = [
    "set -eu",
    "mkdir -p /sandbox/.nemoclaw",
    "cat > /sandbox/.nemoclaw/agent-env.sh <<'EOF_NEMO_GH_TOKEN'",
    `export GH_TOKEN=${shellQuote(token)}`,
    `export GITHUB_TOKEN=${shellQuote(token)}`,
    "EOF_NEMO_GH_TOKEN",
    "chmod 600 /sandbox/.nemoclaw/agent-env.sh",
    "for rc in ~/.bashrc ~/.profile; do",
    '  [ -f "$rc" ] || touch "$rc"',
    `  grep -qF ${shellQuote(startupSourceLine)} "$rc" || printf '\\n${startupSourceLine}\\n' >> "$rc"`,
    "done",
    ". /sandbox/.nemoclaw/agent-env.sh",
    "exit",
  ].join("\n");

  const result = runFn(
    `cat <<'EOF_NEMO_GH_SYNC' | openshell sandbox connect ${shellQuote(sandboxName)}\n${script}\nEOF_NEMO_GH_SYNC`,
    {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    },
  );

  if (result.status === 0) {
    logFn("  ✓ Synced GitHub token into sandbox environment");
    return true;
  }

  warnFn("  Could not sync GitHub token into sandbox environment automatically.");
  return false;
}

async function configureSandboxFromBackupManifest(sandboxName, manifest, _options = {}) {
  const syncGithubTokenEnvFn = _options.syncGithubTokenEnv || syncSandboxGithubTokenEnv;
  syncGithubTokenEnvFn(sandboxName, _options);

  const currentEntry = registry.getSandbox(sandboxName) || {};
  const manifestEntry = (manifest && manifest.registry) || {};
  const registryEntry = {
    ...currentEntry,
    ...manifestEntry,
    model: manifestEntry.model || currentEntry.model || null,
    provider: manifestEntry.provider || currentEntry.provider || null,
    providerBaseUrl: manifestEntry.providerBaseUrl || currentEntry.providerBaseUrl || null,
  };
  if (!registryEntry.provider && !registryEntry.model && !(registryEntry.policies || []).length)
    return;

  await configureSandboxProviderAndModel(sandboxName, registryEntry);
  configureSandboxPolicies(sandboxName, registryEntry);
  updateOrRegisterSandbox(sandboxName, registryEntry);
}

async function configureSandboxProviderAndModel(sandboxName, registryEntry) {
  if (registryEntry.provider && registryEntry.model) {
    hydrateRestoreCredentialEnv(registryEntry.provider);
    const { modelMetadata } = await setupInference(
      sandboxName,
      registryEntry.model,
      registryEntry.provider,
      {
        allowWarmupFailure: true,
        providerBaseUrl: registryEntry.providerBaseUrl || null,
      },
    );
    await syncSandboxInferenceConfig(sandboxName, registryEntry.model, registryEntry.provider, {
      modelMetadata,
      providerBaseUrl: registryEntry.providerBaseUrl || null,
    });
  }
}

function configureSandboxPolicies(sandboxName, registryEntry) {
  for (const presetName of registryEntry.policies || []) {
    policies.applyPreset(sandboxName, presetName);
  }
}

function updateOrRegisterSandbox(sandboxName, registryEntry) {
  const updatedEntry = registry.getSandbox(sandboxName);
  const mergedEntry = {
    ...(updatedEntry || {}),
    ...(registryEntry || {}),
    name: sandboxName,
    createdAt: (updatedEntry && updatedEntry.createdAt) || registryEntry.createdAt,
  };
  if (updatedEntry) {
    registry.updateSandbox(sandboxName, mergedEntry);
  } else {
    registry.registerSandbox(mergedEntry);
  }
}

function printSandboxBackups(sandboxName, listBackupsFn = backupStore.listBackups) {
  const backups = listBackupsFn(sandboxName);
  console.log("");
  if (backups.length === 0) {
    console.log(`  No backups found for sandbox '${sandboxName}'.`);
    console.log("");
    return backups;
  }

  console.log(`  Backups for sandbox '${sandboxName}':`);
  for (const backup of backups) {
    const date = backup.createdAt
      ? backup.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z")
      : "unknown";
    console.log(`    ${backup.id.padEnd(24)}${date}  ${formatBytes(backup.sizeBytes)}`);
  }
  console.log("");
  return backups;
}

function sandboxBackup(sandboxName, actionArgs = [], options = {}) {
  const errorFn = options.error || console.error;
  const exitFn = options.exit === undefined ? process.exit : options.exit;
  const createBackupFn = options.createBackup || backupStore.createBackup;
  const listBackupsFn = options.listBackups || backupStore.listBackups;

  try {
    const parsed = parseBackupActionArgs(actionArgs);
    if (parsed.list) {
      return printSandboxBackups(sandboxName, listBackupsFn);
    }

    if (!ensureLiveSandboxForAction(sandboxName, "back up", options)) {
      if (exitFn) {
        exitFn(1);
      }
      return false;
    }

    console.log("");
    console.log(`  Creating backup for sandbox '${sandboxName}'...`);
    const result = createBackupFn(sandboxName, { label: parsed.label });
    console.log(`  ✓ Backup saved to ${result.backupDir}`);
    console.log(
      `  Archive: ${path.basename(result.archivePath)} (${formatBytes(result.sizeBytes)})`,
    );
    console.log("");
    return result;
  } catch (error) {
    errorFn(`  ${error.message}`);
    if (exitFn) {
      exitFn(1);
    }
    return false;
  }
}

async function sandboxRestore(sandboxName, actionArgs = [], _options = {}) {
  const errorFn = _options.error || console.error;
  const exitFn = _options.exit === undefined ? process.exit : _options.exit;
  const promptFn = _options.prompt || require("./lib/credentials").prompt;
  const resolveBackupFn = _options.resolveBackup || backupStore.resolveBackup;
  const restoreBackupFn = _options.restoreBackup || backupStore.restoreBackup;
  const createSandboxFn = _options.createSandbox || createSandbox;
  const configureSandboxFn = _options.configureSandbox || configureSandboxFromBackupManifest;
  const ensureGatewayFn = _options.ensureGateway || ensureSandboxGatewayForRestore;

  try {
    const parsed = parseRestoreActionArgs(actionArgs);
    const selectedBackup = resolveBackupFn(sandboxName, parsed.backupId);
    const manifest = selectedBackup.manifest || backupStore.readManifest(selectedBackup.path);
    const isLive =
      _options.isAvailable ??
      isOpenShellSandboxAvailable(sandboxName, _options.runCapture || runCapture);

    if (isLive) {
      if (!(await confirmRestoreOverwrite(promptFn, sandboxName, selectedBackup.id))) {
        return false;
      }
    } else {
      await _restoreCreateSandbox(
        ensureGatewayFn,
        createSandboxFn,
        manifest,
        sandboxName,
        selectedBackup.id,
      );
    }

    await _restoreBackupAndConfigure(
      restoreBackupFn,
      configureSandboxFn,
      sandboxName,
      selectedBackup,
      manifest,
    );
    return { sandboxName, backupId: selectedBackup.id, recreated: !isLive };
  } catch (error) {
    errorFn(`  ${error.message}`);
    if (exitFn) {
      exitFn(1);
    }
    return false;
  }
}

async function _restoreCreateSandbox(
  ensureGatewayFn,
  createSandboxFn,
  manifest,
  sandboxName,
  backupId,
) {
  ensureGatewayFn();
  console.log("");
  console.log(`  Recreating sandbox '${sandboxName}' from backup '${backupId}'...`);
  await createSandboxFn(
    Boolean(manifest && manifest.registry && manifest.registry.gpuEnabled),
    null,
    null,
    null,
    sandboxName,
  );
}

async function _restoreBackupAndConfigure(
  restoreBackupFn,
  configureSandboxFn,
  sandboxName,
  selectedBackup,
  manifest,
) {
  console.log(`  Restoring backup '${selectedBackup.id}' into sandbox '${sandboxName}'...`);
  restoreBackupFn(sandboxName, selectedBackup.path);
  await configureSandboxFn(sandboxName, manifest || {}, { backupDir: selectedBackup.path });
  console.log(`  ✓ Restored backup '${selectedBackup.id}' into sandbox '${sandboxName}'`);
  console.log("");
}

async function confirmRestoreOverwrite(promptFn, sandboxName, backupId) {
  console.log("");
  console.log(`  Restore will overwrite files inside sandbox '${sandboxName}'.`);
  const confirm = await promptFn(`  Type RESTORE to continue restoring '${backupId}': `);
  if (confirm !== "RESTORE") {
    console.log("  Cancelled.");
    console.log("");
    return false;
  }
  return true;
}

function explainSandboxConnectFailure(sandboxName, result) {
  const recentLogs = runCapture(`openshell logs "${sandboxName}" 2>&1 | tail -n 80`, {
    ignoreError: true,
  });

  if (hasSandboxAttachHandshakeFailure(recentLogs)) {
    console.error("");
    console.error(
      `  OpenShell reached sandbox '${sandboxName}', but the shell attach handshake was rejected.`,
    );
    console.error(
      "  This usually happens when an older sandbox is reused after the gateway session changed.",
    );
    console.error("");
    console.error(`  Workaround:  openshell sandbox connect --editor vscode "${sandboxName}"`);
    console.error("  Recovery:    nemoclaw onboard");
    console.error(
      `               Then choose 'y' if prompted to recreate sandbox '${sandboxName}'.`,
    );
    exitWithSpawnResult(result);
  }

  console.error(
    `  Command failed (exit ${result.status}): openshell sandbox connect "${sandboxName}"`,
  );
  exitWithSpawnResult(result);
}

// ── Commands ─────────────────────────────────────────────────────

async function onboard(args) {
  const { onboard: runOnboard } = require("./lib/onboard");
  const allowedArgs = new Set(["--non-interactive", "--resume"]);
  const unknownArgs = args.filter((arg) => !allowedArgs.has(arg));
  if (unknownArgs.length > 0) {
    console.error(`  Unknown onboard option(s): ${unknownArgs.join(", ")}`);
    console.error("  Usage: nemoclaw onboard [--non-interactive] [--resume]");
    process.exit(1);
  }
  const nonInteractive = args.includes("--non-interactive");
  const resume = args.includes("--resume");
  await runOnboard({ nonInteractive, resume });
}

async function setup() {
  console.log("");
  console.log("  ⚠  `nemoclaw setup` is deprecated. Use `nemoclaw onboard` instead.");
  console.log("     Running legacy setup.sh for backwards compatibility...");
  console.log("");
  await ensureApiKey();
  const { defaultSandbox } = registry.listSandboxes();
  const safeName =
    defaultSandbox && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(defaultSandbox) ? defaultSandbox : "";
  run(`bash "${SCRIPTS}/setup.sh" ${shellQuote(safeName)}`);
}

async function setupSpark() {
  await ensureApiKey();
  run(`sudo -E bash "${SCRIPTS}/setup-spark.sh"`);
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
    const brevResult = spawnSync("brev", ["ls"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    exists = (brevResult.stdout || "").includes(name);
  } catch {
    // Ignore lookup failure and continue as if the instance does not exist.
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
      execFileSync(
        "ssh",
        ["-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", name, "echo ok"],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      );
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
  run(
    `ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'mkdir -p /home/ubuntu/nemoclaw'`,
  );
  run(
    `rsync -az --delete --exclude node_modules --exclude .git --exclude src -e "ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR" "${ROOT}/scripts" "${ROOT}/Dockerfile" "${ROOT}/nemoclaw" "${ROOT}/nemoclaw-blueprint" "${ROOT}/bin" "${ROOT}/package.json" ${qname}:/home/ubuntu/nemoclaw/`,
  );

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
    run(
      `scp -q -o StrictHostKeyChecking=no -o LogLevel=ERROR ${shellQuote(envTmp)} ${qname}:/home/ubuntu/nemoclaw/.env`,
    );
    run(
      `ssh -q -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'chmod 600 /home/ubuntu/nemoclaw/.env'`,
    );
  } finally {
    try {
      fs.unlinkSync(envTmp);
    } catch {
      /* ignored */
    }
    try {
      fs.rmdirSync(envDir);
    } catch {
      /* ignored */
    }
  }

  console.log("  Running setup...");
  runInteractive(
    `ssh -t -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && bash scripts/brev-setup.sh'`,
  );

  if (tgToken || discordToken) {
    console.log("  Starting services...");
    run(
      `ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && bash scripts/start-services.sh'`,
    );
  }

  console.log("");
  console.log("  Connecting to sandbox...");
  console.log("");
  runInteractive(
    `ssh -t -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && openshell sandbox connect nemoclaw'`,
  );
}

async function start() {
  await ensureApiKey();
  const sandboxEnv = getServiceSandboxEnv();
  run(`${sandboxEnv}bash "${SCRIPTS}/start-services.sh"`);
}

function stop() {
  const sandboxEnv = getServiceSandboxEnv();
  run(`${sandboxEnv}bash "${SCRIPTS}/start-services.sh" --stop`);
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
  const command =
    forwardedArgs.length > 0
      ? `curl -fsSL ${shellQuote(REMOTE_UNINSTALL_URL)} | bash -s -- ${forwardedArgs}`
      : `curl -fsSL ${shellQuote(REMOTE_UNINSTALL_URL)} | bash`;
  const result = spawnSync("bash", ["-c", command], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });
  exitWithSpawnResult(result);
}

function showStatus(_options = {}) {
  const runFn = _options.run || run;
  // Show sandbox registry
  const { sandboxes, defaultSandbox } = getStatusSandboxes(_options);
  if (sandboxes.length > 0) {
    console.log("");
    console.log("  Sandboxes:");
    for (const sb of sandboxes) {
      const def = sb.name === defaultSandbox ? " *" : "";
      const model = sb.model ? ` (${sb.model})` : "";
      const stale = sb.isLive ? "" : " [stale]";
      console.log(`    ${sb.name}${def}${model}${stale}`);
    }
    if (sandboxes.some((sb) => !sb.isLive)) {
      for (const line of getStaleSandboxWarningLines()) {
        console.log(`    ${line}`);
      }
    }
    console.log("");
  }

  // Show service status
  const liveSandboxes = sandboxes.filter((sandbox) => sandbox.isLive);
  const liveDefaultSandbox = liveSandboxes.some((sandbox) => sandbox.name === defaultSandbox)
    ? defaultSandbox
    : liveSandboxes[0]?.name || null;
  const sandboxEnv = getServiceSandboxEnv(() => ({
    sandboxes: liveSandboxes,
    defaultSandbox: liveDefaultSandbox,
  }));
  runFn(`${sandboxEnv}bash "${SCRIPTS}/start-services.sh" --status`);
}

function listSandboxes() {
  const { sandboxes, defaultSandbox } = getStatusSandboxes();
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
    const stale = sb.isLive ? "" : " [stale]";
    const model = sb.model || "unknown";
    const provider = sb.provider || "unknown";
    const gpu = sb.gpuEnabled ? "GPU" : "CPU";
    const presets = sb.policies && sb.policies.length > 0 ? sb.policies.join(", ") : "none";
    console.log(`    ${sb.name}${def}${stale}`);
    console.log(`      model: ${model}  provider: ${provider}  ${gpu}  policies: ${presets}`);
  }
  if (sandboxes.some((sb) => !sb.isLive)) {
    console.log("");
    for (const line of getStaleSandboxWarningLines()) {
      console.log(`  ${line}`);
    }
  }
  console.log("");
  console.log("  * = default sandbox");
  console.log("");
}

// ── Sandbox-scoped actions ───────────────────────────────────────

async function getReconciledSandboxGatewayState(sandboxName) {
  const openshellPath = resolveOpenshell() || "openshell";
  const getResult = run(`${openshellPath} sandbox get ${shellQuote(sandboxName)} 2>&1`, {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  const getOutput = (getResult.stdout || getResult.stderr || "").toString();

  if (getResult.status === 0) {
    return { state: "present", output: getOutput.trim() };
  }

  if (!getOutput.trim()) {
    return { state: "unknown", output: "Command produced no output" };
  }

  // Split out recovery logic for complexity
  async function _recoverGateway(openshellPath, sandboxName, recoveryType) {
    run(`${openshellPath} gateway select ${GATEWAY_NAME} 2>&1`, {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    const selectResult = run(`${openshellPath} status 2>&1`, {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    const selectOutput = (selectResult.stdout || selectResult.stderr || "").toString();
    if (selectResult.status === 0 && isGatewayConnected(selectOutput)) {
      const retryResult = run(`${openshellPath} sandbox get ${shellQuote(sandboxName)} 2>&1`, {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
      const retryOutput = (retryResult.stdout || retryResult.stderr || "").toString();
      if (retryResult.status === 0) {
        return {
          state: "present",
          output: retryOutput.trim(),
          recoveredGateway: true,
          recoveryVia: recoveryType,
        };
      }
    }
    run(`${openshellPath} gateway start --name ${GATEWAY_NAME} 2>&1`, {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    run(`${openshellPath} gateway select ${GATEWAY_NAME} 2>&1`, {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const retryResult = run(`${openshellPath} sandbox get ${shellQuote(sandboxName)} 2>&1`, {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    const retryOutput = (retryResult.stdout || retryResult.stderr || "").toString();
    if (retryResult.status === 0) {
      return {
        state: "present",
        output: retryOutput.trim(),
        recoveredGateway: true,
        recoveryVia: "start",
      };
    }
    return null;
  }

  if (/No active gateway/i.test(getOutput.toString())) {
    const recovered = await _recoverGateway(openshellPath, sandboxName, "select");
    if (recovered) return recovered;
  }

  if (
    /transport error|tcp connect error|Connection refused|Connection reset by peer/i.test(
      getOutput.toString(),
    )
  ) {
    const recovered = await _recoverGateway(openshellPath, sandboxName, "select");
    if (recovered) return recovered;
    return { state: "gateway_unreachable_after_restart", output: getOutput.trim() };
  }

  if (/not found|does not exist/i.test(getOutput.toString())) {
    return { state: "missing", output: getOutput.trim() };
  }

  return { state: "unknown", output: getOutput.trim() };
}

function printGatewayLifecycleHint(output, _sandboxName, logFn) {
  // Print helpful hints based on error messages
  if (/Connection refused|Connection reset|transport error/i.test(output)) {
    logFn("  Hint: The gateway may need to be restarted or is unhealthy.");
    logFn(`  Try: openshell gateway start --name ${GATEWAY_NAME}`);
  }
}

function sandboxConnect(sandboxName) {
  if (!ensureLiveSandboxForAction(sandboxName, "connect to")) {
    process.exit(1);
  }
  ensureSandboxGatewayReachable();
  syncSandboxControlUiConfig(sandboxName);
  // Ensure port forward is alive before connecting
  run(`openshell forward stop 18789 "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });
  run(`${getDashboardForwardStartCommand(sandboxName)} 2>/dev/null || true`, { ignoreError: true });
  const result = runInteractive(`openshell sandbox connect "${sandboxName}"`, {
    ignoreError: true,
  });
  if (result.status !== 0) {
    explainSandboxConnectFailure(sandboxName, result);
  }
}

// eslint-disable-next-line complexity
async function sandboxStatus(sandboxName) {
  const sb = registry.getSandbox(sandboxName);
  const isLive = isOpenShellSandboxAvailable(sandboxName);
  if (sb) {
    console.log("");
    console.log(`  Sandbox: ${sb.name}`);
    console.log(`    Model:    ${sb.model || "unknown"}`);
    console.log(`    Provider: ${sb.provider || "unknown"}`);
    console.log(`    GPU:      ${sb.gpuEnabled ? "yes" : "no"}`);
    console.log(`    Policies: ${(sb.policies || []).join(", ") || "none"}`);
    if (!isLive) {
      for (const line of getStaleSandboxWarningLines()) {
        console.log(`    ${line}`);
      }
    }
  }

  const lookup = await getReconciledSandboxGatewayState(sandboxName);
  if (lookup.state === "present") {
    console.log("");
    if (lookup.recoveredGateway) {
      console.log(
        `  Recovered NemoClaw gateway runtime via ${lookup.recoveryVia || "gateway reattach"}.`,
      );
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
    console.log(
      `  Sandbox '${sandboxName}' is recorded locally, but the gateway trust material rotated after restart.`,
    );
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log(
      "  Existing sandbox connections cannot be reattached safely after this gateway identity change.",
    );
    console.log(
      "  Recreate this sandbox with `nemoclaw onboard` once the gateway runtime is stable.",
    );
  } else if (lookup.state === "gateway_unreachable_after_restart") {
    console.log("");
    console.log(
      `  Sandbox '${sandboxName}' may still exist, but the selected NemoClaw gateway is still refusing connections after restart.`,
    );
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log(
      "  Retry `openshell gateway start --name nemoclaw` and verify `openshell status` is healthy before reconnecting.",
    );
    console.log(
      "  If the gateway never becomes healthy, rebuild the gateway and then recreate the affected sandbox.",
    );
  } else if (lookup.state === "gateway_missing_after_restart") {
    console.log("");
    console.log(
      `  Sandbox '${sandboxName}' may still exist locally, but the NemoClaw gateway is no longer configured after restart/rebuild.`,
    );
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log(
      "  Start the gateway again with `openshell gateway start --name nemoclaw` before retrying.",
    );
    console.log(
      "  If the gateway had to be rebuilt from scratch, recreate the affected sandbox afterward.",
    );
  } else {
    console.log("");
    console.log(`  Could not verify sandbox '${sandboxName}' against the live OpenShell gateway.`);
    if (lookup.output) {
      console.log(lookup.output);
    }
    printGatewayLifecycleHint(lookup.output, sandboxName, console.log);
  }

  const runtimeLines = getInferenceRuntimeStatus(sb || { name: sandboxName }, (name) => {
    const status = nim.nimStatus(name);
    // Always return both properties, never optional
    return {
      running: typeof status.running === "boolean" ? status.running : false,
      healthy: typeof status.healthy === "boolean" ? status.healthy : false,
    };
  });
  for (const line of runtimeLines) {
    console.log(`    ${line.label.padEnd(9)}${line.value}`);
  }
  console.log("");
}

function sandboxLogs(sandboxName, follow) {
  if (!ensureLiveSandboxForAction(sandboxName, "show logs for")) {
    process.exit(1);
  }
  const followFlag = follow ? " --tail" : "";
  run(`openshell logs "${sandboxName}"${followFlag}`);
}

function sandboxTelegramProbe(sandboxName) {
  if (!ensureLiveSandboxForAction(sandboxName, "probe")) {
    process.exit(1);
  }
  ensureSandboxGatewayReachable();
  console.log("");
  console.log(`  Probing Telegram network path inside sandbox '${sandboxName}'...`);
  console.log(
    "  This checks proxy and DNS diagnostics plus a bridge-equivalent Node Bot API probe when TELEGRAM_BOT_TOKEN is available.",
  );
  console.log("");
  exitWithSpawnResult(runTelegramProbe(sandboxName));
}

function sandboxDiscordProbe(sandboxName) {
  if (!ensureLiveSandboxForAction(sandboxName, "probe")) {
    process.exit(1);
  }
  ensureSandboxGatewayReachable();
  console.log("");
  console.log(`  Probing Discord network path inside sandbox '${sandboxName}'...`);
  console.log(
    "  This checks proxy and DNS diagnostics plus a bridge-equivalent Discord Bot API probe when DISCORD_BOT_TOKEN is available.",
  );
  console.log("");
  exitWithSpawnResult(runDiscordProbe(sandboxName));
}

async function sandboxPolicyAdd(sandboxName) {
  if (!ensureLiveSandboxForAction(sandboxName, "update policies for")) {
    process.exit(1);
  }
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
  if (!ensureLiveSandboxForAction(sandboxName, "list policies for")) {
    process.exit(1);
  }
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

function sandboxDashboard(sandboxName) {
  if (!ensureLiveSandboxForAction(sandboxName, "open the dashboard for")) {
    process.exit(1);
  }
  // Ensure dashboard forward is alive before printing links.
  run(`openshell forward stop 18789 "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });
  run(`${getDashboardForwardStartCommand(sandboxName)} 2>/dev/null || true`, { ignoreError: true });

  const dashboardAccess = getDashboardAccessInfo(sandboxName);
  const dashboardGuidance = getDashboardGuidanceLines(dashboardAccess);
  console.log("");
  console.log(`  ${"─".repeat(50)}`);
  for (const access of dashboardAccess) {
    console.log(`  ${access.label.padEnd(12)}${access.url}`);
  }
  for (const guidance of dashboardGuidance) {
    console.log(`  ${guidance}`);
  }
  console.log(`  ${"─".repeat(50)}`);
  console.log("");
}

function parseRepairMainArgs(args) {
  const parsed = {
    model: null,
    skipVerify: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--skip-verify") {
      parsed.skipVerify = true;
      continue;
    }
    if (arg === "--model") {
      const model = args[i + 1];
      if (!model) {
        throw new Error("Missing value for --model.");
      }
      parsed.model = model;
      i += 1;
      continue;
    }
    throw new Error(`Unknown repair-main option: ${arg}`);
  }

  return parsed;
}

function sandboxRepairMain(sandboxName, actionArgs = [], options = {}) {
  const ensureLiveFn = options.ensureLiveSandboxForAction || ensureLiveSandboxForAction;
  const exitFn = options.exit || process.exit;
  if (!ensureLiveFn(sandboxName, "repair")) {
    exitFn(1);
    return false;
  }

  const runSandboxScriptFn = options.runSandboxScript || backupStore.runSandboxScript;

  try {
    const parsed = parseRepairMainArgs(actionArgs);
    const fallbackModel = parsed.model ? JSON.stringify(parsed.model) : "None";
    console.log("");
    console.log(`  Repairing main agent wiring in sandbox '${sandboxName}'...`);
    const repairScript = `set -eu
export OPENCLAW_CONFIG_PATH=/tmp/nemoclaw/openclaw.json
python3 - <<'PY'
import json
import os
from pathlib import Path

runtime_path = Path('/tmp/nemoclaw/openclaw.json')
selection_path = Path('/sandbox/.nemoclaw/config.json')
workspace_path = '/sandbox/.openclaw/workspace'
agent_dir = '/sandbox/.openclaw/agents/main/agent'
model_override = ${fallbackModel}


def normalize(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def ensure_inference_model(raw_model):
    model = normalize(raw_model)
    if not model:
        return None
    if model.startswith('inference/'):
        return model
    return f'inference/{model}'


with runtime_path.open() as f:
    cfg = json.load(f)

agents = cfg.setdefault('agents', {})
defaults = agents.setdefault('defaults', {})
model_defaults = defaults.setdefault('model', {})

selection_model = None
selection = {}
if selection_path.exists():
    with selection_path.open() as f:
        selection = json.load(f)
    selection_model = normalize(selection.get('model'))

primary_model = ensure_inference_model(model_override) or ensure_inference_model(selection_model) or ensure_inference_model(model_defaults.get('primary')) or 'inference/qwen3.5:9b-64k'
defaults['workspace'] = workspace_path
model_defaults['primary'] = primary_model

agent_list = agents.get('list') or []
new_list = []
main_entry = {
    'id': 'main',
    'name': 'main',
    'workspace': workspace_path,
    'agentDir': agent_dir,
    'model': primary_model,
    'default': True,
}
new_list.append(main_entry)

for entry in agent_list:
    if not isinstance(entry, dict):
        continue
    if entry.get('id') == 'main':
        continue
    repaired = dict(entry)
    repaired['default'] = False
    new_list.append(repaired)

agents['list'] = new_list

with runtime_path.open('w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')

if selection:
    selection['model'] = primary_model.replace('inference/', '', 1)
    with selection_path.open('w') as f:
        json.dump(selection, f, indent=2)
        f.write('\n')

print(json.dumps({
    'sandbox': '${sandboxName}',
    'mainModel': primary_model,
    'mainWorkspace': workspace_path,
    'mainAgentDir': agent_dir,
    'selectionModel': selection.get('model') if selection else None,
    'agentIds': [entry.get('id') for entry in new_list if isinstance(entry, dict)],
}, indent=2))
PY
openclaw agents list --json`;

    runSandboxScriptFn(sandboxName, repairScript, { ignoreError: false });

    if (!parsed.skipVerify) {
      const verifyScript = `set -eu
export OPENCLAW_CONFIG_PATH=/tmp/nemoclaw/openclaw.json
openclaw agent --agent main --local -m 'Reply with exactly MAIN_REPAIR_OK' --session-id verify-main-repair --json`;
      runSandboxScriptFn(sandboxName, verifyScript, { ignoreError: false });
    }

    console.log(`  ✓ Repaired main agent wiring in '${sandboxName}'`);
    if (parsed.skipVerify) {
      console.log("  Verification was skipped (--skip-verify).");
    }
    console.log("");
    return true;
  } catch (error) {
    console.error(`  Failed to repair main agent wiring: ${error.message}`);
    exitFn(1);
    return false;
  }
}

async function sandboxDestroy(sandboxName, options = {}) {
  const promptFn = options.prompt || require("./lib/credentials").prompt;
  const runFn = options.run || run;
  const stopNimFn = options.stopNim || ((name) => nim.stopNimContainer(name));
  const removeSandboxFn = options.removeSandbox || ((name) => registry.removeSandbox(name));
  const isLive =
    options.isAvailable ??
    isOpenShellSandboxAvailable(sandboxName, options.runCapture || runCapture);

  console.log("");

  if (!isLive) {
    for (const line of getStaleSandboxWarningLines()) {
      console.log(`  ${line}`);
    }
    const confirm = await promptFn(
      `  Remove stale local sandbox entry '${sandboxName}' from the NemoClaw registry? [y/N]: `,
    );
    if (!/^y(es)?$/i.test(confirm || "")) {
      console.log("  Cancelled.");
      console.log("");
      return false;
    }
    removeSandboxFn(sandboxName);
    console.log(`  ✓ Removed stale sandbox entry '${sandboxName}' from the local registry`);
    console.log("");
    return true;
  }

  console.log(
    `  Warning: destroying sandbox '${sandboxName}' permanently deletes workspace files.`,
  );
  console.log(
    "  This includes SOUL.md, USER.md, IDENTITY.md, AGENTS.md, MEMORY.md, and daily memory notes.",
  );
  console.log(
    `  Run 'nemoclaw ${sandboxName} backup' before continuing if you need to keep those customizations.`,
  );
  const confirm = await promptFn(`  Type DESTROY to permanently delete sandbox '${sandboxName}': `);
  if (confirm !== "DESTROY") {
    console.log("  Cancelled.");
    console.log("");
    return false;
  }

  console.log(`  Stopping NIM for '${sandboxName}'...`);
  stopNimFn(sandboxName);

  console.log(`  Deleting sandbox '${sandboxName}'...`);
  runFn(`openshell sandbox delete "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });

  removeSandboxFn(sandboxName);
  console.log(`  ✓ Sandbox '${sandboxName}' destroyed`);
  console.log("");
  return true;
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

  Sandbox Management:
    nemoclaw list                    List all sandboxes
    nemoclaw <name> connect          Connect to a sandbox
    nemoclaw <name> backup           Create a full sandbox backup
    nemoclaw <name> restore [id]     Restore a backup into a sandbox
    nemoclaw <name> repair-main      Restore explicit main agent wiring in older sandboxes
    nemoclaw <name> dashboard        Show dashboard access URL(s)
    nemoclaw <name> status           Show sandbox status and health
    nemoclaw <name> logs [--follow]  View sandbox logs
    nemoclaw <name> telegram-probe   Probe api.telegram.org from inside a sandbox
    nemoclaw <name> discord-probe    Probe discord.com from inside a sandbox
    nemoclaw <name> destroy          Stop NIM + delete sandbox

  ${G}Policy Presets:${R}
    nemoclaw <name> policy-add       Add a network or filesystem policy preset
    nemoclaw <name> policy-list      List presets ${D}(● = applied)${R}

  ${G}Deploy:${R}
    nemoclaw deploy <instance>       Deploy to a Brev VM and start services

  ${G}Services:${R}
    nemoclaw start                   Start auxiliary services ${D}(Telegram, Discord, tunnel)${R}
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

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (shouldShowHelp(cmd)) {
    help();
    return;
  }
  if (GLOBAL_COMMANDS.has(cmd)) {
    await handleGlobalCommand(cmd, args);
    return;
  }
  await handleSandboxCommand(cmd, args);
}

function shouldShowHelp(cmd) {
  return !cmd || cmd === "help" || cmd === "--help" || cmd === "-h";
}

async function handleGlobalCommand(cmd, args) {
  switch (cmd) {
    case "onboard":
      await onboard(args);
      break;
    case "setup":
      await setup();
      break;
    case "setup-spark":
      await setupSpark();
      break;
    case "deploy":
      await deploy(args[0]);
      break;
    case "start":
      await start();
      break;
    case "stop":
      stop();
      break;
    case "status":
      showStatus();
      break;
    case "debug":
      debug(args);
      break;
    case "uninstall":
      uninstall(args);
      break;
    case "list":
      listSandboxes();
      break;
    case "--version":
    case "-v": {
      const pkg = require(path.join(__dirname, "..", "package.json"));
      console.log(`nemoclaw v${pkg.version}`);
      break;
    }
    default:
      help();
      break;
  }
}

async function handleSandboxCommand(cmd, args) {
  const sandbox = registry.getSandbox(cmd);
  const isLiveSandbox = isOpenShellSandboxAvailable(cmd);
  const hasBackups = backupStore.hasSandboxBackups(cmd);
  if (sandbox || isLiveSandbox || hasBackups) {
    validateName(cmd, "sandbox name");
    if (!sandbox && isLiveSandbox) {
      registry.registerSandbox({ name: cmd, gpuEnabled: false });
    }
    const action = args[0] || "connect";
    const actionArgs = args.slice(1);
    await dispatchSandboxAction(cmd, action, actionArgs);
    return;
  }
  suggestUnknownCommand(cmd);
}

async function dispatchSandboxAction(cmd, action, actionArgs) {
  switch (action) {
    case "connect":
      sandboxConnect(cmd);
      break;
    case "backup":
      sandboxBackup(cmd, actionArgs);
      break;
    case "restore":
      await sandboxRestore(cmd, actionArgs);
      break;
    case "repair-main":
      sandboxRepairMain(cmd, actionArgs);
      break;
    case "dashboard":
      sandboxDashboard(cmd);
      break;
    case "status":
      sandboxStatus(cmd);
      break;
    case "logs":
      sandboxLogs(cmd, actionArgs.includes("--follow"));
      break;
    case "telegram-probe":
      sandboxTelegramProbe(cmd);
      break;
    case "discord-probe":
      sandboxDiscordProbe(cmd);
      break;
    case "policy-add":
      await sandboxPolicyAdd(cmd);
      break;
    case "policy-list":
      sandboxPolicyList(cmd);
      break;
    case "destroy":
      await sandboxDestroy(cmd);
      break;
    default:
      console.error(`  Unknown action: ${action}`);
      console.error(
        `  Valid actions: connect, backup, restore, repair-main, dashboard, status, logs, telegram-probe, discord-probe, policy-add, policy-list, destroy`,
      );
      process.exit(1);
  }
}

function suggestUnknownCommand(cmd) {
  console.error(`  Unknown command: ${cmd}`);
  console.error("");
  const allNames = registry.listSandboxes().sandboxes.map((s) => s.name);
  if (allNames.length > 0) {
    console.error(`  Registered sandboxes: ${allNames.join(", ")}`);
    console.error(`  Try: nemoclaw <sandbox-name> connect`);
    console.error("");
  }
  console.error(`  Run 'nemoclaw help' for usage.`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  ensureLiveSandboxForAction,
  configureSandboxFromBackupManifest,
  syncSandboxGithubTokenEnv,
  getServiceSandboxEnv,
  getGatewayClusterContainerName,
  getStaleSandboxWarningLines,
  getStatusSandboxes,
  hasGatewayConnectFailure,
  hasSandboxAttachHandshakeFailure,
  isOpenShellSandboxAvailable,
  isGatewayConnected,
  main,
  printStaleSandboxWarning,
  printSandboxBackups,
  sandboxBackup,
  sandboxRepairMain,
  sandboxDestroy,
  sandboxRestore,
  showStatus,
};
