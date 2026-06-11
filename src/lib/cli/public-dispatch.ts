// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Public dispatcher for NemoClaw's sandbox-first CLI surface.
//
// oclif owns command discovery, parsing, help rendering, and command execution
// under src/commands/**. This module intentionally stays in front of oclif to
// support NemoClaw's permanent product grammar:
// `nemoclaw <sandbox-name> <action>` while the oclif-native command IDs are
// `sandbox:<action>` and parse as `nemoclaw sandbox <action> <sandbox-name>`.
// Keep new command adapters in src/commands/** and product behavior in
// src/lib/actions/**; keep this file limited to argv normalization,
// public route translation, suggestions, and registry-aware sandbox-name checks.
const { ROOT, validateName } = require("../runner");
const { CLI_NAME } = require("./branding");
const { help } = require("../actions/root-help");
const { runOclifArgv, runOclifCommandById } = require("./oclif-runner");
const {
  canonicalUsageList,
  globalCommandTokens,
  sandboxActionTokens,
} = require("./command-registry");
import { normalizeArgv, suggestCommand, type NormalizedSandboxArgv } from "./argv-normalizer";
import { getRegisteredOclifCommandMetadata } from "./oclif-metadata";
import {
  translatePublicGlobalArgv,
  translatePublicSandboxArgv,
  type PublicTranslationResult,
} from "./public-argv-translation";

// ── Global commands (derived from command registry) ──────────────

const GLOBAL_COMMANDS = globalCommandTokens();

type RegistryModule = typeof import("../state/registry");
type RegistryRecoveryModule = typeof import("../registry-recovery-action");
type SandboxConnectModule = typeof import("../actions/sandbox/connect");

let registryModule: RegistryModule | null = null;
let registryRecoveryModule: RegistryRecoveryModule | null = null;
let sandboxConnectModule: SandboxConnectModule | null = null;

function registry(): RegistryModule {
  registryModule ??= require("../state/registry") as RegistryModule;
  return registryModule;
}

function registryRecovery(): RegistryRecoveryModule {
  registryRecoveryModule ??= require("../registry-recovery-action") as RegistryRecoveryModule;
  return registryRecoveryModule;
}

function sandboxConnect(): SandboxConnectModule {
  sandboxConnectModule ??= require("../actions/sandbox/connect") as SandboxConnectModule;
  return sandboxConnectModule;
}

function isPublicSandboxConnectFlag(arg: string | undefined): boolean {
  return sandboxConnect().isSandboxConnectFlag(arg);
}

// ── Commands ─────────────────────────────────────────────────────

function oclifRunOptions() {
  return {
    rootDir: ROOT,
    error: console.error,
    exit: (code: number) => process.exit(code),
  };
}

async function runDirectOclifCommand(commandId: string, args: string[] = []): Promise<void> {
  await runOclifCommandById(commandId, args, oclifRunOptions());
}

async function runNativeOclifArgv(args: string[]): Promise<void> {
  await runOclifArgv(args, oclifRunOptions());
}

// ── Dispatch helpers ─────────────────────────────────────────────

function suggestGlobalCommand(token: string): string | null {
  return suggestCommand(token, GLOBAL_COMMANDS);
}

function hasHelpFlag(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function argsBeforeSeparator(args: readonly string[]): readonly string[] {
  const separatorIndex = args.indexOf("--");
  return separatorIndex === -1 ? args : args.slice(0, separatorIndex);
}

function hasPublicSandboxHelpFlag(action: string, args: readonly string[]): boolean {
  if (action !== "exec") return hasHelpFlag(args);
  return hasHelpFlag(argsBeforeSeparator(args));
}

function findRegisteredSandboxName(tokens: string[]): string | null {
  const registered = new Set(
    registry()
      .listSandboxes()
      .sandboxes.map((s: { name: string }) => s.name),
  );
  return tokens.find((token) => registered.has(token)) || null;
}

function printConnectOrderHint(candidate: string | null): void {
  console.error(`  Command order is: ${CLI_NAME} <sandbox-name> connect`);
  if (candidate) {
    console.error(`  Did you mean: ${CLI_NAME} ${candidate} connect?`);
  }
}

function sandboxActionList(): string[] {
  return sandboxActionTokens();
}

type OpenShellCommandHint = {
  entered: string;
  command: string;
  note?: string;
};

function getOpenShellCommandHint(argv: readonly string[]): OpenShellCommandHint | null {
  const [cmd, subcommand] = argv;
  if (cmd === "term") {
    return {
      entered: argv.join(" "),
      command: "openshell term",
      note: "Use this to monitor gateway logs and policy approval prompts.",
    };
  }
  if (cmd === "policy" && subcommand === "set") {
    return {
      entered: argv.join(" "),
      command: "openshell policy set --policy <policy-file> <sandbox-name>",
      note: `For NemoClaw presets, use: ${CLI_NAME} <sandbox-name> policy-add <preset>`,
    };
  }
  if (cmd === "gateway" && subcommand === "stop") {
    return {
      entered: argv.join(" "),
      command: "openshell gateway stop -g nemoclaw",
    };
  }
  return null;
}

function printOpenShellCommandHint(hint: OpenShellCommandHint): never {
  console.error(`  Unknown ${CLI_NAME} command: ${hint.entered}`);
  console.error("");
  console.error("  This operation belongs to OpenShell.");
  console.error(`  Run: ${hint.command}`);
  if (hint.note) {
    console.error(`  ${hint.note}`);
  }
  console.error("");
  console.error(`  Run '${CLI_NAME} help' for NemoClaw commands.`);
  process.exit(1);
}

function isKnownSandboxAction(action: string): boolean {
  return sandboxActionList().includes(action);
}

function validSandboxActionsText(): string {
  return sandboxActionList().filter(Boolean).join(", ");
}

function shouldExecuteViaNativeArgv(
  result: Extract<PublicTranslationResult, { kind: "nativeArgv" }>,
): boolean {
  // Native argv remains useful for fabricated unknown child routes so oclif owns
  // the unknown-command error. Exact public translations should run by command
  // ID to avoid flexible-taxonomy reinterpreting positional args under WSL.
  const helpArgs =
    result.commandId === "sandbox:exec" ? argsBeforeSeparator(result.args) : result.args;
  if (hasHelpFlag(helpArgs)) return false;
  if (result.commandId.startsWith("root:")) return false;
  if (getRegisteredOclifCommandMetadata(result.commandId)) return false;
  return true;
}
function printDispatchUsageError(
  result: Extract<PublicTranslationResult, { kind: "publicUsageError" }>,
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

async function recoverRequestedSandboxIfNeeded(
  sandboxName: string,
  action: string,
  rawArgsAfterSandboxName: string[],
): Promise<void> {
  if (registry().getSandbox(sandboxName) || !isKnownSandboxAction(action)) return;

  validateName(sandboxName, "sandbox name");
  await registryRecovery().recoverRegistryEntries({ requestedSandboxName: sandboxName });
  if (registry().getSandbox(sandboxName)) return;

  if (rawArgsAfterSandboxName.length === 0) {
    const suggestion = suggestGlobalCommand(sandboxName);
    if (suggestion) {
      console.error(`  Unknown command: ${sandboxName}`);
      console.error(`  Did you mean: ${CLI_NAME} ${suggestion}?`);
      process.exit(1);
    }
  }

  console.error(`  Sandbox '${sandboxName}' does not exist.`);
  const allNames = registry()
    .listSandboxes()
    .sandboxes.map((s: { name: string }) => s.name);
  if (allNames.length > 0) {
    console.error("");
    console.error(`  Registered sandboxes: ${allNames.join(", ")}`);
    console.error(`  Run '${CLI_NAME} list' to see all sandboxes.`);
    const reorderedCandidate =
      rawArgsAfterSandboxName[0] === "connect"
        ? findRegisteredSandboxName(rawArgsAfterSandboxName.slice(1))
        : null;
    if (reorderedCandidate) {
      console.error("");
      printConnectOrderHint(reorderedCandidate);
    }
  } else {
    console.error(`  Run '${CLI_NAME} onboard' to create one.`);
  }
  process.exit(1);
}

function handlePublicConnectHelp(normalized: NormalizedSandboxArgv): boolean {
  if (!normalized.connectHelpRequested) return false;
  validateName(normalized.sandboxName, "sandbox name");
  sandboxConnect().printSandboxConnectHelp(normalized.sandboxName);
  return true;
}

function validatePublicConnectArgs(
  sandboxName: string,
  action: string,
  actionArgs: string[],
): void {
  if (action === "connect") {
    sandboxConnect().parseSandboxConnectArgs(sandboxName, actionArgs);
  }
}

async function runPublicTranslationResult(
  result: PublicTranslationResult,
  opts: { sandboxName?: string } = {},
): Promise<void> {
  switch (result.kind) {
    case "nativeArgv":
      if (shouldExecuteViaNativeArgv(result)) {
        await runNativeOclifArgv(result.argv);
      } else {
        await runDirectOclifCommand(result.commandId, result.args);
      }
      return;
    case "publicUsageError":
      printDispatchUsageError(result, opts.sandboxName);
      return;
    case "unknownPublicAction":
      console.error(`  Unknown action: ${result.action}`);
      console.error(`  Valid actions: ${validSandboxActionsText()}`);
      process.exit(1);
  }
}

// ── Dispatch ─────────────────────────────────────────────────────

// eslint-disable-next-line complexity
export async function dispatchCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "internal" || argv[0] === "sandbox") {
    await runNativeOclifArgv(argv);
    return;
  }

  const normalized = normalizeArgv(argv, {
    globalCommands: GLOBAL_COMMANDS,
    isSandboxConnectFlag: isPublicSandboxConnectFlag,
  });

  if (normalized.kind === "rootHelp") {
    await runDirectOclifCommand("root:help", []);
    return;
  }

  if (normalized.kind === "dumpCommands") {
    canonicalUsageList().forEach((c: string) => console.log(c));
    return;
  }

  if (normalized.kind === "global") {
    await runPublicTranslationResult(
      translatePublicGlobalArgv(normalized.command, normalized.args),
    );
    return;
  }

  const cmd = normalized.sandboxName;
  const rawArgsAfterCmd = argv.slice(1);
  const requestedSandboxAction = normalized.action;
  const requestedSandboxActionArgs = normalized.actionArgs;
  if (handlePublicConnectHelp(normalized)) return;

  // Help is parser metadata, not sandbox runtime behavior. Render sandbox-scoped
  // public help before registry recovery so `nemoclaw missing channels start --help`
  // stays side-effect free and never starts or repairs services.
  if (
    !normalized.connectHelpRequested &&
    isKnownSandboxAction(requestedSandboxAction) &&
    hasPublicSandboxHelpFlag(requestedSandboxAction, requestedSandboxActionArgs)
  ) {
    validateName(cmd, "sandbox name");
    await runPublicTranslationResult(
      translatePublicSandboxArgv(cmd, requestedSandboxAction, requestedSandboxActionArgs),
      {
        sandboxName: cmd,
      },
    );
    return;
  }

  // #3447 — when the typed command matches an OpenShell-owned operation
  // (term / policy set / gateway stop) and there is no sandbox by that name,
  // point users at the correct tool. Must run before recovery so bare
  // `nemoclaw term` (which normalizes to sandboxName=term, action=connect)
  // doesn't get swallowed by the recovery's "Sandbox does not exist" exit.
  const openshellHint = getOpenShellCommandHint(argv);
  if (openshellHint && !registry().getSandbox(cmd)) {
    printOpenShellCommandHint(openshellHint);
  }

  // If the registry doesn't know this name but the action is a sandbox-scoped
  // command, attempt recovery — the sandbox may still be live with a stale registry.
  await recoverRequestedSandboxIfNeeded(cmd, requestedSandboxAction, rawArgsAfterCmd);

  const sandbox = registry().getSandbox(cmd);
  if (!sandbox) {
    const suggestion = suggestGlobalCommand(cmd);
    if (suggestion) {
      console.error(`  Unknown command: ${cmd}`);
      console.error(`  Did you mean: ${CLI_NAME} ${suggestion}?`);
      process.exit(1);
    }
  }

  if (sandbox) {
    validateName(cmd, "sandbox name");
    const action = requestedSandboxAction;
    const actionArgs = requestedSandboxActionArgs;
    validatePublicConnectArgs(cmd, action, actionArgs);
    await runPublicTranslationResult(translatePublicSandboxArgv(cmd, action, actionArgs), {
      sandboxName: cmd,
    });
    return;
  }

  // Unknown command — suggest
  console.error(`  Unknown command: ${cmd}`);
  console.error("");

  // Check if it looks like a sandbox name with missing action
  const allNames = registry()
    .listSandboxes()
    .sandboxes.map((s: { name: string }) => s.name);
  if (allNames.length > 0) {
    console.error(`  Registered sandboxes: ${allNames.join(", ")}`);
    console.error(`  Try: ${CLI_NAME} <sandbox-name> connect`);
    console.error("");
  }

  console.error(`  Run '${CLI_NAME} help' for usage.`);
  process.exit(1);
}
