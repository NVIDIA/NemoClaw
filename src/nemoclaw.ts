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
const { stripAnsi } = require("./lib/openshell");
const {
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
const { runRegisteredOclifCommand } = require("./lib/cli/oclif-runner");
const { isErrnoException }: typeof import("./lib/errno") = require("./lib/errno");
const agentRuntime = require("../bin/lib/agent-runtime");
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
import { normalizeArgv, suggestCommand } from "./lib/cli/argv-normalizer";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./lib/openshell-timeouts";
import { renderPublicOclifHelp } from "./lib/cli/public-oclif-help";
import {
  resolveGlobalOclifDispatch,
  resolveSandboxOclifDispatch,
  type DispatchResult,
} from "./lib/cli/oclif-dispatch";

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

// ── Pre-upgrade backup ───────────────────────────────────────────

// ── Snapshot ─────────────────────────────────────────────────────

// ── Dispatch helpers ─────────────────────────────────────────────

function suggestGlobalCommand(token: string): string | null {
  return suggestCommand(token, GLOBAL_COMMANDS);
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
      if (result.commandId) {
        renderPublicOclifHelp(result.commandId, `<name> ${result.usage}`);
      } else {
        printSandboxActionUsage(result.usage);
      }
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
  }
}

// ── Dispatch ─────────────────────────────────────────────────────

// eslint-disable-next-line complexity
async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const normalized = normalizeArgv(argv, {
    globalCommands: GLOBAL_COMMANDS,
    isSandboxConnectFlag,
  });

  if (normalized.kind === "rootHelp") {
    await runOclif("root:help", []);
    return;
  }

  if (normalized.kind === "dumpCommands") {
    canonicalUsageList().forEach((c: string) => console.log(c));
    return;
  }

  if (normalized.kind === "global") {
    await runDispatchResult(resolveGlobalOclifDispatch(normalized.command, normalized.args));
    return;
  }

  const cmd = normalized.sandboxName;
  const args = argv.slice(1);
  const requestedSandboxAction = normalized.action;
  const requestedSandboxActionArgs = normalized.actionArgs;
  if (normalized.connectHelpRequested) {
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
}

exports.main = main;
module.exports.dispatchCli = main;
// Compatibility for tests that require the CLI module and await completion.
// Prefer calling main(argv) directly in new in-process harnesses.
exports.mainPromise =
  process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH === "1" ? Promise.resolve() : main();
