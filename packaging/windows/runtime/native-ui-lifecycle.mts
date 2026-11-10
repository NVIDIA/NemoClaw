// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { run } from "./native-command.mts";

type GatewayState = Pick<ChildProcess, "exitCode" | "signalCode">;
type StateLease = { assertHeld(): void };
type CleanupStep = readonly [label: string, action: () => unknown];
type MxcCompletion = "AgentCompleted" | "ExecFailed" | "MainProcessCompleted" | "MainProcessFailed";

export function observeNativeSandboxCreation(child: ChildProcess) {
  let rejected = false;
  let stderr = "";
  const capture = (chunk: Buffer | string) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  };
  child.stderr?.on("data", capture);
  const failure = new Promise<never>((_, reject) => {
    child.once("error", () => {
      rejected = child.pid === undefined;
      reject(new Error("The OpenShell sandbox request could not run."));
    });
    const closed = (code: number | null, signal: NodeJS.Signals | null) => {
      child.stderr?.removeListener("data", capture);
      if (code === 0 && signal === null) return;
      // Only this explicit server rejection is definitive. Transport errors and
      // interrupted requests still require the ordinary cleanup/reconciliation path.
      rejected ||=
        signal === null &&
        !child.killed &&
        code !== null &&
        code !== 0 &&
        stderr.includes("code: 'Client specified an invalid argument', message:");
      reject(
        new Error(
          `OpenShell sandbox creation failed (${code ?? signal ?? "unknown"}) before UI readiness.`,
        ),
      );
    };
    child.once("close", closed);
    if (child.exitCode !== null || child.signalCode !== null)
      closed(child.exitCode, child.signalCode);
  });
  void failure.catch(() => {});
  return { failure, wasRejected: () => rejected };
}

// Long-running UI sessions terminate through deletion, not natural process exit.
// The caller must still stop its request watcher and confirm registry absence.
export async function requestNativeUiSandboxDeletion(
  openshell: string,
  environment: NodeJS.ProcessEnv,
  ownership: {
    sandboxName: string;
    gateway: GatewayState | null | undefined;
    stateSession: StateLease | null;
    creationRejected?: boolean;
  },
  ownProcess: (child: ChildProcess) => void,
) {
  const assertOwnership = () => {
    ownership.stateSession?.assertHeld();
    if (
      !ownership.gateway ||
      ownership.gateway.exitCode !== null ||
      ownership.gateway.signalCode !== null
    )
      throw new Error("The native gateway stopped before sandbox deletion was confirmed.");
  };
  assertOwnership();
  if (ownership.creationRejected) {
    await confirmNativeUiRegistryEmpty(openshell, environment, undefined, ownProcess);
  } else {
    try {
      await run(
        openshell,
        ["sandbox", "delete", ownership.sandboxName],
        environment,
        "Deleting the native UI sandbox",
        30_000,
        undefined,
        ownProcess,
        { quiet: true },
      );
    } catch {
      // A failed response can follow an accepted mutation. Do not repeat it.
      throw new Error("The native sandbox deletion request could not be confirmed.");
    }
  }
  assertOwnership();
}

export async function confirmNativeUiRegistryEmpty(
  openshell: string,
  environment: NodeJS.ProcessEnv,
  removal:
    | {
        sandboxName: string;
        gateway: GatewayState | null | undefined;
        stateSession: StateLease | null;
        timeout?: number;
      }
    | undefined,
  ownProcess: (child: ChildProcess) => void,
) {
  const timeout = removal?.timeout ?? (removal ? 30_000 : 10_000);
  const deadlineFailure = () =>
    new Error("The private UI gateway registry was not empty before its deadline.");
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 30_000) throw deadlineFailure();
  const deadline = Date.now() + timeout;
  const assertOwnership = () => {
    if (!removal) return;
    removal.stateSession?.assertHeld();
    if (
      !removal.gateway ||
      removal.gateway.exitCode !== null ||
      removal.gateway.signalCode !== null
    )
      throw new Error("The native gateway stopped before sandbox removal was confirmed.");
  };
  while (Date.now() < deadline) {
    assertOwnership();
    let registry: unknown;
    try {
      const result = await run(
        openshell,
        ["sandbox", "list", "-o", "json"],
        environment,
        "Reading the native UI registry",
        Math.min(10_000, Math.max(1, deadline - Date.now())),
        undefined,
        ownProcess,
        { quiet: true },
      );
      registry = JSON.parse(result.stdout);
    } catch {
      if (Date.now() >= deadline) throw deadlineFailure();
      throw new Error("The private UI gateway registry could not be read.");
    }
    assertOwnership();
    if (Date.now() >= deadline) throw deadlineFailure();
    // Newer CLI versions wrap the collection in a paginated envelope. An empty
    // first page cannot prove absence if another page remains unexamined.
    if (
      registry !== null &&
      typeof registry === "object" &&
      !Array.isArray(registry) &&
      "sandboxes" in registry &&
      "next_page_token" in registry &&
      registry.next_page_token === ""
    )
      registry = registry.sandboxes;
    if (Array.isArray(registry) && registry.length === 0) return;
    // Only an accepted deletion of this session's sandbox may still be pending.
    // Do not retry mutations, failed reads, unexpected entries or rejected creates.
    if (
      !removal ||
      !Array.isArray(registry) ||
      registry.length !== 1 ||
      registry[0] === null ||
      typeof registry[0] !== "object" ||
      registry[0].name !== removal.sandboxName ||
      registry[0].phase !== "Deleting"
    )
      throw new Error("The private UI gateway registry is not confirmed empty.");
    await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw deadlineFailure();
}

export function nativeMxcCompletion(status: unknown, sandboxName: string): MxcCompletion | null {
  if (
    typeof status !== "object" ||
    status === null ||
    !("name" in status) ||
    status.name !== sandboxName ||
    !("phase" in status) ||
    typeof status.phase !== "string"
  )
    throw new Error("The MXC cleanup status did not match the owned sandbox.");
  let condition: unknown = null;
  if ("conditions" in status) {
    if (!Array.isArray(status.conditions))
      throw new Error("The MXC cleanup conditions are malformed.");
    for (const entry of status.conditions as unknown[]) {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        !("type" in entry) ||
        typeof entry.type !== "string" ||
        !("status" in entry) ||
        typeof entry.status !== "string" ||
        !("reason" in entry) ||
        typeof entry.reason !== "string"
      )
        throw new Error("The MXC cleanup conditions are malformed.");
      if (entry.type === "Ready") {
        if (condition !== null)
          throw new Error("The MXC cleanup conditions contain duplicate readiness records.");
        condition = entry;
      }
    }
  } else {
    // Older packaged OpenShell exposes only this derivative field. Never use it
    // to override missing or conflicting evidence in the upstream conditions array.
    condition = "ready_condition" in status ? status.ready_condition : null;
  }
  if (
    condition !== null &&
    typeof condition === "object" &&
    "status" in condition &&
    "reason" in condition
  ) {
    if (condition.reason === "MainProcessCompleted" || condition.reason === "MainProcessFailed") {
      // Canonical main exit is not executor teardown. The caller must still
      // delete its sandbox and verify absence before releasing owned resources.
      const exitCode = "exit_code" in status ? status.exit_code : undefined;
      if (
        "conditions" in status &&
        condition.status === "False" &&
        typeof exitCode === "number" &&
        Number.isInteger(exitCode) &&
        exitCode >= -2147483648 &&
        exitCode <= 2147483647
      ) {
        if (
          status.phase === "Completed" &&
          condition.reason === "MainProcessCompleted" &&
          exitCode === 0
        )
          return "MainProcessCompleted";
        if (status.phase === "Error" && condition.reason === "MainProcessFailed" && exitCode !== 0)
          return "MainProcessFailed";
      }
      throw new Error("The MXC main-process exit evidence is inconsistent.");
    }
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
  if (["Completed", "Error", "Stopped", "Stopping", "Deleting"].includes(status.phase))
    throw new Error("MXC stopped without confirming execution cleanup.");
  return null;
}

// A workload receipt precedes process exit. Legacy MXC reports executor teardown;
// newer MXC reports main exit and retains its supervisor until sandbox deletion.
// Neither return value replaces the caller's deletion and registry absence checks.
export async function waitForNativeMxcCompletion(
  openshell: string,
  environment: NodeJS.ProcessEnv,
  sandboxName: string,
  gateway: GatewayState,
  stateSession: StateLease | null,
  timeout = 45_000,
  ownProcess: (child: ChildProcess) => void,
  signal?: AbortSignal,
): Promise<MxcCompletion> {
  const deadline = Date.now() + timeout;
  const assertOwnership = () => {
    if (signal?.aborted) throw new Error("The native MXC completion wait was cancelled.");
    stateSession?.assertHeld();
    if (gateway.exitCode !== null || gateway.signalCode !== null)
      throw new Error("The native gateway stopped before MXC execution completed.");
  };
  while (Date.now() < deadline) {
    assertOwnership();
    const result = await run(
      openshell,
      ["sandbox", "get", sandboxName, "-o", "json"],
      environment,
      "Reading native MXC completion",
      Math.min(10_000, Math.max(1, deadline - Date.now())),
      undefined,
      ownProcess,
      { signal, quiet: true },
    );
    assertOwnership();
    if (Date.now() >= deadline) break;
    const completion = nativeMxcCompletion(JSON.parse(result.stdout), sandboxName);
    if (completion !== null) return completion;
    await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error("The native MXC execution did not complete before its deadline.");
}

export async function watchNativeUiSandbox(
  openshell: string,
  environment: NodeJS.ProcessEnv,
  sandboxName: string,
  gateway: GatewayState,
  stateSession: StateLease | null,
  signal: AbortSignal,
  ownProcess: (child: ChildProcess) => void,
): Promise<void> {
  while (!signal.aborted) {
    stateSession?.assertHeld();
    if (gateway.exitCode !== null || gateway.signalCode !== null)
      throw new Error("The OpenShell gateway stopped while the agent Web UI was open.");
    let status: unknown;
    try {
      const result = await run(
        openshell,
        ["sandbox", "get", sandboxName, "-o", "json"],
        environment,
        "Reading the native UI sandbox",
        10_000,
        undefined,
        ownProcess,
        { signal, quiet: true },
      );
      status = JSON.parse(result.stdout);
    } catch {
      if (signal.aborted) return;
      throw new Error("The running OpenClaw sandbox could not be confirmed.");
    }
    if (signal.aborted) return;
    stateSession?.assertHeld();
    if (gateway.exitCode !== null || gateway.signalCode !== null)
      throw new Error("The OpenShell gateway stopped while the agent Web UI was open.");
    if (
      typeof status !== "object" ||
      status === null ||
      !("name" in status) ||
      status.name !== sandboxName ||
      !("phase" in status) ||
      typeof status.phase !== "string" ||
      ["Completed", "Error", "Stopped", "Stopping", "Deleting"].includes(status.phase)
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
