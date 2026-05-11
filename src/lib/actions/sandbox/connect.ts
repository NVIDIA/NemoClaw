// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0


import { spawnSync } from "node:child_process";
import os from "node:os";

import { CLI_NAME } from "../../cli/branding";
import { parseGatewayInference } from "../../inference/config";
import { ensureOllamaAuthProxy } from "../../inference/ollama/proxy";
import {
  captureOpenshell,
  getOpenshellBinary,
  runOpenshell,
} from "../../adapters/openshell/runtime";
import {
  OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "../../adapters/openshell/timeouts";
import * as registry from "../../state/registry";
import type { SandboxEntry } from "../../state/registry";
import { ROOT } from "../../runner";
import { runSetupDnsProxy } from "../dns";
import { ensureLiveSandboxOrExit } from "./gateway-state";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
} from "../../state/sandbox-session";
import { checkAndRecoverSandboxProcesses } from "./process-recovery";
import * as sandboxVersion from "../../sandbox-version";
import { D, G, R, YW } from "../../cli/terminal-style";
import { resolveOpenshell } from "../../adapters/openshell/resolve";

const agentRuntime = require("../../../../bin/lib/agent-runtime");

const NEMOCLAW_GATEWAY_NAME = "nemoclaw";

export type SandboxConnectOptions = {
  probeOnly?: boolean;
};

type SpawnLikeResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
};

const SANDBOX_CONNECT_FLAGS = new Set([
  "--dangerously-skip-permissions",
  "--probe-only",
  "--help",
  "-h",
]);

export function isSandboxConnectFlag(arg: string | undefined): boolean {
  return typeof arg === "string" && SANDBOX_CONNECT_FLAGS.has(arg);
}

export function printSandboxConnectHelp(sandboxName = "<name>"): void {
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

export function parseSandboxConnectArgs(
  sandboxName: string,
  actionArgs: string[],
): SandboxConnectOptions {
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
        break;
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
    ensureSandboxInferenceRoute(sandboxName, { quiet: false });
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
    ensureSandboxInferenceRoute(sandboxName, { quiet: false });
    console.log(`  Probe complete: recovered ${agentName} gateway in '${sandboxName}'.`);
    return;
  }
  ensureSandboxInferenceRoute(sandboxName, { quiet: false });
  console.error(
    `  Probe failed: ${agentName} gateway is not running in '${sandboxName}' and automatic recovery failed.`,
  );
  console.error("  Check /tmp/gateway.log inside the sandbox for details.");
  process.exit(1);
}

function isSandboxInferenceRouteHealthy(sandboxName: string): boolean {
  // Keep the shell string inside the sandbox: curl write-out, body capture,
  // and status classification must run as one bounded probe. sandboxName
  // remains an argv value, so no user input is interpolated into the script.
  const probe = captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--",
      "sh",
      "-c",
      [
        "OUT=/tmp/nemoclaw-inference-route-probe.out",
        "HTTP_CODE=$(curl -sk -o \"$OUT\" -w '%{http_code}' --connect-timeout 3 --max-time 8 https://inference.local/v1/models 2>/dev/null || printf '000')",
        "case \"$HTTP_CODE\" in 000|5*) printf 'BROKEN %s ' \"$HTTP_CODE\"; head -c 160 \"$OUT\" 2>/dev/null ;; *) printf 'OK %s' \"$HTTP_CODE\" ;; esac",
      ].join("; "),
    ],
    { ignoreError: true, timeout: OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS },
  );
  return probe.status === 0 && /^OK\s+[0-9]{3}\b/.test(probe.output.trim());
}

function repairSandboxInferenceRouteIfNeeded(
  sandboxName: string,
  { quiet = false }: { quiet?: boolean } = {},
): boolean {
  if (process.env.NEMOCLAW_DISABLE_INFERENCE_ROUTE_REPAIR === "1") return false;
  if (isSandboxInferenceRouteHealthy(sandboxName)) return false;

  if (!quiet) {
    console.log("");
    console.log(`  inference.local is unavailable inside '${sandboxName}'. Repairing sandbox DNS proxy...`);
  }
  const repair = runSetupDnsProxy(
    { gatewayName: NEMOCLAW_GATEWAY_NAME, sandboxName },
    { log: quiet ? () => undefined : console.log },
  );
  if (repair.exitCode !== 0) {
    if (!quiet) {
      console.error("  Warning: failed to repair sandbox DNS proxy.");
      if (repair.message) console.error(`  ${repair.message}`);
    }
    return false;
  }

  const healthy = isSandboxInferenceRouteHealthy(sandboxName);
  if (!quiet) {
    if (healthy) {
      console.log("  inference.local route repaired.");
    } else {
      console.error("  Warning: inference.local is still unavailable after DNS proxy repair.");
    }
  }
  return healthy;
}

function ensureSandboxInferenceRoute(
  sandboxName: string,
  { quiet = false }: { quiet?: boolean } = {},
): SandboxEntry | null {
  let sb: SandboxEntry | null = null;
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
        if (!quiet) {
          console.log(
            `  Switching inference route to ${sb.provider}/${sb.model} for sandbox '${sandboxName}'`,
          );
        }
        const swapResult = runOpenshell(
          ["inference", "set", "--provider", sb.provider, "--model", sb.model, "--no-verify"],
          { ignoreError: true },
        );
        if (swapResult.status !== 0 && !quiet) {
          console.error(
            `  ${YW}Warning: failed to switch inference route — connect will proceed anyway.${R}`,
          );
        }
      }
      repairSandboxInferenceRouteIfNeeded(sandboxName, { quiet });
    }
  } catch {
    /* non-fatal — don't block connect on inference route repair */
  }
  return sb;
}

function exitWithSpawnResult(result: SpawnLikeResult): void {
  if (result.status !== null) {
    process.exit(result.status);
  }

  if (result.signal) {
    const signalNumber = os.constants.signals[result.signal];
    process.exit(signalNumber ? 128 + signalNumber : 1);
  }

  process.exit(1);
}

export async function connectSandbox(
  sandboxName: string,
  { probeOnly = false }: SandboxConnectOptions = {},
): Promise<void> {
  const { isSandboxReady, parseSandboxStatus } = require("../../onboard");
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
  const sb = ensureSandboxInferenceRoute(sandboxName);

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
        console.error("  Check: openshell sandbox list");
        process.exit(1);
      }
      process.stdout.write(`\r    Status: ${cur.padEnd(20)} (${elapsed}s elapsed)`);
    }

    if (!ready) {
      console.error("");
      console.error(`  Timed out after ${timeout}s waiting for sandbox '${sandboxName}'.`);
      console.error("  Check: openshell sandbox list");
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
