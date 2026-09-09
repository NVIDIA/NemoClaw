// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildCliOpenShellSandboxExecArgs,
  createCliOpenShellSandboxCommandExecutor,
  runCliOpenShellStreamingCommand,
  type OpenShellCommandChild,
  type OpenShellCommandChildOptions,
  type OpenShellCommandSignalSource,
  type OpenShellCommandSpawner,
} from "../../adapters/openshell/sandbox-command-cli";
import type {
  OpenShellSandboxCommandExecutor,
  OpenShellSandboxCommandRequest,
} from "../../adapters/openshell/sandbox-command";
import {
  namedOpenShellGateway,
  selectedOpenShellGateway,
} from "../../adapters/openshell/sandbox-observer";
import { spawnExitCode } from "../../core/process-exit";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import type {
  MutableConfigPermsInspection,
  MutableConfigRepairResult,
} from "../../sandbox/mutable-config-perms";
import type { SandboxEntry } from "../../state/registry";
import { type ExecPolicyHintDeps, preparePolicyHint } from "./exec-policy-hint-integration";
import type { GatewaySelectResult } from "./gateway-select";
import { wrapExecCommandWithRuntimeEnv } from "./runtime-env";

export {
  wrapExecCommandWithRuntimeEnv,
  wrapOpenClawAgentCommandWithRuntimeEnv,
} from "./runtime-env";

export type SandboxExecOptions = {
  workdir?: string;
  tty?: boolean | null;
  timeoutSeconds?: number;
  stdin?: boolean;
};

export type SandboxExecChildOptions = SandboxExecOptions & {
  hostCwd?: string;
  hostEnv?: NodeJS.ProcessEnv;
  subprocessEnv?: NodeJS.ProcessEnv;
};

export type SandboxExecGatewayRestart = (sandboxName: string) => { ok: boolean };

export type SandboxExecAgentResolver = (sandboxName: string) => string | null;

export type SpawnLikeResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  releaseSignals?: () => void;
};

export type SandboxExecChild = OpenShellCommandChild;

export type SandboxExecSpawner = OpenShellCommandSpawner;

export type SandboxExecSignalSource = OpenShellCommandSignalSource;

export type SandboxExecCleanupDeps = {
  getSandbox: (sandboxName: string) => Pick<SandboxEntry, "agent"> | null;
  inspectMutableConfigPerms: (sandboxName: string) => MutableConfigPermsInspection;
  repairMutableConfigPerms: (sandboxName: string) => MutableConfigRepairResult;
};

export type SandboxExecCompletion = {
  code: number;
  commandCode: number;
  invocationError?: string;
  cleanupError?: string;
};

/**
 * Compatibility argv surface for buffered and interactive consumers tracked
 * by #10991 and #10994. Remove it after those callers use typed executors.
 */
export function buildOpenshellExecArgs(
  sandboxName: string,
  command: readonly string[],
  options: SandboxExecOptions = {},
  gatewayName?: string,
): string[] {
  return buildCliOpenShellSandboxExecArgs({
    sandboxName,
    target: gatewayName ? namedOpenShellGateway(gatewayName) : selectedOpenShellGateway(),
    command,
    workdir: options.workdir,
    tty: options.tty,
    timeoutSeconds: options.timeoutSeconds,
    stdin: options.stdin,
  });
}

// OpenShell accepts LF/CR in command argv while retaining field-specific
// rejection for NUL-bearing command args and NUL/LF/CR-bearing workdirs. Keep
// the downstream check narrow so inline scripts remain byte-exact. NemoClaw's
// public exec surface does not populate OpenShell's request-environment field,
// whose values remain subject to OpenShell's own NUL/LF/CR validation.
function execInputError(command: readonly string[], workdir: string | undefined): string | null {
  const nulIndex = command.findIndex((arg) => arg.includes("\0"));
  if (nulIndex !== -1) {
    return `error: command argument ${nulIndex + 1} contains a NUL byte, which OpenShell exec does not accept`;
  }
  if (workdir?.includes("\0")) {
    return "error: --workdir must not contain NUL bytes";
  }
  if (workdir && /[\r\n]/.test(workdir)) {
    return "error: --workdir must not contain newlines or carriage returns";
  }
  return null;
}

export function workdirMissingMessage(workdir: string): string {
  return `error: --workdir: ${workdir} does not exist inside the sandbox`;
}

export function computeExitCode(result: SpawnLikeResult): {
  code: number;
  errorMessage?: string;
} {
  if (result.error) {
    return { code: 1, errorMessage: result.error.message };
  }
  return { code: spawnExitCode(result) };
}

function repairFailureDetail(
  inspection: MutableConfigPermsInspection,
  result: MutableConfigRepairResult,
): string | null {
  if (!result.applied) {
    return `repair skipped: ${result.reason}`;
  }
  if (result.verified) return null;
  const before = inspection.applies ? inspection.issues.join("; ") : inspection.reason;
  const errors = result.errors.join("; ") || "verification failed";
  return `${errors}${before ? ` (before repair: ${before})` : ""}`;
}

/**
 * Restore the mutable OpenClaw permission contract after the public
 * `nemoclaw <sandbox> exec` command boundary. OpenShell executes the requested
 * process directly, so the sandbox entrypoint's one-shot cleanup does not run
 * on this path. Hermes and custom agents are deliberately left unchanged.
 *
 * Each production inspect/repair call takes the cross-process sandbox mutation
 * lock. The repair is idempotent, and the host keeps lock authority outside the
 * sandbox-owned config tree.
 */
export function cleanupOpenClawAfterExec(
  sandboxName: string,
  deps: SandboxExecCleanupDeps,
): string | null {
  let entry: Pick<SandboxEntry, "agent"> | null;
  try {
    entry = deps.getSandbox(sandboxName);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `sandbox registry lookup failed: ${detail}`;
  }
  if (!entry) return null;
  if ((entry.agent ?? "openclaw") !== "openclaw") return null;

  let inspection: MutableConfigPermsInspection;
  try {
    inspection = deps.inspectMutableConfigPerms(sandboxName);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `permission inspection failed: ${detail}`;
  }
  if (inspection.applies && inspection.ok) return null;

  let repair: MutableConfigRepairResult;
  try {
    repair = deps.repairMutableConfigPerms(sandboxName);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `permission repair failed: ${detail}`;
  }
  const repairFailure = repairFailureDetail(inspection, repair);
  if (repairFailure || !repair.applied) return repairFailure;

  let verification: MutableConfigPermsInspection;
  try {
    verification = deps.inspectMutableConfigPerms(sandboxName);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `post-repair permission verification failed: ${detail}`;
  }
  if (!verification.applies) {
    return `post-repair permission verification unavailable: ${verification.reason}`;
  }
  if (!verification.ok) {
    return `post-repair permission verification failed: ${verification.issues.join("; ")}`;
  }
  return null;
}

/**
 * Compatibility child-process surface for interactive consumers tracked by
 * #10994. Remove it after those callers use a typed interactive executor.
 */
export async function runSandboxExecChild(
  binary: string,
  args: readonly string[],
  options: SandboxExecChildOptions = {},
  spawnChild?: SandboxExecSpawner,
  signalSource?: SandboxExecSignalSource,
): Promise<SpawnLikeResult> {
  const childOptions: OpenShellCommandChildOptions = {
    stdin: options.stdin,
    hostCwd: options.hostCwd,
    hostEnv: options.hostEnv ?? options.subprocessEnv,
  };
  return runCliOpenShellStreamingCommand(binary, args, childOptions, spawnChild, signalSource);
}

export function cleanupFailureMessage(commandCode: number, detail: string): string {
  return `  OpenClaw permission cleanup failed (command exit ${commandCode}; cleanup exit 1): ${detail}`;
}

function defaultSelectGateway(sandboxName: string): GatewaySelectResult {
  return (
    require("./gateway-select") as typeof import("./gateway-select")
  ).selectSandboxOwningGateway(sandboxName);
}

// Test seams for execSandbox. All default to the production behavior; tests
// inject them so the dispatch path stays hermetic without spawning a real
// process or hitting the process-exiting OpenShell binary lookup.
export type ExecSandboxDeps = {
  /** Typed command execution and pre-dispatch workdir observation. */
  commandExecutor?: OpenShellSandboxCommandExecutor;
  /** Post-command observability and cleanup seams. */
  policyHint?: ExecPolicyHintDeps;
  cleanupDeps?: SandboxExecCleanupDeps;
  /** Activate config written by a successful direct Google Chat pairing approval. */
  restartGateway?: SandboxExecGatewayRestart;
  /** Resolve the sandbox's recorded agent before applying agent-specific post-exec effects. */
  resolveSandboxAgent?: SandboxExecAgentResolver;
  /** Select the sandbox's owning gateway before the exec talks to OpenShell. */
  selectGateway?: (sandboxName: string) => GatewaySelectResult;
  /** Defer terminal process exit until an outer lifecycle lock is released. */
  exit?: (code: number) => never;
};

async function runSandboxExecRequest(
  executor: OpenShellSandboxCommandExecutor,
  request: OpenShellSandboxCommandRequest,
  cleanupDeps: SandboxExecCleanupDeps,
): Promise<SandboxExecCompletion> {
  let completed: Awaited<ReturnType<OpenShellSandboxCommandExecutor["runStreaming"]>>;
  try {
    completed = await executor.runStreaming(request);
  } catch (error) {
    completed = {
      outcome: {
        kind: "failed",
        error: {
          kind: "invocation",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      release: () => {},
    };
  }
  try {
    const commandCode = completed.outcome.kind === "completed" ? completed.outcome.exitCode : 1;
    const invocationError =
      completed.outcome.kind === "failed" ? completed.outcome.error.message : undefined;
    const cleanupError = cleanupOpenClawAfterExec(request.sandboxName, cleanupDeps) ?? undefined;
    return {
      code: cleanupError ? 1 : commandCode,
      commandCode,
      ...(invocationError ? { invocationError } : {}),
      ...(cleanupError ? { cleanupError } : {}),
    };
  } finally {
    completed.release();
  }
}

export function isGoogleChatPairingApproval(command: readonly string[]): boolean {
  return (
    command.length >= 5 &&
    command[0] === "openclaw" &&
    command[1] === "pairing" &&
    command[2] === "approve" &&
    command[3] === "googlechat" &&
    Boolean(command[4]) &&
    !command[4]!.startsWith("-")
  );
}

function defaultRestartGateway(sandboxName: string): { ok: boolean } {
  const { defaultInferenceGatewayRestart } =
    require("../inference-set-gateway-restart") as typeof import("../inference-set-gateway-restart");
  return defaultInferenceGatewayRestart(sandboxName);
}

function defaultResolveSandboxAgent(sandboxName: string): string | null {
  const entry = (
    require("../../state/registry") as typeof import("../../state/registry")
  ).getSandbox(sandboxName);
  if (!entry) return null;
  return entry.agent ?? "openclaw";
}

function googleChatPairingActivationFailureMessage(cliName: string, sandboxName: string): string {
  return (
    `  Google Chat pairing approval committed for '${sandboxName}', but managed gateway activation failed. ` +
    `The approval was not rolled back. Run '${cliName} ${sandboxName} gateway restart' before testing the next message.`
  );
}

function googleChatPairingUnmanagedCleanupFailureMessage(sandboxName: string): string {
  return (
    `  Google Chat pairing approval committed for '${sandboxName}', but post-command cleanup failed. ` +
    "The approval was not rolled back. No owning managed gateway is registered, so NemoClaw did not attempt gateway activation."
  );
}

export async function execSandbox(
  sandboxName: string,
  command: readonly string[],
  options: SandboxExecOptions = {},
  deps: ExecSandboxDeps = {},
): Promise<void> {
  const { CLI_NAME } = require("../../cli/branding");
  const exit = deps.exit ?? process.exit;
  if (command.length === 0) {
    console.error(
      `  Usage: ${CLI_NAME} ${sandboxName} exec [--workdir <dir>] [--tty|--no-tty] [--timeout <s>] [--stdin|--no-stdin] -- <cmd> [args...]`,
    );
    exit(2);
  }
  const inputError = execInputError(command, options.workdir);
  if (inputError) {
    console.error(inputError);
    exit(2);
  }
  try {
    assertNoOpenShellGatewayEndpointOverride();
  } catch (error) {
    console.error(`  Error: ${error instanceof Error ? error.message : String(error)}`);
    exit(1);
  }
  const gatewaySelection = (deps.selectGateway ?? defaultSelectGateway)(sandboxName);
  if (gatewaySelection.outcome === "failed") {
    console.error(
      `  Failed to select gateway '${gatewaySelection.gatewayName}' for sandbox '${sandboxName}'.`,
    );
    exit(1);
  }
  const gatewayName =
    gatewaySelection.outcome === "selected" ? gatewaySelection.gatewayName : undefined;
  const target = gatewayName ? namedOpenShellGateway(gatewayName) : selectedOpenShellGateway();
  const commandExecutor = deps.commandExecutor ?? createCliOpenShellSandboxCommandExecutor();
  if (options.workdir) {
    let workdir: Awaited<ReturnType<OpenShellSandboxCommandExecutor["probeDirectory"]>>;
    try {
      workdir = await commandExecutor.probeDirectory({
        sandboxName,
        target,
        path: options.workdir,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`  Failed to invoke openshell: ${detail}`);
      console.error("  Ensure 'openshell' is installed and on PATH.");
      return exit(1);
    }
    if (workdir.state === "missing") {
      console.error(workdirMissingMessage(options.workdir));
      exit(1);
    }
  }
  const emitPolicyDenialHint = preparePolicyHint(
    CLI_NAME,
    sandboxName,
    command,
    deps.policyHint,
    gatewayName,
  );
  const completion = await runSandboxExecRequest(
    commandExecutor,
    {
      sandboxName,
      target,
      command: wrapExecCommandWithRuntimeEnv(command),
      workdir: options.workdir,
      tty: options.tty,
      timeoutSeconds: options.timeoutSeconds,
      stdin: options.stdin,
    },
    deps.cleanupDeps ?? {
      getSandbox: (name) =>
        (require("../../state/registry") as typeof import("../../state/registry")).getSandbox(name),
      inspectMutableConfigPerms: (name) =>
        (
          require("../../sandbox/mutable-config-perms") as typeof import("../../sandbox/mutable-config-perms")
        ).inspectMutableConfigPerms(name),
      repairMutableConfigPerms: (name) =>
        (
          require("../../sandbox/mutable-config-perms") as typeof import("../../sandbox/mutable-config-perms")
        ).repairMutableConfigPerms(name),
    },
  );
  if (completion.invocationError) {
    console.error(`  Failed to invoke openshell: ${completion.invocationError}`);
    console.error("  Ensure 'openshell' is installed and on PATH.");
  }
  if (completion.cleanupError) {
    console.error(cleanupFailureMessage(completion.commandCode, completion.cleanupError));
  }
  await emitPolicyDenialHint(completion);
  let exitCode = completion.code;
  const googleChatApprovalCommitted =
    completion.commandCode === 0 && isGoogleChatPairingApproval(command);
  const managedGoogleChatApproval =
    googleChatApprovalCommitted && gatewaySelection.outcome === "selected";
  if (googleChatApprovalCommitted && completion.cleanupError) {
    console.error(
      managedGoogleChatApproval
        ? googleChatPairingActivationFailureMessage(CLI_NAME, sandboxName)
        : googleChatPairingUnmanagedCleanupFailureMessage(sandboxName),
    );
  }
  if (exitCode === 0 && managedGoogleChatApproval) {
    let recordedAgent: string | null = null;
    try {
      recordedAgent = (deps.resolveSandboxAgent ?? defaultResolveSandboxAgent)(sandboxName);
    } catch {
      console.error(googleChatPairingActivationFailureMessage(CLI_NAME, sandboxName));
      exit(1);
    }
    if (recordedAgent === "openclaw") {
      let restartSucceeded = false;
      try {
        restartSucceeded = (deps.restartGateway ?? defaultRestartGateway)(sandboxName).ok;
      } catch {
        // The approval already committed inside OpenClaw. Convert restart
        // exceptions into the same explicit partial-commit recovery contract.
      }
      if (!restartSucceeded) {
        console.error(googleChatPairingActivationFailureMessage(CLI_NAME, sandboxName));
        exitCode = 1;
      }
    }
  }
  exit(exitCode);
}
