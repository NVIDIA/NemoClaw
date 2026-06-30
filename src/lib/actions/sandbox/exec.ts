// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { spawnExitCode } from "../../core/process-exit";

export type SandboxExecOptions = {
  workdir?: string;
  tty?: boolean | null;
  timeoutSeconds?: number;
};

type SpawnLikeResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
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
//     elements, this guard and the matching docs notice in
//     docs/reference/commands.mdx + commands-nemohermes.mdx become unnecessary
//     and should be removed together.
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

export type SandboxExecRunner = (binary: string, args: readonly string[]) => SpawnLikeResult;

const defaultExecRunner: SandboxExecRunner = (binary, args) =>
  spawnSync(binary, args, { stdio: "inherit" });

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
  const run = deps.run ?? defaultExecRunner;
  const result = run(binary, buildOpenshellExecArgs(sandboxName, command, options));
  const { code, errorMessage } = computeExitCode(result);
  if (errorMessage) {
    console.error(`  Failed to invoke openshell: ${errorMessage}`);
    console.error("  Ensure 'openshell' is installed and on PATH.");
  }
  process.exit(code);
}
