// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execFileSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { DASHBOARD_PORT } = require("./lib/ports");

// ---------------------------------------------------------------------------
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
const YW = _useColor ? "\x1b[1;33m" : "";

const {
  ROOT,
  run,
  runCapture: _runCapture,
  runInteractive,
  shellQuote,
  validateName,
} = require("./lib/runner");
const { resolveOpenshell } = require("./lib/resolve-openshell");
const { startGatewayForRecovery } = require("./lib/onboard");
const {
  getCredential,
  deleteCredential,
  listCredentialKeys,
  prompt: askPrompt,
} = require("./lib/credentials");
const registry = require("./lib/registry");
const nim = require("./lib/nim");
const policies = require("./lib/policies");
const { parseGatewayInference } = require("./lib/inference-config");
const { probeLocalProviderHealth } = require("./lib/local-inference");
const { getVersion } = require("./lib/version");
const onboardSession = require("./lib/onboard-session");
const { parseLiveSandboxNames } = require("./lib/runtime-recovery");
const { NOTICE_ACCEPT_ENV, NOTICE_ACCEPT_FLAG } = require("./lib/usage-notice");
const { runDebugCommand } = require("./lib/debug-command");
const {
  runDeprecatedOnboardAliasCommand,
  runOnboardCommand,
} = require("./lib/onboard-command");
const {
  captureOpenshellCommand,
  getInstalledOpenshellVersion,
  runOpenshellCommand,
  stripAnsi,
  versionGte,
} = require("./lib/openshell");
const { listSandboxesCommand, showStatusCommand } = require("./lib/inventory-commands");
const { executeDeploy } = require("./lib/deploy");
const { runStartCommand, runStopCommand } = require("./lib/services-command");
const {
  buildVersionedUninstallUrl,
  runUninstallCommand,
} = require("./lib/uninstall-command");
const agentRuntime = require("../bin/lib/agent-runtime");
const sandboxVersion = require("./lib/sandbox-version");
const sandboxState = require("./lib/sandbox-state");
const skillInstall = require("./lib/skill-install");

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
  "credentials",
  "backup-all",
  "help",
  "--help",
  "-h",
  "--version",
  "-v",
]);

const REMOTE_UNINSTALL_URL = buildVersionedUninstallUrl(getVersion());
let OPENSHELL_BIN = null;
const MIN_LOGS_OPENSHELL_VERSION = "0.0.7";
const NEMOCLAW_GATEWAY_NAME = "nemoclaw";
const DASHBOARD_FORWARD_PORT = String(DASHBOARD_PORT);

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
  return runOpenshellCommand(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: opts.env,
    stdio: opts.stdio,
    ignoreError: opts.ignoreError,
    errorLine: console.error,
    exit: (code) => process.exit(code),
  });
}

function captureOpenshell(args, opts = {}) {
  return captureOpenshellCommand(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: opts.env,
    ignoreError: opts.ignoreError,
    errorLine: console.error,
    exit: (code) => process.exit(code),
  });
}

function cleanupGatewayAfterLastSandbox() {
  runOpenshell(["forward", "stop", DASHBOARD_FORWARD_PORT], { ignoreError: true });
  runOpenshell(["gateway", "destroy", "-g", NEMOCLAW_GATEWAY_NAME], { ignoreError: true });
  run(
    `docker volume ls -q --filter "name=openshell-cluster-${NEMOCLAW_GATEWAY_NAME}" | grep . && docker volume ls -q --filter "name=openshell-cluster-${NEMOCLAW_GATEWAY_NAME}" | xargs docker volume rm || true`,
    { ignoreError: true },
  );
}

function hasNoLiveSandboxes() {
  const liveList = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  if (liveList.status !== 0) {
    return false;
  }
  return parseLiveSandboxNames(liveList.output).size === 0;
}

function isMissingSandboxDeleteResult(output = "") {
  return /\bNotFound\b|\bNot Found\b|sandbox not found|sandbox .* not found|sandbox .* not present|sandbox does not exist|no such sandbox/i.test(
    stripAnsi(output),
  );
}

function getSandboxDeleteOutcome(deleteResult) {
  const output = `${deleteResult.stdout || ""}${deleteResult.stderr || ""}`.trim();
  return {
    output,
    alreadyGone: deleteResult.status !== 0 && isMissingSandboxDeleteResult(output),
  };
}

function getInstalledOpenshellVersionOrNull() {
  return getInstalledOpenshellVersion(getOpenshellBinary(), {
    cwd: ROOT,
  });
}

// ── Sandbox process health (OpenClaw gateway inside the sandbox) ─────────

/**
 * Run a command inside the sandbox via SSH and return { status, stdout, stderr }.
 * Returns null if SSH config cannot be obtained.
 */
function executeSandboxCommand(sandboxName, command) {
  const sshConfigResult = captureOpenshell(["sandbox", "ssh-config", sandboxName], {
    ignoreError: true,
  });
  if (sshConfigResult.status !== 0) return null;

  const tmpFile = path.join(os.tmpdir(), `nemoclaw-ssh-${process.pid}-${Date.now()}.conf`);
  fs.writeFileSync(tmpFile, sshConfigResult.output, { mode: 0o600 });
  try {
    const result = spawnSync(
      "ssh",
      [
        "-F",
        tmpFile,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "LogLevel=ERROR",
        `openshell-${sandboxName}`,
        command,
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
    );
    return {
      status: result.status ?? 1,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Check whether the OpenClaw gateway process is running inside the sandbox.
 * Uses the gateway's HTTP endpoint (dashboard port) as the source of truth,
 * since the gateway runs as a separate user and pgrep may not see it.
 * Returns true (running), false (stopped), or null (cannot determine).
 */
function isSandboxGatewayRunning(sandboxName) {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const probeUrl = agentRuntime.getHealthProbeUrl(agent);
  const result = executeSandboxCommand(
    sandboxName,
    `curl -sf --max-time 3 ${shellQuote(probeUrl)} > /dev/null 2>&1 && echo RUNNING || echo STOPPED`,
  );
  if (!result) return null;
  if (result.stdout === "RUNNING") return true;
  if (result.stdout === "STOPPED") return false;
  return null;
}

/**
 * Restart the OpenClaw gateway process inside the sandbox after a pod restart.
 * Cleans stale lock/temp files, sources proxy config, and launches the gateway
 * in the background. Returns true on success.
 */
function recoverSandboxProcesses(sandboxName) {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const agentScript = agentRuntime.buildRecoveryScript(agent);
  // The recovery script runs as the sandbox user (non-root). This matches
  // the non-root fallback path in nemoclaw-start.sh — no privilege
  // separation, but the gateway runs and inference works.
  const script =
    agentScript ||
    [
      // Source proxy config (written to .bashrc by nemoclaw-start on first boot)
      "[ -f ~/.bashrc ] && . ~/.bashrc 2>/dev/null;",
      // Re-check liveness before touching anything — another caller may have
      // already recovered the gateway between our initial check and now (TOCTOU).
      `if curl -sf --max-time 3 http://127.0.0.1:${DASHBOARD_PORT}/ > /dev/null 2>&1; then echo ALREADY_RUNNING; exit 0; fi;`,
      // Clean stale lock files from the previous run (gateway checks these)
      "rm -rf /tmp/openclaw-*/gateway.*.lock 2>/dev/null;",
      // Clean stale temp files from the previous run
      "rm -f /tmp/gateway.log /tmp/auto-pair.log;",
      "touch /tmp/gateway.log; chmod 600 /tmp/gateway.log;",
      "touch /tmp/auto-pair.log; chmod 600 /tmp/auto-pair.log;",
      // Resolve and start gateway
      'OPENCLAW="$(command -v openclaw)";',
      'if [ -z "$OPENCLAW" ]; then echo OPENCLAW_MISSING; exit 1; fi;',
      'nohup "$OPENCLAW" gateway run > /tmp/gateway.log 2>&1 &',
      "GPID=$!; sleep 2;",
      // Verify the gateway actually started (didn't crash immediately)
      'if kill -0 "$GPID" 2>/dev/null; then echo "GATEWAY_PID=$GPID"; else echo GATEWAY_FAILED; cat /tmp/gateway.log 2>/dev/null | tail -5; fi',
    ].join(" ");

  const result = executeSandboxCommand(sandboxName, script);
  if (!result) return false;
  return (
    result.status === 0 &&
    (result.stdout.includes("GATEWAY_PID=") || result.stdout.includes("ALREADY_RUNNING"))
  );
}

/**
 * Re-establish the dashboard port forward to the sandbox.
 * Uses the agent's forward port when a non-OpenClaw agent is active.
 */
function ensureSandboxPortForward(sandboxName) {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const port = agent ? String(agent.forwardPort) : DASHBOARD_FORWARD_PORT;
  runOpenshell(["forward", "stop", port], { ignoreError: true });
  runOpenshell(["forward", "start", "--background", port, sandboxName], {
    ignoreError: true,
  });
}

/**
 * Detect and recover from a sandbox that survived a gateway restart but
 * whose OpenClaw processes are not running. Returns an object describing
 * the outcome: { checked, wasRunning, recovered }.
 */
function checkAndRecoverSandboxProcesses(sandboxName, { quiet = false } = {}) {
  const running = isSandboxGatewayRunning(sandboxName);
  if (running === null) {
    return { checked: false, wasRunning: null, recovered: false };
  }
  if (running) {
    return { checked: true, wasRunning: true, recovered: false };
  }

  // Gateway not running — attempt recovery
  const _recoveryAgent = agentRuntime.getSessionAgent(sandboxName);
  if (!quiet) {
    console.log("");
    console.log(`  ${agentRuntime.getAgentDisplayName(_recoveryAgent)} gateway is not running inside the sandbox (sandbox likely restarted).`);
    console.log("  Recovering...");
  }

  const recovered = recoverSandboxProcesses(sandboxName);
  if (recovered) {
    // Wait for gateway to bind its HTTP port before declaring success
    spawnSync("sleep", ["3"]);
    if (isSandboxGatewayRunning(sandboxName) !== true) {
      // Gateway process started but HTTP endpoint never came up
      if (!quiet) {
        console.error("  Gateway process started but is not responding.");
        console.error("  Check /tmp/gateway.log inside the sandbox for details.");
      }
      return { checked: true, wasRunning: false, recovered: false };
    }
    ensureSandboxPortForward(sandboxName);
    if (!quiet) {
      console.log(`  ${G}✓${R} ${agentRuntime.getAgentDisplayName(_recoveryAgent)} gateway restarted inside sandbox.`);
      console.log(`  ${G}✓${R} Dashboard port forward re-established.`);
    }
  } else if (!quiet) {
    console.error(`  Could not restart ${agentRuntime.getAgentDisplayName(_recoveryAgent)} gateway automatically.`);
    console.error("  Connect to the sandbox and run manually:");
    console.error(`    ${agentRuntime.getGatewayCommand(_recoveryAgent)}`);
  }

  return { checked: true, wasRunning: false, recovered };
}

function buildRecoveredSandboxEntry(name, metadata = {}) {
  return {
    name,
    model: metadata.model || null,
    provider: metadata.provider || null,
    gpuEnabled: metadata.gpuEnabled === true,
    policies: Array.isArray(metadata.policies)
      ? metadata.policies
      : Array.isArray(metadata.policyPresets)
        ? metadata.policyPresets
        : [],
    nimContainer: metadata.nimContainer || null,
    agent: metadata.agent || null,
  };
}

function upsertRecoveredSandbox(name, metadata = {}) {
  let validName;
  try {
    validName = validateName(name, "sandbox name");
  } catch {
    return false;
  }

  const entry = buildRecoveredSandboxEntry(validName, metadata);
  if (registry.getSandbox(validName)) {
    registry.updateSandbox(validName, entry);
    return false;
  }
  registry.registerSandbox(entry);
  return true;
}

function shouldRecoverRegistryEntries(current, session, requestedSandboxName) {
  const hasSessionSandbox = Boolean(session?.sandboxName);
  const missingSessionSandbox =
    hasSessionSandbox && !current.sandboxes.some((sandbox) => sandbox.name === session.sandboxName);
  const missingRequestedSandbox =
    Boolean(requestedSandboxName) &&
    !current.sandboxes.some((sandbox) => sandbox.name === requestedSandboxName);
  const hasRecoverySeed =
    current.sandboxes.length > 0 || hasSessionSandbox || Boolean(requestedSandboxName);
  return {
    missingRequestedSandbox,
    shouldRecover:
      hasRecoverySeed &&
      (current.sandboxes.length === 0 || missingRequestedSandbox || missingSessionSandbox),
  };
}

function seedRecoveryMetadata(current, session, requestedSandboxName) {
  const metadataByName = new Map(current.sandboxes.map((sandbox) => [sandbox.name, sandbox]));
  let recoveredFromSession = false;

  if (!session?.sandboxName) {
    return { metadataByName, recoveredFromSession };
  }

  metadataByName.set(
    session.sandboxName,
    buildRecoveredSandboxEntry(session.sandboxName, {
      model: session.model || null,
      provider: session.provider || null,
      nimContainer: session.nimContainer || null,
      policyPresets: session.policyPresets || null,
    }),
  );
  const sessionSandboxMissing = !current.sandboxes.some(
    (sandbox) => sandbox.name === session.sandboxName,
  );
  const shouldRecoverSessionSandbox =
    current.sandboxes.length === 0 ||
    sessionSandboxMissing ||
    requestedSandboxName === session.sandboxName;
  if (shouldRecoverSessionSandbox) {
    recoveredFromSession = upsertRecoveredSandbox(
      session.sandboxName,
      metadataByName.get(session.sandboxName),
    );
  }
  return { metadataByName, recoveredFromSession };
}

async function recoverRegistryFromLiveGateway(metadataByName) {
  if (!resolveOpenshell()) {
    return 0;
  }
  const recovery = await recoverNamedGatewayRuntime();
  const canInspectLiveGateway =
    recovery.recovered ||
    recovery.before?.state === "healthy_named" ||
    recovery.after?.state === "healthy_named";
  if (!canInspectLiveGateway) {
    return 0;
  }

  let recoveredFromGateway = 0;
  const liveList = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  const liveNames = Array.from(parseLiveSandboxNames(liveList.output));
  for (const name of liveNames) {
    const metadata = metadataByName.get(name) || {};
    if (upsertRecoveredSandbox(name, metadata)) {
      recoveredFromGateway += 1;
    }
  }
  return recoveredFromGateway;
}

function applyRecoveredDefault(currentDefaultSandbox, requestedSandboxName, session) {
  const recovered = registry.listSandboxes();
  const preferredDefault =
    requestedSandboxName || (!currentDefaultSandbox ? session?.sandboxName || null : null);
  if (
    preferredDefault &&
    recovered.sandboxes.some((sandbox) => sandbox.name === preferredDefault)
  ) {
    registry.setDefault(preferredDefault);
  }
  return registry.listSandboxes();
}

async function recoverRegistryEntries({ requestedSandboxName = null } = {}) {
  const current = registry.listSandboxes();
  const session = onboardSession.loadSession();
  const recoveryCheck = shouldRecoverRegistryEntries(current, session, requestedSandboxName);
  if (!recoveryCheck.shouldRecover) {
    return { ...current, recoveredFromSession: false, recoveredFromGateway: 0 };
  }

  const seeded = seedRecoveryMetadata(current, session, requestedSandboxName);
  const shouldProbeLiveGateway = current.sandboxes.length > 0 || Boolean(session?.sandboxName);
  const recoveredFromGateway = shouldProbeLiveGateway
    ? await recoverRegistryFromLiveGateway(seeded.metadataByName)
    : 0;
  const recovered = applyRecoveredDefault(current.defaultSandbox, requestedSandboxName, session);
  return {
    ...recovered,
    recoveredFromSession: seeded.recoveredFromSession,
    recoveredFromGateway,
  };
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
  const connected = /^\s*Status:\s*Connected\b/im.test(cleanStatus);
  const named = hasNamedGateway(gatewayInfo.output);
  const refusing = /Connection refused|client error \(Connect\)|tcp connect error/i.test(
    cleanStatus,
  );
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

/** Attempt to recover the named NemoClaw gateway after a restart or connectivity loss. */
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
    ["missing_named", "named_unhealthy", "named_unreachable", "connected_other"].includes(state),
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

/** Query sandbox presence and return its output with the live enforced policy. */
function getSandboxGatewayState(sandboxName) {
  const result = captureOpenshell(["sandbox", "get", sandboxName]);
  let output = result.output;
  if (result.status === 0) {
    // `openshell sandbox get` returns the immutable baseline policy from sandbox
    // creation, which does not include network_policies added later via
    // `openshell policy set`. Replace the Policy section with the live policy
    // from `policy get --full`, preserving the colored "Policy:" header and
    // Sandbox info above it. (#1132)
    const livePolicy = captureOpenshell(["policy", "get", "--full", sandboxName], {
      ignoreError: true,
    });
    if (livePolicy.status === 0 && livePolicy.output.trim()) {
      const rawLines = String(output).split("\n");
      const cleanLines = stripAnsi(String(output)).split("\n");
      const policyLineIdx = cleanLines.findIndex((l) => l.trim() === "Policy:");
      if (policyLineIdx !== -1) {
        // Keep everything before Policy (Sandbox info with colors),
        // plus the original colored "Policy:" header line.
        const before = rawLines.slice(0, policyLineIdx + 1).join("\n");
        // Extract YAML content from policy get --full (skip metadata header before "---").
        // Use a regex to handle varying line endings (\n, \r\n) and optional trailing whitespace.
        const delimIdx = livePolicy.output.search(/^---\s*$/m);
        const yamlPart = delimIdx !== -1
          ? livePolicy.output.slice(delimIdx).replace(/^---\s*[\r\n]+/, "")
          : livePolicy.output;
        // Guard: only replace if the extracted content looks like policy YAML
        // (starts with a YAML key like "version:" or "network_policies:").
        // Avoids replacing with warnings or status text from unexpected output.
        const trimmedYaml = yamlPart.trim();
        const looksLikeError = /^(error|failed|invalid|warning|status)\b/i.test(trimmedYaml);
        if (trimmedYaml && !looksLikeError && /^[a-z_][a-z0-9_]*\s*:/m.test(trimmedYaml)) {
          // Add 2-space indent to match the original sandbox get output format.
          const indented = trimmedYaml.split("\n").map((l) => (l ? "  " + l : l)).join("\n");
          output = before + "\n\n" + indented + "\n";
        }
      }
    }
    return { state: "present", output };
  }
  if (/\bNotFound\b|\bNot Found\b|sandbox not found/i.test(output)) {
    return { state: "missing", output };
  }
  if (
    /transport error|Connection refused|handshake verification failed|Missing gateway auth token|device identity required/i.test(
      output,
    )
  ) {
    return { state: "gateway_error", output };
  }
  return { state: "unknown_error", output };
}

/** Print troubleshooting hints based on gateway lifecycle state in the output. */
function printGatewayLifecycleHint(output = "", sandboxName = "", writer = console.error) {
  const cleanOutput = stripAnsi(output);
  if (/No gateway configured/i.test(cleanOutput)) {
    writer(
      "  The selected NemoClaw gateway is no longer configured or its metadata/runtime has been lost.",
    );
    writer(
      "  Start the gateway again with `openshell gateway start --name nemoclaw` before expecting existing sandboxes to reconnect.",
    );
    writer(
      "  If the gateway has to be rebuilt from scratch, recreate the affected sandbox afterward.",
    );
    return;
  }
  if (
    /Connection refused|client error \(Connect\)|tcp connect error/i.test(cleanOutput) &&
    /Gateway:\s+nemoclaw/i.test(cleanOutput)
  ) {
    writer(
      "  The selected NemoClaw gateway exists in metadata, but its API is refusing connections after restart.",
    );
    writer("  This usually means the gateway runtime did not come back cleanly after the restart.");
    writer(
      "  Retry `openshell gateway start --name nemoclaw`; if it stays in this state, rebuild the gateway before expecting existing sandboxes to reconnect.",
    );
    return;
  }
  if (/handshake verification failed/i.test(cleanOutput)) {
    writer("  This looks like gateway identity drift after restart.");
    writer(
      "  Existing sandboxes may still be recorded locally, but the current gateway no longer trusts their prior connection state.",
    );
    writer(
      "  Try re-establishing the NemoClaw gateway/runtime first. If the sandbox is still unreachable, recreate just that sandbox with `nemoclaw onboard`.",
    );
    return;
  }
  if (/Connection refused|transport error/i.test(cleanOutput)) {
    writer(
      `  The sandbox '${sandboxName}' may still exist, but the current gateway/runtime is not reachable.`,
    );
    writer("  Check `openshell status`, verify the active gateway, and retry.");
    return;
  }
  if (/Missing gateway auth token|device identity required/i.test(cleanOutput)) {
    writer(
      "  The gateway is reachable, but the current auth or device identity state is not usable.",
    );
    writer("  Verify the active gateway and retry after re-establishing the runtime.");
  }
}

// eslint-disable-next-line complexity
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
    if (
      /Connection refused|client error \(Connect\)|tcp connect error/i.test(latestStatus) &&
      /Gateway:\s+nemoclaw/i.test(latestStatus)
    ) {
      return {
        state: "gateway_unreachable_after_restart",
        output: latestLifecycle.status || lookup.output,
      };
    }
    if (
      recovery.after?.state === "named_unreachable" ||
      recovery.before?.state === "named_unreachable"
    ) {
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
    const session = onboardSession.loadSession();
    if (session && session.sandboxName === sandboxName) {
      onboardSession.updateSession((s) => {
        s.sandboxName = null;
        return s;
      });
    }
    console.error(`  Sandbox '${sandboxName}' is not present in the live OpenShell gateway.`);
    console.error("  Removed stale local registry entry.");
    console.error(
      "  Run `nemoclaw list` to confirm the remaining sandboxes, or `nemoclaw onboard` to create a new one.",
    );
    process.exit(1);
  }
  if (lookup.state === "identity_drift") {
    console.error(
      `  Sandbox '${sandboxName}' is recorded locally, but the gateway trust material rotated after restart.`,
    );
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error(
      "  Existing sandbox connections cannot be reattached safely after this gateway identity change.",
    );
    console.error(
      "  Recreate this sandbox with `nemoclaw onboard` once the gateway runtime is stable.",
    );
    process.exit(1);
  }
  if (lookup.state === "gateway_unreachable_after_restart") {
    console.error(
      `  Sandbox '${sandboxName}' may still exist, but the selected NemoClaw gateway is still refusing connections after restart.`,
    );
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error(
      "  Retry `openshell gateway start --name nemoclaw` and verify `openshell status` is healthy before reconnecting.",
    );
    console.error(
      "  If the gateway never becomes healthy, rebuild the gateway and then recreate the affected sandbox.",
    );
    process.exit(1);
  }
  if (lookup.state === "gateway_missing_after_restart") {
    console.error(
      `  Sandbox '${sandboxName}' may still exist locally, but the NemoClaw gateway is no longer configured after restart/rebuild.`,
    );
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error(
      "  Start the gateway again with `openshell gateway start --name nemoclaw` before retrying.",
    );
    console.error(
      "  If the gateway had to be rebuilt from scratch, recreate the affected sandbox afterward.",
    );
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

function printOldLogsCompatibilityGuidance(installedVersion = null) {
  const versionText = installedVersion ? ` (${installedVersion})` : "";
  console.error(
    `  Installed OpenShell${versionText} is too old or incompatible with \`nemoclaw logs\`.`,
  );
  console.error(`  NemoClaw expects \`openshell logs <name>\` and live streaming via \`--tail\`.`);
  console.error(
    "  Upgrade OpenShell by rerunning `nemoclaw onboard`, or reinstall the OpenShell CLI and try again.",
  );
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

function printDangerouslySkipPermissionsWarning() {
  console.error("");
  console.error("  \u26a0  --dangerously-skip-permissions: sandbox security restrictions disabled.");
  console.error("     Network:    all known endpoints open (no method/path filtering)");
  console.error("     Filesystem: sandbox home directory is writable");
  console.error("     Use for development/testing only.");
  console.error("");
}

// ── Commands ─────────────────────────────────────────────────────

function buildOnboardCommandDeps(args) {
  const { onboard: runOnboard } = require("./lib/onboard");
  const { listAgents } = require("./lib/agent-defs");
  return {
    args,
    noticeAcceptFlag: NOTICE_ACCEPT_FLAG,
    noticeAcceptEnv: NOTICE_ACCEPT_ENV,
    env: process.env,
    runOnboard,
    listAgents,
    log: console.log,
    error: console.error,
    exit: (code) => process.exit(code),
  };
}

async function onboard(args) {
  await runOnboardCommand(buildOnboardCommandDeps(args));
}

async function setup(args = []) {
  await runDeprecatedOnboardAliasCommand({
    ...buildOnboardCommandDeps(args),
    kind: "setup",
  });
}

async function setupSpark(args = []) {
  await runDeprecatedOnboardAliasCommand({
    ...buildOnboardCommandDeps(args),
    kind: "setup-spark",
  });
}

async function deploy(instanceName) {
  await executeDeploy({
    instanceName,
    env: process.env,
    rootDir: ROOT,
    getCredential,
    validateName,
    shellQuote,
    run,
    runInteractive,
    execFileSync: (file, args, opts = {}) =>
      String(execFileSync(file, args, { encoding: "utf-8", ...opts })),
    spawnSync,
    log: console.log,
    error: console.error,
    stdoutWrite: (message) => process.stdout.write(message),
    exit: (code) => process.exit(code),
  });
}

async function start() {
  const { startAll } = require("./lib/services");
  await runStartCommand({
    listSandboxes: () => registry.listSandboxes(),
    startAll,
  });
}

function stop() {
  const { stopAll } = require("./lib/services");
  runStopCommand({
    listSandboxes: () => registry.listSandboxes(),
    stopAll,
  });
}

function debug(args) {
  const { runDebug } = require("./lib/debug");
  runDebugCommand(args, {
    getDefaultSandbox: () => registry.listSandboxes().defaultSandbox || undefined,
    runDebug,
    log: console.log,
    error: console.error,
    exit: (code) => process.exit(code),
  });
}

function uninstall(args) {
  runUninstallCommand({
    args,
    rootDir: ROOT,
    currentDir: __dirname,
    remoteScriptUrl: REMOTE_UNINSTALL_URL,
    env: process.env,
    spawnSyncImpl: spawnSync,
    log: console.log,
    error: console.error,
    exit: (code) => process.exit(code),
  });
}

async function credentialsCommand(args) {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log("");
    console.log("  Usage: nemoclaw credentials <subcommand>");
    console.log("");
    console.log("  Subcommands:");
    console.log("    list                  List stored credential keys (values are not printed)");
    console.log("    reset <KEY> [--yes]   Remove a stored credential so onboard re-prompts");
    console.log("");
    console.log("  Stored at ~/.nemoclaw/credentials.json (mode 600)");
    console.log("");
    return;
  }

  if (sub === "list") {
    const keys = listCredentialKeys();
    if (keys.length === 0) {
      console.log("  No stored credentials.");
      return;
    }
    console.log("  Stored credentials:");
    for (const k of keys) {
      console.log(`    ${k}`);
    }
    return;
  }

  if (sub === "reset") {
    const key = args[1];
    // Validate that <KEY> is a real positional argument, not a flag like
    // `--yes` that the user passed without a key. Without this guard, the
    // missing-key path would mistakenly look up '--yes' as a credential.
    if (!key || key.startsWith("-")) {
      console.error("  Usage: nemoclaw credentials reset <KEY> [--yes]");
      console.error("  Run 'nemoclaw credentials list' to see stored keys.");
      process.exit(1);
    }
    // Reject unknown trailing arguments to keep scripted use predictable.
    const extraArgs = args.slice(2).filter((arg) => arg !== "--yes" && arg !== "-y");
    if (extraArgs.length > 0) {
      console.error(`  Unknown argument(s) for credentials reset: ${extraArgs.join(", ")}`);
      console.error("  Usage: nemoclaw credentials reset <KEY> [--yes]");
      process.exit(1);
    }
    // Only consult the persisted credentials file — getCredential() falls back
    // to process.env, which would let an env-only key pass this check even
    // though there is nothing on disk to delete.
    if (!listCredentialKeys().includes(key)) {
      console.error(`  No stored credential found for '${key}'.`);
      process.exit(1);
    }
    const skipPrompt = args.includes("--yes") || args.includes("-y");
    if (!skipPrompt) {
      const answer = (await askPrompt(`  Remove stored credential '${key}'? [y/N]: `))
        .trim()
        .toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        console.log("  Cancelled.");
        return;
      }
    }
    const removed = deleteCredential(key);
    if (removed) {
      console.log(`  Removed '${key}' from ~/.nemoclaw/credentials.json`);
      console.log("  Re-run 'nemoclaw onboard' to enter a new value.");
    } else {
      console.error(`  No stored credential found for '${key}'.`);
      process.exit(1);
    }
    return;
  }

  console.error(`  Unknown credentials subcommand: ${sub}`);
  console.error("  Run 'nemoclaw credentials help' for usage.");
  process.exit(1);
}

function showStatus() {
  const { showStatus: showServiceStatus } = require("./lib/services");
  showStatusCommand({
    listSandboxes: () => registry.listSandboxes(),
    getLiveInference: () =>
      parseGatewayInference(captureOpenshell(["inference", "get"], { ignoreError: true }).output),
    showServiceStatus,
    log: console.log,
  });
}

async function listSandboxes() {
  await listSandboxesCommand({
    recoverRegistryEntries: () => recoverRegistryEntries(),
    getLiveInference: () =>
      parseGatewayInference(captureOpenshell(["inference", "get"], { ignoreError: true }).output),
    loadLastSession: () => onboardSession.loadSession(),
    log: console.log,
  });
}

// ── Sandbox-scoped actions ───────────────────────────────────────

async function sandboxConnect(sandboxName, { dangerouslySkipPermissions = false } = {}) {
  await ensureLiveSandboxOrExit(sandboxName);

  // Version staleness check — warn but don't block
  try {
    const versionCheck = sandboxVersion.checkAgentVersion(sandboxName);
    if (versionCheck.isStale) {
      for (const line of sandboxVersion.formatStalenessWarning(sandboxName, versionCheck)) {
        console.error(line);
      }
    }
  } catch { /* non-fatal — don't block connect on version check failure */ }

  if (dangerouslySkipPermissions) {
    printDangerouslySkipPermissionsWarning();
    const policies = require("./lib/policies");
    policies.applyPermissivePolicy(sandboxName);
  }
  checkAndRecoverSandboxProcesses(sandboxName);
  // Print a one-shot hint before dropping the user into the sandbox
  // shell so a fresh user knows the first thing to type. Without this,
  // `nemoclaw <name> connect` lands on a bare bash prompt and users
  // ask "now what?" — see #465. Suppress the hint when stdout isn't a
  // TTY so scripted callers don't get noise in their pipelines.
  if (process.stdout.isTTY && !["1", "true"].includes(String(process.env.NEMOCLAW_NO_CONNECT_HINT || ""))) {
    console.log("");
    console.log(`  ${G}✓${R} Connecting to sandbox '${sandboxName}'`);
    console.log(`  ${D}Inside the sandbox, run \`openclaw tui\` to start chatting with the agent.${R}`);
    console.log(`  ${D}Type \`exit\` (or Ctrl-D) to return to the host shell.${R}`);
    console.log("");
  }
  const result = spawnSync(getOpenshellBinary(), ["sandbox", "connect", sandboxName], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });
  exitWithSpawnResult(result);
}

// eslint-disable-next-line complexity
async function sandboxStatus(sandboxName) {
  const sb = registry.getSandbox(sandboxName);
  const live = parseGatewayInference(
    captureOpenshell(["inference", "get"], { ignoreError: true }).output,
  );
  const currentModel = (live && live.model) || (sb && sb.model) || "unknown";
  const currentProvider = (live && live.provider) || (sb && sb.provider) || "unknown";
  const localInferenceHealth =
    typeof currentProvider === "string" ? probeLocalProviderHealth(currentProvider) : null;
  if (sb) {
    console.log("");
    console.log(`  Sandbox: ${sb.name}`);
    console.log(`    Model:    ${currentModel}`);
    console.log(`    Provider: ${currentProvider}`);
    if (localInferenceHealth) {
      console.log(
        `    Inference: ${localInferenceHealth.ok ? `${G}healthy${R}` : `${_RD}unreachable${R}`} (${localInferenceHealth.endpoint})`,
      );
      if (!localInferenceHealth.ok) {
        console.log(`      ${localInferenceHealth.detail}`);
      }
    }
    console.log(`    GPU:      ${sb.gpuEnabled ? "yes" : "no"}`);
    console.log(`    Policies: ${(sb.policies || []).join(", ") || "none"}`);
    if (sb.dangerouslySkipPermissions) {
      console.log(`    Permissions: dangerously-skip-permissions (open)`);
    }

    // Agent version check
    try {
      const versionCheck = sandboxVersion.checkAgentVersion(sandboxName);
      const agent = agentRuntime.getSessionAgent(sandboxName);
      const agentName = agentRuntime.getAgentDisplayName(agent);
      if (versionCheck.sandboxVersion) {
        console.log(`    Agent:    ${agentName} v${versionCheck.sandboxVersion}`);
      }
      if (versionCheck.isStale) {
        console.log(`    ${YW}Update:   v${versionCheck.expectedVersion} available${R}`);
        console.log(`              Run \`nemoclaw ${sandboxName} rebuild\` to upgrade`);
      }
    } catch { /* non-fatal */ }
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
    const session = onboardSession.loadSession();
    if (session && session.sandboxName === sandboxName) {
      onboardSession.updateSession((s) => {
        s.sandboxName = null;
        return s;
      });
    }
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

  // OpenClaw process health inside the sandbox
  if (lookup.state === "present") {
    const processCheck = checkAndRecoverSandboxProcesses(sandboxName, { quiet: true });
    if (processCheck.checked) {
      const _sa = agentRuntime.getSessionAgent(sandboxName);
      const _saName = agentRuntime.getAgentDisplayName(_sa);
      if (processCheck.wasRunning) {
        console.log(`    ${_saName}: ${G}running${R}`);
      } else if (processCheck.recovered) {
        console.log(`    ${_saName}: ${G}recovered${R} (gateway restarted after sandbox restart)`);
      } else {
        console.log(`    ${_saName}: ${_RD}not running${R}`);
        console.log("");
        console.log(`  The sandbox is alive but the ${_saName} gateway process is not running.`);
        console.log("  This typically happens after a gateway restart (e.g., laptop close/open).");
        console.log("");
        console.log("  To recover, run:");
        console.log(`    ${D}nemoclaw ${sandboxName} connect${R}  (auto-recovers on connect)`);
        console.log("  Or manually inside the sandbox:");
        console.log(`    ${D}${agentRuntime.getGatewayCommand(_sa)}${R}`);
      }
    }
  }

  // NIM health
  const nimStat =
    sb && sb.nimContainer ? nim.nimStatusByName(sb.nimContainer) : nim.nimStatus(sandboxName);
  console.log(
    `    NIM:      ${nimStat.running ? `running (${nimStat.container})` : "not running"}`,
  );
  if (nimStat.running) {
    console.log(`    Healthy:  ${nimStat.healthy ? "yes" : "no"}`);
  }
  console.log("");
}

function sandboxLogs(sandboxName, follow) {
  const installedVersion = getInstalledOpenshellVersionOrNull();
  if (installedVersion && !versionGte(installedVersion, MIN_LOGS_OPENSHELL_VERSION)) {
    printOldLogsCompatibilityGuidance(installedVersion);
    process.exit(1);
  }

  const args = ["logs", sandboxName];
  if (follow) args.push("--tail");
  const result = spawnSync(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf-8",
    stdio: follow ? ["ignore", "inherit", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const combined = `${stdout}${stderr}`;
  if (!follow && stdout) {
    process.stdout.write(stdout);
  }
  if (result.status === 0) {
    return;
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
  if (
    /unrecognized subcommand 'logs'|unexpected argument '--tail'|unexpected argument '--follow'/i.test(
      combined,
    ) ||
    (installedVersion && !versionGte(installedVersion, MIN_LOGS_OPENSHELL_VERSION))
  ) {
    printOldLogsCompatibilityGuidance(installedVersion);
    process.exit(1);
  }
  if (result.status === null || result.signal) {
    exitWithSpawnResult(result);
  }
  console.error(`  Command failed (exit ${result.status}): openshell ${args.join(" ")}`);
  exitWithSpawnResult(result);
}

async function sandboxPolicyAdd(sandboxName, args = []) {
  const dryRun = args.includes("--dry-run");
  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  const answer = await policies.selectFromList(allPresets, { applied });
  if (!answer) return;

  const presetContent = policies.loadPreset(answer);
  if (!presetContent) return;

  const endpoints = policies.getPresetEndpoints(presetContent);
  if (endpoints.length > 0) {
    console.log(`  Endpoints that would be opened: ${endpoints.join(", ")}`);
  }

  if (dryRun) {
    console.log("  --dry-run: no changes applied.");
    return;
  }

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

async function sandboxSkillInstall(sandboxName, args = []) {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log("");
    console.log("  Usage: nemoclaw <sandbox> skill install <path>");
    console.log("");
    console.log("  Deploy a skill directory to a running sandbox.");
    console.log("  <path> must be a skill directory containing a SKILL.md (with 'name:' frontmatter),");
    console.log("  or a direct path to a SKILL.md file. All non-dot files in the directory are uploaded.");
    console.log("");
    return;
  }

  if (sub !== "install") {
    console.error(`  Unknown skill subcommand: ${sub}`);
    console.error("  Valid subcommands: install");
    process.exit(1);
  }

  const skillPath = args[1];
  const extraArgs = args.slice(2);
  if (extraArgs.length > 0) {
    console.error(`  Unknown argument(s) for skill install: ${extraArgs.join(", ")}`);
    console.error("  Usage: nemoclaw <sandbox> skill install <path>");
    process.exit(1);
  }
  if (!skillPath) {
    console.error("  Usage: nemoclaw <sandbox> skill install <path>");
    console.error("  <path> must be a directory containing a SKILL.md file.");
    process.exit(1);
  }

  const resolvedPath = path.resolve(skillPath);

  // Accept a directory containing SKILL.md, or a direct path to SKILL.md.
  let skillDir: string;
  let skillMdPath: string;
  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
    skillDir = resolvedPath;
    skillMdPath = path.join(resolvedPath, "SKILL.md");
  } else if (fs.existsSync(resolvedPath) && resolvedPath.endsWith("SKILL.md")) {
    skillDir = path.dirname(resolvedPath);
    skillMdPath = resolvedPath;
  } else {
    console.error(`  No SKILL.md found at '${resolvedPath}'.`);
    console.error("  <path> must be a skill directory or a direct path to SKILL.md.");
    process.exit(1);
  }

  if (!fs.existsSync(skillMdPath)) {
    console.error(`  No SKILL.md found in '${skillDir}'.`);
    console.error("  The skill directory must contain a SKILL.md file.");
    process.exit(1);
  }

  // 1. Validate frontmatter
  let frontmatter;
  try {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    frontmatter = skillInstall.parseFrontmatter(content);
  } catch (err) {
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  const collected = skillInstall.collectFiles(skillDir);
  if (collected.unsafePaths.length > 0) {
    console.error(`  Skill directory contains files with unsafe characters:`);
    for (const p of collected.unsafePaths) console.error(`    ${p}`);
    console.error("  File names must match [A-Za-z0-9._-/]. Rename or remove them.");
    process.exit(1);
  }
  if (collected.skippedDotfiles.length > 0) {
    console.log(`  ${D}Skipping ${collected.skippedDotfiles.length} hidden path(s): ${collected.skippedDotfiles.join(", ")}${R}`);
  }
  const fileLabel = collected.files.length === 1 ? "1 file" : `${collected.files.length} files`;
  console.log(`  ${G}✓${R} Validated SKILL.md (name: ${frontmatter.name}, ${fileLabel})`);

  // 2. Ensure sandbox is live
  await ensureLiveSandboxOrExit(sandboxName);

  // 3. Resolve agent and paths
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const paths = skillInstall.resolveSkillPaths(agent, frontmatter.name);

  // 4. Get SSH config
  const sshConfigResult = captureOpenshell(["sandbox", "ssh-config", sandboxName], {
    ignoreError: true,
  });
  if (sshConfigResult.status !== 0) {
    console.error("  Failed to obtain SSH configuration for the sandbox.");
    process.exit(1);
  }

  const tmpSshConfig = path.join(os.tmpdir(), `nemoclaw-ssh-skill-${process.pid}-${Date.now()}.conf`);
  fs.writeFileSync(tmpSshConfig, sshConfigResult.output, { mode: 0o600 });

  try {
    const ctx = { configFile: tmpSshConfig, sandboxName };

    // 5. Check if skill already exists (update vs fresh install)
    const isUpdate = skillInstall.checkExisting(ctx, paths);

    // 6. Upload skill directory
    const { uploaded, failed } = skillInstall.uploadDirectory(ctx, skillDir, paths.uploadDir);
    if (failed.length > 0) {
      console.error(`  Failed to upload ${failed.length} file(s): ${failed.join(", ")}`);
      process.exit(1);
    }
    console.log(`  ${G}✓${R} Uploaded ${uploaded} file(s) to sandbox`);

    // 7. Post-install (OpenClaw mirror + refresh, or restart hint).
    //    Skip session refresh on updates — the agent already knows the skill;
    //    clearing sessions would destroy chat history unnecessarily.
    const post = skillInstall.postInstall(ctx, paths, skillDir, { skipRefresh: isUpdate });
    for (const msg of post.messages) {
      if (msg.startsWith("Warning:")) {
        console.error(`  ${YW}${msg}${R}`);
      } else {
        console.log(`  ${D}${msg}${R}`);
      }
    }

    // 8. Verify
    const verified = skillInstall.verifyInstall(ctx, paths);
    if (verified) {
      const verb = isUpdate ? "updated" : "installed";
      console.log(`  ${G}✓${R} Skill '${frontmatter.name}' ${verb}`);
    } else {
      console.error(`  Skill uploaded but verification failed at ${paths.uploadDir}/SKILL.md`);
      process.exit(1);
    }
  } finally {
    try {
      fs.unlinkSync(tmpSshConfig);
    } catch {
      /* ignore */
    }
  }
}

function cleanupSandboxServices(sandboxName, { stopHostServices = false } = {}) {
  if (stopHostServices) {
    const { stopAll } = require("./lib/services");
    stopAll({ sandboxName });
  }
  try {
    fs.rmSync(`/tmp/nemoclaw-services-${sandboxName}`, { recursive: true, force: true });
  } catch {
    // PID directory may not exist — ignore.
  }

  // Delete messaging providers created during onboard.
  for (const suffix of ["telegram-bridge", "discord-bridge", "slack-bridge"]) {
    runOpenshell(["provider", "delete", `${sandboxName}-${suffix}`], { ignoreError: true });
  }
}

async function sandboxDestroy(sandboxName, args = []) {
  const skipConfirm = args.includes("--yes") || args.includes("--force");
  if (!skipConfirm) {
    console.log(`  ${YW}Destroy sandbox '${sandboxName}'?${R}`);
    console.log("  This will permanently delete the sandbox and all workspace files inside it.");
    console.log("  This cannot be undone.");
    const answer = await askPrompt("  Type 'yes' to confirm, or press Enter to cancel [y/N]: ");
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
  const deleteResult = runOpenshell(["sandbox", "delete", sandboxName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { output: deleteOutput, alreadyGone } = getSandboxDeleteOutcome(deleteResult);

  if (deleteResult.status !== 0 && !alreadyGone) {
    if (deleteOutput) {
      console.error(`  ${deleteOutput}`);
    }
    console.error(`  Failed to destroy sandbox '${sandboxName}'.`);
    process.exit(deleteResult.status || 1);
  }

  const shouldStopHostServices =
    (deleteResult.status === 0 || alreadyGone) &&
    registry.listSandboxes().sandboxes.length === 1 &&
    !!registry.getSandbox(sandboxName);

  cleanupSandboxServices(sandboxName, { stopHostServices: shouldStopHostServices });

  const removed = registry.removeSandbox(sandboxName);
  const session = onboardSession.loadSession();
  if (session && session.sandboxName === sandboxName) {
    onboardSession.updateSession((s) => {
      s.sandboxName = null;
      return s;
    });
  }
  if (
    (deleteResult.status === 0 || alreadyGone) &&
    removed &&
    registry.listSandboxes().sandboxes.length === 0 &&
    hasNoLiveSandboxes()
  ) {
    cleanupGatewayAfterLastSandbox();
  }
  if (alreadyGone) {
    console.log(`  Sandbox '${sandboxName}' was already absent from the live gateway.`);
  }
  console.log(`  ${G}✓${R} Sandbox '${sandboxName}' destroyed`);
}

// ── Rebuild ──────────────────────────────────────────────────────

function _rebuildLog(msg) {
  console.error(`  ${D}[rebuild ${new Date().toISOString()}] ${msg}${R}`);
}

async function sandboxRebuild(sandboxName, args = []) {
  const verbose = args.includes("--verbose") || args.includes("-v") || process.env.NEMOCLAW_REBUILD_VERBOSE === "1";
  const log = verbose ? _rebuildLog : () => {};
  const skipConfirm = args.includes("--yes") || args.includes("--force");
  const sb = registry.getSandbox(sandboxName);
  if (!sb) {
    console.error(`  Sandbox '${sandboxName}' not found in registry.`);
    process.exit(1);
  }

  // Multi-agent guard (temporary — until swarm lands)
  if (sb.agents && sb.agents.length > 1) {
    console.error("  Multi-agent sandbox rebuild is not yet supported.");
    console.error("  Back up state manually and recreate with `nemoclaw onboard`.");
    process.exit(1);
  }

  const agent = agentRuntime.getSessionAgent(sandboxName);
  const agentName = agentRuntime.getAgentDisplayName(agent);

  // Version check — show what's changing
  const versionCheck = sandboxVersion.checkAgentVersion(sandboxName);
  console.log("");
  console.log(`  ${B}Rebuild sandbox '${sandboxName}'${R}`);
  if (versionCheck.sandboxVersion) {
    console.log(`    Current:  ${agentName} v${versionCheck.sandboxVersion}`);
  }
  if (versionCheck.expectedVersion) {
    console.log(`    Target:   ${agentName} v${versionCheck.expectedVersion}`);
  }
  console.log("");

  if (!skipConfirm) {
    console.log("  This will:");
    console.log("    1. Back up workspace state");
    console.log("    2. Destroy and recreate the sandbox with the current image");
    console.log("    3. Restore workspace state into the new sandbox");
    console.log("");
    const answer = await askPrompt("  Proceed? [y/N]: ");
    if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
      console.log("  Cancelled.");
      return;
    }
  }

  // Step 1: Ensure sandbox is live for backup
  log("Checking sandbox liveness: openshell sandbox list");
  const isLive = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  log(`openshell sandbox list exit=${isLive.status}, output=${(isLive.output || "").substring(0, 200)}`);
  const liveNames = parseLiveSandboxNames(isLive.output || "");
  log(`Live sandboxes: ${Array.from(liveNames).join(", ") || "(none)"}`);
  if (!liveNames.has(sandboxName)) {
    console.error(`  Sandbox '${sandboxName}' is not running. Cannot back up state.`);
    console.error("  Start it first or recreate with `nemoclaw onboard --recreate-sandbox`.");
    process.exit(1);
  }

  // Step 2: Backup
  console.log("  Backing up sandbox state...");
  log(`Agent type: ${sb.agent || "openclaw"}, stateDirs from manifest`);
  const backup = sandboxState.backupSandboxState(sandboxName);
  log(`Backup result: success=${backup.success}, backed=${backup.backedUpDirs.join(",")}, failed=${backup.failedDirs.join(",")}`);
  if (!backup.success) {
    console.error("  Failed to back up sandbox state.");
    if (backup.backedUpDirs.length > 0) {
      console.error(`  Partial backup: ${backup.backedUpDirs.join(", ")}`);
    }
    if (backup.failedDirs.length > 0) {
      console.error(`  Failed: ${backup.failedDirs.join(", ")}`);
    }
    console.error("  Aborting rebuild to prevent data loss.");
    process.exit(1);
  }
  console.log(`  ${G}\u2713${R} State backed up (${backup.backedUpDirs.length} directories)`);
  console.log(`    Backup: ${backup.manifest.backupPath}`);

  // Step 3: Delete sandbox without tearing down gateway or session.
  // sandboxDestroy() cleans up the gateway when it's the last sandbox and
  // nulls session.sandboxName — both break the immediate onboard --resume.
  console.log("  Deleting old sandbox...");
  const sbMeta = registry.getSandbox(sandboxName);
  log(`Registry entry: agent=${sbMeta?.agent}, agentVersion=${sbMeta?.agentVersion}, nimContainer=${sbMeta?.nimContainer}`);
  if (sbMeta && sbMeta.nimContainer) nim.stopNimContainerByName(sbMeta.nimContainer);
  else nim.stopNimContainer(sandboxName);

  log(`Running: openshell sandbox delete ${sandboxName}`);
  const deleteResult = runOpenshell(["sandbox", "delete", sandboxName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { alreadyGone } = getSandboxDeleteOutcome(deleteResult);
  log(`Delete result: exit=${deleteResult.status}, alreadyGone=${alreadyGone}`);
  if (deleteResult.status !== 0 && !alreadyGone) {
    console.error("  Failed to delete sandbox. Aborting rebuild.");
    console.error("  State backup is preserved at: " + backup.manifest.backupPath);
    process.exit(deleteResult.status || 1);
  }
  registry.removeSandbox(sandboxName);
  log(`Registry after remove: ${JSON.stringify(registry.listSandboxes().sandboxes.map(s => s.name))}`);
  console.log(`  ${G}\u2713${R} Old sandbox deleted`);

  // Step 4: Recreate via onboard --resume
  console.log("");
  console.log("  Creating new sandbox with current image...");

  // Force the sandbox name so onboard recreates with the same name.
  // Mark session resumable and point at this sandbox; set env var as fallback.
  const sessionBefore = onboardSession.loadSession();
  log(`Session before update: sandboxName=${sessionBefore?.sandboxName}, status=${sessionBefore?.status}, resumable=${sessionBefore?.resumable}, provider=${sessionBefore?.provider}, model=${sessionBefore?.model}`);

  onboardSession.updateSession((s) => {
    s.sandboxName = sandboxName;
    s.resumable = true;
    s.status = "in_progress";
    return s;
  });
  process.env.NEMOCLAW_SANDBOX_NAME = sandboxName;

  const sessionAfter = onboardSession.loadSession();
  log(`Session after update: sandboxName=${sessionAfter?.sandboxName}, status=${sessionAfter?.status}, resumable=${sessionAfter?.resumable}, provider=${sessionAfter?.provider}, model=${sessionAfter?.model}`);
  log(`Env: NEMOCLAW_SANDBOX_NAME=${process.env.NEMOCLAW_SANDBOX_NAME}, NEMOCLAW_RECREATE_SANDBOX=${process.env.NEMOCLAW_RECREATE_SANDBOX}`);
  log("Calling onboard({ resume: true, nonInteractive: true, recreateSandbox: true })");

  const { onboard } = require("./lib/onboard");
  await onboard({
    resume: true,
    nonInteractive: true,
    recreateSandbox: true,
  });

  log("onboard() returned successfully");

  // Step 5: Restore
  console.log("");
  console.log("  Restoring workspace state...");
  log(`Restoring from: ${backup.manifest.backupPath} into sandbox: ${sandboxName}`);
  const restore = sandboxState.restoreSandboxState(sandboxName, backup.manifest.backupPath);
  log(`Restore result: success=${restore.success}, restored=${restore.restoredDirs.join(",")}, failed=${restore.failedDirs.join(",")}`);
  if (!restore.success) {
    console.error(`  Partial restore: ${restore.restoredDirs.join(", ") || "none"}`);
    console.error(`  Failed: ${restore.failedDirs.join(", ")}`);
    console.error(`  Manual restore available from: ${backup.manifest.backupPath}`);
  } else {
    console.log(`  ${G}\u2713${R} State restored (${restore.restoredDirs.length} directories)`);
  }

  // Step 6: Post-restore agent-specific migration
  const agentDef = agent ? require("./lib/agent-defs").loadAgent(agent.name) : require("./lib/agent-defs").loadAgent("openclaw");
  if (agentDef.name === "openclaw") {
    // openclaw doctor --fix validates and repairs directory structure.
    // Idempotent and safe — catches structural changes between OpenClaw versions
    // (new symlinks, new data dirs, etc.) that the restored state may be missing.
    log("Running openclaw doctor --fix inside sandbox for post-upgrade structure repair");
    const doctorResult = executeSandboxCommand(sandboxName, "openclaw doctor --fix");
    log(`doctor --fix: exit=${doctorResult?.status}, stdout=${(doctorResult?.stdout || "").substring(0, 200)}`);
    if (doctorResult && doctorResult.status === 0) {
      console.log(`  ${G}\u2713${R} Post-upgrade structure check passed`);
    } else {
      console.log(`  ${D}Post-upgrade structure check skipped (doctor returned ${doctorResult?.status ?? "null"})${R}`);
    }
  }
  // Hermes: no explicit post-restore step needed. Hermes's SessionDB._init_schema()
  // auto-migrates state.db (SQLite) on first connection via sequential ALTER TABLE
  // migrations (idempotent, schema_version tracked). ensure_hermes_home() repairs
  // missing directories implicitly. The NemoClaw plugin's skill cache refreshes on
  // on_session_start. Gateway startup is non-fatal if state.db migration fails.

  // Step 7: Update registry with new version
  registry.updateSandbox(sandboxName, {
    agentVersion: agentDef.expectedVersion || null,
  });
  log(`Registry updated: agentVersion=${agentDef.expectedVersion}`);

  console.log("");
  if (restore.success) {
    console.log(`  ${G}\u2713${R} Sandbox '${sandboxName}' rebuilt successfully`);
    if (versionCheck.expectedVersion) {
      console.log(`    Now running: ${agentName} v${versionCheck.expectedVersion}`);
    }
  } else {
    console.log(`  ${YW}\u26a0${R} Sandbox '${sandboxName}' rebuilt but state restore was incomplete`);
    console.log(`    Backup available at: ${backup.manifest.backupPath}`);
  }
}

// ── Pre-upgrade backup ───────────────────────────────────────────

/**
 * Back up all registered sandboxes. Called by install.sh before upgrading
 * NemoClaw or OpenShell so sandbox state is recoverable if the upgrade
 * destroys sandbox contents.
 */
function backupAll() {
  const { sandboxes } = registry.listSandboxes();
  if (sandboxes.length === 0) {
    console.log("  No sandboxes registered. Nothing to back up.");
    return;
  }

  // Check which sandboxes are actually live
  const liveList = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  const liveNames = parseLiveSandboxNames(liveList.output || "");

  let backed = 0;
  let failed = 0;
  let skipped = 0;
  for (const sb of sandboxes) {
    if (!liveNames.has(sb.name)) {
      console.log(`  ${D}Skipping '${sb.name}' (not running)${R}`);
      skipped++;
      continue;
    }
    console.log(`  Backing up '${sb.name}'...`);
    const result = sandboxState.backupSandboxState(sb.name);
    if (result.success) {
      console.log(`  ${G}\u2713${R} ${sb.name}: ${result.backedUpDirs.length} dirs → ${result.manifest.backupPath}`);
      backed++;
    } else {
      console.error(`  ${_RD}✗${R} ${sb.name}: backup failed (${result.failedDirs.join(", ")})`);
      failed++;
    }
  }
  console.log("");
  console.log(`  Pre-upgrade backup: ${backed} backed up, ${failed} failed, ${skipped} skipped`);
  if (backed > 0) {
    console.log(`  Backups stored in: ~/.nemoclaw/rebuild-backups/`);
  }
  // Exit non-zero if any live sandbox failed to back up — the upgrade hook
  // in install.sh treats this as non-fatal but logs a warning.
  if (failed > 0) {
    process.exit(1);
  }
}

// ── Help ─────────────────────────────────────────────────────────

function help() {
  console.log(`
  ${B}${G}NemoClaw${R}  ${D}v${getVersion()}${R}
  ${D}Deploy more secure, always-on AI assistants with a single command.${R}

  ${G}Getting Started:${R}
    ${B}nemoclaw onboard${R}                 Configure inference endpoint and credentials
    nemoclaw onboard ${D}--from <Dockerfile>${R}  Use a custom Dockerfile for the sandbox image
                                    ${D}(non-interactive: ${NOTICE_ACCEPT_FLAG} or ${NOTICE_ACCEPT_ENV}=1)${R}

  ${G}Sandbox Management:${R}
    ${B}nemoclaw list${R}                    List all sandboxes
    nemoclaw <name> connect          Shell into a running sandbox
    nemoclaw <name> status           Sandbox health + NIM status
    nemoclaw <name> logs ${D}[--follow]${R}  Stream sandbox logs
    nemoclaw <name> rebuild          Upgrade sandbox to current agent version ${D}(--yes to skip prompt)${R}
    nemoclaw <name> destroy          Stop NIM + delete sandbox ${D}(--yes to skip prompt)${R}

  ${G}Skills:${R}
    nemoclaw <name> skill install <path>  Deploy a skill directory to the sandbox

  ${G}Policy Presets:${R}
    nemoclaw <name> policy-add       Add a network or filesystem policy preset ${D}(--dry-run to preview)${R}
    nemoclaw <name> policy-list      List presets ${D}(● = applied)${R}

  ${G}Compatibility Commands:${R}
    nemoclaw setup                   Deprecated alias for ${B}nemoclaw onboard${R}
    nemoclaw setup-spark             Deprecated alias for ${B}nemoclaw onboard${R}
    nemoclaw deploy <instance>       Deprecated Brev-specific bootstrap path

  ${G}Services:${R}
    nemoclaw start                   Start auxiliary services ${D}(Telegram, tunnel)${R}
    nemoclaw stop                    Stop all services
    nemoclaw status                  Show sandbox list and service status

  Troubleshooting:
    nemoclaw debug [--quick]         Collect diagnostics for bug reports
    nemoclaw debug --output FILE     Save diagnostics tarball for GitHub issues

  ${G}Credentials:${R}
    nemoclaw credentials list        List stored credential keys
    nemoclaw credentials reset <KEY> Remove a stored credential so onboard re-prompts

  ${G}Backup:${R}
    nemoclaw backup-all              Back up all sandbox state before upgrade

  Cleanup:
    nemoclaw uninstall [flags]       Run uninstall.sh (local only; no remote fallback)

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

// eslint-disable-next-line complexity
(async () => {
  // No command → help
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help();
    return;
  }

  // Global commands
  if (GLOBAL_COMMANDS.has(cmd)) {
    switch (cmd) {
      case "onboard":
        await onboard(args);
        break;
      case "setup":
        await setup(args);
        break;
      case "setup-spark":
        await setupSpark(args);
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
      case "credentials":
        await credentialsCommand(args);
        break;
      case "list":
        await listSandboxes();
        break;
      case "backup-all":
        backupAll();
        break;
      case "--version":
      case "-v": {
        console.log(`nemoclaw v${getVersion()}`);
        break;
      }
      default:
        help();
        break;
    }
    return;
  }

  // Sandbox-scoped commands: nemoclaw <name> <action>
  // If the registry doesn't know this name but the action is connect or skill,
  // attempt recovery — the sandbox may still be live with a stale registry.
  if (!registry.getSandbox(cmd) && (args[0] === "connect" || args[0] === "skill")) {
    validateName(cmd, "sandbox name");
    await recoverRegistryEntries({ requestedSandboxName: cmd });
  }
  const sandbox = registry.getSandbox(cmd);
  if (sandbox) {
    validateName(cmd, "sandbox name");
    const action = args[0] || "connect";
    const actionArgs = args.slice(1);

    switch (action) {
      case "connect":
        await sandboxConnect(cmd, {
          dangerouslySkipPermissions: actionArgs.includes("--dangerously-skip-permissions"),
        });
        break;
      case "status":
        await sandboxStatus(cmd);
        break;
      case "logs":
        sandboxLogs(cmd, actionArgs.includes("--follow"));
        break;
      case "policy-add":
        await sandboxPolicyAdd(cmd, actionArgs);
        break;
      case "policy-list":
        sandboxPolicyList(cmd);
        break;
      case "destroy":
        await sandboxDestroy(cmd, actionArgs);
        break;
      case "skill":
        await sandboxSkillInstall(cmd, actionArgs);
        break;
      case "rebuild":
        await sandboxRebuild(cmd, actionArgs);
        break;
      default:
        console.error(`  Unknown action: ${action}`);
        console.error(`  Valid actions: connect, status, logs, policy-add, policy-list, skill, rebuild, destroy`);
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
