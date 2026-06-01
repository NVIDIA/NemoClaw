// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { bestEffortForwardStopForSandbox } from "./forward-cleanup";
import {
  buildDetachedForwardStartSpawn,
  buildForwardStartProgressLogger,
  runDetachedForwardStartWithPortReleaseRetries,
} from "./forward-start";

type CommandResult = { status: number | null };

export interface AgentFixedForwardDeps {
  runOpenshell(args: string[], opts?: Record<string, unknown>): CommandResult;
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string | null;
  openshellArgv(args: string[]): string[];
  cliName(): string;
  sleep(seconds: number): void;
}

export function ensureAgentFixedForward(
  deps: AgentFixedForwardDeps,
  sandboxName: string,
  port: number,
  label: string,
): boolean {
  const forwardTarget = String(port);
  const stopForwardForSandbox = (portToStop: string | number) =>
    bestEffortForwardStopForSandbox(
      deps.runOpenshell,
      (args, opts) => (deps.runCaptureOpenshell(args, opts) ?? "") as string,
      portToStop,
      sandboxName,
    );

  stopForwardForSandbox(port);
  const { ok, diagnostic } = runDetachedForwardStartWithPortReleaseRetries(
    buildDetachedForwardStartSpawn(
      deps.openshellArgv(["forward", "start", "--background", forwardTarget, sandboxName]),
    ),
    () =>
      (deps.runCaptureOpenshell(["forward", "list"], { timeout: OPENSHELL_PROBE_TIMEOUT_MS }) ?? "") as string,
    { port, sandboxName },
    () => {
      deps.sleep(1);
      stopForwardForSandbox(port);
    },
    { onProgress: buildForwardStartProgressLogger(port) },
  );
  if (!ok) {
    console.warn(
      `! ${label} forward on port ${port} did not start: ${diagnostic.slice(0, 240)}`,
    );
    console.warn(`  Reconnect after resolving the issue: ${deps.cliName()} ${sandboxName} connect`);
    return false;
  }
  return true;
}
