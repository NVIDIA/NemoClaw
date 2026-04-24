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
const { startGatewayForRecovery, pruneKnownHostsEntries } = require("./lib/onboard");
const {
  getCredential,
  deleteCredential,
  listCredentialKeys,
  prompt: askPrompt,
} = require("./lib/credentials");
const registry = require("./lib/registry");
const nim = require("./lib/nim");
const policies = require("./lib/policies");
const shields = require("./lib/shields");
const sandboxConfig = require("./lib/sandbox-config");
const { parseGatewayInference } = require("./lib/inference-config");
const { probeProviderHealth } = require("./lib/inference-health");
const { getVersion } = require("./lib/version");
const onboardSession = require("./lib/onboard-session");
const { parseLiveSandboxNames } = require("./lib/runtime-recovery");
const { NOTICE_ACCEPT_ENV, NOTICE_ACCEPT_FLAG } = require("./lib/usage-notice");
const { runDebugCommand } = require("./lib/debug-command");
const { runDeprecatedOnboardAliasCommand, runOnboardCommand } = require("./lib/onboard-command");
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
const { buildVersionedUninstallUrl, runUninstallCommand } = require("./lib/uninstall-command");
const agentRuntime = require("../bin/lib/agent-runtime");
const sandboxVersion = require("./lib/sandbox-version");
const sandboxState = require("./lib/sandbox-state");
const { parseRestoreArgs } = sandboxState;
const { ensureOllamaAuthProxy } = require("./lib/onboard");
const skillInstall = require("./lib/skill-install");
const { sleepSeconds } = require("./lib/wait");
const { parseSandboxPhase } = require("./lib/gateway-state");
const {
  getActiveSandboxSessions,
  createSystemDeps: createSessionDeps,
} = require("./lib/sandbox-session-state");

import {
  KNOWN_CHANNELS,
  clearChannelTokens,
  getChannelDef,
  getChannelTokenKeys,
  knownChannelNames,
  persistChannelTokens,
} from "./lib/sandbox-channels";
import { isNonInteractive } from "./lib/onboard";

// ── Global commands ──────────────────────────────────────────────

const GLOBAL_COMMANDS = new Set([
  "onboard",
  "list",
  "deploy",
  "setup",
  "setup-spark",
  "start",
  "stop",
  "tunnel",
  "status",
  "debug",
  "uninstall",
  "credentials",
  "backup-all",
  "upgrade-sandboxes",
  "gc",
  "help",
  "--help",
  "-h",
  "--version",
  "-v",
]);

const REMOTE_UNINSTALL_URL = buildVersionedUninstallUrl(getVersion());
let OPENSHELL_BIN = null;
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
  const agentScript = agentRuntime.buildRecoveryScript(agent, agent?.forwardPort ?? DASHBOARD_PORT);
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
      `nohup "$OPENCLAW" gateway run --port ${DASHBOARD_PORT} > /tmp/gateway.log 2>&1 &`,
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
    console.log(
      `  ${agentRuntime.getAgentDisplayName(_recoveryAgent)} gateway is not running inside the sandbox (sandbox likely restarted).`,
    );
    console.log("  Recovering...");
  }

  const recovered = recoverSandboxProcesses(sandboxName);
  if (recovered) {
    // Wait for gateway to bind its HTTP port before declaring success
    sleepSeconds(3);
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
      console.log(
        `  ${G}✓${R} ${agentRuntime.getAgentDisplayName(_recoveryAgent)} gateway restarted inside sandbox.`,
      );
      console.log(`  ${G}✓${R} Dashboard port forward re-established.`);
    }
  } else if (!quiet) {
    console.error(
      `  Could not restart ${agentRuntime.getAgentDisplayName(_recoveryAgent)} gateway automatically.`,
    );
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
  const shouldProbeLiveGateway =
    current.sandboxes.length > 0 || Boolean(session?.sandboxName) || Boolean(requestedSandboxName);
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
    return {
      state: "healthy_named",
      status: status.output,
      gatewayInfo: gatewayInfo.output,
      activeGateway,
    };
  }
  if (activeGateway === "nemoclaw" && named && refusing) {
    return {
      state: "named_unreachable",
      status: status.output,
      gatewayInfo: gatewayInfo.output,
      activeGateway,
    };
  }
  if (activeGateway === "nemoclaw" && named) {
    return {
      state: "named_unhealthy",
      status: status.output,
      gatewayInfo: gatewayInfo.output,
      activeGateway,
    };
  }
  if (connected) {
    return {
      state: "connected_other",
      status: status.output,
      gatewayInfo: gatewayInfo.output,
      activeGateway,
    };
  }
  return {
    state: "missing_named",
    status: status.output,
    gatewayInfo: gatewayInfo.output,
    activeGateway,
  };
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
        const yamlPart =
          delimIdx !== -1
            ? livePolicy.output.slice(delimIdx).replace(/^---\s*[\r\n]+/, "")
            : livePolicy.output;
        // Guard: only replace if the extracted content looks like policy YAML
        // (starts with a YAML key like "version:" or "network_policies:").
        // Avoids replacing with warnings or status text from unexpected output.
        const trimmedYaml = yamlPart.trim();
        const looksLikeError = /^(error|failed|invalid|warning|status)\b/i.test(trimmedYaml);
        if (trimmedYaml && !looksLikeError && /^[a-z_][a-z0-9_]*\s*:/m.test(trimmedYaml)) {
          // Add 2-space indent to match the original sandbox get output format.
          const indented = trimmedYaml
            .split("\n")
            .map((l) => (l ? "  " + l : l))
            .join("\n");
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

/**
 * Reconcile a NotFound sandbox lookup against the named NemoClaw gateway state.
 * When the active OpenShell gateway has drifted off nemoclaw, a NotFound is
 * ambiguous: the sandbox may actually be registered against the nemoclaw
 * gateway but invisible because some other gateway is currently active. This
 * helper self-heals by attempting `openshell gateway select nemoclaw` and
 * re-queries, or returns a `wrong_gateway_active` state so callers can surface
 * actionable guidance instead of destroying the registry entry.
 */
function reconcileMissingAgainstNamedGateway(sandboxName, missingLookup) {
  const lifecycle = getNamedGatewayLifecycleState();
  if (lifecycle.state === "connected_other") {
    runOpenshell(["gateway", "select", "nemoclaw"], { ignoreError: true });
    const retry = getSandboxGatewayState(sandboxName);
    if (retry.state === "present") {
      return { ...retry, recoveredGateway: true, recoveryVia: "select" };
    }
    if (retry.state === "missing") {
      const after = getNamedGatewayLifecycleState();
      if (after.state === "healthy_named") {
        return retry;
      }
    }
    return {
      state: "wrong_gateway_active",
      activeGateway: lifecycle.activeGateway,
      output: lifecycle.status,
    };
  }
  if (lifecycle.state === "missing_named") {
    return { state: "gateway_missing_after_restart", output: lifecycle.status };
  }
  if (lifecycle.state === "named_unreachable" || lifecycle.state === "named_unhealthy") {
    return { state: "gateway_unreachable_after_restart", output: lifecycle.status };
  }
  return missingLookup;
}

/**
 * Print actionable guidance when the nemoclaw gateway exists but another
 * OpenShell gateway is currently active. Emphasizes that the sandbox has NOT
 * been removed and how to switch gateways before retrying. (#2276)
 */
function printWrongGatewayActiveGuidance(sandboxName, activeGateway, writer = console.error) {
  const other = activeGateway && activeGateway !== "nemoclaw" ? activeGateway : "another gateway";
  writer(
    `  Sandbox '${sandboxName}' is registered against the NemoClaw gateway, but the currently active OpenShell gateway is '${other}'. Your sandbox has NOT been removed.`,
  );
  writer("  Switch gateways and retry:");
  writer("      openshell gateway select nemoclaw");
  writer(`  Then re-run: nemoclaw ${sandboxName} connect`);
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
    return reconcileMissingAgainstNamedGateway(sandboxName, lookup);
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

async function ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase = false } = {}) {
  const lookup = await getReconciledSandboxGatewayState(sandboxName);
  if (lookup.state === "present") {
    const phase = parseSandboxPhase(lookup.output || "");
    if (!allowNonReadyPhase && phase && phase !== "Ready") {
      console.error(`  Sandbox '${sandboxName}' is stuck in '${phase}' phase.`);
      console.error(
        "  This usually happens when a process crash inside the sandbox prevented clean startup.",
      );
      console.error("");
      console.error(
        `  Run \`nemoclaw ${sandboxName} rebuild --yes\` to recreate the sandbox (--yes skips the confirmation prompt; workspace state will be preserved).`,
      );
      process.exit(1);
    }
    return lookup;
  }
  if (lookup.state === "missing") {
    // Belt-and-suspenders: only destroy registry state if the nemoclaw gateway
    // is demonstrably the healthy active gateway. The reconciler should have
    // already routed drift cases to `wrong_gateway_active`, but this guards
    // against future regressions.
    const guard = getNamedGatewayLifecycleState();
    if (guard.state !== "healthy_named") {
      if (guard.state === "connected_other") {
        printWrongGatewayActiveGuidance(sandboxName, guard.activeGateway, console.error);
      } else {
        printGatewayLifecycleHint(guard.status || "", sandboxName, console.error);
      }
      process.exit(1);
    }
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
  if (lookup.state === "wrong_gateway_active") {
    printWrongGatewayActiveGuidance(sandboxName, lookup.activeGateway, console.error);
    process.exit(1);
  }
  if (lookup.state === "identity_drift") {
    // Gateway SSH keys rotated after restart — clear stale known_hosts and retry.
    console.error("  Gateway SSH identity changed after restart — clearing stale host keys...");
    const knownHostsPath = path.join(os.homedir(), ".ssh", "known_hosts");
    if (fs.existsSync(knownHostsPath)) {
      try {
        const kh = fs.readFileSync(knownHostsPath, "utf8");
        const cleaned = pruneKnownHostsEntries(kh);
        if (cleaned !== kh) fs.writeFileSync(knownHostsPath, cleaned);
      } catch {
        /* best-effort cleanup */
      }
    }
    const retry = await getReconciledSandboxGatewayState(sandboxName);
    if (retry.state === "present") {
      console.error("  ✓ Reconnected after clearing stale SSH host keys.");
      return retry;
    }
    // Retry failed — fall through to error
    console.error(
      `  Could not reconnect to sandbox '${sandboxName}' after clearing stale host keys.`,
    );
    if (retry.output) {
      console.error(retry.output);
    }
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

/** Print user-facing guidance when OpenShell is too old to support `openshell logs`. */
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
  console.error(
    "  \u26a0  --dangerously-skip-permissions: sandbox security restrictions disabled.",
  );
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

async function tunnel(args) {
  const sub = args[0];
  switch (sub) {
    case "start":
      await start();
      return;
    case "stop":
      stop();
      return;
    default:
      console.error(`  Usage: nemoclaw tunnel <start|stop>`);
      process.exit(1);
  }
}

function debug(args) {
  const { runDebug } = require("./lib/debug");
  const getDefaultSandbox = (): string | undefined => {
    const { defaultSandbox, sandboxes } = registry.listSandboxes();
    if (!defaultSandbox) return undefined;
    if (!sandboxes.find((s) => s.name === defaultSandbox)) {
      console.error(
        `${_RD}Warning:${R} default sandbox '${defaultSandbox}' is no longer in the registry.`,
      );
      console.error(
        `  Use ${B}--sandbox NAME${R} to target a specific sandbox, or run ${B}nemoclaw onboard${R} again.\n`,
      );
      return undefined;
    }
    const liveList = captureOpenshell(["sandbox", "list"], { ignoreError: true });
    if (liveList.status === 0 && !parseLiveSandboxNames(liveList.output).has(defaultSandbox)) {
      console.error(
        `${_RD}Warning:${R} default sandbox '${defaultSandbox}' exists in the local registry but not in OpenShell.`,
      );
      console.error(
        `  Use ${B}--sandbox NAME${R} to target a specific sandbox, or run ${B}nemoclaw onboard${R} again.\n`,
      );
      return undefined;
    }
    return defaultSandbox;
  };
  runDebugCommand(args, {
    getDefaultSandbox,
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

/**
 * Inspect gateway logs for known Telegram conflict signatures without blocking
 * the broader status command when the probe cannot run.
 */
function checkMessagingBridgeHealth(sandboxName, channels) {
  // Only Telegram currently emits a recognizable conflict signature in the
  // gateway log. Discord/Slack have similar single-consumer constraints but
  // log differently; we can extend the regex when those patterns are known.
  if (!Array.isArray(channels) || !channels.includes("telegram")) return [];
  const { spawnSync } = require("child_process");
  const script =
    'tail -n 200 /tmp/gateway.log 2>/dev/null | grep -cE "getUpdates conflict|409[[:space:]:]+Conflict" || true';
  try {
    const result = spawnSync(
      getOpenshellBinary(),
      ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-c", script],
      { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const count = Number.parseInt((result.stdout || "").trim(), 10);
    if (!Number.isFinite(count) || count === 0) return [];
    return [{ channel: "telegram", conflicts: count }];
  } catch {
    return [];
  }
}

function makeConflictProbe() {
  // Upfront liveness check so we can distinguish "provider not attached" from
  // "gateway unreachable". Without this, every non-zero `openshell provider
  // get` collapses into "absent", and a transient gateway failure would
  // persist messagingChannels: [] and permanently suppress future retries.
  let gatewayAlive: boolean | null = null;
  const isGatewayAlive = () => {
    if (gatewayAlive === null) {
      const result = captureOpenshell(["sandbox", "list"], { ignoreError: true });
      gatewayAlive = result.status === 0;
    }
    return gatewayAlive;
  };
  return {
    providerExists: (name) => {
      if (!isGatewayAlive()) return "error";
      const result = captureOpenshell(["provider", "get", name], { ignoreError: true });
      return result.status === 0 ? "present" : "absent";
    },
  };
}

function backfillAndFindOverlaps() {
  // Non-critical path: status must remain usable even if the gateway probe or
  // registry write throws, so any failure yields an empty overlap list.
  try {
    const {
      backfillMessagingChannels,
      findAllOverlaps,
    } = require("./lib/messaging-conflict");
    backfillMessagingChannels(registry, makeConflictProbe());
    return findAllOverlaps(registry);
  } catch {
    return [];
  }
}

/**
 * Read a short tail of the gateway log for degraded messaging diagnostics.
 */
function readGatewayLog(sandboxName) {
  const { spawnSync } = require("child_process");
  try {
    const result = spawnSync(
      getOpenshellBinary(),
      ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-c", "tail -n 10 /tmp/gateway.log 2>/dev/null"],
      { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const output = (result.stdout || "").trim();
    return output || null;
  } catch {
    return null;
  }
}

function showStatus() {
  const { showStatus: showServiceStatus } = require("./lib/services");
  showStatusCommand({
    listSandboxes: () => registry.listSandboxes(),
    getLiveInference: () =>
      parseGatewayInference(captureOpenshell(["inference", "get"], { ignoreError: true }).output),
    showServiceStatus,
    checkMessagingBridgeHealth,
    backfillAndFindOverlaps,
    readGatewayLog,
    log: console.log,
  });
}

async function listSandboxes() {
  const opsBinList = resolveOpenshell();
  const sessionDeps = opsBinList ? createSessionDeps(opsBinList) : null;

  // Cache the SSH process probe once for all sandboxes — avoids spawning ps
  // per sandbox row. The getSshProcesses() call is the expensive part (5s timeout).
  let cachedSshOutput: string | null | undefined;
  const getCachedSshOutput = () => {
    if (cachedSshOutput === undefined && sessionDeps) {
      cachedSshOutput = sessionDeps.getSshProcesses();
    }
    return cachedSshOutput ?? null;
  };

  await listSandboxesCommand({
    recoverRegistryEntries: () => recoverRegistryEntries(),
    getLiveInference: () =>
      parseGatewayInference(captureOpenshell(["inference", "get"], { ignoreError: true }).output),
    loadLastSession: () => onboardSession.loadSession(),
    getActiveSessionCount: sessionDeps
      ? (name) => {
          try {
            const sshOutput = getCachedSshOutput();
            if (sshOutput === null) return null;
            const { parseSshProcesses } = require("./lib/sandbox-session-state");
            return parseSshProcesses(sshOutput, name).length;
          } catch {
            return null;
          }
        }
      : undefined,
    log: console.log,
  });
}

// ── Sandbox-scoped actions ───────────────────────────────────────

async function sandboxConnect(sandboxName, { dangerouslySkipPermissions = false } = {}) {
  const { isSandboxReady, parseSandboxStatus } = require("./lib/onboard");
  await ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase: true });

  // Version staleness check — warn but don't block
  try {
    const versionCheck = sandboxVersion.checkAgentVersion(sandboxName);
    if (versionCheck.isStale) {
      for (const line of sandboxVersion.formatStalenessWarning(sandboxName, versionCheck)) {
        console.error(line);
      }
    }
  } catch {
    /* non-fatal — don't block connect on version check failure */
  }

  // Active session hint — inform if already connected in another terminal
  try {
    const opsBinConnect = resolveOpenshell();
    if (opsBinConnect) {
      const sessionResult = getActiveSandboxSessions(sandboxName, createSessionDeps(opsBinConnect));
      if (sessionResult.detected && sessionResult.sessions.length > 0) {
        const count = sessionResult.sessions.length;
        console.log(
          `  ${D}Note: ${count} existing SSH session${count > 1 ? "s" : ""} to '${sandboxName}' detected (another terminal).${R}`,
        );
      }
    }
  } catch {
    /* non-fatal — don't block connect on session detection failure */
  }

  // Check both the CLI flag and the registry for dangerously-skip-permissions.
  // The registry flag persists from onboard, so subsequent connects without
  // the CLI flag still enter permanent shields-down state.
  const sb = registry.getSandbox(sandboxName);
  const effectiveSkipPerms = dangerouslySkipPermissions || sb?.dangerouslySkipPermissions;
  if (effectiveSkipPerms) {
    printDangerouslySkipPermissionsWarning();
    shields.shieldsDownPermanent(sandboxName);
  }
  checkAndRecoverSandboxProcesses(sandboxName);
  // Ensure Ollama auth proxy is running (recovers from host reboots)
  ensureOllamaAuthProxy();

  // ── Inference route swap (#1248) ──────────────────────────────────
  // When the user has multiple sandboxes with different providers, the
  // cluster-wide inference.local route may still point at the *other*
  // provider. Re-set it to match this sandbox's persisted config.
  try {
    const sb = registry.getSandbox(sandboxName);
    if (sb && sb.provider && sb.model) {
      const live = parseGatewayInference(
        captureOpenshell(["inference", "get"], { ignoreError: true }).output,
      );
      if (!live || live.provider !== sb.provider || live.model !== sb.model) {
        console.log(
          `  Switching inference route to ${sb.provider}/${sb.model} for sandbox '${sandboxName}'`,
        );
        const swapResult = runOpenshell(
          ["inference", "set", "--provider", sb.provider, "--model", sb.model, "--no-verify"],
          { ignoreError: true },
        );
        if (swapResult.status !== 0) {
          console.error(
            `  ${YW}Warning: failed to switch inference route — connect will proceed anyway.${R}`,
          );
        }
      }
    }
  } catch {
    /* non-fatal — don't block connect on inference route swap failure */
  }

  const rawTimeout = process.env.NEMOCLAW_CONNECT_TIMEOUT;
  let timeout = 120;
  if (rawTimeout !== undefined) {
    const parsed = parseInt(rawTimeout, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      console.warn(`  Warning: invalid NEMOCLAW_CONNECT_TIMEOUT="${rawTimeout}", using default 120s`);
    } else {
      timeout = parsed;
    }
  }
  const interval = 3;
  const startedAt = Date.now();
  const deadline = startedAt + timeout * 1000;
  const elapsedSec = () => Math.floor((Date.now() - startedAt) / 1000);
  const remainingMs = () => Math.max(1, deadline - Date.now());
  const runSandboxList = () =>
    captureOpenshell(["sandbox", "list"], {
      ignoreError: true,
      timeout: remainingMs(),
    }).output;

  const list = runSandboxList();
  if (!isSandboxReady(list, sandboxName)) {
    const status = parseSandboxStatus(list, sandboxName);
    const TERMINAL = new Set([
      "Failed",
      "Error",
      "CrashLoopBackOff",
      "ImagePullBackOff",
      "Unknown",
      "Evicted",
    ]);
    if (status && TERMINAL.has(status)) {
      console.error("");
      console.error(`  Sandbox '${sandboxName}' is in '${status}' state.`);
      console.error(`  Run:  nemoclaw ${sandboxName} logs --follow`);
      console.error(`  Run:  nemoclaw ${sandboxName} status`);
      process.exit(1);
    }

    console.log(`  Waiting for sandbox '${sandboxName}' to be ready...`);
    let ready = false;
    let everSeen = status !== null;
    while (Date.now() < deadline) {
      const sleepFor = Math.min(interval, remainingMs() / 1000);
      if (sleepFor <= 0) break;
      spawnSync("sleep", [String(sleepFor)]);
      const poll = runSandboxList();
      const elapsed = elapsedSec();
      if (isSandboxReady(poll, sandboxName)) {
        ready = true;
        break;
      }
      const cur = parseSandboxStatus(poll, sandboxName) || "unknown";
      if (cur !== "unknown") everSeen = true;
      if (TERMINAL.has(cur)) {
        console.error("");
        console.error(`  Sandbox '${sandboxName}' entered '${cur}' state.`);
        console.error(`  Run:  nemoclaw ${sandboxName} logs --follow`);
        console.error(`  Run:  nemoclaw ${sandboxName} status`);
        process.exit(1);
      }
      if (!everSeen && elapsed >= 30) {
        console.error("");
        console.error(`  Sandbox '${sandboxName}' not found after ${elapsed}s.`);
        console.error(`  Check: openshell sandbox list`);
        process.exit(1);
      }
      process.stdout.write(`\r    Status: ${cur.padEnd(20)} (${elapsed}s elapsed)`);
    }

    if (!ready) {
      console.error("");
      console.error(`  Timed out after ${timeout}s waiting for sandbox '${sandboxName}'.`);
      console.error(`  Check: openshell sandbox list`);
      console.error(`  Override timeout: NEMOCLAW_CONNECT_TIMEOUT=300 nemoclaw ${sandboxName} connect`);
      process.exit(1);
    }
    console.log(`\r    Status: ${"Ready".padEnd(20)} (${elapsedSec()}s elapsed)`);
    console.log("  Sandbox is ready. Connecting...");
  }

  // Print a one-shot hint before dropping the user into the sandbox
  // shell so a fresh user knows the first thing to type. Without this,
  // `nemoclaw <name> connect` lands on a bare bash prompt and users
  // ask "now what?" — see #465. Suppress the hint when stdout isn't a
  // TTY so scripted callers don't get noise in their pipelines.
  if (
    process.stdout.isTTY &&
    !["1", "true"].includes(String(process.env.NEMOCLAW_NO_CONNECT_HINT || ""))
  ) {
    console.log("");
    const agentName = sb?.agent || "openclaw";
    const agentCmd = agentName === "openclaw" ? "openclaw tui" : agentName;
    console.log(`  ${G}✓${R} Connecting to sandbox '${sandboxName}'`);
    console.log(
      `  ${D}Inside the sandbox, run \`${agentCmd}\` to start chatting with the agent.${R}`,
    );
    console.log(`  ${D}Type \`/exit\` to leave the chat, then \`exit\` to return to the host shell.${R}`);
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
  const inferenceHealth =
    typeof currentProvider === "string" ? probeProviderHealth(currentProvider) : null;
  if (sb) {
    console.log("");
    console.log(`  Sandbox: ${sb.name}`);
    console.log(`    Model:    ${currentModel}`);
    console.log(`    Provider: ${currentProvider}`);
    if (inferenceHealth) {
      if (!inferenceHealth.probed) {
        console.log(`    Inference: ${D}not probed${R} (${inferenceHealth.detail})`);
      } else if (inferenceHealth.ok) {
        console.log(
          `    Inference: ${G}healthy${R} (${inferenceHealth.endpoint})`,
        );
      } else {
        console.log(
          `    Inference: ${_RD}unreachable${R} (${inferenceHealth.endpoint})`,
        );
        console.log(`      ${inferenceHealth.detail}`);
      }
    }
    console.log(`    GPU:      ${sb.gpuEnabled ? "yes" : "no"}`);
    console.log(`    Policies: ${(sb.policies || []).join(", ") || "none"}`);

    // Active session indicator
    try {
      const opsBinStatus = resolveOpenshell();
      if (opsBinStatus) {
        const sessionResult = getActiveSandboxSessions(sandboxName, createSessionDeps(opsBinStatus));
        if (sessionResult.detected) {
          const count = sessionResult.sessions.length;
          console.log(`    Connected: ${count > 0 ? `${G}yes${R} (${count} session${count > 1 ? "s" : ""})` : "no"}`);
        }
      }
    } catch {
      /* non-fatal */
    }

    if (sb.dangerouslySkipPermissions) {
      console.log(`    Permissions: dangerously-skip-permissions (shields permanently down)`);
    } else if (shields.isShieldsDown(sandboxName)) {
      console.log(`    Permissions: shields down (check \`shields status\` for details)`);
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
    } catch {
      /* non-fatal */
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
    const phase = parseSandboxPhase(lookup.output || "");
    if (phase && phase !== "Ready") {
      console.log("");
      console.log(`  Sandbox '${sandboxName}' is stuck in '${phase}' phase.`);
      console.log(
        "  This usually happens when a process crash inside the sandbox prevented clean startup.",
      );
      console.log("");
      console.log(
        `  Run \`nemoclaw ${sandboxName} rebuild --yes\` to recreate the sandbox (--yes skips the confirmation prompt; workspace state will be preserved).`,
      );
    }
  } else if (lookup.state === "wrong_gateway_active") {
    console.log("");
    printWrongGatewayActiveGuidance(sandboxName, lookup.activeGateway, console.log);
  } else if (lookup.state === "missing") {
    // Belt-and-suspenders: only destroy registry state if the nemoclaw gateway
    // is demonstrably the healthy active gateway. Guards against regressions
    // in the reconciler.
    const guard = getNamedGatewayLifecycleState();
    if (guard.state !== "healthy_named") {
      console.log("");
      if (guard.state === "connected_other") {
        printWrongGatewayActiveGuidance(sandboxName, guard.activeGateway, console.log);
      } else {
        printGatewayLifecycleHint(guard.status || "", sandboxName, console.log);
      }
    } else {
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
    }
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
  const args = buildSandboxLogsArgs(sandboxName, follow);

  const result = runOpenshell(args, {
    stdio: "inherit",
    ignoreError: true,
  });
  if (result.status !== 0) {
    console.error(`  Command failed (exit ${result.status}): openshell ${args.join(" ")}`);
  }
  exitWithSpawnResult(result);
}

function buildSandboxLogsArgs(sandboxName, follow) {
  const args = ["sandbox", "exec", "-n", sandboxName, "--", "tail", "-n", "200"];
  if (follow) {
    args.push("-f");
  }
  args.push("/tmp/gateway.log");
  return args;
}

async function sandboxPolicyAdd(sandboxName, args = []) {
  const dryRun = args.includes("--dry-run");
  const skipConfirm =
    args.includes("--yes") || args.includes("--force") || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  const presetArg = args.find((arg) => !arg.startsWith("-"));
  let answer = null;
  if (presetArg) {
    const normalized = presetArg.trim().toLowerCase();
    const preset = allPresets.find((item) => item.name === normalized);
    if (!preset) {
      console.error(`  Unknown preset '${presetArg}'.`);
      console.error(`  Valid presets: ${allPresets.map((item) => item.name).join(", ")}`);
      process.exit(1);
    }
    if (applied.includes(preset.name)) {
      console.error(`  Preset '${preset.name}' is already applied.`);
      process.exit(1);
    }
    answer = preset.name;
  } else {
    if (process.env.NEMOCLAW_NON_INTERACTIVE === "1") {
      console.error("  Non-interactive mode requires a preset name.");
      console.error("  Usage: nemoclaw <sandbox> policy-add <preset> [--yes] [--dry-run]");
      process.exit(1);
    }
    answer = await policies.selectFromList(allPresets, { applied });
  }
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

  if (!skipConfirm) {
    const confirm = await askPrompt(`  Apply '${answer}' to sandbox '${sandboxName}'? [Y/n]: `);
    if (confirm.toLowerCase() === "n") return;
  }

  policies.applyPreset(sandboxName, answer);
}

function sandboxPolicyList(sandboxName) {
  const allPresets = policies.listPresets();
  const registryPresets = policies.getAppliedPresets(sandboxName);

  // getGatewayPresets returns null when gateway is unreachable, or an
  // array of matched preset names when reachable (possibly empty).
  const gatewayPresets = policies.getGatewayPresets(sandboxName);

  console.log("");
  console.log(`  Policy presets for sandbox '${sandboxName}':`);
  allPresets.forEach((p) => {
    const inRegistry = registryPresets.includes(p.name);
    const inGateway = gatewayPresets ? gatewayPresets.includes(p.name) : null;

    let marker;
    let suffix = "";
    if (inGateway === null) {
      // Gateway unreachable — fall back to registry-only display
      marker = inRegistry ? "●" : "○";
    } else if (inRegistry && inGateway) {
      marker = "●";
    } else if (!inRegistry && !inGateway) {
      marker = "○";
    } else if (inGateway && !inRegistry) {
      marker = "●";
      suffix = " (active on gateway, missing from local state)";
    } else {
      // inRegistry && !inGateway
      marker = "○";
      suffix = " (recorded locally, not active on gateway)";
    }
    console.log(`    ${marker} ${p.name} — ${p.description}${suffix}`);
  });

  if (gatewayPresets === null) {
    console.log("");
    console.log("  ⚠ Could not query gateway — showing local state only.");
  }
  console.log("");
}

// ── Messaging channels ───────────────────────────────────────────

function sandboxChannelsList(sandboxName) {
  console.log("");
  console.log(`  Known messaging channels for sandbox '${sandboxName}':`);
  for (const [name, channel] of Object.entries(KNOWN_CHANNELS)) {
    console.log(`    ${name} — ${channel.description}`);
  }
  console.log("");
}

async function promptAndRebuild(sandboxName, actionDesc) {
  if (isNonInteractive()) {
    console.log("");
    console.log(
      `  Change queued. Run 'nemoclaw ${sandboxName} rebuild' to apply (${actionDesc}).`,
    );
    return;
  }
  const answer = (await askPrompt(`  Rebuild '${sandboxName}' now to apply? [Y/n]: `))
    .trim()
    .toLowerCase();
  if (answer === "n" || answer === "no") {
    console.log(
      `  Run 'nemoclaw ${sandboxName} rebuild' when you are ready to apply (${actionDesc}).`,
    );
    return;
  }
  await sandboxRebuild(sandboxName, ["--yes"]);
}

async function sandboxChannelsAdd(sandboxName, args = []) {
  const dryRun = args.includes("--dry-run");
  const channelArg = args.find((arg) => !arg.startsWith("-"));
  if (!channelArg) {
    console.error("  Usage: nemoclaw <sandbox> channels add <channel> [--dry-run]");
    console.error(`  Valid channels: ${knownChannelNames().join(", ")}`);
    process.exit(1);
  }

  const channel = getChannelDef(channelArg);
  if (!channel) {
    console.error(`  Unknown channel '${channelArg}'.`);
    console.error(`  Valid channels: ${knownChannelNames().join(", ")}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`  --dry-run: would enable channel '${channelArg}' for '${sandboxName}'.`);
    return;
  }

  const tokenKeys = getChannelTokenKeys(channel);
  const acquired = {};
  for (const envKey of tokenKeys) {
    const isPrimary = envKey === channel.envKey;
    const help = isPrimary ? channel.help : channel.appTokenHelp;
    const label = isPrimary ? channel.label : channel.appTokenLabel;
    const existing = getCredential(envKey);
    if (existing) {
      acquired[envKey] = existing;
      continue;
    }
    if (isNonInteractive()) {
      console.error(`  Missing ${envKey} for channel '${channelArg}'.`);
      console.error(
        `  Set ${envKey} in the environment or via 'nemoclaw credentials' before running in non-interactive mode.`,
      );
      process.exit(1);
    }
    console.log("");
    console.log(`  ${help}`);
    const token = (await askPrompt(`  ${label}: `, { secret: true })).trim();
    if (!token) {
      console.error(`  Aborted — no value entered for ${envKey}.`);
      process.exit(1);
    }
    acquired[envKey] = token;
  }

  persistChannelTokens(acquired);
  console.log(`  ${G}✓${R} Saved ${channelArg} credentials.`);
  await promptAndRebuild(sandboxName, `add '${channelArg}'`);
}

async function sandboxChannelsRemove(sandboxName, args = []) {
  const dryRun = args.includes("--dry-run");
  const channelArg = args.find((arg) => !arg.startsWith("-"));
  if (!channelArg) {
    console.error("  Usage: nemoclaw <sandbox> channels remove <channel> [--dry-run]");
    console.error(`  Valid channels: ${knownChannelNames().join(", ")}`);
    process.exit(1);
  }

  const channel = getChannelDef(channelArg);
  if (!channel) {
    console.error(`  Unknown channel '${channelArg}'.`);
    console.error(`  Valid channels: ${knownChannelNames().join(", ")}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`  --dry-run: would remove channel '${channelArg}' for '${sandboxName}'.`);
    return;
  }

  clearChannelTokens(channel);
  console.log(`  ${G}✓${R} Cleared stored ${channelArg} credentials.`);
  await promptAndRebuild(sandboxName, `remove '${channelArg}'`);
}

async function sandboxChannelsSetEnabled(sandboxName, args, disabled) {
  const verb = disabled ? "stop" : "start";
  const dryRun = args.includes("--dry-run");
  const channelArg = args.find((arg) => !arg.startsWith("-"));
  if (!channelArg) {
    console.error(`  Usage: nemoclaw <sandbox> channels ${verb} <channel> [--dry-run]`);
    console.error(`  Valid channels: ${knownChannelNames().join(", ")}`);
    process.exit(1);
  }

  const channel = getChannelDef(channelArg);
  if (!channel) {
    console.error(`  Unknown channel '${channelArg}'.`);
    console.error(`  Valid channels: ${knownChannelNames().join(", ")}`);
    process.exit(1);
  }

  const normalized = channelArg.trim().toLowerCase();
  const alreadyDisabled = registry.getDisabledChannels(sandboxName).includes(normalized);
  if (alreadyDisabled === disabled) {
    console.log(
      `  Channel '${normalized}' is already ${disabled ? "disabled" : "enabled"} for '${sandboxName}'. Nothing to do.`,
    );
    return;
  }

  if (dryRun) {
    console.log(
      `  --dry-run: would ${verb} channel '${normalized}' for '${sandboxName}'.`,
    );
    return;
  }

  if (!registry.setChannelDisabled(sandboxName, normalized, disabled)) {
    console.error(`  Sandbox '${sandboxName}' not found in the registry.`);
    process.exit(1);
  }
  const state = disabled ? "disabled" : "enabled";
  console.log(`  ${G}✓${R} Marked ${normalized} ${state} for '${sandboxName}'.`);
  await promptAndRebuild(sandboxName, `${verb} '${normalized}'`);
}

async function sandboxChannelsStop(sandboxName, args = []) {
  await sandboxChannelsSetEnabled(sandboxName, args, true);
}

async function sandboxChannelsStart(sandboxName, args = []) {
  await sandboxChannelsSetEnabled(sandboxName, args, false);
}

/**
 * Install or update a local skill directory into a live sandbox and perform
 * any agent-specific post-install refresh needed for the new content to load.
 */
async function sandboxSkillInstall(sandboxName, args = []) {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log("");
    console.log("  Usage: nemoclaw <sandbox> skill install <path>");
    console.log("");
    console.log("  Deploy a skill directory to a running sandbox.");
    console.log(
      "  <path> must be a skill directory containing a SKILL.md (with 'name:' frontmatter),",
    );
    console.log(
      "  or a direct path to a SKILL.md file. All non-dot files in the directory are uploaded.",
    );
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
    console.log(
      `  ${D}Skipping ${collected.skippedDotfiles.length} hidden path(s): ${collected.skippedDotfiles.join(", ")}${R}`,
    );
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

  const tmpSshConfig = path.join(
    os.tmpdir(),
    `nemoclaw-ssh-skill-${process.pid}-${Date.now()}.conf`,
  );
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
    //    OpenClaw caches skill content per session, so always refresh the
    //    session index after an install/update to avoid stale SKILL.md data.
    const post = skillInstall.postInstall(ctx, paths, skillDir);
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

async function sandboxPolicyRemove(sandboxName, args = []) {
  const dryRun = args.includes("--dry-run");
  const skipConfirm =
    args.includes("--yes") || args.includes("--force") || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  const presetArg = args.find((arg) => !arg.startsWith("-"));
  let answer = null;
  if (presetArg) {
    const normalized = presetArg.trim().toLowerCase();
    const preset = allPresets.find((item) => item.name === normalized);
    if (!preset) {
      console.error(`  Unknown preset '${presetArg}'.`);
      console.error(`  Valid presets: ${allPresets.map((item) => item.name).join(", ")}`);
      process.exit(1);
    }
    if (!applied.includes(preset.name)) {
      console.error(`  Preset '${preset.name}' is not applied.`);
      process.exit(1);
    }
    answer = preset.name;
  } else {
    if (process.env.NEMOCLAW_NON_INTERACTIVE === "1") {
      console.error("  Non-interactive mode requires a preset name.");
      console.error("  Usage: nemoclaw <sandbox> policy-remove <preset> [--yes] [--dry-run]");
      process.exit(1);
    }
    answer = await policies.selectForRemoval(allPresets, { applied });
  }
  if (!answer) return;

  const presetContent = policies.loadPreset(answer);
  if (!presetContent) return;

  const endpoints = policies.getPresetEndpoints(presetContent);
  if (endpoints.length > 0) {
    console.log(`  Endpoints that would be removed: ${endpoints.join(", ")}`);
  }

  if (dryRun) {
    console.log("  --dry-run: no changes applied.");
    return;
  }

  if (!skipConfirm) {
    const confirm = await askPrompt(`  Remove '${answer}' from sandbox '${sandboxName}'? [Y/n]: `);
    if (confirm.toLowerCase() === "n") return;
  }

  if (!policies.removePreset(sandboxName, answer)) {
    process.exit(1);
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

/**
 * Remove the host-side Docker image that was built for a sandbox during onboard.
 * Must be called before registry.removeSandbox() since the imageTag is stored there.
 */
function removeSandboxImage(sandboxName) {
  const sb = registry.getSandbox(sandboxName);
  if (!sb?.imageTag) return;
  const result = run(["docker", "rmi", sb.imageTag], { ignoreError: true });
  if (result.status === 0) {
    console.log(`  Removed Docker image ${sb.imageTag}`);
  } else {
    console.warn(`  ${YW}⚠${R} Failed to remove Docker image ${sb.imageTag}; run 'nemoclaw gc' to clean up.`);
  }
}

async function sandboxDestroy(sandboxName, args = []) {
  const skipConfirm = args.includes("--yes") || args.includes("--force");

  // Active session detection — enrich the confirmation prompt if sessions are active
  let activeSessionCount = 0;
  const opsBin = resolveOpenshell();
  if (opsBin) {
    try {
      const sessionResult = getActiveSandboxSessions(sandboxName, createSessionDeps(opsBin));
      if (sessionResult.detected) {
        activeSessionCount = sessionResult.sessions.length;
      }
    } catch {
      /* non-fatal */
    }
  }

  if (!skipConfirm) {
    console.log(`  ${YW}Destroy sandbox '${sandboxName}'?${R}`);
    if (activeSessionCount > 0) {
      const plural = activeSessionCount > 1 ? "sessions" : "session";
      console.log(`  ${YW}⚠  Active SSH ${plural} detected (${activeSessionCount} connection${activeSessionCount > 1 ? "s" : ""})${R}`);
      console.log(`  Destroying will terminate ${activeSessionCount === 1 ? "the" : "all"} active ${plural} with a Broken pipe error.`);
    }
    console.log("  This will permanently delete the sandbox and all workspace files inside it.");
    console.log("  This cannot be undone.");
    const answer = await askPrompt("  Type 'yes' to confirm, or press Enter to cancel [y/N]: ");
    if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
      console.log("  Cancelled.");
      return;
    }
  }

  const sb = registry.getSandbox(sandboxName);
  if (sb && sb.nimContainer) {
    console.log(`  Stopping NIM for '${sandboxName}'...`);
    nim.stopNimContainerByName(sb.nimContainer);
  } else {
    // Best-effort cleanup of convention-named NIM containers that may not
    // be recorded in the registry (e.g. older sandboxes).  Suppress output
    // so the user doesn't see "No such container" noise when no NIM exists.
    nim.stopNimContainer(sandboxName, { silent: true });
  }

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
  removeSandboxImage(sandboxName);

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

async function sandboxRebuild(sandboxName, args = [], opts = {}) {
  const verbose =
    args.includes("--verbose") ||
    args.includes("-v") ||
    process.env.NEMOCLAW_REBUILD_VERBOSE === "1";
  const log = verbose ? _rebuildLog : () => {};
  const skipConfirm = args.includes("--yes") || args.includes("--force");
  // When called from upgradeSandboxes in a loop, throwOnError prevents
  // process.exit from aborting the entire batch on the first failure.
  const bail = opts.throwOnError
    ? (msg, code = 1) => {
        throw new Error(msg);
      }
    : (_msg, code = 1) => process.exit(code);

  // Active session detection — enrich the confirmation prompt if sessions are active
  let rebuildActiveSessionCount = 0;
  const opsBinRebuild = resolveOpenshell();
  if (opsBinRebuild) {
    try {
      const sessionResult = getActiveSandboxSessions(sandboxName, createSessionDeps(opsBinRebuild));
      if (sessionResult.detected) {
        rebuildActiveSessionCount = sessionResult.sessions.length;
      }
    } catch {
      /* non-fatal */
    }
  }

  const sb = registry.getSandbox(sandboxName);
  if (!sb) {
    console.error(`  Sandbox '${sandboxName}' not found in registry.`);
    bail(`Sandbox '${sandboxName}' not found in registry.`);
    return;
  }

  // Multi-agent guard (temporary — until swarm lands)
  if (sb.agents && sb.agents.length > 1) {
    console.error("  Multi-agent sandbox rebuild is not yet supported.");
    console.error("  Back up state manually and recreate with `nemoclaw onboard`.");
    bail("Multi-agent sandbox rebuild is not yet supported.");
    return;
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
    if (rebuildActiveSessionCount > 0) {
      const plural = rebuildActiveSessionCount > 1 ? "sessions" : "session";
      console.log(`  ${YW}⚠  Active SSH ${plural} detected (${rebuildActiveSessionCount} connection${rebuildActiveSessionCount > 1 ? "s" : ""})${R}`);
      console.log(`  Rebuilding will terminate ${rebuildActiveSessionCount === 1 ? "the" : "all"} active ${plural} with a Broken pipe error.`);
      console.log("");
    }
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

  // Step 0: Preflight — verify recreate preconditions BEFORE destroying
  // anything.  The most common rebuild failure is a missing provider
  // credential when onboard runs in non-interactive mode.  Checking now
  // lets us abort with the sandbox still intact.  See #2273.
  const session = onboardSession.loadSession();
  let rebuildCredentialEnv: string | null = null;
  if (session && session.sandboxName && session.sandboxName !== sandboxName) {
    // Session belongs to a different sandbox — its credentialEnv may be
    // wrong (e.g. hermes session while rebuilding openclaw).  Skip the
    // credential preflight; the agent sync from the registry (#2201)
    // and onboard itself will handle provider selection.
    log(`Preflight warning: session belongs to '${session.sandboxName}', not '${sandboxName}' — skipping credential preflight`);
    console.log(
      `  ${D}Note: onboard session belongs to '${session.sandboxName}', not '${sandboxName}'. ` +
      `Skipping credential preflight.${R}`,
    );
  } else {
    rebuildCredentialEnv = session?.credentialEnv || null;
  }
  if (rebuildCredentialEnv) {
    const credentialValue = getCredential(rebuildCredentialEnv);
    log(`Preflight credential check: ${rebuildCredentialEnv} → ${credentialValue ? "present" : "MISSING"}`);
    if (!credentialValue) {
      console.error("");
      console.error(`  ${_RD}Rebuild preflight failed:${R} provider credential not found.`);
      console.error(`  The non-interactive recreate step requires ${rebuildCredentialEnv},`);
      console.error("  but it is not set in the environment or saved in ~/.nemoclaw/credentials.json.");
      console.error("");
      console.error("  To fix, do one of:");
      console.error(`    export ${rebuildCredentialEnv}=<your-key>`);
      console.error("    nemoclaw onboard          # re-enter the key interactively");
      console.error("");
      console.error("  Sandbox is untouched — no data was lost.");
      bail(`Missing credential: ${rebuildCredentialEnv}`);
      return;
    }
  } else {
    // No credentialEnv in session — local inference (Ollama/vLLM) or
    // session was lost.  Either way, skip the credential preflight;
    // onboard will handle it.
    log("Preflight credential check: no credentialEnv in session (local inference or missing session)");
  }

  // Step 1: Ensure sandbox is live for backup
  log("Checking sandbox liveness: openshell sandbox list");
  const isLive = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  log(
    `openshell sandbox list exit=${isLive.status}, output=${(isLive.output || "").substring(0, 200)}`,
  );
  const liveNames = parseLiveSandboxNames(isLive.output || "");
  log(`Live sandboxes: ${Array.from(liveNames).join(", ") || "(none)"}`);
  if (!liveNames.has(sandboxName)) {
    console.error(`  Sandbox '${sandboxName}' is not running. Cannot back up state.`);
    console.error("  Start it first or recreate with `nemoclaw onboard --recreate-sandbox`.");
    bail(`Sandbox '${sandboxName}' is not running.`);
    return;
  }

  // Step 2: Backup
  console.log("  Backing up sandbox state...");
  log(`Agent type: ${sb.agent || "openclaw"}, stateDirs from manifest`);
  const backup = sandboxState.backupSandboxState(sandboxName);
  log(
    `Backup result: success=${backup.success}, backed=${backup.backedUpDirs.join(",")}, failed=${backup.failedDirs.join(",")}`,
  );
  if (!backup.success) {
    console.error("  Failed to back up sandbox state.");
    if (backup.backedUpDirs.length > 0) {
      console.error(`  Partial backup: ${backup.backedUpDirs.join(", ")}`);
    }
    if (backup.failedDirs.length > 0) {
      console.error(`  Failed: ${backup.failedDirs.join(", ")}`);
    }
    console.error("  Aborting rebuild to prevent data loss.");
    bail("Failed to back up sandbox state.");
    return;
  }
  console.log(`  ${G}\u2713${R} State backed up (${backup.backedUpDirs.length} directories)`);
  console.log(`    Backup: ${backup.manifest.backupPath}`);

  // Step 3: Delete sandbox without tearing down gateway or session.
  // sandboxDestroy() cleans up the gateway when it's the last sandbox and
  // nulls session.sandboxName — both break the immediate onboard --resume.
  console.log("  Deleting old sandbox...");
  const sbMeta = registry.getSandbox(sandboxName);
  log(
    `Registry entry: agent=${sbMeta?.agent}, agentVersion=${sbMeta?.agentVersion}, nimContainer=${sbMeta?.nimContainer}`,
  );
  if (sbMeta && sbMeta.nimContainer) {
    log(`Stopping NIM container: ${sbMeta.nimContainer}`);
    nim.stopNimContainerByName(sbMeta.nimContainer);
  } else {
    // Best-effort cleanup — see comment in sandboxDestroy.
    nim.stopNimContainer(sandboxName, { silent: true });
  }

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
    bail("Failed to delete sandbox.", deleteResult.status || 1);
    return;
  }
  removeSandboxImage(sandboxName);
  registry.removeSandbox(sandboxName);
  log(
    `Registry after remove: ${JSON.stringify(registry.listSandboxes().sandboxes.map((s) => s.name))}`,
  );
  console.log(`  ${G}\u2713${R} Old sandbox deleted`);

  // Step 4: Recreate via onboard --resume
  console.log("");
  console.log("  Creating new sandbox with current image...");

  // Force the sandbox name so onboard recreates with the same name.
  // Mark session resumable and point at this sandbox; set env var as fallback.
  const sessionBefore = onboardSession.loadSession();
  log(
    `Session before update: sandboxName=${sessionBefore?.sandboxName}, status=${sessionBefore?.status}, resumable=${sessionBefore?.resumable}, provider=${sessionBefore?.provider}, model=${sessionBefore?.model}`,
  );

  // Sync the session's agent field with the registry so onboard --resume
  // rebuilds the correct sandbox type.  Without this, a stale session.agent
  // from a previous onboard of a *different* agent type would be picked up
  // by resolveAgentName() and the wrong Dockerfile would be used.  (#2201)
  const rebuildAgent = sb.agent || null;
  onboardSession.updateSession((s) => {
    s.sandboxName = sandboxName;
    s.resumable = true;
    s.status = "in_progress";
    s.agent = rebuildAgent;
    return s;
  });
  process.env.NEMOCLAW_SANDBOX_NAME = sandboxName;

  const sessionAfter = onboardSession.loadSession();
  log(
    `Session after update: sandboxName=${sessionAfter?.sandboxName}, status=${sessionAfter?.status}, resumable=${sessionAfter?.resumable}, provider=${sessionAfter?.provider}, model=${sessionAfter?.model}`,
  );
  log(
    `Env: NEMOCLAW_SANDBOX_NAME=${process.env.NEMOCLAW_SANDBOX_NAME}, NEMOCLAW_RECREATE_SANDBOX=${process.env.NEMOCLAW_RECREATE_SANDBOX}`,
  );

  // Forward the stored --from Dockerfile path so onboard --resume uses the
  // same custom image.  Without this, the conflict check rejects the resume
  // because requestedFrom (null) !== recordedFrom (the stored path).  (#2301)
  const storedFromDockerfile = sessionAfter?.metadata?.fromDockerfile || null;
  log(`Calling onboard({ resume: true, nonInteractive: true, recreateSandbox: true, fromDockerfile: ${storedFromDockerfile} })`);

  // Intercept process.exit during onboard so we can attempt rollback
  // instead of dying with the sandbox destroyed.  onboard() has ~87
  // process.exit() calls that would otherwise kill the process with no
  // chance to recover.  See #2273.
  //
  // NOTE: Throwing from the overridden process.exit unwinds onboard's
  // call stack, which skips process.once("exit") listeners (lock
  // release, build context cleanup, session failure marking).  We
  // manually release the lock and mark the session failed in the
  // onboardFailed block below.  Full fix is tracked in #2306 (extract
  // rebuild-specific recreate path that throws instead of exiting).
  const { onboard } = require("./lib/onboard");
  let onboardFailed = false;
  let onboardExitCode = 1;
  const _savedExit = process.exit;
  process.exit = ((code) => {
    onboardFailed = true;
    onboardExitCode = typeof code === "number" ? code : 1;
    // Throw a sentinel to unwind the onboard call stack.
    // The catch block below handles it.
    const err = new Error(`onboard exited with code ${onboardExitCode}`);
    err.name = "RebuildOnboardExit";
    throw err;
  }) as typeof process.exit;

  try {
    await onboard({
      resume: true,
      nonInteractive: true,
      recreateSandbox: true,
      agent: rebuildAgent,
      fromDockerfile: storedFromDockerfile,
    });
    log("onboard() returned successfully");
  } catch (err) {
    onboardFailed = true;
    if (err?.name !== "RebuildOnboardExit") {
      log(`onboard() threw: ${err?.message || err}`);
    }
  } finally {
    process.exit = _savedExit;
  }

  if (onboardFailed) {
    // Clean up onboard's internal state that normally runs in
    // process.once("exit") listeners — those never fire because we
    // threw from the overridden process.exit instead of actually
    // exiting.  Without this the onboard lock file stays on disk and
    // blocks the next onboard/rebuild invocation.
    try { onboardSession.releaseOnboardLock(); } catch { /* best effort */ }
    try {
      const failedStep = onboardSession.loadSession()?.lastStepStarted;
      if (failedStep) {
        onboardSession.markStepFailed(failedStep, "Rebuild recreate failed");
      }
    } catch { /* best effort */ }

    console.error("");
    console.error(`  ${_RD}Recreate failed after sandbox was destroyed.${R}`);
    console.error(`  Backup is preserved at: ${backup.manifest.backupPath}`);
    console.error("");
    console.error("  To recover manually:");
    console.error(`    1. Fix the issue above (missing credential, Docker problem, etc.)`);
    console.error(`    2. Run: nemoclaw onboard --resume`);
    console.error(`       This will recreate sandbox '${sandboxName}'.`);
    console.error(`    3. Then restore your workspace state:`);
    console.error(`       nemoclaw ${sandboxName} snapshot restore "${backup.manifest.timestamp}"`);
    console.error("");
    bail(`Recreate failed (sandbox destroyed). Backup: ${backup.manifest.backupPath}`, onboardExitCode);
    return;
  }

  // Step 5: Restore
  console.log("");
  console.log("  Restoring workspace state...");
  log(`Restoring from: ${backup.manifest.backupPath} into sandbox: ${sandboxName}`);
  const restore = sandboxState.restoreSandboxState(sandboxName, backup.manifest.backupPath);
  log(
    `Restore result: success=${restore.success}, restored=${restore.restoredDirs.join(",")}, failed=${restore.failedDirs.join(",")}`,
  );
  if (!restore.success) {
    console.error(`  Partial restore: ${restore.restoredDirs.join(", ") || "none"}`);
    console.error(`  Failed: ${restore.failedDirs.join(", ")}`);
    console.error(`  Manual restore available from: ${backup.manifest.backupPath}`);
  } else {
    console.log(`  ${G}\u2713${R} State restored (${restore.restoredDirs.length} directories)`);
  }

  // Step 5.5: Restore policy presets (#1952)
  // Policy presets live in the gateway policy engine, not the sandbox filesystem.
  // They are lost when the sandbox is destroyed and recreated. Re-apply any
  // presets that were captured in the backup manifest.
  const savedPresets = backup.manifest.policyPresets || [];
  if (savedPresets.length > 0) {
    console.log("");
    console.log("  Restoring policy presets...");
    log(`Policy presets to restore: [${savedPresets.join(",")}]`);
    const restoredPresets: string[] = [];
    const failedPresets: string[] = [];
    for (const presetName of savedPresets) {
      try {
        log(`Applying preset: ${presetName}`);
        const applied = policies.applyPreset(sandboxName, presetName);
        if (applied) {
          restoredPresets.push(presetName);
        } else {
          failedPresets.push(presetName);
        }
      } catch (err) {
        log(`Failed to apply preset '${presetName}': ${err.message || err}`);
        failedPresets.push(presetName);
      }
    }
    if (restoredPresets.length > 0) {
      console.log(`  ${G}\u2713${R} Policy presets restored: ${restoredPresets.join(", ")}`);
    }
    if (failedPresets.length > 0) {
      console.error(`  ${YW}\u26a0${R} Failed to restore presets: ${failedPresets.join(", ")}`);
      console.error(`    Re-apply manually with: nemoclaw ${sandboxName} policy-add`);
    }
  }

  // Step 6: Post-restore agent-specific migration
  const agentDef = agent
    ? require("./lib/agent-defs").loadAgent(agent.name)
    : require("./lib/agent-defs").loadAgent("openclaw");
  if (agentDef.name === "openclaw") {
    // openclaw doctor --fix validates and repairs directory structure.
    // Idempotent and safe — catches structural changes between OpenClaw versions
    // (new symlinks, new data dirs, etc.) that the restored state may be missing.
    log("Running openclaw doctor --fix inside sandbox for post-upgrade structure repair");
    const doctorResult = executeSandboxCommand(sandboxName, "openclaw doctor --fix");
    log(
      `doctor --fix: exit=${doctorResult?.status}, stdout=${(doctorResult?.stdout || "").substring(0, 200)}`,
    );
    if (doctorResult && doctorResult.status === 0) {
      console.log(`  ${G}\u2713${R} Post-upgrade structure check passed`);
    } else {
      console.log(
        `  ${D}Post-upgrade structure check skipped (doctor returned ${doctorResult?.status ?? "null"})${R}`,
      );
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
    console.log(
      `  ${YW}\u26a0${R} Sandbox '${sandboxName}' rebuilt but state restore was incomplete`,
    );
    console.log(`    Backup available at: ${backup.manifest.backupPath}`);
  }
}

// ── Upgrade sandboxes (#1904) ────────────────────────────────────
// Detect sandboxes running stale agent versions and offer to rebuild them.

async function upgradeSandboxes(args = []) {
  const checkOnly = args.includes("--check");
  const auto = args.includes("--auto");
  const skipConfirm = auto || args.includes("--yes");

  const sandboxes = registry.listSandboxes().sandboxes;
  if (sandboxes.length === 0) {
    console.log("  No sandboxes found in the registry.");
    return;
  }

  // Query live sandboxes so we can tell the user which are running
  const liveResult = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  if (liveResult.status !== 0) {
    console.error("  Failed to query running sandboxes from OpenShell.");
    console.error("  Ensure OpenShell is running: openshell status");
    process.exit(liveResult.status || 1);
  }
  const liveNames = parseLiveSandboxNames(liveResult.output || "");

  // Classify sandboxes as stale, unknown, or current
  const stale = [];
  const unknown = [];
  for (const sb of sandboxes) {
    const versionCheck = sandboxVersion.checkAgentVersion(sb.name);
    if (versionCheck.isStale) {
      stale.push({
        name: sb.name,
        current: versionCheck.sandboxVersion,
        expected: versionCheck.expectedVersion,
        running: liveNames.has(sb.name),
      });
    } else if (versionCheck.detectionMethod === "unavailable") {
      unknown.push({
        name: sb.name,
        expected: versionCheck.expectedVersion,
        running: liveNames.has(sb.name),
      });
    }
  }

  if (stale.length === 0 && unknown.length === 0) {
    console.log("  All sandboxes are up to date.");
    return;
  }

  if (stale.length > 0) {
    console.log(`\n  ${B}Stale sandboxes:${R}`);
    for (const s of stale) {
      const status = s.running ? `${G}running${R}` : `${D}stopped${R}`;
      console.log(`    ${s.name}  v${s.current || "?"} → v${s.expected}  (${status})`);
    }
  }
  if (unknown.length > 0) {
    console.log(`\n  ${YW}Unknown version:${R}`);
    for (const s of unknown) {
      const status = s.running ? `${G}running${R}` : `${D}stopped${R}`;
      console.log(`    ${s.name}  v? → v${s.expected}  (${status})`);
    }
  }
  console.log("");

  if (checkOnly) {
    if (stale.length > 0) console.log(`  ${stale.length} sandbox(es) need upgrading.`);
    if (unknown.length > 0) {
      console.log(
        `  ${unknown.length} sandbox(es) could not be version-checked; start them and rerun, or rebuild manually.`,
      );
    }
    console.log("  Run `nemoclaw upgrade-sandboxes` to rebuild them.");
    return;
  }

  const rebuildable = stale.filter((s) => s.running);
  const stopped = stale.filter((s) => !s.running);
  if (stopped.length > 0) {
    console.log(`  ${D}Skipping ${stopped.length} stopped sandbox(es) — start them first.${R}`);
  }
  if (rebuildable.length === 0) {
    console.log("  No running stale sandboxes to rebuild.");
    return;
  }

  let rebuilt = 0;
  let failed = 0;
  for (const s of rebuildable) {
    if (!skipConfirm) {
      const answer = await askPrompt(`  Rebuild '${s.name}'? [y/N]: `);
      if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
        console.log(`  Skipped '${s.name}'.`);
        continue;
      }
    }
    try {
      await sandboxRebuild(s.name, ["--yes"], { throwOnError: true });
      rebuilt++;
    } catch (err) {
      console.error(`  ${YW}\u26a0${R} Failed to rebuild '${s.name}': ${err.message}`);
      failed++;
    }
  }

  console.log("");
  if (rebuilt > 0) console.log(`  ${G}\u2713${R} ${rebuilt} sandbox(es) rebuilt.`);
  if (failed > 0) console.log(`  ${YW}\u26a0${R} ${failed} sandbox(es) failed — see errors above.`);
  if (failed > 0) process.exit(1);
}

// ── Pre-upgrade backup ───────────────────────────────────────────

// ── Snapshot ─────────────────────────────────────────────────────

function parseSnapshotCreateFlags(flags) {
  const opts = { name: null };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--name") {
      if (i + 1 >= flags.length || flags[i + 1].startsWith("--")) {
        console.error("  --name requires a value");
        process.exit(1);
      }
      opts.name = flags[++i];
    } else {
      console.error(`  Unknown flag: ${flag}`);
      process.exit(1);
    }
  }
  return opts;
}

function formatSnapshotVersion(b) {
  return `v${b.snapshotVersion}`;
}

function renderSnapshotTable(backups) {
  const rows = backups.map((b) => ({
    version: formatSnapshotVersion(b),
    name: b.name || "",
    timestamp: b.timestamp,
    backupPath: b.backupPath,
  }));
  const widths = {
    version: Math.max(7, ...rows.map((r) => r.version.length)),
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    timestamp: Math.max(9, ...rows.map((r) => r.timestamp.length)),
    backupPath: Math.max(4, ...rows.map((r) => r.backupPath.length)),
  };
  const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
  console.log(
    `    ${B}${pad("Version", widths.version)}  ${pad("Name", widths.name)}  ${pad("Timestamp", widths.timestamp)}  ${pad("Path", widths.backupPath)}${R}`,
  );
  for (const r of rows) {
    console.log(
      `    ${pad(r.version, widths.version)}  ${pad(r.name, widths.name)}  ${pad(r.timestamp, widths.timestamp)}  ${D}${pad(r.backupPath, widths.backupPath)}${R}`,
    );
  }
}

// Query the running src pod's image reference via `kubectl` inside the
// gateway container. Returns null on any failure.
function resolveSrcPodImage(srcName) {
  const gatewayContainer = `openshell-cluster-${NEMOCLAW_GATEWAY_NAME}`;
  try {
    const result = spawnSync(
      "docker",
      [
        "exec",
        gatewayContainer,
        "kubectl",
        "get",
        "pod",
        srcName,
        "-n",
        "openshell",
        "-o",
        'jsonpath={.spec.containers[?(@.name=="agent")].image}',
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 },
    );
    if (result.status !== 0) return null;
    const img = (result.stdout || "").trim().split(/\s+/)[0];
    return img || null;
  } catch {
    return null;
  }
}

// Auto-create a sandbox that clones the image of an existing one.
// Used by `snapshot restore --to <dst>` when dst does not exist yet: reuses
// the source's baked image so the user does not have to re-run onboarding.
// Returns true on success; on failure, logs and calls process.exit(1).
async function autoCreateSandboxFromSource(srcName, dstName, srcEntry) {
  const sandboxCreateStream = require("./lib/sandbox-create-stream");
  const { isSandboxReady } = require("./lib/gateway-state");
  const basePolicy = path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
  const openshellBin = getOpenshellBinary();

  const fromImage = resolveSrcPodImage(srcName);
  if (!fromImage) {
    console.error(
      `  Cannot auto-create '${dstName}': could not resolve '${srcName}' pod image.`,
    );
    console.error(`  Create '${dstName}' manually with 'nemoclaw onboard'.`);
    process.exit(1);
  }

  const cmdParts = [
    openshellBin,
    "sandbox",
    "create",
    "--name",
    dstName,
    "--from",
    fromImage,
    "--policy",
    basePolicy,
    "--auto-providers",
    "--",
    "nemoclaw-start",
  ].map((p) => shellQuote(p));
  const command = `${cmdParts.join(" ")} 2>&1`;

  console.log(
    `  '${dstName}' does not exist. Creating from '${srcName}' image (${fromImage})...`,
  );

  const createResult = await sandboxCreateStream.streamSandboxCreate(command, process.env, {
    // Use a pre-built image, so skip build+push and jump to pod creation.
    initialPhase: "create",
    // Wait until the sandbox actually reaches Ready state, not just appears in the list.
    readyCheck: () => {
      const list = captureOpenshell(["sandbox", "list"], { ignoreError: true });
      if (list.status !== 0) return false;
      return isSandboxReady(list.output || "", dstName);
    },
  });

  if (createResult.status !== 0 && !createResult.forcedReady) {
    console.error(`  Failed to create sandbox '${dstName}' (exit ${createResult.status}).`);
    const tail = (createResult.output || "").slice(-600);
    if (tail) console.error(tail);
    process.exit(1);
  }

  // Double-check Ready after stream exit.
  const verify = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  if (verify.status !== 0 || !isSandboxReady(verify.output || "", dstName)) {
    console.error(`  Sandbox '${dstName}' did not reach Ready state after create.`);
    process.exit(1);
  }

  // Set up DNS proxy in the new pod (same step onboard runs after sandbox create).
  const dnsScript = path.join(ROOT, "scripts", "setup-dns-proxy.sh");
  if (fs.existsSync(dnsScript)) {
    run(["bash", dnsScript, NEMOCLAW_GATEWAY_NAME, dstName], { ignoreError: true });
  }

  // Register dst in the NemoClaw registry, cloning most fields from src.
  // Policies are cleared here — the caller replays them from the snapshot
  // manifest after the restore succeeds and writes them back into this entry.
  registry.registerSandbox({
    ...srcEntry,
    name: dstName,
    createdAt: new Date().toISOString(),
    policies: [],
    // dst has its own lifecycle; don't inherit src's local NIM container
    // reference, or destroying dst would stop src's NIM.
    nimContainer: null,
  });

  console.log(`  ${G}\u2713${R} Sandbox '${dstName}' created`);
}

async function sandboxSnapshot(sandboxName, subArgs) {
  const subcommand = subArgs[0] || "help";
  switch (subcommand) {
    case "create": {
      const opts = parseSnapshotCreateFlags(subArgs.slice(1));
      const isLive = captureOpenshell(["sandbox", "list"], { ignoreError: true });
      if (isLive.status !== 0) {
        console.error("  Failed to query live sandbox state from OpenShell.");
        process.exit(1);
      }
      const liveNames = parseLiveSandboxNames(isLive.output || "");
      if (!liveNames.has(sandboxName)) {
        console.error(`  Sandbox '${sandboxName}' is not running. Cannot create snapshot.`);
        process.exit(1);
      }
      const label = opts.name ? ` (--name ${opts.name})` : "";
      console.log(`  Creating snapshot of '${sandboxName}'${label}...`);
      const result = sandboxState.backupSandboxState(sandboxName, { name: opts.name });
      if (result.success) {
        // Virtual snapshotVersion is only assigned by listBackups, so re-resolve
        // the just-created snapshot by its timestamp to get a valid v<N>.
        const entry =
          sandboxState.findBackup(sandboxName, result.manifest.timestamp).match ??
          result.manifest;
        const v = formatSnapshotVersion(entry);
        const nameSuffix = entry.name ? ` name=${entry.name}` : "";
        console.log(
          `  ${G}\u2713${R} Snapshot ${v}${nameSuffix} created (${result.backedUpDirs.length} directories)`,
        );
        console.log(`    ${result.manifest.backupPath}`);
      } else {
        if (result.error) {
          console.error(`  ${result.error}`);
        } else {
          console.error("  Snapshot failed.");
          if (result.failedDirs.length > 0) {
            console.error(`  Failed directories: ${result.failedDirs.join(", ")}`);
          }
        }
        process.exit(1);
      }
      break;
    }
    case "list": {
      const backups = sandboxState.listBackups(sandboxName);
      if (backups.length === 0) {
        console.log(`  No snapshots found for '${sandboxName}'.`);
        return;
      }
      console.log(`  Snapshots for '${sandboxName}':`);
      console.log("");
      renderSnapshotTable(backups);
      console.log("");
      console.log(`  ${backups.length} snapshot(s). Restore with:`);
      console.log(`    nemoclaw ${sandboxName} snapshot restore [version|name|timestamp]`);
      break;
    }
    case "restore": {
      // `--to <dst>` restores the snapshot from sandboxName into a different
      // sandbox. If `dst` is not yet live, it is auto-created by cloning the
      // source sandbox's baked image. Without `--to`, restore targets
      // sandboxName itself
      const parsed = parseRestoreArgs(sandboxName, subArgs);
      if (!parsed.ok) {
        console.error(`  ${parsed.error}`);
        process.exit(1);
      }
      const targetSandbox =
        parsed.targetSandbox === sandboxName
          ? sandboxName
          : validateName(parsed.targetSandbox, "target sandbox name");
      const isLive = captureOpenshell(["sandbox", "list"], { ignoreError: true });
      if (isLive.status !== 0) {
        console.error("  Failed to query live sandbox state from OpenShell.");
        process.exit(1);
      }
      const liveNames = parseLiveSandboxNames(isLive.output || "");
      if (!liveNames.has(targetSandbox)) {
        // Self-restore: cannot auto-create, there is no source to clone from.
        if (targetSandbox === sandboxName) {
          console.error(`  Sandbox '${targetSandbox}' is not running. Cannot restore snapshot.`);
          process.exit(1);
        }
        // Cross-sandbox restore into a sandbox that doesn't exist yet:
        // auto-create it by cloning the source's running pod image. The
        // source must exist so we can probe its image via kubectl; the
        // registry entry is used to seed dst's agent/model/provider fields.
        if (!liveNames.has(sandboxName)) {
          console.error(
            `  Cannot auto-create '${targetSandbox}': source '${sandboxName}' not found.`,
          );
          console.error(`  Create '${targetSandbox}' manually with 'nemoclaw onboard'.`);
          process.exit(1);
        }
        const srcEntry = registry.getSandbox(sandboxName) || { name: sandboxName };
        await autoCreateSandboxFromSource(sandboxName, targetSandbox, srcEntry);
      }
      const selector = parsed.selector;
      let backupPath;
      let resolvedSnapshot = null;
      if (selector) {
        const { match } = sandboxState.findBackup(sandboxName, selector);
        if (!match) {
          console.error(`  No snapshot matching '${selector}' found for '${sandboxName}'.`);
          console.error("  Selector must be an exact version (v<N>), name, or timestamp.");
          console.error("  Run: nemoclaw " + sandboxName + " snapshot list");
          process.exit(1);
        }
        backupPath = match.backupPath;
        resolvedSnapshot = match;
        const v = formatSnapshotVersion(match);
        const nameSuffix = match.name ? ` name=${match.name}` : "";
        console.log(`  Using snapshot ${v}${nameSuffix} (${match.timestamp})`);
      } else {
        const latest = sandboxState.getLatestBackup(sandboxName);
        if (!latest) {
          console.error(`  No snapshots found for '${sandboxName}'.`);
          process.exit(1);
        }
        backupPath = latest.backupPath;
        resolvedSnapshot = latest;
        const v = formatSnapshotVersion(latest);
        const nameSuffix = latest.name ? ` name=${latest.name}` : "";
        console.log(`  Using latest snapshot ${v}${nameSuffix} (${latest.timestamp})`);
      }
      if (targetSandbox !== sandboxName) {
        console.log(`  Restoring snapshot from '${sandboxName}' into '${targetSandbox}'...`);
      } else {
        console.log(`  Restoring snapshot into '${sandboxName}'...`);
      }
      const result = sandboxState.restoreSandboxState(targetSandbox, backupPath);
      if (result.success) {
        console.log(`  ${G}\u2713${R} Restored ${result.restoredDirs.length} directories`);
      } else {
        console.error(`  Restore failed.`);
        if (result.restoredDirs.length > 0) {
          console.error(`  Partial: ${result.restoredDirs.join(", ")}`);
        }
        if (result.failedDirs.length > 0) {
          console.error(`  Failed: ${result.failedDirs.join(", ")}`);
        }
        process.exit(1);
      }
      // Reconcile the target's policy presets to match the snapshot manifest
      // exactly — add anything the snapshot recorded but the target is
      // missing, and remove anything the target has that the snapshot did
      // not. This mirrors how stateDirs are restored (full replacement, not
      // additive) so the command's semantics are consistent.
      //
      // When the snapshot predates the `policyPresets` field (undefined),
      // skip the reconcile entirely — we have no recorded state to match.
      if (resolvedSnapshot && Array.isArray(resolvedSnapshot.policyPresets)) {
        const snapshotPresets = resolvedSnapshot.policyPresets;
        const currentPresets = policies.getAppliedPresets(targetSandbox);
        const toRemove = currentPresets.filter((p) => !snapshotPresets.includes(p));
        const toAdd = snapshotPresets.filter((p) => !currentPresets.includes(p));

        if (toRemove.length > 0 || toAdd.length > 0) {
          const summary = [];
          if (toAdd.length > 0) summary.push(`add ${toAdd.join(", ")}`);
          if (toRemove.length > 0) summary.push(`remove ${toRemove.join(", ")}`);
          console.log(
            `  Reconciling policy presets on '${targetSandbox}': ${summary.join("; ")}`,
          );

          const failed = [];
          for (const preset of toRemove) {
            try {
              if (!policies.removePreset(targetSandbox, preset)) {
                failed.push(`${preset} (remove failed)`);
              }
            } catch (err) {
              failed.push(`${preset} (remove: ${err.message})`);
            }
          }
          for (const preset of toAdd) {
            try {
              if (!policies.applyPreset(targetSandbox, preset)) {
                failed.push(`${preset} (apply failed)`);
              }
            } catch (err) {
              failed.push(`${preset} (apply: ${err.message})`);
            }
          }
          if (failed.length > 0) {
            console.warn(`  Warning: could not reconcile preset(s): ${failed.join("; ")}`);
          }
        }
      }
      break;
    }
    default:
      console.log(`  Usage:`);
      console.log(`    nemoclaw ${sandboxName} snapshot create [--name <name>]`);
      console.log(`                                             Create a snapshot (auto-versioned v1, v2, ...)`);
      console.log(`    nemoclaw ${sandboxName} snapshot list            List available snapshots`);
      console.log(`    nemoclaw ${sandboxName} snapshot restore [selector] [--to <dst>]`);
      console.log(`                                             Restore by version (v1), name, or timestamp.`);
      console.log(`                                             Omit selector to restore the most recent.`);
      console.log(`                                             Use --to to restore into another sandbox; <dst> is auto-created if missing.`);
      break;
  }
}

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
      console.log(
        `  ${G}\u2713${R} ${sb.name}: ${result.backedUpDirs.length} dirs → ${result.manifest.backupPath}`,
      );
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

// ── Garbage collection ──────────────────────────────────────────

async function garbageCollectImages(args = []) {
  const dryRun = args.includes("--dry-run");
  const skipConfirm = args.includes("--yes") || args.includes("--force");

  // 1. List all openshell/sandbox-from images on the host
  const imagesResult = spawnSync(
    "docker",
    ["images", "--filter", "reference=openshell/sandbox-from", "--format", "{{.Repository}}:{{.Tag}}\t{{.Size}}"],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (imagesResult.status !== 0) {
    console.error("  Failed to query Docker images. Is Docker running?");
    process.exit(1);
  }

  const allImages = (imagesResult.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [tag, size] = line.split("\t");
      return { tag, size: size || "unknown" };
    });

  if (allImages.length === 0) {
    console.log("  No sandbox images found on the host.");
    return;
  }

  // 2. Determine which images are in use by live or registered sandboxes
  const registeredTags = new Set();
  const { sandboxes } = registry.listSandboxes();
  for (const sb of sandboxes) {
    if (sb.imageTag) registeredTags.add(sb.imageTag);
  }

  // 3. Cross-reference to find orphans
  const orphans = allImages.filter((img) => !registeredTags.has(img.tag));

  if (orphans.length === 0) {
    console.log(`  All ${allImages.length} sandbox image(s) are in use. Nothing to clean up.`);
    return;
  }

  // 4. Display what will be removed
  console.log(`  Found ${orphans.length} orphaned sandbox image(s):\n`);
  for (const img of orphans) {
    console.log(`    ${img.tag}  ${D}(${img.size})${R}`);
  }
  console.log("");

  if (dryRun) {
    console.log(`  --dry-run: would remove ${orphans.length} image(s).`);
    return;
  }

  // 5. Confirm
  if (!skipConfirm) {
    const answer = await askPrompt(`  Remove ${orphans.length} orphaned image(s)? [y/N]: `);
    if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
      console.log("  Cancelled.");
      return;
    }
  }

  // 6. Remove orphans
  let removed = 0;
  let failed = 0;
  for (const img of orphans) {
    const rmiResult = spawnSync("docker", ["rmi", img.tag], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (rmiResult.status === 0) {
      console.log(`  ${G}✓${R} Removed ${img.tag}`);
      removed++;
    } else {
      const details = `${rmiResult.stderr || rmiResult.stdout || ""}`.trim();
      console.error(
        `  ${YW}⚠${R} Failed to remove ${img.tag}${details ? `: ${details}` : ""}`,
      );
      failed++;
    }
  }

  console.log("");
  if (removed > 0) console.log(`  ${G}✓${R} Removed ${removed} orphaned image(s).`);
  if (failed > 0) console.log(`  ${YW}⚠${R} Failed to remove ${failed} image(s).`);
  if (failed > 0) process.exit(1);
}

// ── Help ─────────────────────────────────────────────────────────

/** Print CLI usage with all commands, flags, and reconfiguration guidance. */
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
    nemoclaw <name> snapshot create   Create a snapshot of sandbox state ${D}([--name <label>] to tag it)${R}
    nemoclaw <name> snapshot list     List available snapshots
    nemoclaw <name> snapshot restore  Restore state from a snapshot ${D}([v<N>|name|timestamp], omit for latest; --to <dst> clones into another sandbox, auto-created from this sandbox's image if missing)${R}
    nemoclaw <name> rebuild          Upgrade sandbox to current agent version ${D}(--yes to skip prompt)${R}
    nemoclaw <name> destroy          Stop NIM + delete sandbox ${D}(--yes to skip prompt)${R}

  ${G}Skills:${R}
    nemoclaw <name> skill install <path>  Deploy a skill directory to the sandbox

  ${G}Policy Presets:${R}
    nemoclaw <name> policy-add [preset]    Add a network or filesystem policy preset ${D}(--yes, --dry-run)${R}
    nemoclaw <name> policy-remove [preset] Remove an applied policy preset ${D}(--yes, --dry-run)${R}
    nemoclaw <name> policy-list      List presets ${D}(● = applied)${R}

  ${G}Messaging Channels:${R}
    nemoclaw <name> channels list             List supported messaging channels
    nemoclaw <name> channels add <channel>    Save credentials and rebuild ${D}(telegram|discord|slack)${R}
    nemoclaw <name> channels remove <channel> Clear credentials and rebuild
    nemoclaw <name> channels stop <channel>   Disable channel (keeps credentials)
    nemoclaw <name> channels start <channel>  Re-enable a previously stopped channel

  ${G}Compatibility Commands:${R}
    nemoclaw setup                   Deprecated alias for ${B}nemoclaw onboard${R}
    nemoclaw setup-spark             Deprecated alias for ${B}nemoclaw onboard${R}
    nemoclaw deploy <instance>       Deprecated Brev-specific bootstrap path

  ${G}Services:${R}
    nemoclaw tunnel start            Start the cloudflared public-URL tunnel
    nemoclaw tunnel stop             Stop the cloudflared public-URL tunnel
    nemoclaw start                   ${D}Deprecated alias for 'tunnel start'${R}
    nemoclaw stop                    ${D}Deprecated alias for 'tunnel stop'${R}
    nemoclaw status                  Show sandbox list and service status

  Troubleshooting:
    nemoclaw debug [--quick] [--sandbox NAME]
                                     Collect diagnostics for bug reports
    nemoclaw debug --output FILE     Save diagnostics tarball for GitHub issues

  ${G}Credentials:${R}
    nemoclaw credentials list        List stored credential keys
    nemoclaw credentials reset <KEY> Remove a stored credential so onboard re-prompts

  ${G}Backup:${R}
    nemoclaw backup-all              Back up all sandbox state before upgrade

  ${G}Upgrade:${R}
    nemoclaw upgrade-sandboxes       Detect and rebuild stale sandboxes ${D}(--check, --auto)${R}

  ${G}Cleanup:${R}
    nemoclaw gc                      Remove orphaned sandbox Docker images ${D}(--yes|--force, --dry-run)${R}
    nemoclaw uninstall [flags]       Run uninstall.sh (local only; no remote fallback)

  ${G}Uninstall flags:${R}
    --yes                            Skip the confirmation prompt
    --keep-openshell                 Leave the openshell binary installed
    --delete-models                  Remove NemoClaw-pulled Ollama models

  ${G}Reconfiguration (after onboard):${R}
    ${D}Change inference model at runtime (no re-onboard needed):${R}
      openshell inference set -g nemoclaw -m <model> -p <provider>

    ${D}Add network presets (e.g. Telegram, GitHub) to a running sandbox:${R}
      nemoclaw <name> policy-add

    ${D}Change credentials, messaging channels, or sandbox image settings:${R}
      nemoclaw credentials reset <KEY>   ${D}then${R}   nemoclaw onboard

    ${D}openclaw.json is read-only inside the sandbox (Landlock enforced).${R}
    ${D}To change OpenClaw settings, re-run nemoclaw onboard to rebuild the sandbox.${R}

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
        console.error(
          `  ${YW}Deprecated:${R} 'nemoclaw start' is now 'nemoclaw tunnel start'. See 'nemoclaw help'.`,
        );
        await start();
        break;
      case "stop":
        console.error(
          `  ${YW}Deprecated:${R} 'nemoclaw stop' is now 'nemoclaw tunnel stop'. See 'nemoclaw help'.`,
        );
        stop();
        break;
      case "tunnel":
        await tunnel(args);
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
      case "upgrade-sandboxes":
        await upgradeSandboxes(args);
        break;
      case "gc":
        await garbageCollectImages(args);
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
  // If the registry doesn't know this name but the action is a sandbox-scoped
  // command, attempt recovery — the sandbox may still be live with a stale registry.
  const sandboxActions = [
    "connect",
    "status",
    "logs",
    "policy-add",
    "policy-remove",
    "policy-list",
    "destroy",
    "skill",
    "rebuild",
    "snapshot",
    "shields",
    "config",
    "channels",
    "",
  ];
  if (!registry.getSandbox(cmd) && sandboxActions.includes(args[0] || "")) {
    validateName(cmd, "sandbox name");
    await recoverRegistryEntries({ requestedSandboxName: cmd });
    if (!registry.getSandbox(cmd)) {
      console.error(`  Sandbox '${cmd}' does not exist.`);
      const allNames = registry.listSandboxes().sandboxes.map((s) => s.name);
      if (allNames.length > 0) {
        console.error("");
        console.error(`  Registered sandboxes: ${allNames.join(", ")}`);
        console.error(`  Run 'nemoclaw list' to see all sandboxes.`);
      } else {
        console.error(`  Run 'nemoclaw onboard' to create one.`);
      }
      process.exit(1);
    }
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
      case "policy-remove":
        await sandboxPolicyRemove(cmd, actionArgs);
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
      case "snapshot":
        await sandboxSnapshot(cmd, actionArgs);
        break;
      case "shields": {
        const shieldsSub = actionArgs[0];
        const shieldsFlags = actionArgs.slice(1);
        switch (shieldsSub) {
          case "down": {
            const opts = { timeout: null, reason: null, policy: "permissive" };
            for (let i = 0; i < shieldsFlags.length; i++) {
              if (shieldsFlags[i] === "--timeout") {
                if (i + 1 >= shieldsFlags.length || shieldsFlags[i + 1].startsWith("--")) {
                  console.error("  --timeout requires a value (e.g. 5m, 30m, 300)");
                  process.exit(1);
                }
                opts.timeout = shieldsFlags[++i];
              } else if (shieldsFlags[i] === "--reason") {
                if (i + 1 >= shieldsFlags.length || shieldsFlags[i + 1].startsWith("--")) {
                  console.error("  --reason requires a value");
                  process.exit(1);
                }
                opts.reason = shieldsFlags[++i];
              } else if (shieldsFlags[i] === "--policy") {
                if (i + 1 >= shieldsFlags.length || shieldsFlags[i + 1].startsWith("--")) {
                  console.error("  --policy requires a value (e.g. permissive, /path/to/policy.yaml)");
                  process.exit(1);
                }
                opts.policy = shieldsFlags[++i];
              } else {
                console.error(`  Unknown flag: ${shieldsFlags[i]}`);
                process.exit(1);
              }
            }
            shields.shieldsDown(cmd, opts);
            break;
          }
          case "up":
            shields.shieldsUp(cmd);
            break;
          case "status":
            shields.shieldsStatus(cmd);
            break;
          default:
            console.error("  Usage: nemoclaw <name> shields <down|up|status>");
            console.error("    down  [--timeout 5m] [--reason 'text'] [--policy permissive]");
            console.error("    up    Restore policy from snapshot");
            console.error("    status  Show current shields state");
            process.exit(1);
        }
        break;
      }
      case "channels": {
        const channelsSub = actionArgs[0];
        const channelsArgs = actionArgs.slice(1);
        switch (channelsSub) {
          case "list":
          case undefined:
          case "":
            sandboxChannelsList(cmd);
            break;
          case "add":
            await sandboxChannelsAdd(cmd, channelsArgs);
            break;
          case "remove":
            await sandboxChannelsRemove(cmd, channelsArgs);
            break;
          case "stop":
            await sandboxChannelsStop(cmd, channelsArgs);
            break;
          case "start":
            await sandboxChannelsStart(cmd, channelsArgs);
            break;
          default:
            console.error(`  Unknown channels subcommand: ${channelsSub}`);
            console.error("  Usage: nemoclaw <name> channels <list|add|remove|stop|start> [args]");
            console.error("    list                  List supported messaging channels");
            console.error("    add <channel>         Store credentials and rebuild the sandbox");
            console.error("    remove <channel>      Clear credentials and rebuild the sandbox");
            console.error("    stop <channel>        Disable channel without wiping credentials");
            console.error("    start <channel>       Re-enable a previously stopped channel");
            process.exit(1);
        }
        break;
      }
      case "config": {
        const configSub = actionArgs[0];
        switch (configSub) {
          case "get": {
            const configOpts = { key: null, format: "json" };
            for (let i = 1; i < actionArgs.length; i++) {
              if (actionArgs[i] === "--key") configOpts.key = actionArgs[++i];
              else if (actionArgs[i] === "--format") configOpts.format = actionArgs[++i];
            }
            sandboxConfig.configGet(cmd, configOpts);
            break;
          }
          case "set": {
            const setOpts = { key: null, value: null, restart: false };
            for (let i = 1; i < actionArgs.length; i++) {
              if (actionArgs[i] === "--key") setOpts.key = actionArgs[++i];
              else if (actionArgs[i] === "--value") setOpts.value = actionArgs[++i];
              else if (actionArgs[i] === "--restart") setOpts.restart = true;
            }
            sandboxConfig.configSet(cmd, setOpts);
            break;
          }
          case "rotate-token": {
            const tokenOpts = { fromEnv: null, fromStdin: false };
            for (let i = 1; i < actionArgs.length; i++) {
              if (actionArgs[i] === "--from-env") tokenOpts.fromEnv = actionArgs[++i];
              else if (actionArgs[i] === "--from-stdin") tokenOpts.fromStdin = true;
            }
            await sandboxConfig.configRotateToken(cmd, tokenOpts);
            break;
          }
          default:
            console.error("  Usage: nemoclaw <name> config <get|set|rotate-token>");
            console.error("    get           [--key dotpath] [--format json|yaml]");
            console.error("    set           --key <dotpath> --value <value> [--restart]");
            console.error("    rotate-token  [--from-env <VAR>] [--from-stdin]");
            process.exit(1);
        }
        break;
      }
      default:
        console.error(`  Unknown action: ${action}`);
        console.error(
          `  Valid actions: connect, status, logs, policy-add, policy-remove, policy-list, skill, snapshot, rebuild, shields, config, channels, destroy`,
        );
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
