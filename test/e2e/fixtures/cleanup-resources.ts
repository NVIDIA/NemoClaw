// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { assertExitZero, type CommandExitResult, resultText } from "./clients/command.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { ShellProbeRunOptions } from "./shell-probe.ts";

type CleanupRun = () => Promise<void> | void;

export function assertCleanupSucceededOrAbsent(
  result: CommandExitResult,
  absent: boolean | RegExp,
  label: string,
): void {
  const alreadyAbsent = typeof absent === "boolean" ? absent : absent.test(resultText(result));
  if (result.exitCode === 0 || alreadyAbsent) return;
  assertExitZero(result, label);
}

export async function cleanupAcquiredResource(
  acquired: boolean,
  cleanup: CleanupRun,
): Promise<void> {
  if (acquired) await cleanup();
}

export async function cleanupExistingPath(pathname: string, cleanup: CleanupRun): Promise<void> {
  if (fs.existsSync(pathname)) await cleanup();
}

export async function cleanupUnlessVerified(
  cleanupVerified: boolean,
  cleanup: CleanupRun,
): Promise<void> {
  if (!cleanupVerified) await cleanup();
}

export async function cleanupWhenCommandAvailable(
  host: Pick<HostCliClient, "isCommandAvailable">,
  command: string,
  probeOptions: ShellProbeRunOptions,
  cleanup: CleanupRun,
): Promise<void> {
  if (!(await host.isCommandAvailable(command, probeOptions))) return;
  await cleanup();
}

export async function cleanupWhenOpenShellAvailable(
  host: Pick<HostCliClient, "isCommandAvailable" | "openshellCommandPath">,
  probeOptions: ShellProbeRunOptions,
  cleanup: CleanupRun,
): Promise<void> {
  await cleanupWhenCommandAvailable(host, host.openshellCommandPath, probeOptions, cleanup);
}

export function registerSandboxCleanupUnlessKept(keepSandbox: boolean, register: () => void): void {
  if (keepSandbox) return;
  register();
}

export function terminateProcessIfRunning(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
}
