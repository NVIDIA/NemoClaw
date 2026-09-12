// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { superviseChild } from "../../helpers/process-supervisor.ts";

export function cleanLaunchState(
  fixtureRoot: string,
  baselinePath: string,
  ptyMonitorRoot: string,
) {
  rmSync(baselinePath, { force: true });
  rmSync(`${baselinePath}.tmp`, { force: true });
  rmSync(ptyMonitorRoot, { force: true, recursive: true });
  for (const name of readdirSync(fixtureRoot).filter((entry) =>
    entry.startsWith("nemoclaw-launch-host."),
  ))
    rmSync(join(fixtureRoot, name), { force: true, recursive: true });
  return (
    !existsSync(baselinePath) &&
    !existsSync(ptyMonitorRoot) &&
    !readdirSync(fixtureRoot).some((name) => name.startsWith("nemoclaw-launch-host."))
  );
}

export async function runLaunchCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: {
    onTimeout?: () => boolean;
    timeoutMs?: number;
  } = {},
) {
  let stderr = "";
  let stdout = "";
  const child = spawn(command, args, { detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
  const result = await superviseChild(child, {
    killGraceMs: 1_000,
    onStderr: (chunk) => (stderr += chunk),
    onStdout: (chunk) => (stdout += chunk),
    timeoutMs: options.timeoutMs ?? 15_000,
  });
  const ownedStateRemoved = result.timedOut ? options.onTimeout?.() : undefined;
  return {
    signal: result.signal,
    status: result.exitCode,
    stderr,
    stdout,
    timedOut: result.timedOut,
    ownedStateRemoved,
  };
}
