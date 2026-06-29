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

export async function execSandbox(
  sandboxName: string,
  command: readonly string[],
  options: SandboxExecOptions = {},
): Promise<void> {
  const { CLI_NAME } = require("../../cli/branding");
  const { getOpenshellBinary } = require("../../adapters/openshell/runtime");
  if (command.length === 0) {
    console.error(
      `  Usage: ${CLI_NAME} ${sandboxName} exec [--workdir <dir>] [--tty|--no-tty] [--timeout <s>] -- <cmd> [args...]`,
    );
    process.exit(2);
  }
  const binary = getOpenshellBinary();
  if (options.workdir) {
    validateWorkdirOrFail(binary, sandboxName, options.workdir);
  }
  const result = spawnSync(binary, buildOpenshellExecArgs(sandboxName, command, options), {
    stdio: "inherit",
  });
  const { code, errorMessage } = computeExitCode(result);
  if (errorMessage) {
    console.error(`  Failed to invoke openshell: ${errorMessage}`);
    console.error("  Ensure 'openshell' is installed and on PATH.");
  }
  process.exit(code);
}
