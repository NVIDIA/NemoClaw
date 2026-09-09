// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type GatewayState = Pick<ChildProcess, "exitCode" | "signalCode">;
type StateLease = { assertHeld(): void };
type CleanupStep = readonly [label: string, action: () => unknown];

export async function watchNativeUiSandbox(
  openshell: string,
  environment: NodeJS.ProcessEnv,
  sandboxName: string,
  gateway: GatewayState,
  stateSession: StateLease | null,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    stateSession?.assertHeld();
    if (gateway.exitCode !== null || gateway.signalCode !== null)
      throw new Error("The OpenShell gateway stopped while the agent Web UI was open.");
    let status: unknown;
    try {
      const result = await execFileAsync(openshell, ["sandbox", "get", sandboxName, "-o", "json"], {
        env: environment,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        signal,
      });
      status = JSON.parse(result.stdout);
    } catch {
      if (signal.aborted) return;
      throw new Error("The running OpenClaw sandbox could not be confirmed.");
    }
    if (
      typeof status !== "object" ||
      status === null ||
      !("name" in status) ||
      status.name !== sandboxName ||
      !("phase" in status) ||
      typeof status.phase !== "string" ||
      ["Error", "Stopped", "Stopping", "Deleting"].includes(status.phase)
    )
      throw new Error("The contained OpenClaw session stopped while its Web UI was open.");
    for (let elapsed = 0; elapsed < 5000 && !signal.aborted; elapsed += 100) await sleep(100);
  }
}

export async function attemptNativeUiCleanup(steps: readonly CleanupStep[]): Promise<string[]> {
  const failed: string[] = [];
  for (const [label, action] of steps) {
    try {
      await action();
    } catch {
      failed.push(label);
    }
  }
  return failed;
}
