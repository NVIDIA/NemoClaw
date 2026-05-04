// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execFileSync, spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { DASHBOARD_PORT, GATEWAY_PORT, OLLAMA_PORT } = require("./lib/ports");

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

// ---------------------------------------------------------------------------
// Agent branding — derived from NEMOCLAW_AGENT when an alias launcher sets it;
// otherwise the branding module falls back to the OpenClaw defaults.
// ---------------------------------------------------------------------------
const { CLI_NAME, CLI_DISPLAY_NAME } = require("./lib/branding");

const {
  dockerCapture,
  dockerInspect,
  dockerRemoveVolumesByPrefix,
  dockerRmi,
} = require("./lib/docker");
const { resolveOpenshell } = require("./lib/resolve-openshell");
const { pruneKnownHostsEntries, hydrateCredentialEnv, isNonInteractive } = require("./lib/onboard");
const { ensureOllamaAuthProxy } = require("./lib/onboard-ollama-proxy");
const { prompt: askPrompt } = require("./lib/credentials");
const registry = require("./lib/registry");
import type { SandboxEntry } from "./lib/registry";
const nim = require("./lib/nim");
const shields = require("./lib/shields");
const { parseGatewayInference } = require("./lib/inference-config");
const policies = require("./lib/policies");
const { probeProviderHealth } = require("./lib/inference-health");
const { buildStatusCommandDeps } = require("./lib/status-command-deps");
const { help, version } = require("./lib/root-help-action");
const onboardSession = require("./lib/onboard-session");
import type { Session } from "./lib/onboard-session";
const { parseLiveSandboxNames } = require("./lib/runtime-recovery");
const { stripAnsi } = require("./lib/openshell");
const {
  captureOpenshell,
  captureOpenshellForStatus,
  getInstalledOpenshellVersionOrNull,
  getOpenshellBinary,
  getStatusProbeTimeoutMs,
  isCommandTimeout,
  runOpenshell,
} = require("./lib/openshell-runtime");
const {
  getNamedGatewayLifecycleState,
  recoverNamedGatewayRuntime,
} = require("./lib/gateway-runtime-action");
const { recoverRegistryEntries } = require("./lib/registry-recovery-action");
const { runRegisteredOclifCommand } = require("./lib/oclif-runner");
const { isErrnoException }: typeof import("./lib/errno") = require("./lib/errno");
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
  parseForwardList,
} = require("./lib/sandbox-session-state");

const {
  canonicalUsageList,
  globalCommandTokens,
  sandboxActionTokens,
} = require("./lib/command-registry");
import {
  OPENSHELL_OPERATION_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "./lib/openshell-timeouts";
import {
  resolveGlobalOclifDispatch,
  resolveSandboxOclifDispatch,
  type DispatchResult,
} from "./lib/legacy-oclif-dispatch";

// ── Global commands (derived from command registry) ──────────────

const GLOBAL_COMMANDS = globalCommandTokens();

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

const SANDBOX_EXEC_STARTED_MARKER = "__NEMOCLAW_SANDBOX_EXEC_STARTED__";

type RecoveredSandboxMetadata = Partial<
  Pick<SandboxEntry, "model" | "provider" | "gpuEnabled" | "policies" | "nimContainer" | "agent">
> & {
  policyPresets?: string[] | null;
};

const NEMOCLAW_GATEWAY_NAME = "nemoclaw";
const DASHBOARD_FORWARD_PORT = String(DASHBOARD_PORT);
const DEFAULT_LOGS_PROBE_TIMEOUT_MS = 5000;
const LOGS_PROBE_TIMEOUT_ENV = "NEMOCLAW_LOGS_PROBE_TIMEOUT_MS";

type DoctorStatus = "ok" | "warn" | "fail" | "info";

type DoctorCheck = {
  group: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  hint?: string;
};

type CommandCapture = {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
};

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
  if (!sshConfigResult.output.trim()) return null;

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

function executeSandboxExecCommand(
  sandboxName: string,
  command: string,
  timeout = 15000,
): SandboxCommandResult | null {
  const markedCommand = `printf '%s\\n' '${SANDBOX_EXEC_STARTED_MARKER}'; ${command}`;
  const timeoutOverride = Number(process.env.NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS || "");
  const effectiveTimeout =
    Number.isFinite(timeoutOverride) && timeoutOverride > 0 ? timeoutOverride : timeout;
  try {
    const result = spawnSync(
      getOpenshellBinary(),
      ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-c", markedCommand],
      {
        cwd: ROOT,
        encoding: "utf-8",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: effectiveTimeout,
      },
    );
    if (result.error) return null;
    const stdout = (result.stdout || "").trim();
    const stdoutLines = stdout.split(/\r?\n/);
    const markerIndex = stdoutLines.indexOf(SANDBOX_EXEC_STARTED_MARKER);
    if (markerIndex === -1) return null;
    const commandStdoutLines = stdoutLines.slice(markerIndex + 1);
    return {
      status: result.status ?? 1,
      stdout: commandStdoutLines.join("\n").trim(),
      stderr: (result.stderr || "").trim(),
    };
  } catch {
    return null;
  }
}

async function executeSandboxExecCommandForStatus(
  sandboxName: string,
  command: string,
): Promise<SandboxCommandResult | null> {
  const markedCommand = `printf '%s\\n' '${SANDBOX_EXEC_STARTED_MARKER}'; ${command}`;
  const result = await captureOpenshellForStatus(
    ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-c", markedCommand],
    { ignoreError: true },
  );
  if (isCommandTimeout(result) || result.error) return null;
  const stdout = (result.output || "").trim();
  const stdoutLines = stdout.split(/\r?\n/);
  const markerIndex = stdoutLines.indexOf(SANDBOX_EXEC_STARTED_MARKER);
  if (markerIndex === -1) return null;
  const commandStdoutLines = stdoutLines.slice(markerIndex + 1);
  return {
    status: result.status ?? 1,
    stdout: commandStdoutLines.join("\n").trim(),
    stderr: "",
  };
}

function parseSandboxGatewayProbe(result: SandboxCommandResult | null): boolean | null {
  if (!result) return null;
  if (result.stdout === "RUNNING") return true;
  if (result.stdout === "STOPPED") return false;
  return null;
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
  const command = `curl -sf --max-time 3 ${shellQuote(probeUrl)} > /dev/null 2>&1 && echo RUNNING || echo STOPPED`;
  const execProbe = parseSandboxGatewayProbe(executeSandboxExecCommand(sandboxName, command));
  if (execProbe !== null) return execProbe;
  return parseSandboxGatewayProbe(executeSandboxCommand(sandboxName, command));
}

async function isSandboxGatewayRunningForStatus(sandboxName: string): Promise<boolean | null> {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const probeUrl = agentRuntime.getHealthProbeUrl(agent);
  const command = `curl -sf --max-time 3 ${shellQuote(probeUrl)} > /dev/null 2>&1 && echo RUNNING || echo STOPPED`;
  return parseSandboxGatewayProbe(await executeSandboxExecCommandForStatus(sandboxName, command));
}

/**
 * Restart the gateway process inside the sandbox after a pod restart.
 * Cleans stale lock/temp files, sources proxy config, and launches the gateway
 * in the background. Returns true on success.
 */
function recoverSandboxProcesses(sandboxName: string): boolean {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const agentScript = agentRuntime.buildRecoveryScript(agent, agent?.forwardPort ?? DASHBOARD_PORT);
  const hasRecoveryMarker = (result: SandboxCommandResult | null) =>
    !!(
      result &&
      (result.stdout.includes("GATEWAY_PID=") || result.stdout.includes("ALREADY_RUNNING"))
    );
  const recoveredSsh = (result: SandboxCommandResult | null) =>
    !!(result && result.status === 0 && hasRecoveryMarker(result));

  if (agentScript) {
    // Non-OpenClaw manifests do not yet declare a runtime user for root
    // sandbox exec. Recover them over SSH so the launch inherits the sandbox
    // login user instead of creating root-owned agent state under /sandbox.
    return recoveredSsh(executeSandboxCommand(sandboxName, agentScript));
  }

  const script = agentRuntime.buildOpenClawRecoveryScript(DASHBOARD_PORT);
  const execResult = executeSandboxExecCommand(sandboxName, script, 30000);
  if (hasRecoveryMarker(execResult)) return true;
  if (execResult !== null) return false;
  return recoveredSsh(executeSandboxCommand(sandboxName, script));
}

function readNonNegativeNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function waitForRecoveredSandboxGateway(sandboxName: string): boolean {
  const timeoutSeconds = readNonNegativeNumberEnv(
    "NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS",
    30,
  );
  const intervalSeconds = readNonNegativeNumberEnv(
    "NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS",
    3,
  );
  const attempts =
    intervalSeconds > 0
      ? Math.max(1, Math.floor(timeoutSeconds / intervalSeconds) + 1)
      : Math.max(1, Math.floor(timeoutSeconds) + 1);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (isSandboxGatewayRunning(sandboxName) === true) {
      return true;
    }
    if (attempt < attempts - 1) {
      sleepSeconds(intervalSeconds);
    }
  }
  return false;
}

/**
 * Re-establish the dashboard port forward to the sandbox.
 * Uses the agent's forward port when a non-OpenClaw agent is active.
 * Returns true when `forward start` succeeded and a follow-up probe
 * confirms the new entry is running, false otherwise.
 */
function ensureSandboxPortForward(sandboxName: string): boolean {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const port = agent ? String(agent.forwardPort) : DASHBOARD_FORWARD_PORT;
  runOpenshell(["forward", "stop", port], { ignoreError: true });
  const startResult = runOpenshell(
    ["forward", "start", "--background", port, sandboxName],
    { ignoreError: true },
  );
  if (startResult.status !== 0) return false;
  return isSandboxForwardHealthy(sandboxName) === true;
}

/**
 * Probe `openshell forward list` for the sandbox's dashboard forward.
 * Returns true when an entry exists for the expected sandbox+port pair
 * with STATUS=running, false when the entry is missing or non-running,
 * and null when openshell is unreachable.
 *
 * The in-sandbox gateway and the host-side forward are independent
 * dimensions: the forward can die (host SSH session dropped, list shows
 * STATUS=dead) while the gateway keeps listening on 127.0.0.1:<port>.
 */
function isSandboxForwardHealthy(sandboxName: string): boolean | null {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const port = agent ? String(agent.forwardPort) : DASHBOARD_FORWARD_PORT;
  const result = captureOpenshell(["forward", "list"], {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (!result || isCommandTimeout(result) || result.status !== 0) return null;
  const entries = parseForwardList(result.output) as Array<{
    sandboxName: string;
    port: string;
    status: string;
  }>;
  const match = entries.find((entry) => entry.port === port);
  if (!match) return false;
  if (match.sandboxName !== sandboxName) return false;
  return match.status === "running";
}

/**
 * Detect and recover from a sandbox that survived a gateway restart but
 * whose OpenClaw processes are not running. Also re-establishes the
 * host-side dashboard port-forward when it has gone dead independently
 * of the gateway. Returns an object describing the outcome:
 * `{ checked, wasRunning, recovered, forwardRecovered }`.
 */
function checkAndRecoverSandboxProcesses(
  sandboxName: string,
  { quiet = false }: { quiet?: boolean } = {},
) {
  const running = isSandboxGatewayRunning(sandboxName);
  if (running === null) {
    return { checked: false, wasRunning: null, recovered: false, forwardRecovered: false };
  }
  const _recoveryAgent = agentRuntime.getSessionAgent(sandboxName);
  if (running) {
    // Gateway is alive but the host-side forward can still be dead or
    // owned by another sandbox. Probe and re-establish only when
    // necessary so the live-and-healthy path stays a no-op.
    const forwardHealthy = isSandboxForwardHealthy(sandboxName);
    if (forwardHealthy === false) {
      if (!quiet) {
        console.log("");
        console.log(
          `  Dashboard port forward to '${sandboxName}' is missing or dead.`,
        );
        console.log("  Re-establishing...");
      }
      const forwardRecovered = ensureSandboxPortForward(sandboxName);
      if (!quiet) {
        if (forwardRecovered) {
          console.log(`  ${G}✓${R} Dashboard port forward re-established.`);
        } else {
          console.error("  Failed to re-establish the dashboard port forward.");
          console.error(
            `  Run \`openshell forward start --background <port> ${sandboxName}\` manually.`,
          );
        }
      }
      return { checked: true, wasRunning: true, recovered: false, forwardRecovered };
    }
    return { checked: true, wasRunning: true, recovered: false, forwardRecovered: false };
  }

  // Gateway not running — attempt recovery
  if (!quiet) {
    console.log("");
    console.log(
      `  ${agentRuntime.getAgentDisplayName(_recoveryAgent)} gateway is not running inside the sandbox (sandbox likely restarted).`,
    );
    console.log("  Recovering...");
  }

  const recovered = recoverSandboxProcesses(sandboxName);
  if (recovered) {
    // Wait for gateway to bind its HTTP port before declaring success. The
    // recovered process can be alive before the OpenAI-compatible API is ready.
    if (!waitForRecoveredSandboxGateway(sandboxName)) {
      if (!quiet) {
        console.error("  Gateway process started but is not responding.");
        console.error("  Check /tmp/gateway.log inside the sandbox for details.");
      }
      return { checked: true, wasRunning: false, recovered: false, forwardRecovered: false };
    }
    const forwardRecovered = ensureSandboxPortForward(sandboxName);
    if (!quiet) {
      console.log(
        `  ${G}✓${R} ${agentRuntime.getAgentDisplayName(_recoveryAgent)} gateway restarted inside sandbox.`,
      );
      if (forwardRecovered) {
        console.log(`  ${G}✓${R} Dashboard port forward re-established.`);
      } else {
        console.error("  Failed to re-establish the dashboard port forward.");
        console.error(
          `  Run \`openshell forward start --background <port> ${sandboxName}\` manually.`,
        );
      }
    }
    return { checked: true, wasRunning: false, recovered, forwardRecovered };
  }
  if (!quiet) {
    console.error(
      `  Could not restart ${agentRuntime.getAgentDisplayName(_recoveryAgent)} gateway automatically.`,
    );
    console.error("  Connect to the sandbox and run manually:");
    console.error(`    ${agentRuntime.getGatewayCommand(_recoveryAgent)}`);
  }

  return { checked: true, wasRunning: false, recovered, forwardRecovered: false };
}

exports.runtimeBridge = {
  sandboxConnect,
  sandboxDestroy,
  sandboxRebuild,
  sandboxSkillInstall,
  sandboxStatus,
  upgradeSandboxes,
};
exports.ensureLiveSandboxOrExit = ensureLiveSandboxOrExit;
exports.G = G;
exports.R = R;

function mergeLivePolicyIntoSandboxOutput(output: string, livePolicyOutput: string): string {
  const rawLines = String(output).split("\n");
  const cleanLines = stripAnsi(String(output)).split("\n");
  const policyLineIdx = cleanLines.findIndex((l: string) => l.trim() === "Policy:");
  if (policyLineIdx === -1) return output;

  // Keep everything before Policy (Sandbox info with colors),
  // plus the original colored "Policy:" header line.
  const before = rawLines.slice(0, policyLineIdx + 1).join("\n");
  // Extract YAML content from policy get --full (skip metadata header before "---").
  // Use a regex to handle varying line endings (\n, \r\n) and optional trailing whitespace.
  const delimIdx = livePolicyOutput.search(/^---\s*$/m);
  const yamlPart =
    delimIdx !== -1
      ? livePolicyOutput.slice(delimIdx).replace(/^---\s*[\r\n]+/, "")
      : livePolicyOutput;
  // Guard: only replace if the extracted content looks like policy YAML
  // (starts with a YAML key like "version:" or "network_policies:").
  // Avoids replacing with warnings or status text from unexpected output.
  const trimmedYaml = yamlPart.trim();
  const looksLikeError = /^(error|failed|invalid|warning|status)\b/i.test(trimmedYaml);
  if (!trimmedYaml || looksLikeError || !/^[a-z_][a-z0-9_]*\s*:/m.test(trimmedYaml)) {
    return output;
  }

  // Add 2-space indent to match the original sandbox get output format.
  const indented = trimmedYaml
    .split("\n")
    .map((l: string) => (l ? "  " + l : l))
    .join("\n");
  return before + "\n\n" + indented + "\n";
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
      output = mergeLivePolicyIntoSandboxOutput(output, livePolicy.output);
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

async function getSandboxGatewayStateForStatus(sandboxName: string) {
  const timeoutMs = getStatusProbeTimeoutMs();
  const result = await captureOpenshellForStatus(["sandbox", "get", sandboxName], {
    timeout: timeoutMs,
  });
  let output = result.output;
  if (isCommandTimeout(result)) {
    return {
      state: "status_probe_timeout",
      output: `  Live sandbox status probe timed out after ${Math.ceil(timeoutMs / 1000)}s. Local registry data is shown above.`,
    };
  }
  if (result.status === 0) {
    const livePolicy = await captureOpenshellForStatus(["policy", "get", "--full", sandboxName], {
      ignoreError: true,
      timeout: timeoutMs,
    });
    if (!isCommandTimeout(livePolicy) && livePolicy.status === 0 && livePolicy.output.trim()) {
      output = mergeLivePolicyIntoSandboxOutput(output, livePolicy.output);
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

type SandboxGatewayStateLookup = (
  sandboxName: string,
) =>
  | ReturnType<typeof getSandboxGatewayState>
  | ReturnType<typeof getSandboxGatewayStateForStatus>;

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
    `  Sandbox '${sandboxName}' is registered against the ${CLI_DISPLAY_NAME} gateway, but the currently active OpenShell gateway is '${other}'. Your sandbox has NOT been removed.`,
  );
  writer("  Switch gateways and retry:");
  writer("      openshell gateway select nemoclaw");
  writer(`  Then re-run: ${CLI_NAME} ${sandboxName} connect`);
}

/** Print troubleshooting hints based on gateway lifecycle state in the output. */
function printGatewayLifecycleHint(output = "", sandboxName = "", writer = console.error) {
  const cleanOutput = stripAnsi(output);
  if (/No gateway configured/i.test(cleanOutput)) {
    writer(
      `  The selected ${CLI_DISPLAY_NAME} gateway is no longer configured or its metadata/runtime has been lost.`,
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
      `  Try re-establishing the ${CLI_DISPLAY_NAME} gateway/runtime first. If the sandbox is still unreachable, recreate just that sandbox with \`${CLI_NAME} onboard\`.`,
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

async function getReconciledSandboxGatewayState(
  sandboxName: string,
  opts: { getState?: SandboxGatewayStateLookup } = {},
) {
  const getState = opts.getState ?? getSandboxGatewayState;
  let lookup = await getState(sandboxName);
  if (lookup.state === "present") {
    return lookup;
  }
  if (lookup.state === "missing") {
    return reconcileMissingAgainstNamedGateway(sandboxName, lookup);
  }

  if (lookup.state === "gateway_error") {
    const recovery = await recoverNamedGatewayRuntime();
    if (recovery.recovered) {
      const retried = await getState(sandboxName);
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
        `  Run \`${CLI_NAME} ${sandboxName} rebuild --yes\` to recreate the sandbox (--yes skips the confirmation prompt; workspace state will be preserved).`,
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
      `  Run \`${CLI_NAME} list\` to confirm the remaining sandboxes, or \`${CLI_NAME} onboard\` to create a new one.`,
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
      `  Recreate this sandbox with \`${CLI_NAME} onboard\` once the gateway runtime is stable.`,
    );
    process.exit(1);
  }
  if (lookup.state === "gateway_unreachable_after_restart") {
    console.error(
      `  Sandbox '${sandboxName}' may still exist, but the selected ${CLI_DISPLAY_NAME} gateway is still refusing connections after restart.`,
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
      `  Sandbox '${sandboxName}' may still exist locally, but the ${CLI_DISPLAY_NAME} gateway is no longer configured after restart/rebuild.`,
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
    `  Installed OpenShell${versionText} is too old or incompatible with \`${CLI_NAME} logs\`.`,
  );
  console.error(
    `  ${CLI_DISPLAY_NAME} expects \`openshell logs <name>\` and live streaming via \`--tail\`.`,
  );
  console.error(
    `  Upgrade OpenShell by rerunning \`${CLI_NAME} onboard\`, or reinstall the OpenShell CLI and try again.`,
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

async function runOclif(commandId: string, args: string[] = []): Promise<void> {
  await runRegisteredOclifCommand(commandId, args, {
    rootDir: ROOT,
    error: console.error,
    exit: (code: number) => process.exit(code),
  });
}

function printSandboxActionUsage(action: string): void {
  console.log(`  Usage: ${CLI_NAME} <name> ${action}`);
}

// ── Sandbox-scoped actions ───────────────────────────────────────

type SandboxConnectOptions = {
  probeOnly?: boolean;
};

const SANDBOX_CONNECT_FLAGS = new Set(["--dangerously-skip-permissions", "--probe-only", "--help", "-h"]);

function isSandboxConnectFlag(arg: string | undefined): boolean {
  return typeof arg === "string" && SANDBOX_CONNECT_FLAGS.has(arg);
}

function printSandboxConnectHelp(sandboxName = "<name>") {
  console.log("");
  console.log(`  Usage: ${CLI_NAME} ${sandboxName} connect [--probe-only]`);
  console.log("");
  console.log("  Options:");
  console.log(
    "    --probe-only                    Run recovery checks and exit without opening SSH",
  );
  console.log("    -h, --help                      Show this help");
  console.log("");
}

function parseSandboxConnectArgs(sandboxName: string, actionArgs: string[]): SandboxConnectOptions {
  const options: SandboxConnectOptions = {};
  for (const arg of actionArgs) {
    if (!isSandboxConnectFlag(arg)) {
      console.error(`  Unknown flag for connect: ${arg}`);
      printSandboxConnectHelp(sandboxName);
      process.exit(1);
    }
    switch (arg) {
      case "--dangerously-skip-permissions":
        console.error("  --dangerously-skip-permissions was removed; use shields commands instead.");
        printSandboxConnectHelp(sandboxName);
        process.exit(1);
      case "--probe-only":
        options.probeOnly = true;
        break;
      case "--help":
      case "-h":
        printSandboxConnectHelp(sandboxName);
        process.exit(0);
        break;
    }
  }
  return options;
}

function runSandboxConnectProbe(sandboxName: string): void {
  const processCheck = checkAndRecoverSandboxProcesses(sandboxName, { quiet: true });
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const agentName = agentRuntime.getAgentDisplayName(agent);
  if (!processCheck.checked) {
    console.error(
      `  Probe failed: could not inspect the ${agentName} gateway inside sandbox '${sandboxName}'.`,
    );
    process.exit(1);
  }
  if (processCheck.wasRunning) {
    if (processCheck.forwardRecovered) {
      console.log(
        `  Probe complete: ${agentName} gateway is running in '${sandboxName}'; restored dashboard port forward.`,
      );
    } else {
      console.log(`  Probe complete: ${agentName} gateway is running in '${sandboxName}'.`);
    }
    return;
  }
  if (processCheck.recovered) {
    console.log(`  Probe complete: recovered ${agentName} gateway in '${sandboxName}'.`);
    return;
  }
  console.error(
    `  Probe failed: ${agentName} gateway is not running in '${sandboxName}' and automatic recovery failed.`,
  );
  console.error("  Check /tmp/gateway.log inside the sandbox for details.");
  process.exit(1);
}

async function sandboxConnect(
  sandboxName: string,
  { probeOnly = false }: SandboxConnectOptions = {},
) {
  const { isSandboxReady, parseSandboxStatus } = require("./lib/onboard");
  await ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase: true });

  if (probeOnly) {
    return runSandboxConnectProbe(sandboxName);
  }

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
      console.error(`  Run:  ${CLI_NAME} ${sandboxName} logs --follow`);
      console.error(`  Run:  ${CLI_NAME} ${sandboxName} status`);
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
        console.error(`  Run:  ${CLI_NAME} ${sandboxName} logs --follow`);
        console.error(`  Run:  ${CLI_NAME} ${sandboxName} status`);
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
        `  Override timeout: NEMOCLAW_CONNECT_TIMEOUT=300 ${CLI_NAME} ${sandboxName} connect`,
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

function captureHostCommand(
  command: string,
  args: string[],
  timeout = 5000,
): CommandCapture {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error,
  };
}

function oneLine(value = ""): string {
  return String(value).replace(/\s+/g, " ").trim();
}

function doctorSummary(checks: DoctorCheck[]): { status: DoctorStatus; failed: number; warned: number } {
  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  if (failed > 0) return { status: "fail", failed, warned };
  if (warned > 0) return { status: "warn", failed, warned };
  return { status: "ok", failed, warned };
}

function doctorStatusLabel(status: DoctorStatus): string {
  switch (status) {
    case "ok":
      return `${G}[ok]${R}`;
    case "warn":
      return `${YW}[warn]${R}`;
    case "fail":
      return `${_RD}[fail]${R}`;
    case "info":
      return `${D}[info]${R}`;
    default:
      return `[${status}]`;
  }
}

function renderDoctorReport(sandboxName: string, checks: DoctorCheck[], asJson: boolean): number {
  const summary = doctorSummary(checks);
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          sandbox: sandboxName,
          status: summary.status,
          failed: summary.failed,
          warnings: summary.warned,
          checks,
        },
        null,
        2,
      ),
    );
    return summary.failed > 0 ? 1 : 0;
  }

  console.log("");
  console.log(`  ${B}${CLI_DISPLAY_NAME} doctor:${R} ${sandboxName}`);
  const groupOrder = ["Host", "Gateway", "Sandbox", "Inference", "Messaging", "Local services"];
  const orderedGroups = [
    ...groupOrder,
    ...checks
      .map((check) => check.group)
      .filter((group, index, all) => !groupOrder.includes(group) && all.indexOf(group) === index),
  ];
  for (const group of orderedGroups) {
    const groupChecks = checks.filter((check) => check.group === group);
    if (groupChecks.length === 0) continue;
    console.log("");
    console.log(`  ${G}${group}:${R}`);
    for (const check of groupChecks) {
      console.log(`    ${doctorStatusLabel(check.status)} ${check.label}: ${check.detail}`);
      if (check.hint) {
        console.log(`         ${D}hint: ${check.hint}${R}`);
      }
    }
  }

  console.log("");
  if (summary.status === "ok") {
    console.log(`  Summary: ${G}healthy${R}`);
  } else if (summary.status === "warn") {
    console.log(`  Summary: ${YW}healthy with ${summary.warned} warning(s)${R}`);
  } else {
    console.log(
      `  Summary: ${_RD}attention needed${R} (${summary.failed} failed, ${summary.warned} warning(s))`,
    );
  }
  console.log("");
  return summary.failed > 0 ? 1 : 0;
}

function dockerInspectGateway(containerName: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const inspect = captureHostCommand(
    "docker",
    [
      "inspect",
      "--format",
      "{{.State.Running}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\t{{.Config.Image}}",
      containerName,
    ],
    5000,
  );
  if (inspect.status !== 0) {
    checks.push({
      group: "Gateway",
      label: "Docker container",
      status: "fail",
      detail: `${containerName} not found or not inspectable`,
      hint: "run `docker ps --filter name=openshell-cluster-nemoclaw`",
    });
    return checks;
  }

  const [runningRaw, healthRaw, imageRaw] = inspect.stdout.trim().split("\t");
  const running = runningRaw === "true";
  const health = healthRaw || "none";
  const image = imageRaw || "unknown";
  const healthOk = health === "healthy" || health === "none";
  checks.push({
    group: "Gateway",
    label: "Docker container",
    status: running && healthOk ? "ok" : "fail",
    detail: `${containerName} ${running ? "running" : "stopped"} (${health}; ${image})`,
    hint: running ? undefined : "restart the gateway with `openshell gateway start --name nemoclaw`",
  });

  const port = captureHostCommand("docker", ["port", containerName, "30051/tcp"], 5000);
  if (port.status === 0 && port.stdout.trim()) {
    const mapping = oneLine(port.stdout);
    checks.push({
      group: "Gateway",
      label: "Port mapping",
      status: mapping.includes(`:${GATEWAY_PORT}`) ? "ok" : "warn",
      detail: mapping,
      hint: mapping.includes(`:${GATEWAY_PORT}`)
        ? undefined
        : `expected host port ${GATEWAY_PORT} from NEMOCLAW_GATEWAY_PORT`,
    });
  } else {
    checks.push({
      group: "Gateway",
      label: "Port mapping",
      status: "fail",
      detail: "30051/tcp is not published on the host",
      hint: "gateway traffic will not reach OpenShell until the container is recreated with a host port",
    });
  }
  return checks;
}

function findSandboxListLine(output: string, sandboxName: string): string | null {
  const lines = stripAnsi(output).split(/\r?\n/);
  return (
    lines.find((line: string) => {
      const columns = line.trim().split(/\s+/);
      return columns.includes(sandboxName);
    }) || null
  );
}

function inferSandboxReadyFromLine(line: string | null): boolean | null {
  if (!line) return null;
  if (/\bReady\b/i.test(line)) return true;
  if (/\b(Failed|Error|CrashLoopBackOff|ImagePullBackOff|Unknown|Evicted)\b/i.test(line)) {
    return false;
  }
  return null;
}

function stoppedCloudflaredCheck(): DoctorCheck {
  return {
    group: "Local services",
    label: "cloudflared",
    status: "info",
    detail: "stopped",
    hint: `start when needed with \`${CLI_NAME} tunnel start\``,
  };
}

function staleCloudflaredPidFileCheck(): DoctorCheck {
  return {
    group: "Local services",
    label: "cloudflared",
    status: "warn",
    detail: "stale PID file",
    hint: `run \`${CLI_NAME} tunnel stop\` and start it again if you need a public tunnel`,
  };
}

function staleCloudflaredPidCheck(pid: number): DoctorCheck {
  return {
    group: "Local services",
    label: "cloudflared",
    status: "warn",
    detail: `stale PID ${pid}`,
    hint: `run \`${CLI_NAME} tunnel stop\` to clean up the service state`,
  };
}

function readCloudflaredPidFile(pidFile: string): string | null {
  try {
    return fs.readFileSync(pidFile, "utf-8").trim();
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function commandLineNamesCloudflared(commandLine: string): boolean {
  return commandLine
    .split(/\0|\s+/)
    .filter(Boolean)
    .some((token) => path.basename(token) === "cloudflared");
}

function readProcessCommandLine(pid: number): string | null {
  if (process.platform === "win32") {
    return null;
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
  } catch {
    try {
      return execFileSync(
        "ps",
        ["-p", String(pid), "-o", "comm=", "-o", "args="],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1000,
        },
      );
    } catch {
      return null;
    }
  }
}

function isCloudflaredProcess(pid: number): boolean {
  const commandLine = readProcessCommandLine(pid);
  if (commandLine === null) {
    return false;
  }
  return commandLineNamesCloudflared(commandLine);
}

function cloudflaredDoctorCheck(sandboxName: string): DoctorCheck {
  const pidFile = path.join(`/tmp/nemoclaw-services-${sandboxName}`, "cloudflared.pid");
  if (!fs.existsSync(pidFile)) {
    return stoppedCloudflaredCheck();
  }
  const rawPid = readCloudflaredPidFile(pidFile);
  if (rawPid === null) {
    return stoppedCloudflaredCheck();
  }
  const pid = Number(rawPid);
  if (!Number.isFinite(pid) || pid <= 0) {
    return staleCloudflaredPidFileCheck();
  }
  try {
    process.kill(pid, 0);
    if (!isCloudflaredProcess(pid)) {
      return staleCloudflaredPidCheck(pid);
    }
    return {
      group: "Local services",
      label: "cloudflared",
      status: "ok",
      detail: `running (PID ${pid})`,
    };
  } catch {
    return staleCloudflaredPidCheck(pid);
  }
}

function ollamaDoctorCheck(currentProvider: string): DoctorCheck {
  const endpoint = `http://127.0.0.1:${OLLAMA_PORT}/api/tags`;
  const result = captureHostCommand(
    "curl",
    ["-sS", "--connect-timeout", "2", "--max-time", "4", endpoint],
    6000,
  );
  const required = currentProvider === "ollama-local";
  if (result.status !== 0) {
    return {
      group: "Local services",
      label: "Ollama",
      status: required ? "fail" : "info",
      detail: `not reachable at ${endpoint}`,
      hint: required ? "start Ollama or change the sandbox inference provider" : undefined,
    };
  }

  let modelCount = "unknown model count";
  try {
    const parsed = JSON.parse(result.stdout);
    if (Array.isArray(parsed.models)) {
      modelCount = `${parsed.models.length} model(s)`;
    }
  } catch {
    /* keep generic detail */
  }
  return {
    group: "Local services",
    label: "Ollama",
    status: "ok",
    detail: `reachable at ${endpoint} (${modelCount})`,
  };
}

function messagingDoctorCheck(sandboxName: string, sb: SandboxEntry): DoctorCheck {
  const registeredChannels = Array.isArray(sb.messagingChannels) ? sb.messagingChannels : [];
  const disabledChannels = new Set(Array.isArray(sb.disabledChannels) ? sb.disabledChannels : []);
  const channels = registeredChannels.filter((channel: string) => !disabledChannels.has(channel));
  const pausedChannels = registeredChannels.filter((channel: string) =>
    disabledChannels.has(channel),
  );
  if (registeredChannels.length === 0) {
    return {
      group: "Messaging",
      label: "Channels",
      status: "info",
      detail: "no messaging channels registered",
    };
  }

  if (channels.length === 0) {
    return {
      group: "Messaging",
      label: "Channels",
      status: "info",
      detail: `all messaging channels paused (${pausedChannels.join(", ")})`,
      hint: `run \`${CLI_NAME} ${sandboxName} channels start <channel>\` to re-enable one`,
    };
  }

  const degraded = buildStatusCommandDeps(ROOT).checkMessagingBridgeHealth?.(sandboxName, channels) || [];
  const pausedSuffix =
    pausedChannels.length > 0 ? `; paused channels skipped: ${pausedChannels.join(", ")}` : "";
  if (degraded.length === 0) {
    return {
      group: "Messaging",
      label: "Channels",
      status: "ok",
      detail: `${channels.join(", ")} enabled; no recent conflict signatures${pausedSuffix}`,
    };
  }

  return {
    group: "Messaging",
    label: "Channels",
    status: "warn",
    detail:
      degraded
        .map(
          (item: { channel: string; conflicts: number }) =>
            `${item.channel}: ${item.conflicts} conflict(s)`,
        )
        .join("; ") + pausedSuffix,
    hint: `run \`${CLI_NAME} ${sandboxName} logs --follow\` for enabled bridge details`,
  };
}

// eslint-disable-next-line complexity
async function sandboxDoctor(sandboxName: string, args: string[] = []): Promise<void> {
  const asJson = args.includes("--json");
  const helpRequested = args.includes("--help") || args.includes("-h");
  const unknown = args.filter((arg) => !["--json", "--help", "-h"].includes(arg));
  if (helpRequested) {
    console.log(`  Usage: ${CLI_NAME} <name> doctor [--json]`);
    return;
  }
  if (unknown.length > 0) {
    console.error(`  Unknown doctor argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(" ")}`);
    console.error(`  Usage: ${CLI_NAME} <name> doctor [--json]`);
    process.exit(1);
  }

  const sb = registry.getSandbox(sandboxName);
  const checks: DoctorCheck[] = [];

  checks.push({
    group: "Host",
    label: "CLI build",
    status: fs.existsSync(path.join(ROOT, "dist", "nemoclaw.js")) ? "ok" : "fail",
    detail: fs.existsSync(path.join(ROOT, "dist", "nemoclaw.js"))
      ? "dist/nemoclaw.js present"
      : "dist/nemoclaw.js missing",
    hint: fs.existsSync(path.join(ROOT, "dist", "nemoclaw.js")) ? undefined : "run `npm run build:cli`",
  });

  const dockerInfo = captureHostCommand("docker", ["info", "--format", "{{.ServerVersion}}"], 8000);
  checks.push({
    group: "Host",
    label: "Docker daemon",
    status: dockerInfo.status === 0 ? "ok" : "fail",
    detail:
      dockerInfo.status === 0
        ? `server ${dockerInfo.stdout.trim() || "unknown"}`
        : oneLine(dockerInfo.stderr || dockerInfo.error?.message || "docker info failed"),
    hint: dockerInfo.status === 0 ? undefined : "start Docker and verify your user can access the daemon",
  });

  const openshellBin = resolveOpenshell();
  checks.push({
    group: "Host",
    label: "OpenShell CLI",
    status: openshellBin ? "ok" : "fail",
    detail: openshellBin || "not found on PATH",
    hint: openshellBin ? undefined : "install OpenShell before using sandbox commands",
  });

  checks.push(...dockerInspectGateway(`openshell-cluster-${NEMOCLAW_GATEWAY_NAME}`));

  let openshellConnected = false;
  if (openshellBin) {
    const recovery = await recoverNamedGatewayRuntime();
    const lifecycle = recovery.after || recovery.before;
    const cleanStatus = stripAnsi(lifecycle?.status || "");
    openshellConnected = lifecycle?.state === "healthy_named";
    checks.push({
      group: "Gateway",
      label: "OpenShell status",
      status: openshellConnected ? "ok" : "fail",
      detail: openshellConnected
        ? "connected to nemoclaw"
        : oneLine(cleanStatus || lifecycle?.gatewayInfo || "not connected to nemoclaw"),
      hint: openshellConnected ? undefined : "run `openshell gateway select nemoclaw` and retry",
    });
  }

  if (openshellBin && openshellConnected) {
    const list = captureOpenshell(["sandbox", "list"], {
      ignoreError: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    });
    const liveNames = parseLiveSandboxNames(list.output || "");
    const present = list.status === 0 && liveNames.has(sandboxName);
    const line = findSandboxListLine(list.output || "", sandboxName);
    const ready = inferSandboxReadyFromLine(line);
    checks.push({
      group: "Sandbox",
      label: "Live sandbox",
      status: present && ready === true ? "ok" : "fail",
      detail: present
        ? ready === true
          ? `${sandboxName} present (Ready)`
          : `${sandboxName} present${line ? ` (${oneLine(line)})` : ""}`
        : `${sandboxName} not present in live OpenShell sandbox list`,
      hint: present
        ? ready === true
          ? undefined
          : `run \`${CLI_NAME} ${sandboxName} status\` or \`${CLI_NAME} ${sandboxName} logs --follow\``
        : `run \`${CLI_NAME} ${sandboxName} status\` or recreate with \`${CLI_NAME} onboard\``,
    });
  } else if (openshellBin) {
    checks.push({
      group: "Sandbox",
      label: "Live sandbox",
      status: "fail",
      detail: "skipped because the nemoclaw gateway is not connected",
      hint: "fix the gateway check above before trusting sandbox readiness",
    });
  }

  const live = openshellBin && openshellConnected
    ? parseGatewayInference(
        captureOpenshell(["inference", "get"], {
          ignoreError: true,
          timeout: OPENSHELL_PROBE_TIMEOUT_MS,
        }).output,
      )
    : null;
  const currentModel = (live && live.model) || (sb && sb.model) || "unknown";
  const currentProvider = (live && live.provider) || (sb && sb.provider) || "unknown";
  checks.push({
    group: "Inference",
    label: "Route",
    status: currentProvider !== "unknown" || currentModel !== "unknown" ? "ok" : "warn",
    detail: `${currentProvider} / ${currentModel}`,
    hint:
      currentProvider !== "unknown" || currentModel !== "unknown"
        ? undefined
        : `run \`${CLI_NAME} ${sandboxName} status\` after the gateway is healthy`,
  });

  if (typeof currentProvider === "string" && currentProvider !== "unknown") {
    const inferenceHealth = probeProviderHealth(currentProvider);
    if (!inferenceHealth) {
      checks.push({
        group: "Inference",
        label: "Provider health",
        status: "info",
        detail: `no health probe registered for ${currentProvider}`,
      });
    } else if (!inferenceHealth.probed) {
      checks.push({
        group: "Inference",
        label: "Provider health",
        status: "info",
        detail: inferenceHealth.detail,
      });
    } else {
      checks.push({
        group: "Inference",
        label: "Provider health",
        status: inferenceHealth.ok ? "ok" : "fail",
        detail: inferenceHealth.ok
          ? `${inferenceHealth.endpoint} reachable`
          : inferenceHealth.detail,
        hint: inferenceHealth.ok ? undefined : "check network access or provider credentials",
      });
    }
  }

  if (sb) {
    try {
      const versionCheck = sandboxVersion.checkAgentVersion(sandboxName);
      const agent = agentRuntime.getSessionAgent(sandboxName);
      const agentName = agentRuntime.getAgentDisplayName(agent);
      if (versionCheck.isStale) {
        checks.push({
          group: "Sandbox",
          label: "Agent version",
          status: "warn",
          detail: `${agentName} v${versionCheck.sandboxVersion || "unknown"}; v${versionCheck.expectedVersion} available`,
          hint: `run \`${CLI_NAME} ${sandboxName} rebuild\``,
        });
      } else if (versionCheck.sandboxVersion) {
        checks.push({
          group: "Sandbox",
          label: "Agent version",
          status: "ok",
          detail: `${agentName} v${versionCheck.sandboxVersion}`,
        });
      } else {
        checks.push({
          group: "Sandbox",
          label: "Agent version",
          status: "info",
          detail: "could not detect version",
        });
      }
    } catch {
      checks.push({
        group: "Sandbox",
        label: "Agent version",
        status: "info",
        detail: "version check unavailable",
      });
    }

    checks.push({
      group: "Sandbox",
      label: "Shields",
      status: shields.isShieldsDown(sandboxName) ? "warn" : "ok",
      detail: shields.isShieldsDown(sandboxName) ? "down" : "up",
      hint: shields.isShieldsDown(sandboxName)
        ? `run \`${CLI_NAME} ${sandboxName} shields status\` for details`
        : undefined,
    });
    checks.push(messagingDoctorCheck(sandboxName, sb));
  }

  checks.push(ollamaDoctorCheck(currentProvider));
  checks.push(cloudflaredDoctorCheck(sandboxName));

  const exitCode = renderDoctorReport(sandboxName, checks, asJson);
  if (exitCode !== 0) process.exit(exitCode);
}

// eslint-disable-next-line complexity
async function sandboxStatus(sandboxName: string) {
  const sb = registry.getSandbox(sandboxName);
  const lookup = await getReconciledSandboxGatewayState(sandboxName, {
    getState: getSandboxGatewayStateForStatus,
  });
  const liveResult =
    lookup.state === "present"
      ? await captureOpenshellForStatus(["inference", "get"], {
          ignoreError: true,
        })
      : null;
  const live =
    liveResult && !isCommandTimeout(liveResult)
      ? parseGatewayInference(liveResult.output)
      : null;
  const currentModel = (live && live.model) || (sb && sb.model) || "unknown";
  const currentProvider = (live && live.provider) || (sb && sb.provider) || "unknown";
  const inferenceHealth =
    lookup.state === "present" && typeof currentProvider === "string"
      ? probeProviderHealth(currentProvider)
      : null;
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
    if (lookup.state !== "present") {
      console.log("    Inference: not verified (gateway/sandbox state not verified)");
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
      const versionCheck = sandboxVersion.checkAgentVersion(sandboxName, { skipProbe: true });
      const agent = agentRuntime.getSessionAgent(sandboxName);
      const agentName = agentRuntime.getAgentDisplayName(agent);
      if (versionCheck.sandboxVersion) {
        console.log(`    Agent:    ${agentName} v${versionCheck.sandboxVersion}`);
      }
      if (versionCheck.isStale) {
        console.log(`    ${YW}Update:   v${versionCheck.expectedVersion} available${R}`);
        console.log(`              Run \`${CLI_NAME} ${sandboxName} rebuild\` to upgrade`);
      }
    } catch {
      /* non-fatal */
    }
  }

  if (lookup.state === "present") {
    console.log("");
    if ("recoveredGateway" in lookup && lookup.recoveredGateway) {
      console.log(
        `  Recovered ${CLI_DISPLAY_NAME} gateway runtime via ${("recoveryVia" in lookup ? lookup.recoveryVia : null) || "gateway reattach"}.`,
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
        `  Run \`${CLI_NAME} ${sandboxName} rebuild --yes\` to recreate the sandbox (--yes skips the confirmation prompt; workspace state will be preserved).`,
      );
    }
  } else if (lookup.state === "wrong_gateway_active") {
    const activeGateway =
      "activeGateway" in lookup && typeof lookup.activeGateway === "string"
        ? lookup.activeGateway
        : undefined;
    console.log("");
    printWrongGatewayActiveGuidance(sandboxName, activeGateway, console.log);
    process.exit(1);
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
    process.exit(1);
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
      `  Recreate this sandbox with \`${CLI_NAME} onboard\` once the gateway runtime is stable.`,
    );
    process.exit(1);
  } else if (lookup.state === "gateway_unreachable_after_restart") {
    console.log("");
    console.log(
      `  Sandbox '${sandboxName}' may still exist, but the selected ${CLI_DISPLAY_NAME} gateway is still refusing connections after restart.`,
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
    process.exit(1);
  } else if (lookup.state === "gateway_missing_after_restart") {
    console.log("");
    console.log(
      `  Sandbox '${sandboxName}' may still exist locally, but the ${CLI_DISPLAY_NAME} gateway is no longer configured after restart/rebuild.`,
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
    process.exit(1);
  } else {
    console.log("");
    console.log(`  Could not verify sandbox '${sandboxName}' against the live OpenShell gateway.`);
    if (lookup.output) {
      console.log(lookup.output);
    }
    printGatewayLifecycleHint(lookup.output, sandboxName, console.log);
    process.exit(1);
  }

  // OpenClaw process health inside the sandbox
  if (lookup.state === "present") {
    const running = await isSandboxGatewayRunningForStatus(sandboxName);
    if (running !== null) {
      const _sa = agentRuntime.getSessionAgent(sandboxName);
      const _saName = agentRuntime.getAgentDisplayName(_sa);
      if (running) {
        console.log(`    ${_saName}: ${G}running${R}`);
      } else {
        console.log(`    ${_saName}: ${_RD}not running${R}`);
        console.log("");
        console.log(`  The sandbox is alive but the ${_saName} gateway process is not running.`);
        console.log("  This typically happens after a gateway restart (e.g., laptop close/open).");
        console.log("");
        console.log("  To recover, run:");
        console.log(`    ${D}${CLI_NAME} ${sandboxName} connect${R}  (auto-recovers on connect)`);
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

function printSkillInstallUsage(): void {
  console.log("");
  console.log(`  Usage: ${CLI_NAME} <sandbox> skill install <path>`);
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
    console.error(`  Usage: ${CLI_NAME} <sandbox> skill install <path>`);
    process.exit(1);
  }
  if (!skillPath) {
    console.error(`  Usage: ${CLI_NAME} <sandbox> skill install <path>`);
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

function cleanupSandboxServices(
  sandboxName: string,
  { stopHostServices = false }: { stopHostServices?: boolean } = {},
) {
  if (stopHostServices) {
    const { stopAll } = require("./lib/services");
    stopAll({ sandboxName });
  }

  const sb = registry.getSandbox(sandboxName);
  if (sb?.provider?.includes("ollama")) {
    const { unloadOllamaModels } = require("./lib/onboard-ollama-proxy");
    unloadOllamaModels();
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
      `  ${YW}⚠${R} Failed to remove Docker image ${sb.imageTag}; run '${CLI_NAME} gc' to clean up.`,
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

  if (sb?.provider?.includes("ollama")) {
    const { unloadOllamaModels, killStaleProxy } = require("./lib/onboard-ollama-proxy");
    unloadOllamaModels();
    killStaleProxy();
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
    console.error(`  Back up state manually and recreate with \`${CLI_NAME} onboard\`.`);
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

  let rebuildConfirmed = false;
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
    rebuildConfirmed = true;
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
      console.error("  but it is not set in the environment.");
      console.error("");
      console.error("  To fix, do one of:");
      console.error(`    export ${rebuildCredentialEnv}=<your-key>`);
      console.error(`    ${CLI_NAME} onboard          # re-enter the key interactively`);
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
    console.error(`  Start it first or recreate with \`${CLI_NAME} onboard --recreate-sandbox\`.`);
    bail(`Sandbox '${sandboxName}' is not running.`);
    return;
  }

  // Step 2: Backup
  console.log("  Backing up sandbox state...");
  log(`Agent type: ${sb.agent || "openclaw"}, stateDirs from manifest`);
  const backup = sandboxState.backupSandboxState(sandboxName);
  log(
    `Backup result: success=${backup.success}, backed=${backup.backedUpDirs.join(",")}; files=${backup.backedUpFiles.join(",")}, failed=${backup.failedDirs.join(",")}; failedFiles=${backup.failedFiles.join(",")}`,
  );
  if (!backup.success) {
    console.error("  Failed to back up sandbox state.");
    if (backup.backedUpDirs.length > 0) {
      console.error(`  Partial backup: ${backup.backedUpDirs.join(", ")}`);
    }
    if (backup.failedDirs.length > 0) {
      console.error(`  Failed: ${backup.failedDirs.join(", ")}`);
    }
    if (backup.failedFiles.length > 0) {
      console.error(`  Failed files: ${backup.failedFiles.join(", ")}`);
    }
    console.error("  Aborting rebuild to prevent data loss.");
    bail("Failed to back up sandbox state.");
    return;
  }
  console.log(
    `  ${G}\u2713${R} State backed up (${backup.backedUpDirs.length} directories, ${backup.backedUpFiles.length} files)`,
  );
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
    // Persist inference selection from the about-to-be-removed registry entry
    // so onboard --resume can recreate with the same provider/model in
    // non-interactive mode. Without this the registry is gone by the time
    // setupNim runs, leaving no recovery source. Assign explicitly (with a
    // null fallback) so a missing registry value doesn't silently leave a
    // stale session entry from an earlier sandbox in place.
    s.provider = sb.provider ?? null;
    s.model = sb.model ?? null;
    s.nimContainer = sb.nimContainer ?? null;
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
      // Reaching here means the user already consented to the destructive
      // rebuild (either via --yes/--force or by answering "y" at the prompt).
      // Propagate that consent so the size-confirm gate inside the
      // non-interactive onboard does not abort after the old sandbox has
      // been deleted (#2639 follow-up).
      autoYes: skipConfirm || rebuildConfirmed,
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
    console.error(`    2. Run: ${CLI_NAME} onboard --resume`);
    console.error(`       This will recreate sandbox '${sandboxName}'.`);
    console.error(`    3. Then restore your workspace state:`);
    console.error(
      `       ${CLI_NAME} ${sandboxName} snapshot restore "${backup.manifest.timestamp}"`,
    );
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
    `Restore result: success=${restore.success}, restored=${restore.restoredDirs.join(",")}; files=${restore.restoredFiles.join(",")}, failed=${restore.failedDirs.join(",")}; failedFiles=${restore.failedFiles.join(",")}`,
  );
  if (!restore.success) {
    console.error(`  Partial restore: ${restore.restoredDirs.join(", ") || "none"}`);
    console.error(`  Failed: ${restore.failedDirs.join(", ")}`);
    if (restore.failedFiles.length > 0) {
      console.error(`  Failed files: ${restore.failedFiles.join(", ")}`);
    }
    console.error(`  Manual restore available from: ${backup.manifest.backupPath}`);
  } else {
    console.log(
      `  ${G}\u2713${R} State restored (${restore.restoredDirs.length} directories, ${restore.restoredFiles.length} files)`,
    );
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
      console.error(`    Re-apply manually with: ${CLI_NAME} ${sandboxName} policy-add`);
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
    console.log(`  Run \`${CLI_NAME} upgrade-sandboxes\` to rebuild them.`);
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

// ── Dispatch helpers ─────────────────────────────────────────────

function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i++) matrix[i][0] = i;
  for (let j = 0; j < cols; j++) matrix[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[left.length][right.length];
}

function suggestGlobalCommand(token: string): string | null {
  let best: { command: string; distance: number } | null = null;
  for (const command of GLOBAL_COMMANDS) {
    if (command.startsWith("-")) continue;
    const distance = editDistance(token, command);
    if (!best || distance < best.distance) {
      best = { command, distance };
    }
  }
  if (!best) return null;
  if (best.distance <= 1) return best.command;
  if (token.length >= 5 && best.distance <= 2) return best.command;
  return null;
}

function findRegisteredSandboxName(tokens: string[]): string | null {
  const registered = new Set(
    registry.listSandboxes().sandboxes.map((s: { name: string }) => s.name),
  );
  return tokens.find((token) => registered.has(token)) || null;
}

function printConnectOrderHint(candidate: string | null): void {
  console.error(`  Command order is: ${CLI_NAME} <sandbox-name> connect`);
  if (candidate) {
    console.error(`  Did you mean: ${CLI_NAME} ${candidate} connect?`);
  }
}

const VALID_SANDBOX_ACTIONS =
  "connect, status, doctor, logs, policy-add, policy-remove, policy-list, skill, snapshot, share, rebuild, recover, shields, config, channels, gateway-token, destroy";

function printDispatchUsageError(
  result: Extract<DispatchResult, { kind: "usageError" }>,
  sandboxName?: string,
): never {
  if (result.lines.length === 0) {
    help();
    process.exit(1);
  }

  const [usage, ...details] = result.lines;
  console.error(`  Usage: ${CLI_NAME} ${sandboxName ? `${sandboxName} ` : ""}${usage}`);
  for (const line of details) {
    console.error(`    ${line}`);
  }
  process.exit(1);
}

async function runDispatchResult(
  result: DispatchResult,
  opts: { sandboxName?: string; actionArgs?: string[] } = {},
): Promise<void> {
  switch (result.kind) {
    case "oclif":
      await runOclif(result.commandId, result.args);
      return;
    case "help":
      printSandboxActionUsage(result.usage);
      return;
    case "usageError":
      printDispatchUsageError(result, opts.sandboxName);
    case "unknownSubcommand":
      if (result.command === "credentials") {
        console.error(`  Unknown credentials subcommand: ${result.subcommand}`);
        console.error(`  Run '${CLI_NAME} credentials help' for usage.`);
      } else {
        console.error(`  Unknown channels subcommand: ${result.subcommand}`);
        console.error(
          `  Usage: ${CLI_NAME} <name> channels <list|add|remove|stop|start> [args]`,
        );
        console.error("    list                  List supported messaging channels");
        console.error("    add <channel>         Store credentials and rebuild the sandbox");
        console.error("    remove <channel>      Clear credentials and rebuild the sandbox");
        console.error("    stop <channel>        Disable channel without wiping credentials");
        console.error("    start <channel>       Re-enable a previously stopped channel");
      }
      process.exit(1);
    case "unknownAction":
      console.error(`  Unknown action: ${result.action}`);
      console.error(`  Valid actions: ${VALID_SANDBOX_ACTIONS}`);
      process.exit(1);
    case "legacy": {
      const sandboxName = opts.sandboxName;
      const actionArgs = opts.actionArgs ?? [];
      if (!sandboxName) {
        throw new Error(`Missing sandbox name for legacy dispatch target ${result.target}`);
      }
      switch (result.target) {
        case "doctor":
          await sandboxDoctor(sandboxName, actionArgs);
          return;
        case "policy-add": {
          const { addSandboxPolicy } = require("./lib/policy-channel-actions") as {
            addSandboxPolicy: (sandboxName: string, args?: string[]) => Promise<void>;
          };
          await addSandboxPolicy(sandboxName, actionArgs);
          return;
        }
        case "skill":
          await sandboxSkillInstall(sandboxName, actionArgs);
          return;
        case "snapshot": {
          const { runSandboxSnapshot } = require("./lib/snapshot-action") as {
            runSandboxSnapshot: (sandboxName: string, args: string[]) => Promise<void>;
          };
          await runSandboxSnapshot(sandboxName, actionArgs);
          return;
        }
        default:
          throw new Error(`Unhandled legacy dispatch target ${result.target}`);
      }
    }
  }
}

// ── Dispatch ─────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

// eslint-disable-next-line complexity
const mainPromise = (async () => {
  // No command → help
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    await runOclif("root:help", []);
    return;
  }

  // Internal developer flag — dump canonical command list for check-docs.sh parity checks
  if (cmd === "--dump-commands") {
    canonicalUsageList().forEach((c: string) => console.log(c));
    return;
  }

  // Global commands
  if (GLOBAL_COMMANDS.has(cmd)) {
    await runDispatchResult(resolveGlobalOclifDispatch(cmd, args));
    return;
  }

  // Sandbox-scoped commands: nemoclaw <name> <action>
  const firstSandboxArg = args[0];
  const implicitConnectArg = isSandboxConnectFlag(firstSandboxArg);
  const requestedSandboxAction =
    !firstSandboxArg || implicitConnectArg ? "connect" : firstSandboxArg;
  const requestedSandboxActionArgs = !firstSandboxArg || implicitConnectArg ? args : args.slice(1);
  if (
    requestedSandboxAction === "connect" &&
    requestedSandboxActionArgs.some((arg) => arg === "--help" || arg === "-h")
  ) {
    validateName(cmd, "sandbox name");
    printSandboxConnectHelp(cmd);
    return;
  }

  // If the registry doesn't know this name but the action is a sandbox-scoped
  // command, attempt recovery — the sandbox may still be live with a stale registry.
  // Derived from command registry — single source of truth
  const sandboxActions = sandboxActionTokens();
  if (!registry.getSandbox(cmd) && sandboxActions.includes(requestedSandboxAction)) {
    validateName(cmd, "sandbox name");
    await recoverRegistryEntries({ requestedSandboxName: cmd });
    if (!registry.getSandbox(cmd)) {
      if (args.length === 0) {
        const suggestion = suggestGlobalCommand(cmd);
        if (suggestion) {
          console.error(`  Unknown command: ${cmd}`);
          console.error(`  Did you mean: ${CLI_NAME} ${suggestion}?`);
          process.exit(1);
        }
      }
      console.error(`  Sandbox '${cmd}' does not exist.`);
      const allNames = registry.listSandboxes().sandboxes.map((s: { name: string }) => s.name);
      if (allNames.length > 0) {
        console.error("");
        console.error(`  Registered sandboxes: ${allNames.join(", ")}`);
        console.error(`  Run '${CLI_NAME} list' to see all sandboxes.`);
        const reorderedCandidate =
          args[0] === "connect" ? findRegisteredSandboxName(args.slice(1)) : null;
        if (reorderedCandidate) {
          console.error("");
          printConnectOrderHint(reorderedCandidate);
        }
      } else {
        console.error(`  Run '${CLI_NAME} onboard' to create one.`);
      }
      process.exit(1);
    }
  }

  if (!registry.getSandbox(cmd)) {
    const suggestion = suggestGlobalCommand(cmd);
    if (suggestion) {
      console.error(`  Unknown command: ${cmd}`);
      console.error(`  Did you mean: ${CLI_NAME} ${suggestion}?`);
      process.exit(1);
    }
  }

  const sandbox = registry.getSandbox(cmd);
  if (sandbox) {
    validateName(cmd, "sandbox name");
    const action = requestedSandboxAction;
    const actionArgs = requestedSandboxActionArgs;
    if (action === "connect") {
      parseSandboxConnectArgs(cmd, actionArgs);
    }
    await runDispatchResult(resolveSandboxOclifDispatch(cmd, action, actionArgs), {
      sandboxName: cmd,
      actionArgs,
    });
    return;
  }

  // Unknown command — suggest
  console.error(`  Unknown command: ${cmd}`);
  console.error("");

  // Check if it looks like a sandbox name with missing action
  const allNames = registry.listSandboxes().sandboxes.map((s: { name: string }) => s.name);
  if (allNames.length > 0) {
    console.error(`  Registered sandboxes: ${allNames.join(", ")}`);
    console.error(`  Try: ${CLI_NAME} <sandbox-name> connect`);
    console.error("");
  }

  console.error(`  Run '${CLI_NAME} help' for usage.`);
  process.exit(1);
})();

exports.mainPromise = mainPromise;
