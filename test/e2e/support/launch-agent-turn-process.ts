// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import { superviseChild } from "../../helpers/process-supervisor.ts";

export async function runLaunchCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 15_000,
) {
  let stderr = "";
  let stdout = "";
  const child = spawn(command, args, { detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
  const result = await superviseChild(child, {
    killGraceMs: 1_000,
    onStderr: (chunk) => (stderr += chunk),
    onStdout: (chunk) => (stdout += chunk),
    timeoutMs,
  });
  return {
    signal: result.signal,
    status: result.exitCode,
    stderr,
    stdout,
    timedOut: result.timedOut,
  };
}
