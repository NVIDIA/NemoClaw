// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execFileSync, spawn, spawnSync } = require("child_process");
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

const { ROOT, run, runInteractive, shellQuote, validateName } = require("./lib/runner");
const {
  dockerCapture,
  dockerInspect,
  dockerListImagesFormat,
  dockerRemoveVolumesByPrefix,
  dockerRmi,
} = require("./lib/docker");
const { resolveOpenshell } = require("./lib/resolve-openshell");
const {
  fetchGatewayAuthTokenFromSandbox,
  startGatewayForRecovery,
  pruneKnownHostsEntries,
  hydrateCredentialEnv,
  isNonInteractive,
} = require("./lib/onboard");
const { ensureOllamaAuthProxy } = require("./lib/onboard-ollama-proxy");
const { parseGatewayTokenArgs, runGatewayTokenCommand } = require("./lib/gateway-token-command");
const {
  getCredential,
  prompt: askPrompt,
} = require("./lib/credentials");
const registry = require("./lib/registry");
import type { SandboxEntry } from "./lib/registry";
const nim = require("./lib/nim");
const policies = require("./lib/policies");
const shields = require("./lib/shields");
const sandboxConfig = require("./lib/sandbox-config");
const { parseGatewayInference } = require("./lib/inference-config");
const { probeProviderHealth } = require("./lib/inference-health");
const { getVersion } = require("./lib/version");
const onboardSession = require("./lib/onboard-session");
import type { Session } from "./lib/onboard-session";
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
const skillInstall = require("./lib/skill-install");
const { sleepSeconds } = require("./lib/wait");
const { parseSandboxPhase } = require("./lib/gateway-state");
const {
  getActiveSandboxSessions,
  createSystemDeps: createSessionDeps,
} = require("./lib/sandbox-session-state");

const {
  commandsByGroup: registryCommandsByGroup,
  canonicalUsageList,
  globalCommandTokens,
  sandboxActionTokens,
} = require("./lib/command-registry");
import {
  KNOWN_CHANNELS,
  clearChannelTokens,
  getChannelDef,
  getChannelTokenKeys,
  knownChannelNames,
  persistChannelTokens,
} from "./lib/sandbox-channels";
import {
  OPENSHELL_OPERATION_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "./lib/openshell-timeouts";
const onboardProviders = require("./lib/onboard-providers");

// ── Global commands (derived from command registry) ──────────────

const GLOBAL_COMMANDS = globalCommandTokens();

type CommandArgs = string[];
type RunnerOptions = {
  env?: NodeJS.ProcessEnv;
  stdio?: import("node:child_process").StdioOptions;
  ignoreError?: boolean;
  timeout?: number;
};

type SpawnLikeResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  output?: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
};

type SandboxCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type RecoveredSandboxMetadata = Partial<
  Pick<SandboxEntry, "model" | "provider" | "gpuEnabled" | "policies" | "nimContainer" | "agent">
> & {
  policyPresets?: string[] | null;
};

const REMOTE_UNINSTALL_URL = buildVersionedUninstallUrl(getVersion());
let OPENSHELL_BIN: string | null = null;
const NEMOCLAW_GATEWAY_NAME = "nemoclaw";
const DASHBOARD_FORWARD_PORT = String(DASHBOARD_PORT);
const DEFAULT_LOGS_PROBE_TIMEOUT_MS = 5000;
const LOGS_PROBE_TIMEOUT_ENV = "NEMOCLAW_LOGS_PROBE_TIMEOUT_MS";

function getOpenshellBinary(): string {
  if (!OPENSHELL_BIN) {
    OPENSHELL_BIN = resolveOpenshell();
  }
  if (!OPENSHELL_BIN) {
    console.error("openshell CLI not found. Install OpenShell before using sandbox commands.");
    process.exit(1);
  }
  return OPENSHELL_BIN;
}

function runOpenshell(args: CommandArgs, opts: RunnerOptions = {}) {
  return runOpenshellCommand(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: opts.env,
    stdio: opts.stdio,
    ignoreError: opts.ignoreError,
    timeout: opts.timeout,
    errorLine: console.error,
    exit: (code: number) => process.exit(code),
  });
}

function captureOpenshell(args: CommandArgs, opts: RunnerOptions = {}) {
  return captureOpenshellCommand(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: opts.env,
    ignoreError: opts.ignoreError,
    timeout: opts.timeout,
    errorLine: console.error,
    exit: (code: number) => process.exit(code),
  });
}

function cleanupGatewayAfterLastSandbox() {
  runOpenshell(["forward", "stop", DASHBOARD_FORWARD_PORT], {
    ignoreError: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  runOpenshell(["gateway", "destroy", "-g", NEMOCLAW_GATEWAY_NAME], { ignoreError: true });
  dockerRemoveVolumesByPrefix(`openshell-cluster-${NEMOCLAW_GATEWAY_NAME}`, {
    ignoreError: true,
  });
}

function hasNoLiveSandboxes() {
  const liveList = captureOpenshell(["sandbox", "list"], {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (liveList.status !== 0) {
    return false;
  }
  return parseLiveSandboxNames(liveList.output).size === 0;
}

function isMissingSandboxDeleteResult(output = ""): boolean {
  return /\bNotFound\b|\bNot Found\b|sandbox not found|sandbox .* not found|sandbox .* not present|sandbox does not exist|no such sandbox/i.test(
    stripAnsi(output),
  );
}

function getSandboxDeleteOutcome(deleteResult: SpawnLikeResult) {
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
function executeSandboxCommand(sandboxName: string, command: string): SandboxCommandResult | null {
  const sshConfigResult = captureOpenshell(["sandbox", "ssh-config", sandboxName], {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
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
function isSandboxGatewayRunning(sandboxName: string): boolean | null {
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
function recoverSandboxProcesses(sandboxName: string): boolean {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const agentScript = agentRuntime.buildRecoveryScript(agent, agent?.forwardPort ?? DASHBOARD_PORT);
  const script =
    agentScript ||
    [
      // Source /tmp/nemoclaw-proxy-env.sh explicitly so NODE_OPTIONS preload
      // guards (safety-net, ciao, slack, …) survive gateway respawn. Without
      // this, library errors crash-loop the gateway because the original
      // .bashrc-only path silently failed when the env file was unreadable
      // or the shell did not source ~/.bashrc. See #2478. Mirrors the
      // hardened block in src/lib/agent-runtime.ts:buildRecoveryScript.
      // Defer warning emission until AFTER touch+chmod gateway.log so
      // warnings land in the persistent log a sysadmin would tail. Stderr
      // alone hides them because executeSandboxCommand captures stderr
      // without surfacing it. Mirrors src/lib/agent-runtime.ts.
      "if [ -r /tmp/nemoclaw-proxy-env.sh ]; then . /tmp/nemoclaw-proxy-env.sh; _PE_MISSING=0; else _PE_MISSING=1; fi;",
      "[ -f ~/.bashrc ] && . ~/.bashrc;",
      'case "${NODE_OPTIONS:-}" in *nemoclaw-sandbox-safety-net*) _GUARDS_MISSING=0 ;; *) _GUARDS_MISSING=1 ;; esac;',
      `if curl -sf --max-time 3 http://127.0.0.1:${DASHBOARD_PORT}/ > /dev/null 2>&1; then echo ALREADY_RUNNING; exit 0; fi;`,
      "rm -rf /tmp/openclaw-*/gateway.*.lock 2>/dev/null;",
      "rm -f /tmp/gateway.log /tmp/auto-pair.log;",
      "touch /tmp/gateway.log; chmod 600 /tmp/gateway.log;",
      "touch /tmp/auto-pair.log; chmod 600 /tmp/auto-pair.log;",
      '[ "$_PE_MISSING" = "1" ] && { _W="[gateway-recovery] WARNING: /tmp/nemoclaw-proxy-env.sh missing — gateway launching without library guards (#2478)"; echo "$_W" >&2; echo "$_W" >> /tmp/gateway.log; };',
      '[ "$_GUARDS_MISSING" = "1" ] && { _W="[gateway-recovery] WARNING: NODE_OPTIONS missing safety-net preload — gateway may crash on unhandled library errors (#2478)"; echo "$_W" >&2; echo "$_W" >> /tmp/gateway.log; };',
      'OPENCLAW="$(command -v openclaw)";',
      'if [ -z "$OPENCLAW" ]; then echo OPENCLAW_MISSING; exit 1; fi;',
      // Append rather than truncate so [gateway-recovery] WARNING lines
      // written above survive past the launch. (#2478)
      `nohup "$OPENCLAW" gateway run --port ${DASHBOARD_PORT} >> /tmp/gateway.log 2>&1 &`,
      "GPID=$!; sleep 2;",
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
function ensureSandboxPortForward(sandboxName: string): void {
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
function checkAndRecoverSandboxProcesses(
  sandboxName: string,
  { quiet = false }: { quiet?: boolean } = {},
) {
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

function buildRecoveredSandboxEntry(
  name: string,
  metadata: RecoveredSandboxMetadata = {},
): SandboxEntry {
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

function upsertRecoveredSandbox(name: string, metadata: RecoveredSandboxMetadata = {}) {
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

function shouldRecoverRegistryEntries(
  current: { sandboxes: Array<{ name: string }>; defaultSandbox?: string | null },
  session: Session | null,
  requestedSandboxName: string | null,
) {
  const sessionSandboxName = session?.sandboxName ?? null;
  const hasSessionSandbox = Boolean(sessionSandboxName);
  const missingSessionSandbox =
    hasSessionSandbox && !current.sandboxes.some((sandbox) => sandbox.name === sessionSandboxName);
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

function seedRecoveryMetadata(
  current: { sandboxes: SandboxEntry[] },
  session: Session | null,
  requestedSandboxName: string | null,
) {
  const metadataByName = new Map<string, RecoveredSandboxMetadata>(
    current.sandboxes.map((sandbox: SandboxEntry) => [sandbox.name, sandbox]),
  );
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
    (sandbox: { name: string }) => sandbox.name === session.sandboxName,
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

async function recoverRegistryFromLiveGateway(
  metadataByName: Map<string, RecoveredSandboxMetadata>,
) {
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
  const liveList = captureOpenshell(["sandbox", "list"], {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  const liveNames = Array.from<string>(parseLiveSandboxNames(liveList.output));
  for (const name of liveNames) {
    const metadata = metadataByName.get(name) || undefined;
    if (upsertRecoveredSandbox(name, metadata)) {
      recoveredFromGateway += 1;
    }
  }
  return recoveredFromGateway;
}

function applyRecoveredDefault(
  currentDefaultSandbox: string | null,
  requestedSandboxName: string | null,
  session: Session | null,
) {
  const recovered = registry.listSandboxes();
  const preferredDefault =
    requestedSandboxName || (!currentDefaultSandbox ? session?.sandboxName || null : null);
  if (
    preferredDefault &&
    recovered.sandboxes.some((sandbox: { name: string }) => sandbox.name === preferredDefault)
  ) {
    registry.setDefault(preferredDefault);
  }
  return registry.listSandboxes();
}

async function recoverRegistryEntries({
  requestedSandboxName = null,
}: { requestedSandboxName?: string | null } = {}) {
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

function hasNamedGateway(output = ""): boolean {
  return stripAnsi(output).includes("Gateway: nemoclaw");
}

function getActiveGatewayName(output = ""): string | null {
  const match = stripAnsi(output).match(/^\s*Gateway:\s+(.+?)\s*$/m);
  return match ? match[1].trim() : null;
}

function getNamedGatewayLifecycleState() {
  const status = captureOpenshell(["status"], { timeout: OPENSHELL_PROBE_TIMEOUT_MS });
  const gatewayInfo = captureOpenshell(["gateway", "info", "-g", "nemoclaw"], {
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
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

  runOpenshell(["gateway", "select", "nemoclaw"], {
    ignoreError: true,
    timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
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
    runOpenshell(["gateway", "select", "nemoclaw"], {
      ignoreError: true,
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    after = getNamedGatewayLifecycleState();
    if (after.state === "healthy_named") {
      process.env.OPENSHELL_GATEWAY = "nemoclaw";
      return { recovered: true, before, after, attempted: true, via: "start" };
    }
  }

  return { recovered: false, before, after, attempted: true };
}

/** Query sandbox presence and return its output with the live enforced policy. */
function getSandboxGatewayState(sandboxName: string) {
  const result = captureOpenshell(["sandbox", "get", sandboxName], {
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  let output = result.output;
  if (result.status === 0) {
    // `openshell sandbox get` returns the immutable baseline policy from sandbox
    // creation, which does not include network_policies added later via
    // `openshell policy set`. Replace the Policy section with the live policy
    // from `policy get --full`, preserving the colored "Policy:" header and
    // Sandbox info above it. (#1132)
    const livePolicy = captureOpenshell(["policy", "get", "--full", sandboxName], {
      ignoreError: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    });
    if (livePolicy.status === 0 && livePolicy.output.trim()) {
      const rawLines = String(output).split("\n");
      const cleanLines = stripAnsi(String(output)).split("\n");
      const policyLineIdx = cleanLines.findIndex((l: string) => l.trim() === "Policy:");
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
            .map((l: string) => (l ? "  " + l : l))
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
function reconcileMissingAgainstNamedGateway(
  sandboxName: string,
  missingLookup: ReturnType<typeof getSandboxGatewayState>,
) {
  const lifecycle = getNamedGatewayLifecycleState();
  if (lifecycle.state === "connected_other") {
    runOpenshell(["gateway", "select", "nemoclaw"], {
      ignoreError: true,
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
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
function printWrongGatewayActiveGuidance(
  sandboxName: string,
  activeGateway: string | null | undefined,
  writer: (message: string) => void = console.error,
) {
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
async function getReconciledSandboxGatewayState(sandboxName: string) {
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

async function ensureLiveSandboxOrExit(
  sandboxName: string,
  { allowNonReadyPhase = false }: { allowNonReadyPhase?: boolean } = {},
) {
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
      onboardSession.updateSession((s: Session) => {
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
    const activeGateway =
      "activeGateway" in lookup && typeof lookup.activeGateway === "string"
        ? lookup.activeGateway
        : undefined;
    printWrongGatewayActiveGuidance(sandboxName, activeGateway, console.error);
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

function exitWithSpawnResult(result: SpawnLikeResult & { signal?: NodeJS.Signals | null }) {
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

function buildOnboardCommandDeps(args: string[]) {
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
    exit: (code: number) => process.exit(code),
  };
}

async function onboard(args: string[]): Promise<void> {
  await runOnboardCommand(buildOnboardCommandDeps(args));
}

async function setup(args: string[] = []): Promise<void> {
  await runDeprecatedOnboardAliasCommand({
    ...buildOnboardCommandDeps(args),
    kind: "setup",
  });
}

async function setupSpark(args: string[] = []): Promise<void> {
  await runDeprecatedOnboardAliasCommand({
    ...buildOnboardCommandDeps(args),
    kind: "setup-spark",
  });
}

async function deploy(instanceName: string): Promise<void> {
  await executeDeploy({
    instanceName,
    env: process.env,
    rootDir: ROOT,
    getCredential,
    validateName,
    shellQuote,
    run,
    runInteractive,
    execFileSync: (
      file: string,
      args: string[],
      opts: Omit<
        import("node:child_process").ExecFileSyncOptionsWithStringEncoding,
        "encoding"
      > = {},
    ) => String(execFileSync(file, args, { encoding: "utf-8", ...opts })),
    spawnSync,
    log: console.log,
    error: console.error,
    stdoutWrite: (message: string) => process.stdout.write(message),
    exit: (code: number) => process.exit(code),
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

async function tunnel(args: string[]): Promise<void> {
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

function debug(args: string[]) {
  const { runDebug } = require("./lib/debug");
  const getDefaultSandbox = (): string | undefined => {
    const { defaultSandbox, sandboxes } = registry.listSandboxes();
    if (!defaultSandbox) return undefined;
    if (!sandboxes.find((s: { name: string }) => s.name === defaultSandbox)) {
      console.error(
        `${_RD}Warning:${R} default sandbox '${defaultSandbox}' is no longer in the registry.`,
      );
      console.error(
        `  Use ${B}--sandbox NAME${R} to target a specific sandbox, or run ${B}nemoclaw onboard${R} again.\n`,
      );
      return undefined;
    }
    const liveList = captureOpenshell(["sandbox", "list"], {
      ignoreError: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    });
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
    exit: (code: number) => process.exit(code),
  });
}

function uninstall(args: string[]) {
  runUninstallCommand({
    args,
    rootDir: ROOT,
    currentDir: __dirname,
    remoteScriptUrl: REMOTE_UNINSTALL_URL,
    env: process.env,
    spawnSyncImpl: spawnSync,
    log: console.log,
    error: console.error,
    exit: (code: number) => process.exit(code),
  });
}

// Suffixes that mark a per-sandbox messaging integration in the gateway's
// provider list, not a NemoClaw-managed credential. The bridge providers are
// created during onboarding (see src/lib/onboard.ts:3203,3208,3218) and torn
// down by the channels/sandbox-delete flows. `nemoclaw credentials list`
// hides them and `nemoclaw credentials reset` refuses to touch them so
// users cannot accidentally break a live integration via the credentials
// surface.
const BRIDGE_PROVIDER_SUFFIXES: readonly string[] = [
  "-telegram-bridge",
  "-discord-bridge",
  "-slack-bridge",
  // Slack registers a second provider for the App-Level Token (used for
  // Socket Mode). bridgeProviderName() emits `${sandbox}-slack-app` for
  // SLACK_APP_TOKEN, so the guardrails must match that suffix too —
  // otherwise the slack-app provider shows up as an ordinary credential
  // and `credentials reset` would happily delete it.
  "-slack-app",
];

function isBridgeProviderName(name: string): boolean {
  return BRIDGE_PROVIDER_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

async function credentialsCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log("");
    console.log("  Usage: nemoclaw credentials <subcommand>");
    console.log("");
    console.log("  Subcommands:");
    console.log("    list                  List provider credentials registered with the OpenShell gateway");
    console.log("    reset <PROVIDER> [--yes]   Remove a provider credential so onboard re-prompts");
    console.log("");
    console.log("  Credentials live in the OpenShell gateway. Inspect with `openshell provider list`.");
    console.log("  Nothing is persisted to host disk; deploy/non-onboard commands read from env vars.");
    console.log("");
    return;
  }

  if (sub === "list") {
    // Pin to the NemoClaw gateway so a different active gateway cannot make
    // us list (or later delete) providers from the wrong place.
    const recovery = await recoverNamedGatewayRuntime();
    if (!recovery.recovered) {
      console.error("  Could not query the NemoClaw OpenShell gateway. Is it running?");
      console.error("  Run 'openshell gateway start --name nemoclaw' or 'nemoclaw onboard' first.");
      process.exit(1);
    }
    const result = runOpenshell(["provider", "list", "--names"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      console.error("  Could not query OpenShell gateway. Is it running?");
      console.error("  Run 'openshell gateway start --name nemoclaw' or 'nemoclaw onboard' first.");
      process.exit(1);
    }
    const allNames = String(result.stdout || "")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // Show only credential providers. Per-sandbox messaging bridges are
    // live integrations managed by the channels surface; surfacing them
    // here would invite users to "reset" what looks like a credential and
    // accidentally destroy a running bridge.
    const credentialNames = allNames.filter((n) => !isBridgeProviderName(n)).sort();
    const bridgeNames = allNames.filter((n) => isBridgeProviderName(n));
    if (credentialNames.length === 0) {
      console.log("  No provider credentials registered.");
    } else {
      console.log("  Providers registered with the OpenShell gateway:");
      for (const name of credentialNames) {
        console.log(`    ${name}`);
      }
    }
    if (bridgeNames.length > 0) {
      console.log("");
      console.log(
        `  ${String(bridgeNames.length)} per-sandbox messaging bridge(s) are also registered.`,
      );
      console.log(
        "  Manage those with `nemoclaw <sandbox> channels list/remove/stop` — not this command.",
      );
    }
    return;
  }

  if (sub === "reset") {
    const key = args[1];
    // Validate that <PROVIDER> is a real positional argument, not a flag like
    // `--yes` that the user passed without a key.
    if (!key || key.startsWith("-")) {
      console.error("  Usage: nemoclaw credentials reset <PROVIDER> [--yes]");
      console.error("  KEY is an OpenShell provider name. Run 'nemoclaw credentials list' first.");
      process.exit(1);
    }
    // Reject unknown trailing arguments to keep scripted use predictable.
    const extraArgs = args.slice(2).filter((arg) => arg !== "--yes" && arg !== "-y");
    if (extraArgs.length > 0) {
      console.error(`  Unknown argument(s) for credentials reset: ${extraArgs.join(", ")}`);
      console.error("  Usage: nemoclaw credentials reset <PROVIDER> [--yes]");
      process.exit(1);
    }
    // Refuse to delete a per-sandbox messaging bridge — those are live
    // integrations created/destroyed by the channels surface, not
    // NemoClaw-managed credentials. Without this guard, scripting against
    // the gateway provider list could tear down a running bridge and
    // leave the sandbox in a half-configured state.
    if (isBridgeProviderName(key)) {
      console.error(
        `  '${key}' is a per-sandbox messaging bridge, not a credential.`,
      );
      console.error(
        "  Use `nemoclaw <sandbox> channels remove <telegram|discord|slack>` to retire",
      );
      console.error(
        "  the integration (it tears down the bridge provider and rebuilds the sandbox),",
      );
      console.error(
        "  or `nemoclaw <sandbox> channels stop <…>` to pause it without clearing tokens.",
      );
      process.exit(1);
    }
    const skipPrompt = args.includes("--yes") || args.includes("-y");
    if (!skipPrompt) {
      const answer = (await askPrompt(`  Remove provider '${key}' from the OpenShell gateway? [y/N]: `))
        .trim()
        .toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        console.log("  Cancelled.");
        return;
      }
    }
    // Pin to the NemoClaw gateway so we cannot accidentally delete a
    // provider from a different active gateway. We deliberately do NOT
    // touch process.env here — `key` is an OpenShell provider name, and
    // calling deleteCredential on it would silently strip an unrelated
    // env entry whenever a provider name happens to share the shape of
    // a credential env variable.
    const recovery = await recoverNamedGatewayRuntime();
    if (!recovery.recovered) {
      console.error("  Could not reach the NemoClaw OpenShell gateway. Is it running?");
      console.error("  Run 'openshell gateway start --name nemoclaw' or 'nemoclaw onboard' first.");
      process.exit(1);
    }
    const result = runOpenshell(["provider", "delete", key], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) {
      console.log(`  Removed provider '${key}' from the OpenShell gateway.`);
      console.log("  Re-run 'nemoclaw onboard' to enter a new value.");
    } else {
      console.error(`  Could not remove provider '${key}'.`);
      // Earlier releases accepted a credential env-var name (e.g.
      // NVIDIA_API_KEY) here; the API now takes an OpenShell provider
      // name (nvidia-prod, openai-api, telegram-bridge, …). Surface the
      // rename to anyone whose script is still passing the old shape.
      if (/^[A-Z][A-Z0-9_]+$/.test(key)) {
        console.error("");
        console.error(`  '${key}' looks like a credential env variable name.`);
        console.error("  As of this release, 'credentials reset' takes an OpenShell");
        console.error("  provider name. Run 'nemoclaw credentials list' to see the");
        console.error("  registered providers, then retry with one of those names.");
      }
      const stderr = String(result.stderr || "").trim();
      if (stderr) console.error(`  ${stderr}`);
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
function checkMessagingBridgeHealth(sandboxName: string, channels: string[]) {
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
  const isGatewayAlive = (): boolean => {
    if (gatewayAlive === null) {
      const result = captureOpenshell(["sandbox", "list"], {
        ignoreError: true,
        timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      });
      gatewayAlive = result.status === 0;
    }
    return gatewayAlive;
  };
  return {
    providerExists: (name: string) => {
      if (!isGatewayAlive()) return "error";
      const result = captureOpenshell(["provider", "get", name], {
        ignoreError: true,
        timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      });
      return result.status === 0 ? "present" : "absent";
    },
  };
}

function backfillAndFindOverlaps() {
  // Non-critical path: status must remain usable even if the gateway probe or
  // registry write throws, so any failure yields an empty overlap list.
  try {
    const { backfillMessagingChannels, findAllOverlaps } = require("./lib/messaging-conflict");
    backfillMessagingChannels(registry, makeConflictProbe());
    return findAllOverlaps(registry);
  } catch {
    return [];
  }
}

/**
 * Read a short tail of the gateway log for degraded messaging diagnostics.
 */
function readGatewayLog(sandboxName: string) {
  const { spawnSync } = require("child_process");
  try {
    const result = spawnSync(
      getOpenshellBinary(),
      [
        "sandbox",
        "exec",
        "-n",
        sandboxName,
        "--",
        "sh",
        "-c",
        "tail -n 10 /tmp/gateway.log 2>/dev/null",
      ],
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
      parseGatewayInference(
        captureOpenshell(["inference", "get"], {
          ignoreError: true,
          timeout: OPENSHELL_PROBE_TIMEOUT_MS,
        }).output,
      ),
    showServiceStatus,
    checkMessagingBridgeHealth,
    backfillAndFindOverlaps,
    readGatewayLog,
    log: console.log,
  });
}

async function listSandboxes(): Promise<void> {
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
      parseGatewayInference(
        captureOpenshell(["inference", "get"], {
          ignoreError: true,
          timeout: OPENSHELL_PROBE_TIMEOUT_MS,
        }).output,
      ),
    loadLastSession: () => onboardSession.loadSession(),
    getActiveSessionCount: sessionDeps
      ? (name: string) => {
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

async function sandboxConnect(sandboxName: string) {
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

  checkAndRecoverSandboxProcesses(sandboxName);
  // Ensure Ollama auth proxy is running (recovers from host reboots)
  ensureOllamaAuthProxy();

  // ── Inference route swap (#1248) ──────────────────────────────────
  // When the user has multiple sandboxes with different providers, the
  // cluster-wide inference.local route may still point at the *other*
  // provider. Re-set it to match this sandbox's persisted config.
  let sb;
  try {
    sb = registry.getSandbox(sandboxName);
    if (sb && sb.provider && sb.model) {
      const live = parseGatewayInference(
        captureOpenshell(["inference", "get"], {
          ignoreError: true,
          timeout: OPENSHELL_PROBE_TIMEOUT_MS,
        }).output,
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
      console.warn(
        `  Warning: invalid NEMOCLAW_CONNECT_TIMEOUT="${rawTimeout}", using default 120s`,
      );
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
      console.error(
        `  Override timeout: NEMOCLAW_CONNECT_TIMEOUT=300 nemoclaw ${sandboxName} connect`,
      );
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
    console.log(
      `  ${D}Type \`/exit\` to leave the chat, then \`exit\` to return to the host shell.${R}`,
    );
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
async function sandboxStatus(sandboxName: string) {
  const sb = registry.getSandbox(sandboxName);
  const live = parseGatewayInference(
    captureOpenshell(["inference", "get"], {
      ignoreError: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    }).output,
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
        console.log(`    Inference: ${G}healthy${R} (${inferenceHealth.endpoint})`);
      } else {
        console.log(`    Inference: ${_RD}unreachable${R} (${inferenceHealth.endpoint})`);
        console.log(`      ${inferenceHealth.detail}`);
      }
    }
    console.log(`    GPU:      ${sb.gpuEnabled ? "yes" : "no"}`);
    console.log(`    Policies: ${(sb.policies || []).join(", ") || "none"}`);

    // Active session indicator
    try {
      const opsBinStatus = resolveOpenshell();
      if (opsBinStatus) {
        const sessionResult = getActiveSandboxSessions(
          sandboxName,
          createSessionDeps(opsBinStatus),
        );
        if (sessionResult.detected) {
          const count = sessionResult.sessions.length;
          console.log(
            `    Connected: ${count > 0 ? `${G}yes${R} (${count} session${count > 1 ? "s" : ""})` : "no"}`,
          );
        }
      }
    } catch {
      /* non-fatal */
    }

    if (shields.isShieldsDown(sandboxName)) {
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
    if ("recoveredGateway" in lookup && lookup.recoveredGateway) {
      console.log(
        `  Recovered NemoClaw gateway runtime via ${("recoveryVia" in lookup ? lookup.recoveryVia : null) || "gateway reattach"}.`,
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
    const activeGateway =
      "activeGateway" in lookup && typeof lookup.activeGateway === "string"
        ? lookup.activeGateway
        : undefined;
    console.log("");
    printWrongGatewayActiveGuidance(sandboxName, activeGateway, console.log);
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
        onboardSession.updateSession((s: Session) => {
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

  const nimStat =
    sb && sb.nimContainer ? nim.nimStatusByName(sb.nimContainer) : nim.nimStatus(sandboxName);
  if (nim.shouldShowNimLine(sb && sb.nimContainer, nimStat.running)) {
    console.log(
      `    NIM:      ${nimStat.running ? `running (${nimStat.container})` : "not running"}`,
    );
    if (nimStat.running) {
      console.log(`    Healthy:  ${nimStat.healthy ? "yes" : "no"}`);
    }
  }
  console.log("");
}

function sandboxLogs(sandboxName: string, follow: boolean) {
  if (follow) {
    streamSandboxFollowLogs(sandboxName);
    return;
  }

  enableSandboxAuditLogs(sandboxName);
  runOpenclawGatewayLogs(sandboxName, false);
  const args = buildSandboxLogsArgs(sandboxName, false);
  const result = runOpenshell(args, {
    stdio: "inherit",
    ignoreError: true,
  });
  if (result.status !== 0) {
    console.error(`  Command failed (exit ${result.status}): openshell ${args.join(" ")}`);
  }
  exitWithSpawnResult(result);
}

function getLogsProbeTimeoutMs(): number {
  const rawValue = process.env[LOGS_PROBE_TIMEOUT_ENV];
  if (!rawValue) {
    return DEFAULT_LOGS_PROBE_TIMEOUT_MS;
  }
  const parsed = Number(rawValue);
  const timeoutMs = Number.isFinite(parsed) ? Math.floor(parsed) : Number.NaN;
  return timeoutMs > 0 ? timeoutMs : DEFAULT_LOGS_PROBE_TIMEOUT_MS;
}

function describeLogProbeResult(result: SpawnLikeResult): string {
  if (result.error) {
    return result.error.message;
  }
  if (result.signal) {
    return `signal ${result.signal}`;
  }
  return `exit ${result.status ?? "unknown"}`;
}

function runOpenclawGatewayLogs(sandboxName: string, follow: boolean): SpawnLikeResult {
  const args = buildSandboxOpenclawGatewayLogsArgs(sandboxName, follow);
  const result = runOpenshell(args, {
    stdio: "inherit",
    ignoreError: true,
    timeout: getLogsProbeTimeoutMs(),
  });
  if (result.status !== 0) {
    console.error(
      `  OpenClaw log source unavailable (${describeLogProbeResult(result)}): ` +
        `openshell ${args.join(" ")}`,
    );
  }
  return result;
}

function streamSandboxFollowLogs(sandboxName: string): void {
  const openclawArgs = buildSandboxOpenclawGatewayLogsArgs(sandboxName, true);
  const openshellArgs = buildSandboxLogsArgs(sandboxName, true);
  const spawnOptions = {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit" as const,
  };
  const sources: Array<{
    label: string;
    args: string[];
    child: import("node:child_process").ChildProcess;
    done: boolean;
  }> = [];
  let exiting = false;
  let completedSources = 0;
  let finalStatus = 0;
  let requestedExitCode: number | null = null;
  let forcedExitTimer: NodeJS.Timeout | null = null;
  // Guard against early exit: a source spawned before enableSandboxAuditLogs
  // can fire its exit event during the blocking spawnSync call, before the
  // second source is registered. Without this flag, maybeExit would see
  // completedSources === sources.length === 1 and exit prematurely.
  let setupComplete = false;

  const stopChildren = (signal: NodeJS.Signals) => {
    for (const { child } of sources) {
      if (!child.killed && child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    }
  };
  const maybeExit = () => {
    if (!setupComplete || completedSources !== sources.length) {
      return;
    }
    if (forcedExitTimer) {
      clearTimeout(forcedExitTimer);
      forcedExitTimer = null;
    }
    process.exit(requestedExitCode ?? finalStatus);
  };
  const exitFromSignal = (signal: NodeJS.Signals | null): number => {
    if (!signal) return 1;
    const signalNumber = os.constants.signals[signal];
    return signalNumber ? 128 + signalNumber : 1;
  };
  const markSourceDone = (
    source: (typeof sources)[number],
    status: number,
    detail: string | null = null,
  ) => {
    if (source.done) return;
    source.done = true;
    completedSources += 1;
    if (status !== 0 && finalStatus === 0) {
      finalStatus = status;
    }
    if (completedSources < sources.length && !exiting) {
      const suffix = detail || `exit ${status}`;
      console.error(`  ${source.label} stopped (${suffix}); continuing with remaining log source.`);
    }
    maybeExit();
  };
  const requestExitAfterSignal = (signal: NodeJS.Signals, exitCode: number) => {
    if (requestedExitCode !== null) return;
    exiting = true;
    requestedExitCode = exitCode;
    stopChildren(signal);
    forcedExitTimer = setTimeout(() => process.exit(exitCode), 2000);
    forcedExitTimer.unref?.();
    maybeExit();
  };

  process.once("SIGINT", () => {
    requestExitAfterSignal("SIGINT", 130);
  });
  process.once("SIGTERM", () => {
    requestExitAfterSignal("SIGTERM", 143);
  });

  const addSource = (label: string, args: string[]) => {
    const source = { label, args, child: spawn(getOpenshellBinary(), args, spawnOptions), done: false };
    sources.push(source);
    source.child.on("error", (error: Error) => {
      markSourceDone(source, 1, error.message);
    });
    source.child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      markSourceDone(source, code ?? exitFromSignal(signal), signal ? `signal ${signal}` : null);
    });
  };

  addSource("OpenClaw log source", openclawArgs);
  enableSandboxAuditLogs(sandboxName);
  addSource("OpenShell log source", openshellArgs);
  setupComplete = true;
  maybeExit();
}

function enableSandboxAuditLogs(sandboxName: string) {
  const args = buildEnableSandboxAuditLogsArgs(sandboxName);
  const result = runOpenshell(args, {
    stdio: ["ignore", "ignore", "pipe"],
    ignoreError: true,
    timeout: getLogsProbeTimeoutMs(),
  });
  if (result.status !== 0) {
    warnSandboxAuditLogsUnavailable(sandboxName, args, result);
  }
}

function warnSandboxAuditLogsUnavailable(
  sandboxName: string,
  args: string[],
  result: SpawnLikeResult,
): void {
  const stderr = String(result.stderr || "").trim();
  console.error(
    `  Warning: failed to enable OpenShell audit logs for sandbox '${sandboxName}' ` +
      `(${describeLogProbeResult(result)}): openshell ${args.join(" ")}`,
  );
  if (stderr) {
    console.error(`  ${stderr}`);
  }
  console.error("  Policy denial events may be missing from OpenShell logs.");
}

function buildEnableSandboxAuditLogsArgs(sandboxName: string): string[] {
  return ["settings", "set", sandboxName, "--key", "ocsf_json_enabled", "--value", "true"];
}

function buildSandboxOpenclawGatewayLogsArgs(sandboxName: string, follow: boolean): string[] {
  const args = ["sandbox", "exec", "-n", sandboxName, "--", "tail", "-n", "200"];
  if (follow) {
    args.push("-f");
  }
  args.push("/tmp/gateway.log");
  return args;
}

function buildSandboxLogsArgs(sandboxName: string, follow: boolean): string[] {
  const args = ["logs", sandboxName, "-n", "200", "--source", "all"];
  if (follow) {
    args.push("--tail");
  }
  return args;
}

/**
 * Handle `nemoclaw <sandbox> policy-add [flags]`. Supports three mutually
 * exclusive modes: interactive preset picker (default), `--from-file <path>`
 * for a single custom preset YAML, and `--from-dir <path>` for every
 * `.yaml`/`.yml` file in a directory. `--dry-run` previews without applying,
 * `--yes`/`-y`/`--force` (or `NEMOCLAW_NON_INTERACTIVE=1`) skips the
 * confirmation prompt. `--from-dir` applies non-hidden files in lexicographic
 * order and aborts at the first failure (already-applied presets are not
 * rolled back).
 */
async function sandboxPolicyAdd(sandboxName: string, args: string[] = []): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const skipConfirm =
    args.includes("--yes") ||
    args.includes("-y") ||
    args.includes("--force") ||
    process.env.NEMOCLAW_NON_INTERACTIVE === "1";

  const fromFileIdx = args.indexOf("--from-file");
  const fromDirIdx = args.indexOf("--from-dir");

  if (fromFileIdx >= 0 && fromDirIdx >= 0) {
    console.error("  --from-file and --from-dir are mutually exclusive.");
    process.exit(1);
  }

  if (fromFileIdx >= 0) {
    const filePath = args[fromFileIdx + 1];
    if (!filePath || filePath.startsWith("--")) {
      console.error("  --from-file requires a path argument.");
      process.exit(1);
    }
    const ok = await applyExternalPreset(sandboxName, filePath, { dryRun, yes: skipConfirm });
    if (!ok) process.exit(1);
    return;
  }

  if (fromDirIdx >= 0) {
    const dirPath = args[fromDirIdx + 1];
    if (!dirPath || dirPath.startsWith("--")) {
      console.error("  --from-dir requires a directory path.");
      process.exit(1);
    }
    const absDir = path.resolve(dirPath);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
      console.error(`  Directory not found: ${dirPath}`);
      process.exit(1);
    }
    const files = fs
      .readdirSync(absDir, { withFileTypes: true })
      .filter(
        (ent: { name: string; isFile(): boolean }) =>
          ent.isFile() && !ent.name.startsWith(".") && /\.ya?ml$/i.test(ent.name),
      )
      .map((ent: { name: string }) => path.join(absDir, ent.name))
      .sort();
    if (files.length === 0) {
      console.error(`  No .yaml/.yml preset files in ${dirPath}`);
      process.exit(1);
    }
    for (const f of files) {
      const ok = await applyExternalPreset(sandboxName, f, { dryRun, yes: skipConfirm });
      if (!ok) {
        console.error(`  Aborting --from-dir: ${f} failed. Remaining presets not applied.`);
        process.exit(1);
      }
    }
    return;
  }

  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  const presetArg = args.find((arg) => !arg.startsWith("-"));
  let answer = null;
  if (presetArg) {
    const normalized = presetArg.trim().toLowerCase();
    const preset = allPresets.find((item: { name: string }) => item.name === normalized);
    if (!preset) {
      console.error(`  Unknown preset '${presetArg}'.`);
      console.error(
        `  Valid presets: ${allPresets.map((item: { name: string }) => item.name).join(", ")}`,
      );
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
    if (confirm.trim().toLowerCase().startsWith("n")) return;
  }

  policies.applyPreset(sandboxName, answer);
}

/**
 * Apply one custom preset file (`--from-file`, or one entry of `--from-dir`)
 * to a sandbox. Loads and validates the file via `policies.loadPresetFromFile`,
 * prints the egress endpoints with a warning that custom targets are not
 * vetted, honors `dryRun` and `yes`, and delegates to
 * `policies.applyPresetContent`. Returns `true` on success, `false` on any
 * load/apply failure so the caller can decide whether to abort.
 */
async function applyExternalPreset(
  sandboxName: string,
  filePath: string,
  { dryRun, yes }: { dryRun: boolean; yes: boolean },
): Promise<boolean> {
  let loaded;
  try {
    loaded = policies.loadPresetFromFile(filePath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Failed to load preset ${filePath}: ${message}`);
    return false;
  }
  if (!loaded) return false;

  const endpoints = policies.getPresetEndpoints(loaded.content);
  if (endpoints.length > 0) {
    console.log(`  [${loaded.presetName}] Endpoints that would be opened: ${endpoints.join(", ")}`);
    console.log(
      `  ${YW}Warning: custom preset targets are not vetted. Review hosts before applying.${R}`,
    );
  }

  if (dryRun) {
    console.log(`  --dry-run: '${loaded.presetName}' not applied.`);
    return true;
  }

  if (!yes) {
    const confirm = await askPrompt(
      `  Apply '${loaded.presetName}' from ${filePath} to sandbox '${sandboxName}'? [Y/n]: `,
    );
    if (confirm.trim().toLowerCase().startsWith("n")) return true; // user-cancel counts as success (no abort)
  }

  try {
    const result = policies.applyPresetContent(sandboxName, loaded.presetName, loaded.content, {
      custom: { sourcePath: path.resolve(filePath) },
    });
    return result !== false;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Failed to apply preset '${loaded.presetName}': ${message}`);
    return false;
  }
}

function sandboxPolicyList(sandboxName: string) {
  const builtin = policies.listPresets();
  const custom = policies.listCustomPresets(sandboxName);
  const allPresets = [...builtin, ...custom];
  const registryPresets = policies.getAppliedPresets(sandboxName);

  // getGatewayPresets returns null when gateway is unreachable, or an
  // array of matched preset names when reachable (possibly empty).
  const gatewayPresets = policies.getGatewayPresets(sandboxName);

  console.log("");
  console.log(`  Policy presets for sandbox '${sandboxName}':`);
  allPresets.forEach((p: { name: string; description: string }) => {
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

function sandboxChannelsList(sandboxName: string) {
  console.log("");
  console.log(`  Known messaging channels for sandbox '${sandboxName}':`);
  for (const [name, channel] of Object.entries(KNOWN_CHANNELS)) {
    console.log(`    ${name} — ${channel.description}`);
  }
  console.log("");
}

// Map a channel + token-env-key to the OpenShell provider name onboarding
// uses for it. Mirrors the names in src/lib/onboard.ts:3201-3221 so a
// channels-add upsert collides with (i.e. updates) the same provider that
// a later rebuild would have created from scratch.
function bridgeProviderName(sandboxName: string, channelName: string, envKey: string): string {
  if (channelName === "slack" && envKey === "SLACK_APP_TOKEN") {
    return `${sandboxName}-slack-app`;
  }
  return `${sandboxName}-${channelName}-bridge`;
}

// Push channel tokens to the OpenShell gateway and add the channel to the
// sandbox registry's messagingChannels list. Done eagerly at `channels
// add` time (not deferred to rebuild) because the host-side credential
// helpers are env-only after the fix — without an immediate gateway
// upsert plus registry update, a "rebuild later" answer would drop the
// queued change since process.env disappears when the CLI exits.
async function applyChannelAddToGatewayAndRegistry(
  sandboxName: string,
  channelName: string,
  acquired: Record<string, string>,
): Promise<void> {
  const recovery = await recoverNamedGatewayRuntime();
  if (!recovery.recovered) {
    console.error("  Could not reach the NemoClaw OpenShell gateway. Tokens were staged");
    console.error("  in env for this run only — re-run after starting the gateway, or run");
    console.error("  'openshell gateway start --name nemoclaw' manually.");
    process.exit(1);
  }
  const tokenDefs = Object.entries(acquired).map(([envKey, token]) => ({
    name: bridgeProviderName(sandboxName, channelName, envKey),
    envKey,
    token,
  }));
  // upsertMessagingProviders handles create-or-update and process.exits on
  // failure, so reaching the next line means every entry is registered.
  onboardProviders.upsertMessagingProviders(tokenDefs, runOpenshell);

  // Persist the enabled-channels list in the registry so a deferred
  // `nemoclaw <sandbox> rebuild` knows the channel set without needing
  // tokens on disk.
  const entry = registry.getSandbox(sandboxName);
  if (entry) {
    const enabled = new Set(entry.messagingChannels || []);
    enabled.add(channelName);
    const disabled = (entry.disabledChannels || []).filter((c: string) => c !== channelName);
    registry.updateSandbox(sandboxName, {
      messagingChannels: Array.from(enabled).sort(),
      disabledChannels: disabled,
    });
  }
}

// Remove a channel's bridge providers from the gateway and drop it from the
// registry's messagingChannels list. Mirrors applyChannelAddToGatewayAndRegistry.
async function applyChannelRemoveToGatewayAndRegistry(
  sandboxName: string,
  channelName: string,
  channelTokenKeys: string[],
): Promise<void> {
  const recovery = await recoverNamedGatewayRuntime();
  if (!recovery.recovered) {
    console.error("  Could not reach the NemoClaw OpenShell gateway to delete the bridge.");
    console.error("  Re-run after starting the gateway, or run 'openshell gateway start --name nemoclaw'.");
    process.exit(1);
  }
  // Capture each delete's outcome. If any non-NotFound failure surfaces
  // we must NOT update the registry — otherwise NemoClaw would record
  // the channel as removed locally while the bridge is still live in
  // the gateway, which produces a half-configured sandbox the user
  // can't easily recover.
  const failed: string[] = [];
  for (const envKey of channelTokenKeys) {
    const name = bridgeProviderName(sandboxName, channelName, envKey);
    const result = runOpenshell(["provider", "delete", name], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      const output = `${result.stdout || ""}${result.stderr || ""}`;
      // Treat "not found" as success-equivalent — a previous run may
      // have already deleted the provider.
      if (!/\bNotFound\b|not found/i.test(output)) {
        failed.push(name);
      }
    }
  }
  if (failed.length > 0) {
    console.error(
      `  Failed to delete bridge provider(s) from the OpenShell gateway: ${failed.join(", ")}.`,
    );
    console.error("  Registry not updated; re-run after resolving the gateway error.");
    process.exit(1);
  }

  const entry = registry.getSandbox(sandboxName);
  if (entry) {
    const enabled = (entry.messagingChannels || []).filter((c: string) => c !== channelName);
    registry.updateSandbox(sandboxName, { messagingChannels: enabled });
  }
}

async function promptAndRebuild(sandboxName: string, actionDesc: string): Promise<void> {
  if (isNonInteractive()) {
    console.log("");
    console.log(`  Change queued. Run 'nemoclaw ${sandboxName} rebuild' to apply (${actionDesc}).`);
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

async function sandboxChannelsAdd(sandboxName: string, args: string[] = []): Promise<void> {
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
  const acquired: Record<string, string> = {};
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
  // Push to the gateway and update the registry NOW so that answering
  // "rebuild later" (or running non-interactively) does not silently
  // discard the change. Pre-fix this was safe because saveCredential()
  // wrote credentials.json; with env-only persistence, exiting before
  // the rebuild used to drop the queued token.
  await applyChannelAddToGatewayAndRegistry(sandboxName, channelArg, acquired);
  console.log(`  ${G}✓${R} Registered ${channelArg} bridge with the OpenShell gateway.`);
  await promptAndRebuild(sandboxName, `add '${channelArg}'`);
}

async function sandboxChannelsRemove(sandboxName: string, args: string[] = []): Promise<void> {
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
  // Same rationale as channels-add: tear down the gateway providers and
  // drop the channel from the registry NOW so a deferred rebuild does
  // not leave a stale bridge running against a token NemoClaw has
  // already "removed" from the user's perspective.
  await applyChannelRemoveToGatewayAndRegistry(
    sandboxName,
    channelArg,
    getChannelTokenKeys(channel),
  );
  console.log(`  ${G}✓${R} Removed ${channelArg} bridge from the OpenShell gateway.`);
  await promptAndRebuild(sandboxName, `remove '${channelArg}'`);
}

async function sandboxChannelsSetEnabled(
  sandboxName: string,
  args: string[],
  disabled: boolean,
): Promise<void> {
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
    console.log(`  --dry-run: would ${verb} channel '${normalized}' for '${sandboxName}'.`);
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

async function sandboxChannelsStop(sandboxName: string, args: string[] = []): Promise<void> {
  await sandboxChannelsSetEnabled(sandboxName, args, true);
}

async function sandboxChannelsStart(sandboxName: string, args: string[] = []): Promise<void> {
  await sandboxChannelsSetEnabled(sandboxName, args, false);
}

function printSkillInstallUsage(): void {
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
}

function looksLikeOpenClawPlugin(candidatePath: string): boolean {
  const dir =
    fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()
      ? candidatePath
      : path.dirname(candidatePath);
  if (!fs.existsSync(dir)) return false;
  if (fs.existsSync(path.join(dir, "openclaw.plugin.json"))) return true;

  const packageJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const openclawBlock = packageJson?.openclaw;
    return Boolean(
      packageJson?.["openclaw.plugin"] === true ||
      openclawBlock === true ||
      (typeof openclawBlock === "object" &&
        openclawBlock !== null &&
        (openclawBlock.plugin === true ||
          typeof openclawBlock.entry === "string" ||
          typeof openclawBlock.main === "string" ||
          (Array.isArray(openclawBlock.extensions) && openclawBlock.extensions.length > 0))),
    );
  } catch {
    return false;
  }
}

function printPluginInstallHint(): void {
  console.error("  This looks like an OpenClaw plugin, not a SKILL.md agent skill.");
  console.error("  `skill install` only accepts skill directories or direct SKILL.md paths.");
  console.error(
    "  To use an OpenClaw plugin today, bake it into a custom sandbox image with `nemoclaw onboard --from <Dockerfile>`.",
  );
}

/**
 * Install or update a local skill directory into a live sandbox and perform
 * any agent-specific post-install refresh needed for the new content to load.
 */
async function sandboxSkillInstall(sandboxName: string, args: string[] = []): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printSkillInstallUsage();
    return;
  }

  if (sub !== "install") {
    console.error(`  Unknown skill subcommand: ${sub}`);
    console.error("  Valid subcommands: install");
    process.exit(1);
  }

  const skillPath = args[1];
  const extraArgs = args.slice(2);
  if (skillPath === "--help" || skillPath === "-h" || skillPath === "help") {
    printSkillInstallUsage();
    return;
  }
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
    if (looksLikeOpenClawPlugin(resolvedPath)) {
      printPluginInstallHint();
    }
    process.exit(1);
  }

  if (!fs.existsSync(skillMdPath)) {
    console.error(`  No SKILL.md found in '${skillDir}'.`);
    console.error("  The skill directory must contain a SKILL.md file.");
    if (looksLikeOpenClawPlugin(skillDir)) {
      printPluginInstallHint();
    }
    process.exit(1);
  }

  // 1. Validate frontmatter
  let frontmatter;
  try {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    frontmatter = skillInstall.parseFrontmatter(content);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`  ${errorMessage}`);
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

async function sandboxPolicyRemove(sandboxName: string, args: string[] = []): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const skipConfirm =
    args.includes("--yes") ||
    args.includes("-y") ||
    args.includes("--force") ||
    process.env.NEMOCLAW_NON_INTERACTIVE === "1";

  // Remove-able presets = built-in presets + custom presets applied via
  // --from-file / --from-dir (tracked in registry.customPolicies).
  const builtinPresets = policies.listPresets();
  const customPresets = policies.listCustomPresets(sandboxName);
  const allPresets = [...builtinPresets, ...customPresets];
  const applied = policies.getAppliedPresets(sandboxName);

  const presetArg = args.find((arg) => !arg.startsWith("-"));
  let answer = null;
  if (presetArg) {
    const normalized = presetArg.trim().toLowerCase();
    const preset = allPresets.find((item: { name: string }) => item.name === normalized);
    if (!preset) {
      console.error(`  Unknown preset '${presetArg}'.`);
      console.error(
        `  Valid presets: ${allPresets.map((item: { name: string }) => item.name).join(", ") || "(none)"}`,
      );
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

  // Resolve preset content: built-in first, then custom (persisted in
  // registry). Needed only for the endpoint preview below — removePreset()
  // itself re-resolves on the library side.
  let presetContent: string | null = policies.loadPreset(answer);
  if (!presetContent) {
    const entry = customPresets.find((p: { name: string }) => p.name === answer);
    if (entry) {
      const persisted = registry
        .getCustomPolicies(sandboxName)
        .find((p: { name: string }) => p.name === answer);
      presetContent = persisted ? persisted.content : null;
    }
  }
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
    if (confirm.trim().toLowerCase().startsWith("n")) return;
  }

  if (!policies.removePreset(sandboxName, answer)) {
    process.exit(1);
  }
}

function cleanupSandboxServices(
  sandboxName: string,
  { stopHostServices = false }: { stopHostServices?: boolean } = {},
) {
  if (stopHostServices) {
    const { stopAll } = require("./lib/services");
    stopAll({ sandboxName });
  }
  try {
    fs.rmSync(`/tmp/nemoclaw-services-${sandboxName}`, { recursive: true, force: true });
  } catch {
    // PID directory may not exist — ignore.
  }

  // Delete messaging providers created during onboard. Suppress stderr so
  // "! Provider not found" noise doesn't appear when messaging was never configured.
  for (const suffix of ["telegram-bridge", "discord-bridge", "slack-bridge"]) {
    runOpenshell(["provider", "delete", `${sandboxName}-${suffix}`], {
      ignoreError: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
  }
}

/**
 * Remove the host-side Docker image that was built for a sandbox during onboard.
 * Must be called before registry.removeSandbox() since the imageTag is stored there.
 */
function removeSandboxImage(sandboxName: string) {
  const sb = registry.getSandbox(sandboxName);
  if (!sb?.imageTag) return;
  const result = dockerRmi(sb.imageTag, { ignoreError: true });
  if (result.status === 0) {
    console.log(`  Removed Docker image ${sb.imageTag}`);
  } else {
    console.warn(
      `  ${YW}⚠${R} Failed to remove Docker image ${sb.imageTag}; run 'nemoclaw gc' to clean up.`,
    );
  }
}

async function sandboxDestroy(sandboxName: string, args: string[] = []): Promise<void> {
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
      console.log(
        `  ${YW}⚠  Active SSH ${plural} detected (${activeSessionCount} connection${activeSessionCount > 1 ? "s" : ""})${R}`,
      );
      console.log(
        `  Destroying will terminate ${activeSessionCount === 1 ? "the" : "all"} active ${plural} with a Broken pipe error.`,
      );
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
    onboardSession.updateSession((s: Session) => {
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

function _rebuildLog(msg: string) {
  console.error(`  ${D}[rebuild ${new Date().toISOString()}] ${msg}${R}`);
}

async function sandboxRebuild(
  sandboxName: string,
  args: string[] = [],
  opts: { throwOnError?: boolean } = {},
): Promise<void> {
  const verbose =
    args.includes("--verbose") ||
    args.includes("-v") ||
    process.env.NEMOCLAW_REBUILD_VERBOSE === "1";
  const log: (msg: string) => void = verbose ? _rebuildLog : () => {};
  const skipConfirm = args.includes("--yes") || args.includes("--force");
  // When called from upgradeSandboxes in a loop, throwOnError prevents
  // process.exit from aborting the entire batch on the first failure.
  const bail = opts.throwOnError
    ? (msg: string, code = 1) => {
        throw new Error(msg);
      }
    : (_msg: string, code = 1) => process.exit(code);

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
      console.log(
        `  ${YW}⚠  Active SSH ${plural} detected (${rebuildActiveSessionCount} connection${rebuildActiveSessionCount > 1 ? "s" : ""})${R}`,
      );
      console.log(
        `  Rebuilding will terminate ${rebuildActiveSessionCount === 1 ? "the" : "all"} active ${plural} with a Broken pipe error.`,
      );
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
    log(
      `Preflight warning: session belongs to '${session.sandboxName}', not '${sandboxName}' — skipping credential preflight`,
    );
    console.log(
      `  ${D}Note: onboard session belongs to '${session.sandboxName}', not '${sandboxName}'. ` +
        `Skipping credential preflight.${R}`,
    );
  } else {
    rebuildCredentialEnv = session?.credentialEnv || null;
  }
  // Legacy migration: pre-fix local-inference sandboxes (GH #2519) recorded
  // credentialEnv="OPENAI_API_KEY" in onboard-session.json even though the
  // sandbox does not actually need a host OpenAI key (ollama-local uses an
  // auth proxy with an internal token; vllm-local accepts a static dummy
  // bearer). Treat the legacy value as null so rebuild does not demand a
  // credential that was never actually used.
  if (
    (session?.provider === "ollama-local" || session?.provider === "vllm-local") &&
    rebuildCredentialEnv === "OPENAI_API_KEY"
  ) {
    console.log(
      `  ${D}Note: migrating ${session.provider} sandbox off OPENAI_API_KEY (GH #2519). ` +
        `Local inference does not require a host API key.${R}`,
    );
    log(
      `Preflight: legacy ${session.provider} sandbox detected (credentialEnv=OPENAI_API_KEY) — clearing for rebuild`,
    );
    rebuildCredentialEnv = null;
  }
  if (rebuildCredentialEnv) {
    // hydrateCredentialEnv migrates any pre-fix legacy credentials.json
    // into process.env once, so users upgrading from a release that wrote
    // the plaintext file can still rebuild without re-entering keys.
    const credentialValue = hydrateCredentialEnv(rebuildCredentialEnv);
    log(
      `Preflight credential check: ${rebuildCredentialEnv} → ${credentialValue ? "present" : "MISSING"}`,
    );
    if (!credentialValue) {
      console.error("");
      console.error(`  ${_RD}Rebuild preflight failed:${R} provider credential not found.`);
      console.error(`  The non-interactive recreate step requires ${rebuildCredentialEnv},`);
      console.error(
        "  but it is not set in the environment.",
      );
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
    log(
      "Preflight credential check: no credentialEnv in session (local inference or missing session)",
    );
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
    `Registry after remove: ${JSON.stringify(registry.listSandboxes().sandboxes.map((s: { name: string }) => s.name))}`,
  );
  console.log(`  ${G}\u2713${R} Old sandbox deleted`);

  // Step 4: Recreate via onboard --resume
  console.log("");
  console.log("  Creating new sandbox with current image...");

  // Force the sandbox name so onboard recreates with the same name.
  // Mark session resumable and point at this sandbox; set env var as fallback.
  const sessionBefore = onboardSession.loadSession();
  const sessionMatchesSandbox = sessionBefore?.sandboxName === sandboxName;
  log(
    `Session before update: sandboxName=${sessionBefore?.sandboxName}, status=${sessionBefore?.status}, resumable=${sessionBefore?.resumable}, provider=${sessionBefore?.provider}, model=${sessionBefore?.model}, sessionMatch=${sessionMatchesSandbox}`,
  );

  // Sync the session's agent field with the registry so onboard --resume
  // rebuilds the correct sandbox type.  Without this, a stale session.agent
  // from a previous onboard of a *different* agent type would be picked up
  // by resolveAgentName() and the wrong Dockerfile would be used.  (#2201)
  const rebuildAgent = sb.agent || null;
  onboardSession.updateSession((s: Session) => {
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
  // Only read from the session when it belongs to this sandbox to avoid
  // using config from a different sandbox's onboard run.
  const storedFromDockerfile = sessionMatchesSandbox
    ? sessionAfter?.metadata?.fromDockerfile || null
    : null;
  log(
    `Calling onboard({ resume: true, nonInteractive: true, recreateSandbox: true, fromDockerfile: ${storedFromDockerfile} })`,
  );

  // Intercept process.exit during onboard so we can attempt rollback
  // instead of dying with the sandbox destroyed.  onboard() has ~87
  // process.exit() calls that would otherwise kill the process with no
  // chance to recover.  See #2273.
  //
  // NOTE: Throwing from the overridden process.exit unwinds onboard's
  // call stack, which skips process.once("exit") listeners (lock
  // release, build context cleanup, session failure marking).  We
  // manually release the lock and mark the session failed in the
  // onboardFailed block below.
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
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "";
    if (name !== "RebuildOnboardExit") {
      log(`onboard() threw: ${message}`);
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
    try {
      onboardSession.releaseOnboardLock();
    } catch {
      /* best effort */
    }
    try {
      const failedStep = onboardSession.loadSession()?.lastStepStarted;
      if (failedStep) {
        onboardSession.markStepFailed(failedStep, "Rebuild recreate failed");
      }
    } catch {
      /* best effort */
    }

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
    bail(
      `Recreate failed (sandbox destroyed). Backup: ${backup.manifest.backupPath}`,
      onboardExitCode,
    );
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
        const errorMessage = err instanceof Error ? err.message : String(err);
        log(`Failed to apply preset '${presetName}': ${errorMessage}`);
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

async function upgradeSandboxes(args: string[] = []): Promise<void> {
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

  const rebuildable = stale.filter((s: { running: boolean }) => s.running);
  const stopped = stale.filter((s: { running: boolean }) => !s.running);
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
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`  ${YW}\u26a0${R} Failed to rebuild '${s.name}': ${errorMessage}`);
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

function parseSnapshotCreateFlags(flags: string[]) {
  const opts: { name: string | null } = { name: null };
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

function formatSnapshotVersion(b: { snapshotVersion: number }) {
  return `v${b.snapshotVersion}`;
}

function renderSnapshotTable(
  backups: Array<{
    snapshotVersion: number;
    name?: string | null;
    timestamp: string;
    backupPath: string;
  }>,
) {
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
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
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
function resolveSrcPodImage(srcName: string): string | null {
  const gatewayContainer = `openshell-cluster-${NEMOCLAW_GATEWAY_NAME}`;
  try {
    const output = dockerCapture(
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
      { ignoreError: true, timeout: 10000 },
    );
    const img = output.trim().split(/\s+/)[0];
    return img || null;
  } catch {
    return null;
  }
}

// Auto-create a sandbox that clones the image of an existing one.
// Used by `snapshot restore --to <dst>` when dst does not exist yet: reuses
// the source's baked image so the user does not have to re-run onboarding.
// Returns true on success; on failure, logs and calls process.exit(1).
async function autoCreateSandboxFromSource(
  srcName: string,
  dstName: string,
  srcEntry: SandboxEntry | { name: string },
): Promise<void> {
  const sandboxCreateStream = require("./lib/sandbox-create-stream");
  const { isSandboxReady } = require("./lib/gateway-state");
  const basePolicy = path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
  const openshellBin = getOpenshellBinary();

  const fromImage = resolveSrcPodImage(srcName);
  if (!fromImage) {
    console.error(`  Cannot auto-create '${dstName}': could not resolve '${srcName}' pod image.`);
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

  console.log(`  '${dstName}' does not exist. Creating from '${srcName}' image (${fromImage})...`);

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

// Returns true only when the gateway Docker container is confirmed running.
// `openshell sandbox list` reads a local registry and exits 0 even when the
// gateway is stopped (#2673), so we probe the container directly instead.
function probeGatewayRunning(): boolean {
  const container = `openshell-cluster-${NEMOCLAW_GATEWAY_NAME}`;
  const result = dockerInspect(
    ["--type", "container", "--format", "{{.State.Running}}", container],
    { ignoreError: true, suppressOutput: true },
  );
  return result.status === 0 && String(result.stdout || "").trim() === "true";
}

async function sandboxSnapshot(sandboxName: string, subArgs: string[]) {
  const subcommand = subArgs[0] || "help";
  switch (subcommand) {
    case "create": {
      const opts = parseSnapshotCreateFlags(subArgs.slice(1));
      if (!probeGatewayRunning()) {
        console.error("  Failed to query live sandbox state from OpenShell.");
        process.exit(1);
      }
      const isLive = captureOpenshell(["sandbox", "list"], { ignoreError: true });
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
          sandboxState.findBackup(sandboxName, result.manifest.timestamp).match ?? result.manifest;
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
      if (!probeGatewayRunning()) {
        console.error("  Failed to query live sandbox state from OpenShell.");
        process.exit(1);
      }
      const isLive = captureOpenshell(["sandbox", "list"], { ignoreError: true });
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
        const toRemove = currentPresets.filter((p: string) => !snapshotPresets.includes(p));
        const toAdd = snapshotPresets.filter((p: string) => !currentPresets.includes(p));

        if (toRemove.length > 0 || toAdd.length > 0) {
          const summary: string[] = [];
          if (toAdd.length > 0) summary.push(`add ${toAdd.join(", ")}`);
          if (toRemove.length > 0) summary.push(`remove ${toRemove.join(", ")}`);
          console.log(`  Reconciling policy presets on '${targetSandbox}': ${summary.join("; ")}`);

          const failed: string[] = [];
          for (const preset of toRemove) {
            try {
              if (!policies.removePreset(targetSandbox, preset)) {
                failed.push(`${preset} (remove failed)`);
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              failed.push(`${preset} (remove: ${message})`);
            }
          }
          for (const preset of toAdd) {
            try {
              if (!policies.applyPreset(targetSandbox, preset)) {
                failed.push(`${preset} (apply failed)`);
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              failed.push(`${preset} (apply: ${message})`);
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
      console.log(
        `                                             Create a snapshot (auto-versioned v1, v2, ...)`,
      );
      console.log(`    nemoclaw ${sandboxName} snapshot list            List available snapshots`);
      console.log(`    nemoclaw ${sandboxName} snapshot restore [selector] [--to <dst>]`);
      console.log(
        `                                             Restore by version (v1), name, or timestamp.`,
      );
      console.log(
        `                                             Omit selector to restore the most recent.`,
      );
      console.log(
        `                                             Use --to to restore into another sandbox; <dst> is auto-created if missing.`,
      );
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

async function garbageCollectImages(args: string[] = []): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const skipConfirm = args.includes("--yes") || args.includes("--force");

  // 1. List all openshell/sandbox-from images on the host
  let imagesOutput = "";
  try {
    imagesOutput = dockerListImagesFormat(
      "openshell/sandbox-from",
      "{{.Repository}}:{{.Tag}}\t{{.Size}}",
    );
  } catch {
    console.error("  Failed to query Docker images. Is Docker running?");
    process.exit(1);
  }

  const allImages = imagesOutput
    .split("\n")
    .map((line: string) => line.trim())
    .filter(Boolean)
    .map((line: string) => {
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
  const orphans = allImages.filter(
    (img: { tag: string; size: string }) => !registeredTags.has(img.tag),
  );

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
    const rmiResult = dockerRmi(img.tag, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      ignoreError: true,
      suppressOutput: true,
    });
    if (rmiResult.status === 0) {
      console.log(`  ${G}✓${R} Removed ${img.tag}`);
      removed++;
    } else {
      const details = `${rmiResult.stderr || rmiResult.stdout || ""}`.trim();
      console.error(`  ${YW}⚠${R} Failed to remove ${img.tag}${details ? `: ${details}` : ""}`);
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
  const PAD = 38; // column width for usage strings before description
  const grouped = registryCommandsByGroup();
  const lines = [];

  lines.push("");
  lines.push(`  ${B}${G}NemoClaw${R}  ${D}v${getVersion()}${R}`);
  lines.push(`  ${D}Deploy more secure, always-on AI assistants with a single command.${R}`);

  for (const [group, cmds] of grouped) {
    lines.push("");
    lines.push(`  ${G}${group}:${R}`);

    let isFirstInGroup = true;
    for (const cmd of cmds) {
      const usage = cmd.usage;
      const desc = cmd.description;
      const flags = cmd.flags ? ` ${D}${cmd.flags}${R}` : "";

      // Bold the first command in each group
      const prefix = isFirstInGroup ? B : "";
      const suffix = isFirstInGroup ? R : "";

      // Deprecated commands get dim styling
      const dPrefix = cmd.deprecated ? D : "";
      const dSuffix = cmd.deprecated ? R : "";

      const displayUsage = `${dPrefix}${prefix}${usage}${suffix}${dSuffix}`;
      const displayDesc = cmd.deprecated ? `${D}${desc}${R}` : desc;

      // Calculate plain-text length for padding (strip ANSI)
      const padding = Math.max(1, PAD - usage.length);
      lines.push(`    ${displayUsage}${" ".repeat(padding)}${displayDesc}${flags}`);

      isFirstInGroup = false;
    }
  }

  // ── Uninstall flags (static, not in registry) ──
  lines.push("");
  lines.push(`  ${G}Uninstall flags:${R}`);
  lines.push(`    --yes${" ".repeat(29)}Skip the confirmation prompt`);
  lines.push(`    --keep-openshell${" ".repeat(18)}Leave the openshell binary installed`);
  lines.push(`    --delete-models${" ".repeat(19)}Remove NemoClaw-pulled Ollama models`);

  // ── Reconfiguration (no nemoclaw-prefixed lines to avoid parser phantoms) ──
  lines.push("");
  lines.push(`  ${G}Reconfiguration (after onboard):${R}`);
  lines.push(
    `    ${D}• Change inference model:  openshell inference set -g nemoclaw --model <model> --provider <provider>${R}`,
  );
  lines.push(`    ${D}• Add network presets:     use the policy-add command on your sandbox${R}`);
  lines.push(`    ${D}• Change credentials:      credentials reset <PROVIDER>, then re-run onboard${R}`);
  lines.push(`    ${D}• openclaw.json is read-only inside the sandbox (Landlock enforced).${R}`);
  lines.push(`    ${D}  To change OpenClaw settings, re-run onboard to rebuild the sandbox.${R}`);

  // ── Footer ──
  lines.push("");
  lines.push(`  ${D}Powered by NVIDIA OpenShell · Nemotron · Agent Toolkit`);
  lines.push(`  Credentials registered with the OpenShell gateway${R}`);
  lines.push(`  ${D}https://www.nvidia.com/nemoclaw${R}`);
  lines.push("");

  console.log(lines.join("\n"));
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

  // Internal developer flag — dump canonical command list for check-docs.sh parity checks
  if (cmd === "--dump-commands") {
    canonicalUsageList().forEach((c: string) => console.log(c));
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
  // Derived from command registry — single source of truth
  const sandboxActions = sandboxActionTokens();
  if (!registry.getSandbox(cmd) && sandboxActions.includes(args[0] || "")) {
    validateName(cmd, "sandbox name");
    await recoverRegistryEntries({ requestedSandboxName: cmd });
    if (!registry.getSandbox(cmd)) {
      console.error(`  Sandbox '${cmd}' does not exist.`);
      const allNames = registry.listSandboxes().sandboxes.map((s: { name: string }) => s.name);
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
        if (actionArgs.length > 0) {
          console.error(`  Unknown connect argument${actionArgs.length === 1 ? "" : "s"}: ${actionArgs.join(" ")}`);
          if (actionArgs.includes("--dangerously-skip-permissions")) {
            console.error("  --dangerously-skip-permissions was removed; use shields commands instead.");
          }
          console.error("  Usage: nemoclaw <name> connect");
          process.exit(1);
        }
        await sandboxConnect(cmd);
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
      case "gateway-token": {
        const { options: gatewayTokenOpts, unknown: gatewayTokenUnknown } =
          parseGatewayTokenArgs(actionArgs);
        if (gatewayTokenUnknown.length > 0) {
          console.error(`  Unknown flag: ${gatewayTokenUnknown[0]}`);
          console.error("  Usage: nemoclaw <name> gateway-token [--quiet|-q]");
          process.exit(1);
        }
        // Suppress EPIPE traces when the consumer closes the pipe early
        // (e.g. `... | head -c 0`). The token has already been written.
        process.stdout.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EPIPE") process.exit(0);
        });
        const exitCode = runGatewayTokenCommand(cmd, gatewayTokenOpts, {
          fetchToken: fetchGatewayAuthTokenFromSandbox,
        });
        if (exitCode !== 0) process.exit(exitCode);
        break;
      }
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
            const opts: { timeout: string | null; reason: string | null; policy: string } = {
              timeout: null,
              reason: null,
              policy: "permissive",
            };
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
                  console.error(
                    "  --policy requires a value (e.g. permissive, /path/to/policy.yaml)",
                  );
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
            const configOpts: { key: string | null; format: string } = {
              key: null,
              format: "json",
            };
            for (let i = 1; i < actionArgs.length; i++) {
              const flag = actionArgs[i];
              if (flag === "--key") {
                if (i + 1 >= actionArgs.length || actionArgs[i + 1].startsWith("--")) {
                  console.error("  --key requires a value.");
                  console.error("  Usage: nemoclaw <name> config get [--key dotpath] [--format json|yaml]");
                  process.exit(1);
                }
                configOpts.key = actionArgs[++i];
              } else if (flag === "--format") {
                if (i + 1 >= actionArgs.length || actionArgs[i + 1].startsWith("--")) {
                  console.error("  --format requires a value (json|yaml).");
                  console.error("  Usage: nemoclaw <name> config get [--key dotpath] [--format json|yaml]");
                  process.exit(1);
                }
                const format = actionArgs[++i];
                if (format !== "json" && format !== "yaml") {
                  console.error(`  Unknown format: ${format}. Use json or yaml.`);
                  process.exit(1);
                }
                configOpts.format = format;
              } else {
                console.error(`  Unknown flag: ${flag}`);
                console.error("  Usage: nemoclaw <name> config get [--key dotpath] [--format json|yaml]");
                process.exit(1);
              }
            }
            sandboxConfig.configGet(cmd, configOpts);
            break;
          }
          default:
            console.error(
              "  Usage: nemoclaw <name> config get [--key dotpath] [--format json|yaml]",
            );
            process.exit(1);
        }
        break;
      }
      default:
        console.error(`  Unknown action: ${action}`);
        console.error(
          `  Valid actions: connect, status, logs, policy-add, policy-remove, policy-list, skill, snapshot, rebuild, shields, config, channels, gateway-token, destroy`,
        );
        process.exit(1);
    }
    return;
  }

  // Unknown command — suggest
  console.error(`  Unknown command: ${cmd}`);
  console.error("");

  // Check if it looks like a sandbox name with missing action
  const allNames = registry.listSandboxes().sandboxes.map((s: { name: string }) => s.name);
  if (allNames.length > 0) {
    console.error(`  Registered sandboxes: ${allNames.join(", ")}`);
    console.error(`  Try: nemoclaw <sandbox-name> connect`);
    console.error("");
  }

  console.error(`  Run 'nemoclaw help' for usage.`);
  process.exit(1);
})();
