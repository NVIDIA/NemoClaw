// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0


import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DASHBOARD_PORT } from "../../core/ports";
import { ROOT, shellQuote } from "../../runner";
import {
  captureOpenshell,
  captureOpenshellForStatus,
  getOpenshellBinary,
  isCommandTimeout,
  runOpenshell,
} from "../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import * as registry from "../../state/registry";
import { parseForwardList } from "../../state/sandbox-session";
import { G, R } from "../../cli/terminal-style";
import { sleepSeconds } from "../../core/wait";

const agentRuntime = require("../../../../bin/lib/agent-runtime");

export type SandboxCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type SandboxPortDeps = {
  getSandbox?: typeof registry.getSandbox;
  getSessionAgent?: typeof agentRuntime.getSessionAgent;
};

export type SandboxForwardListEntry = {
  sandboxName: string;
  port: string;
  status: string;
};

export type SandboxForwardHealth = boolean | "occupied" | null;

const SANDBOX_EXEC_STARTED_MARKER = "__NEMOCLAW_SANDBOX_EXEC_STARTED__";

function isValidPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65535
  );
}

export function resolveSandboxDashboardPort(
  sandboxName: string,
  deps: SandboxPortDeps = {},
): number {
  const getSessionAgent = deps.getSessionAgent ?? agentRuntime.getSessionAgent;
  const agent = getSessionAgent(sandboxName);
  if (agent && isValidPort(agent.forwardPort)) {
    return agent.forwardPort;
  }

  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const sandbox = getSandbox(sandboxName);
  return isValidPort(sandbox?.dashboardPort) ? sandbox.dashboardPort : DASHBOARD_PORT;
}

function getSandboxHealthProbeUrl(sandboxName: string): string {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  if (agent) return agentRuntime.getHealthProbeUrl(agent);
  return `http://127.0.0.1:${resolveSandboxDashboardPort(sandboxName)}/health`;
}

/**
 * Run a command inside the sandbox via SSH and return { status, stdout, stderr }.
 * Returns null if SSH config cannot be obtained.
 */
export function executeSandboxCommand(
  sandboxName: string,
  command: string,
): SandboxCommandResult | null {
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

export function executeSandboxExecCommand(
  sandboxName: string,
  command: string,
  timeout = 15000,
): SandboxCommandResult | null {
  const markedCommand = `printf '%s\n' '${SANDBOX_EXEC_STARTED_MARKER}'; ${command}`;
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
  const markedCommand = `printf '%s\n' '${SANDBOX_EXEC_STARTED_MARKER}'; ${command}`;
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
 * Uses the gateway's HTTP /health endpoint as the source of truth,
 * since the gateway runs as a separate user and pgrep may not see it.
 * Returns true (running), false (stopped), or null (cannot determine).
 *
 * Uses HTTP status code extraction instead of `curl -sf` so that
 * 401 (device auth enabled) is correctly treated as "alive".
 * Fixes #2342 — previously `curl -sf` failed on 401, causing false
 * "Health Offline" readings.
 */
function isSandboxGatewayRunning(sandboxName: string): boolean | null {
  const probeUrl = getSandboxHealthProbeUrl(sandboxName);
  const command = `HTTP_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 3 ${shellQuote(probeUrl)} 2>/dev/null || echo 000); case "$HTTP_CODE" in 200|401) echo RUNNING ;; *) echo STOPPED ;; esac`;
  const execProbe = parseSandboxGatewayProbe(executeSandboxExecCommand(sandboxName, command));
  if (execProbe !== null) return execProbe;
  return parseSandboxGatewayProbe(executeSandboxCommand(sandboxName, command));
}

export async function isSandboxGatewayRunningForStatus(
  sandboxName: string,
): Promise<boolean | null> {
  const probeUrl = getSandboxHealthProbeUrl(sandboxName);
  const command = `HTTP_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 3 ${shellQuote(probeUrl)} 2>/dev/null || echo 000); case "$HTTP_CODE" in 200|401) echo RUNNING ;; *) echo STOPPED ;; esac`;
  return parseSandboxGatewayProbe(await executeSandboxExecCommandForStatus(sandboxName, command));
}

/**
 * Restart the gateway process inside the sandbox after a pod restart.
 * Cleans stale lock/temp files, sources proxy config, and launches the gateway
 * in the background. Returns true on success.
 */
function recoverSandboxProcesses(sandboxName: string): boolean {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const dashboardPort = resolveSandboxDashboardPort(sandboxName);
  const agentScript = agentRuntime.buildRecoveryScript(agent, dashboardPort);
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

  const script = agentRuntime.buildOpenClawRecoveryScript(dashboardPort);
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
  const timeoutSeconds = readNonNegativeNumberEnv("NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS", 30);
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
 * Uses the recorded dashboard port for OpenClaw sandboxes, or the agent's
 * declared forward port when a non-OpenClaw agent is active.
 * Returns true when `forward start` succeeded and a follow-up probe
 * confirms the new entry is running, false otherwise.
 */
function ensureSandboxPortForward(sandboxName: string): boolean {
  const forwardHealth = isSandboxForwardHealthy(sandboxName);
  if (forwardHealth === true) return true;
  if (forwardHealth === "occupied") return false;

  const port = String(resolveSandboxDashboardPort(sandboxName));
  runOpenshell(["forward", "stop", port], { ignoreError: true });
  const startResult = runOpenshell(["forward", "start", "--background", port, sandboxName], {
    ignoreError: true,
  });
  if (startResult.status !== 0) return false;
  return isSandboxForwardHealthy(sandboxName) === true;
}

/**
 * Probe `openshell forward list` for the sandbox's dashboard forward.
 * Returns true when an entry exists for the expected sandbox+port pair
 * with STATUS=running, false when the entry is missing or non-running,
 * "occupied" when another sandbox already owns the expected port, and
 * null when openshell is unreachable.
 *
 * The in-sandbox gateway and the host-side forward are independent
 * dimensions: the forward can die (host SSH session dropped, list shows
 * STATUS=dead) while the gateway keeps listening on 127.0.0.1:<port>.
 *
 * Also falls back to a local TCP/HTTP probe of 127.0.0.1:<port> when
 * `forward list` would classify the entry as not-running. openshell's
 * STATUS column lags real state — it can show "dead" for an entry that
 * is still serving traffic, or hide an entry whose SSH session was just
 * recycled (#3334). Trusting the column verbatim made every `connect`
 * print a "missing or dead" preamble followed by a "Failed to
 * re-establish" line even though the forward worked.
 */
function isSandboxForwardHealthy(sandboxName: string): SandboxForwardHealth {
  const port = resolveSandboxDashboardPort(sandboxName);
  const result = captureOpenshell(["forward", "list"], {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (!result || isCommandTimeout(result) || result.status !== 0) return null;
  const entries = parseForwardList(result.output) as SandboxForwardListEntry[];
  return classifyForwardHealthWithReachability(entries, sandboxName, String(port), () =>
    isLocalForwardReachable(port),
  );
}

export function classifySandboxForwardHealth(
  entries: SandboxForwardListEntry[],
  sandboxName: string,
  port: string,
): Exclude<SandboxForwardHealth, null> {
  const match = entries.find((entry) => entry.port === port);
  if (!match) return false;
  if (match.sandboxName !== sandboxName) return "occupied";
  return match.status === "running";
}

/**
 * Like {@link classifySandboxForwardHealth} but accepts a reachability
 * callback that probes whether the local forwarded port actually answers.
 * When the entry-based classification would return `false`, the
 * reachability check overrides it: a port that answers is healthy
 * regardless of what `forward list` reports. The "occupied" verdict is
 * preserved — we never silently take over a forward owned by another
 * sandbox, even if that forward happens to be reachable.
 */
export function classifyForwardHealthWithReachability(
  entries: SandboxForwardListEntry[],
  sandboxName: string,
  port: string,
  isReachable: () => boolean,
): Exclude<SandboxForwardHealth, null> {
  const verdict = classifySandboxForwardHealth(entries, sandboxName, port);
  if (verdict !== false) return verdict;
  return isReachable() ? true : false;
}

/**
 * Synchronous reachability check for a local port. Used to override a
 * negative `openshell forward list` verdict when the forward is actually
 * still serving traffic — see {@link classifyForwardHealthWithReachability}.
 * Returns false on any error so the existing recovery path stays intact
 * when Node can't probe (e.g., restrictive sandbox).
 */
function isLocalForwardReachable(port: number): boolean {
  const script =
    "const net=require('node:net');" +
    `const s=net.createConnection({host:'127.0.0.1',port:${port}});` +
    "s.setTimeout(1000);" +
    "s.on('connect',()=>{s.destroy();process.exit(0)});" +
    "s.on('error',()=>process.exit(1));" +
    "s.on('timeout',()=>{s.destroy();process.exit(1)});";
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf-8",
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 2000,
  });
  if (result.error) return false;
  return result.status === 0;
}

/**
 * Detect and recover from a sandbox that survived a gateway restart but
 * whose OpenClaw processes are not running. Also re-establishes the
 * host-side dashboard port-forward when it has gone dead independently
 * of the gateway. Returns an object describing the outcome:
 * `{ checked, wasRunning, recovered, forwardRecovered }`.
 */
export function checkAndRecoverSandboxProcesses(
  sandboxName: string,
  { quiet = false }: { quiet?: boolean } = {},
) {
  const running = isSandboxGatewayRunning(sandboxName);
  if (running === null) {
    return { checked: false, wasRunning: null, recovered: false, forwardRecovered: false };
  }
  const recoveryAgent = agentRuntime.getSessionAgent(sandboxName);
  const recoveryPort = resolveSandboxDashboardPort(sandboxName);
  if (running) {
    // Gateway is alive but the host-side forward can still be dead or
    // owned by another sandbox. Probe and re-establish only when
    // necessary so the live-and-healthy path stays a no-op.
    const forwardHealthy = isSandboxForwardHealthy(sandboxName);
    if (forwardHealthy === false) {
      if (!quiet) {
        console.log("");
        console.log(`  Dashboard port forward to '${sandboxName}' is missing or dead.`);
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
    if (forwardHealthy === "occupied") {
      if (!quiet) {
        console.log("");
        console.error(`  Dashboard port forward for '${sandboxName}' is owned by another sandbox.`);
        console.error("  Leaving the existing port forward unchanged.");
      }
      return { checked: true, wasRunning: true, recovered: false, forwardRecovered: false };
    }
    return { checked: true, wasRunning: true, recovered: false, forwardRecovered: false };
  }

  // Gateway not running — attempt recovery
  if (!quiet) {
    console.log("");
    console.log(
      `  ${agentRuntime.getAgentDisplayName(recoveryAgent)} gateway is not running inside the sandbox (sandbox likely restarted).`,
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
        console.error("  Connect to the sandbox and run manually:");
        console.error(
          `    ${agentRuntime.buildManualRecoveryCommand(recoveryAgent, recoveryPort)}`,
        );
      }
      return { checked: true, wasRunning: false, recovered: false, forwardRecovered: false };
    }
    const forwardRecovered = ensureSandboxPortForward(sandboxName);
    if (!quiet) {
      console.log(
        `  ${G}✓${R} ${agentRuntime.getAgentDisplayName(recoveryAgent)} gateway restarted inside sandbox.`,
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
      `  Could not restart ${agentRuntime.getAgentDisplayName(recoveryAgent)} gateway automatically.`,
    );
    console.error("  Connect to the sandbox and run manually:");
    console.error(`    ${agentRuntime.buildManualRecoveryCommand(recoveryAgent, recoveryPort)}`);
  }

  return { checked: true, wasRunning: false, recovered, forwardRecovered: false };
}
