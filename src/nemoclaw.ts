// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execFileSync, spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
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

const { ROOT, run, runInteractive, validateName } = require("./lib/runner");

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
const { hydrateCredentialEnv, isNonInteractive } = require("./lib/onboard");
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
  getInstalledOpenshellVersionOrNull,
  runOpenshell,
} = require("./lib/openshell-runtime");
const {
  recoverNamedGatewayRuntime,
} = require("./lib/gateway-runtime-action");
const { recoverRegistryEntries } = require("./lib/registry-recovery-action");
const {
  isSandboxConnectFlag,
  parseSandboxConnectArgs,
  printSandboxConnectHelp,
} = require("./lib/sandbox-connect-action");
const {
  executeSandboxCommand,
} = require("./lib/sandbox-process-recovery-action");
const {
  getSandboxDeleteOutcome,
} = require("./lib/sandbox-destroy-action");
const { rebuildSandbox: sandboxRebuild } = require("./lib/sandbox-rebuild-action");
const { runRegisteredOclifCommand } = require("./lib/oclif-runner");
const { isErrnoException }: typeof import("./lib/errno") = require("./lib/errno");
const agentRuntime = require("../bin/lib/agent-runtime");
const sandboxVersion = require("./lib/sandbox-version");
const sandboxState = require("./lib/sandbox-state");
const { parseRestoreArgs } = sandboxState;
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
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./lib/openshell-timeouts";
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

type RecoveredSandboxMetadata = Partial<
  Pick<SandboxEntry, "model" | "provider" | "gpuEnabled" | "policies" | "nimContainer" | "agent">
> & {
  policyPresets?: string[] | null;
};

const NEMOCLAW_GATEWAY_NAME = "nemoclaw";
const DASHBOARD_FORWARD_PORT = String(DASHBOARD_PORT);
const DEFAULT_LOGS_PROBE_TIMEOUT_MS = 5000;
const LOGS_PROBE_TIMEOUT_ENV = "NEMOCLAW_LOGS_PROBE_TIMEOUT_MS";

exports.runtimeBridge = {
  upgradeSandboxes,
};
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

// ── Rebuild ──────────────────────────────────────────────────────

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
        case "policy-add": {
          const { addSandboxPolicy } = require("./lib/policy-channel-actions") as {
            addSandboxPolicy: (sandboxName: string, args?: string[]) => Promise<void>;
          };
          await addSandboxPolicy(sandboxName, actionArgs);
          return;
        }
        case "skill": {
          const { installSandboxSkill } = require("./lib/sandbox-skill-install-action") as {
            installSandboxSkill: (sandboxName: string, args?: string[]) => Promise<void>;
          };
          await installSandboxSkill(sandboxName, actionArgs);
          return;
        }
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
