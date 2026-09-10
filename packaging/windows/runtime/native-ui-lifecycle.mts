// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type GatewayState = Pick<ChildProcess, "exitCode" | "signalCode">;
type StateLease = { assertHeld(): void };
type CleanupStep = readonly [label: string, action: () => unknown];

// The workload's receipt precedes its process exit. Wait for the MXC executor
// itself to finish teardown before deletion can terminate its process monitor.
export async function waitForNativeMxcCompletion(
  openshell: string,
  environment: NodeJS.ProcessEnv,
  sandboxName: string,
  gateway: GatewayState,
  stateSession: StateLease | null,
  timeout = 45_000,
): Promise<"AgentCompleted" | "ExecFailed"> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    stateSession?.assertHeld();
    if (gateway.exitCode !== null || gateway.signalCode !== null)
      throw new Error("The native gateway stopped before MXC execution cleanup completed.");
    const result = await execFileAsync(openshell, ["sandbox", "get", sandboxName, "-o", "json"], {
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      timeout: Math.min(10_000, Math.max(1, deadline - Date.now())),
      maxBuffer: 1024 * 1024,
    });
    const status: unknown = JSON.parse(result.stdout);
    if (
      typeof status !== "object" ||
      status === null ||
      !("name" in status) ||
      status.name !== sandboxName ||
      !("phase" in status) ||
      typeof status.phase !== "string"
    )
      throw new Error("The MXC cleanup status did not match the owned sandbox.");
    const condition = "ready_condition" in status ? status.ready_condition : null;
    if (
      condition !== null &&
      typeof condition === "object" &&
      "status" in condition &&
      "reason" in condition
    ) {
      if (
        status.phase === "Ready" &&
        condition.status === "True" &&
        condition.reason === "AgentCompleted"
      )
        return "AgentCompleted";
      if (
        status.phase === "Error" &&
        condition.status === "False" &&
        condition.reason === "ExecFailed"
      )
        return "ExecFailed";
    }
    if (["Error", "Stopped", "Stopping", "Deleting"].includes(status.phase))
      throw new Error("MXC stopped without confirming execution cleanup.");
    await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error("The native MXC executor did not finish cleanup before its deadline.");
}

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
