// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { spawnExitCode } from "../../core/process-exit";
import type {
  MutableConfigPermsInspection,
  MutableConfigRepairResult,
} from "../../shields/mutable-config-perms";
import type { SandboxEntry } from "../../state/registry";

export type SandboxExecOptions = {
  workdir?: string;
  tty?: boolean | null;
  timeoutSeconds?: number;
};

type SpawnLikeResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  releaseSignals?: () => void;
};

export type SandboxExecRunner = (
  binary: string,
  args: readonly string[],
) => SpawnLikeResult | Promise<SpawnLikeResult>;

export type SandboxExecChild = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal: NodeJS.Signals) => boolean;
  once: {
    (event: "error", listener: (error: Error) => void): unknown;
    (
      event: "close",
      listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ): unknown;
  };
};

export type SandboxExecSpawner = (binary: string, args: readonly string[]) => SandboxExecChild;

export type SandboxExecSignalSource = {
  add: (signal: "SIGTERM" | "SIGINT", listener: () => void) => void;
  remove: (signal: "SIGTERM" | "SIGINT", listener: () => void) => void;
};

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

export type WorkdirProbeResult = {
  status: number | null;
  error?: Error;
};

export type WorkdirProbeOutcome = "ok" | "missing" | "unclear";

export type WorkdirProbeRunner = (binary: string, args: readonly string[]) => WorkdirProbeResult;

export function buildOpenshellExecArgs(
  sandboxName: string,
  command: readonly string[],
  options: SandboxExecOptions = {},
): string[] {
  const argv = ["sandbox", "exec", "--name", sandboxName];
  if (options.workdir) argv.push("--workdir", options.workdir);
  if (options.tty === true) argv.push("--tty");
  if (options.tty === false) argv.push("--no-tty");
  if (typeof options.timeoutSeconds === "number") {
    argv.push("--timeout", String(options.timeoutSeconds));
  }
  argv.push("--", ...command);
  return argv;
}

export function buildWorkdirProbeArgs(sandboxName: string, workdir: string): string[] {
  return ["sandbox", "exec", "--name", sandboxName, "--", "test", "-d", workdir];
}

// OpenShell's `sandbox exec` rejects any argv element that contains a newline
// or carriage return ("command argument N contains newline or carriage return
// characters"). Multi-line commands such as heredocs therefore fail with a
// low-level InvalidArgument error that gives the reporter no NemoClaw-specific
// recovery path (#5980). We detect the offending argument before dispatch and
// fail with actionable guidance instead.
//
// Source-of-truth for this guard:
//   - Invalid state: OpenShell's exec endpoint returns InvalidArgument for any
//     argv element containing \r or \n.
//   - Source boundary: the limitation lives in the external OpenShell
//     `sandbox exec` argv contract, not in NemoClaw. We cannot fix it at the
//     source from this repo, so the guard is a deliberately localized
//     translation of that constraint into actionable NemoClaw guidance.
//   - Regression coverage: `findMultilineExecArg`, `multilineExecMessage`, and
//     the `execSandbox multi-line guard (#5980)` suite in exec.test.ts.
//   - Removal condition: if a future OpenShell release accepts multi-line argv
//     elements (tracked upstream in NVIDIA/OpenShell#2110), this guard and the
//     matching docs notice in docs/reference/commands.mdx +
//     commands-nemohermes.mdx become unnecessary and should be removed together.
//
// The pattern is intentionally limited to \r and \n: OpenShell rejects only
// "newline or carriage return characters", so Unicode line separators (U+2028
// LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR) are valid argv that OpenShell
// accepts. Broadening the pattern to those code points would reject commands
// OpenShell would otherwise run, so the guard deliberately mirrors OpenShell's
// exact constraint rather than a general "line break" notion.
const MULTILINE_ARG_PATTERN = /[\r\n]/;

/** @internal Exported for unit testing only; not part of the public API. */
export function findMultilineExecArg(command: readonly string[]): number {
  for (let index = 0; index < command.length; index += 1) {
    if (MULTILINE_ARG_PATTERN.test(command[index])) return index;
  }
  return -1;
}

// Describe the offending argument WITHOUT echoing its contents: a multi-line
// value can carry pasted secrets, env files, or private-key material, and
// printing even a truncated preview risks persisting it in terminal or CI logs.
// The 1-based position plus a neutral size description is enough for the user
// to find the argument they typed.
function describeMultilineArg(arg: string): string {
  // Split on all three newline conventions (CRLF, bare CR, bare LF) so the
  // count matches what a user sees regardless of platform. The alternation is
  // ordered CRLF-first so a Windows "\r\n" counts as one break, not two. A
  // single trailing break still yields a count of 2 (the empty final segment),
  // which is correct: a lone "\r" argument spans two lines.
  const lineCount = arg.split(/\r\n|\r|\n/).length;
  const charLabel = arg.length === 1 ? "character" : "characters";
  const lineLabel = lineCount === 1 ? "line" : "lines";
  return `${arg.length} ${charLabel} spanning ${lineCount} ${lineLabel}`;
}

export function multilineExecMessage(
  cliName: string,
  sandboxName: string,
  command: readonly string[],
  index: number,
): string {
  // Report a 1-based position within the user command (the args after `--`).
  const position = index + 1;
  return [
    `error: command argument ${position} (${describeMultilineArg(command[index])}) contains a newline or carriage return, which OpenShell exec does not accept.`,
    "Multi-line commands (for example heredocs) cannot be passed through exec argv. Instead:",
    `  - join statements with semicolons: ${cliName} ${sandboxName} exec -- bash -lc "cmd1; cmd2"`,
    `  - pipe the script into the sandbox shell over stdin: printf 'cmd1\\ncmd2\\n' | ${cliName} ${sandboxName} exec -- bash`,
    `  - or write the script to a file in the sandbox and run it: ${cliName} ${sandboxName} exec -- bash <script-path>`,
  ].join("\n");
}

export function workdirMissingMessage(workdir: string): string {
  return `error: --workdir: ${workdir} does not exist inside the sandbox`;
}

export function evaluateWorkdirProbe(probe: WorkdirProbeResult): WorkdirProbeOutcome {
  if (probe.error) return "unclear";
  if (probe.status === 0) return "ok";
  if (probe.status === 1) return "missing";
  return "unclear";
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
    if (result.skipReason === "locked") return null;
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
 * Each production inspect/repair call takes the cross-process, timer-bound
 * shields transition lock and rechecks posture while holding it. The repair is
 * idempotent, so two CLI processes may interleave only between those protected
 * steps: they can repeat a repair or make one caller report conservative drift,
 * but host-side repair mutations cannot overlap or weaken shields-up. A
 * process-local mutex would not serialize separate CLI invocations, while a
 * lock inside the sandbox-owned config tree would put lock authority on the
 * wrong trust side.
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
    if (verification.skipReason === "locked") return null;
    return `post-repair permission verification unavailable: ${verification.reason}`;
  }
  if (!verification.ok) {
    return `post-repair permission verification failed: ${verification.issues.join("; ")}`;
  }
  return null;
}

const defaultSandboxExecSpawner: SandboxExecSpawner = (binary, args) =>
  spawn(binary, [...args], { stdio: "inherit" });

const defaultSandboxExecSignalSource: SandboxExecSignalSource = {
  add: (signal, listener) => process.on(signal, listener),
  remove: (signal, listener) => process.off(signal, listener),
};

export async function runSandboxExecChild(
  binary: string,
  args: readonly string[],
  spawnChild: SandboxExecSpawner = defaultSandboxExecSpawner,
  signalSource: SandboxExecSignalSource = defaultSandboxExecSignalSource,
): Promise<SpawnLikeResult> {
  let child: SandboxExecChild;
  try {
    child = spawnChild(binary, args);
  } catch (error) {
    return { status: null, error: error instanceof Error ? error : new Error(String(error)) };
  }

  return new Promise((resolve) => {
    let spawnError: Error | undefined;
    const forwardTerm = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    // A terminal Ctrl+C is already delivered to every member of the foreground
    // process group, including the non-detached OpenShell child. Hold SIGINT in
    // the parent without re-sending it so one Ctrl+C stays one child signal and
    // cleanup can finish. Headless/PID-targeted cancellation must use TERM;
    // distinguishing its signal origin would require out-of-scope process-group
    // or native siginfo machinery.
    const holdInt = () => {};
    signalSource.add("SIGTERM", forwardTerm);
    signalSource.add("SIGINT", holdInt);
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (status, signal) => {
      resolve({
        status,
        signal,
        ...(spawnError ? { error: spawnError } : {}),
        // Keep handlers installed through host-side permission cleanup. Once
        // the child is reaped they suppress termination without forwarding.
        releaseSignals: () => {
          signalSource.remove("SIGTERM", forwardTerm);
          signalSource.remove("SIGINT", holdInt);
        },
      });
    });
  });
}

export async function runSandboxExecCommand(
  binary: string,
  sandboxName: string,
  command: readonly string[],
  options: SandboxExecOptions,
  run: SandboxExecRunner,
  cleanupDeps: SandboxExecCleanupDeps,
): Promise<SandboxExecCompletion> {
  let result: SpawnLikeResult;
  try {
    result = await run(binary, buildOpenshellExecArgs(sandboxName, command, options));
  } catch (error) {
    result = { status: null, error: error instanceof Error ? error : new Error(String(error)) };
  }
  try {
    const { code: commandCode, errorMessage: invocationError } = computeExitCode(result);
    const cleanupError = cleanupOpenClawAfterExec(sandboxName, cleanupDeps) ?? undefined;
    return {
      code: cleanupError ? 1 : commandCode,
      commandCode,
      ...(invocationError ? { invocationError } : {}),
      ...(cleanupError ? { cleanupError } : {}),
    };
  } finally {
    result.releaseSignals?.();
  }
}

export function cleanupFailureMessage(commandCode: number, detail: string): string {
  return `  OpenClaw permission cleanup failed (command exit ${commandCode}; cleanup exit 1): ${detail}`;
}

const defaultWorkdirProbeRunner: WorkdirProbeRunner = (binary, args) => {
  const probe = spawnSync(binary, args, { stdio: ["ignore", "ignore", "ignore"] });
  return { status: probe.status, error: probe.error };
};

export function validateWorkdirOrFail(
  binary: string,
  sandboxName: string,
  workdir: string,
  run: WorkdirProbeRunner = defaultWorkdirProbeRunner,
): void {
  const outcome = evaluateWorkdirProbe(run(binary, buildWorkdirProbeArgs(sandboxName, workdir)));
  if (outcome === "missing") {
    console.error(workdirMissingMessage(workdir));
    process.exit(1);
  }
}

function defaultResolveBinary(): string {
  const { getOpenshellBinary } = require("../../adapters/openshell/runtime");
  return getOpenshellBinary();
}

// Test seams for execSandbox. All default to the production behavior; tests
// inject them so the dispatch path stays hermetic without spawning a real
// process or hitting the process-exiting OpenShell binary lookup.
export type ExecSandboxDeps = {
  resolveBinary?: () => string;
  probeWorkdir?: WorkdirProbeRunner;
  run?: SandboxExecRunner;
};

export async function execSandbox(
  sandboxName: string,
  command: readonly string[],
  options: SandboxExecOptions = {},
  deps: ExecSandboxDeps = {},
): Promise<void> {
  const { CLI_NAME } = require("../../cli/branding");
  if (command.length === 0) {
    console.error(
      `  Usage: ${CLI_NAME} ${sandboxName} exec [--workdir <dir>] [--tty|--no-tty] [--timeout <s>] -- <cmd> [args...]`,
    );
    process.exit(2);
  }
  const multilineIndex = findMultilineExecArg(command);
  if (multilineIndex !== -1) {
    console.error(multilineExecMessage(CLI_NAME, sandboxName, command, multilineIndex));
    process.exit(2);
  }
  const binary = (deps.resolveBinary ?? defaultResolveBinary)();
  if (options.workdir) {
    validateWorkdirOrFail(binary, sandboxName, options.workdir, deps.probeWorkdir);
  }
  const completion = await runSandboxExecCommand(
    binary,
    sandboxName,
    command,
    options,
    deps.run ?? runSandboxExecChild,
    {
      getSandbox: (name) =>
        (require("../../state/registry") as typeof import("../../state/registry")).getSandbox(name),
      inspectMutableConfigPerms: (name) =>
        (require("../../shields") as typeof import("../../shields")).inspectMutableConfigPerms(
          name,
        ),
      repairMutableConfigPerms: (name) =>
        (require("../../shields") as typeof import("../../shields")).repairMutableConfigPerms(name),
    },
  );
  if (completion.invocationError) {
    console.error(`  Failed to invoke openshell: ${completion.invocationError}`);
    console.error("  Ensure 'openshell' is installed and on PATH.");
  }
  if (completion.cleanupError) {
    console.error(cleanupFailureMessage(completion.commandCode, completion.cleanupError));
  }
  process.exit(completion.code);
}
