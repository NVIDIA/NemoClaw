// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import { executeSandboxDestroy } from "../../src/lib/actions/sandbox/destroy-execution";
import type { SandboxEntry } from "../../src/lib/state/registry";
import { createInMemoryRuntimeProviderBundle } from "./runtime-provider-bundle";

type RecoveryScenario = {
  initialStopped?: boolean;
  stopFails?: boolean;
  identityChanges?: boolean;
  wipeFails?: boolean;
  unsafeCleanup?: boolean;
  workspace?: string;
};

/** Model the owned runtime independently of the recovery helper's implementation. */
export async function runNativeHomeRecoveryScenario(options: RecoveryScenario) {
  let stopped = options.initialStopped ?? false;
  const events: string[] = [];
  const base = createInMemoryRuntimeProviderBundle({
    providerId: "docker",
    workloadProfile: {
      support: null,
      hostArchitectures: ["x64"],
      managedImageSelectionPolicy: "prefer-managed",
      legacyDockerfileBuilds: false,
    },
  });
  const failure = { status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const execute = vi.fn(() => {
    events.push("privileged");
    return stopped
      ? failure
      : {
          ...failure,
          status: 22,
          stderr: Buffer.from("agent native root retains sandbox-owned state"),
        };
  });
  const executeAsSandboxUser = vi.fn(() => {
    events.push("sandbox-user");
    return failure;
  });
  const clearStoppedNativeHome = vi.fn(() => {
    events.push("stopped-cleanup");
    if (options.unsafeCleanup)
      return { cleared: false as const, failure: "runtime-ownership-invalid" as const };
    return stopped && !options.wipeFails
      ? { cleared: true as const }
      : { cleared: false as const, failure: "runtime-not-stopped" as const };
  });
  const identity = {
    schemaVersion: 1 as const,
    providerId: "docker",
    resourceHandle: "in-memory:alpha",
    ownershipSha256: null,
  };
  const bundle = {
    ...base,
    cleanup: { ...base.cleanup, captureDestroyIdentity: () => identity },
    lifecycle: {
      ...base.lifecycle,
      privilegedSandboxControl: {
        ...base.lifecycle.privilegedSandboxControl,
        execute,
        executeAsSandboxUser,
        clearStoppedNativeHome,
      },
    },
  };
  const sandbox: SandboxEntry = {
    name: "alpha",
    agent: "openclaw",
    openshellDriver: "docker",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "alpha-generation-1",
    lifecycleLiveIdentityFingerprint: "a".repeat(64),
  };
  let current: SandboxEntry | null = sandbox;
  const ok = { status: 0, stdout: "", stderr: "" };
  const handlers: Record<string, () => { status: number; stdout: string; stderr: string }> = {
    "sandbox:exec": () => {
      events.push("openshell-exec");
      return stopped
        ? { status: 255, stdout: "", stderr: "sandbox is not running" }
        : { status: 22, stdout: "", stderr: "agent native root retains sandbox-owned state" };
    },
    "sandbox:delete": () => {
      events.push("delete");
      current = null;
      return ok;
    },
    "sandbox:get": () =>
      current
        ? {
            status: 0,
            stdout: `Name: alpha\nPhase: ${options.initialStopped ? "Error" : "Ready"}`,
            stderr: "",
          }
        : { status: 1, stdout: "", stderr: "Error: sandbox alpha not found" },
  };
  const runOpenshell = vi.fn(
    (args: string[]) => handlers[`${String(args[0])}:${String(args[1])}`]?.() ?? ok,
  );
  const stopSandbox = vi.fn(async () => {
    events.push("stop");
    if (options.stopFails)
      return {
        kind: "failed" as const,
        error: { kind: "timeout" as const, message: "stop unavailable" },
      };
    stopped = true;
    if (options.identityChanges)
      current = { ...sandbox, lifecycleLiveIdentityFingerprint: "b".repeat(64) };
    return { kind: "accepted" as const };
  });
  const onMutationStarted = vi.fn();
  const result = await executeSandboxDestroy({
    force: false,
    deleteGatewayName: "nemoclaw",
    getSandbox: () => current,
    listSandboxes: () => ({ sandboxes: current ? [current] : [] }),
    runOpenshell,
    sandbox,
    sandboxConfirmedAbsent: false,
    sandboxName: "alpha",
    mcpRuntimeSelection: { gatewayName: "nemoclaw", workspace: options.workspace ?? "default" },
    stopInferenceResources: vi.fn(),
    onMutationStarted,
    runtimeProviders: { docker: bundle },
    expectedRuntimeProviderIdentity: identity,
    expectedContainerIdentityFingerprint: "a".repeat(64),
    deps: {
      deleteConvergence: { now: () => 0, sleep: () => undefined },
      inspectOpenShellSandboxIdentityFingerprint: () =>
        current?.lifecycleLiveIdentityFingerprint ?? "a".repeat(64),
      openShellLifecycle: { startSandbox: vi.fn(), stopSandbox },
    },
  });
  return { result, current, events, stopSandbox, runOpenshell, onMutationStarted };
}
