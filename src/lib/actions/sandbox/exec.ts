// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import os from "node:os";

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

export function computeExitCode(result: SpawnLikeResult): {
  code: number;
  errorMessage?: string;
} {
  if (result.error) {
    return { code: 1, errorMessage: result.error.message };
  }
  if (result.status !== null) return { code: result.status };
  if (result.signal) {
    const signalNumber = os.constants.signals[result.signal];
    return { code: signalNumber ? 128 + signalNumber : 1 };
  }
  return { code: 1 };
}

function exitWithSpawnResult(result: SpawnLikeResult): never {
  const { code, errorMessage } = computeExitCode(result);
  if (errorMessage) {
    console.error(`  Failed to invoke openshell: ${errorMessage}`);
    console.error("  Ensure 'openshell' is installed and on PATH.");
  }
  process.exit(code);
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
  const result = spawnSync(
    getOpenshellBinary(),
    buildOpenshellExecArgs(sandboxName, command, options),
    { stdio: "inherit" },
  );
  exitWithSpawnResult(result);
}
