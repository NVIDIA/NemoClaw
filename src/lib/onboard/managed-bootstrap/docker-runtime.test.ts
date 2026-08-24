// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamSandboxCreate } from "../../sandbox/create-stream";
import {
  dockerEnv,
  FakeChild,
  makePollingOptions,
} from "../../sandbox/create-stream-test-fixtures";
import { getReadyCheckOutputPatternsForAgent } from "../../sandbox/create-stream-ready-gate";

const adapterMocks = vi.hoisted(() => ({
  activate: vi.fn<typeof import("./adapter").activateManagedBootstrapSequence>(),
  finalize: vi.fn<typeof import("./adapter").finalizeManagedBootstrapSequence>(),
  prepare: vi.fn<typeof import("./adapter").prepareManagedBootstrapSequence>(),
}));
const runtimeSnapshotMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("./adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./adapter")>()),
  activateManagedBootstrapSequence: adapterMocks.activate,
  finalizeManagedBootstrapSequence: adapterMocks.finalize,
  prepareManagedBootstrapSequence: adapterMocks.prepare,
}));

vi.mock("../openshell-docker-sandbox-containers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../openshell-docker-sandbox-containers")>()),
  queryOpenShellDockerSandboxRuntimeSnapshot: runtimeSnapshotMocks.query,
}));

import type {
  ManagedBootstrapActivatedTransaction,
  ManagedBootstrapPreparedTransaction,
} from "./adapter";
import {
  completeDockerManagedNativeGpuFallbackOwnerCleanup,
  createDockerManagedBootstrapSurface,
} from "./docker-runtime";
import { authority, IDENTITY, NEW_ID, OLD_ID } from "./docker-test-fixture";

beforeEach(() => {
  vi.clearAllMocks();
  runtimeSnapshotMocks.query.mockReturnValue({
    ok: true,
    imageId: `sha256:${"a".repeat(64)}`,
    bookkeepingImageRef: "openshell/sandbox-from:alpha",
    stateError: "",
    deviceRequests: null,
    devices: [],
    runtime: "runc",
    nvidiaVisibleDevices: null,
    nativeGpuAttachmentState: "absent",
    containerId: NEW_ID,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Docker managed-bootstrap native fallback owner cleanup", () => {
  const handoff = Object.freeze({
    kind: "openshell-owner-cleanup-required" as const,
    sandboxName: "alpha",
    sandboxId: "sandbox-alpha",
    runtimeId: NEW_ID,
  });
  it("retains the exact handoff instead of deleting a mutable sandbox name", async () => {
    const runOpenshell = vi.fn(() => {
      throw new Error("name-only OpenShell cleanup must not run");
    });
    const recoverUnfinished = vi.fn();

    await expect(
      completeDockerManagedNativeGpuFallbackOwnerCleanup({
        providerId: "docker",
        bootstrapIdentity: IDENTITY,
        handoff,
        runOpenshell,
        recoverUnfinished,
      }),
    ).resolves.toBe(handoff);
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(recoverUnfinished).not.toHaveBeenCalled();
  });

  it("blocks fallback even if a mutable name would resolve to the expected ID", async () => {
    const runOpenshell = vi.fn(() => ({
      status: 0,
      stdout: "ID: sandbox-alpha\n",
      stderr: "",
    }));
    const recoverUnfinished = vi.fn();

    await expect(
      completeDockerManagedNativeGpuFallbackOwnerCleanup({
        providerId: "docker",
        bootstrapIdentity: IDENTITY,
        handoff,
        runOpenshell,
        recoverUnfinished,
      }),
    ).resolves.toBe(handoff);
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(recoverUnfinished).not.toHaveBeenCalled();
  });
});

describe("Docker managed-bootstrap lifecycle composition", () => {
  it("activates a Ready managed hold before post-activation startup output", async () => {
    vi.useFakeTimers();
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-runtime-"));
    const seed = authority("hermes");
    const prepared = Object.freeze({}) as ManagedBootstrapPreparedTransaction;
    const activated = Object.freeze({
      snapshot: { runtimeId: OLD_ID },
      replacement: { replacementRuntimeId: NEW_ID },
    }) as ManagedBootstrapActivatedTransaction;
    const order: string[] = [];
    adapterMocks.prepare.mockImplementation(async (_adapter, input) => {
      order.push("prepare");
      const receipt = await input.create.launch({
        heldWorkloadArgv: seed.handle.heldWorkloadArgv,
        bootstrapIdentity: IDENTITY,
      });
      order.push("create-returned");
      expect(receipt).toEqual(seed.handle.createReceipt);
      return prepared;
    });
    adapterMocks.activate.mockImplementation(async () => {
      order.push("activate");
      return activated;
    });
    const lifecycle = createDockerManagedBootstrapSurface().createLifecycle({
      providerId: "docker",
      stateRoot,
      bootstrapIdentity: IDENTITY,
      request: seed.request,
      image: seed.plan.image,
      agentIdentity: seed.plan.agentIdentity,
      intendedWorkloadArgv: seed.plan.intendedWorkloadArgv,
      expectedSupervisorArgv: seed.plan.expectedSupervisorArgv,
      launchArgv: ["openshell", "sandbox", "create", "--name", "alpha"],
      heldWorkloadArgv: seed.handle.heldWorkloadArgv,
      authorityStore: {
        recordPreparedAuthority: vi.fn(),
      },
      route: "none",
      persistStartupCommand: false,
      sandboxName: "alpha",
      sandboxGpuConfig: {
        mode: "0",
        hostGpuDetected: false,
        hostGpuPlatform: null,
        sandboxGpuEnabled: false,
        sandboxGpuDevice: null,
        errors: [],
      },
      requiredLimits: [],
      timeoutSecs: 30,
      network: {
        inferenceProvider: "openai",
        gatewayUsesContainerBridge: false,
        gatewayPort: 0,
      },
      dependencies: {},
    });
    const child = new FakeChild();
    let ready = false;

    try {
      const result = lifecycle.runCreate(async () => {
        order.push("stream-start");
        const stream = streamSandboxCreate("openshell", ["sandbox", "create"], dockerEnv, {
          ...makePollingOptions(child),
          readyCheck: () => ready,
          readyCheckOutputPatterns: getReadyCheckOutputPatternsForAgent({
            isTerminalAgent: false,
            startupRunsDuringCreate: false,
            env: dockerEnv,
          }),
          initialPhase: "create",
        });
        child.stdout.emit("data", Buffer.from("Created sandbox: alpha\n"));
        ready = true;
        await vi.advanceTimersByTimeAsync(6);
        expect(order).not.toContain("activate");
        return { value: await stream, receipt: seed.handle.createReceipt };
      });

      await expect(result).resolves.toMatchObject({ status: 0, forcedReady: true });
      expect(order).toEqual(["prepare", "stream-start", "create-returned", "activate"]);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(adapterMocks.activate).toHaveBeenCalledOnce();
      expect(lifecycle.inspectNativeRuntime?.()).toEqual({
        imageId: `sha256:${"a".repeat(64)}`,
        bookkeepingImageRef: "openshell/sandbox-from:alpha",
        stateError: "",
        nativeGpuAttachmentState: "absent",
      });
      expect(runtimeSnapshotMocks.query).toHaveBeenCalledWith(
        "alpha",
        {},
        { expectedContainerId: NEW_ID },
      );
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("does not finalize rollback after a claimed commit loses acknowledgement", async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-runtime-"));
    const seed = authority("openclaw");
    const prepared = Object.freeze({}) as ManagedBootstrapPreparedTransaction;
    const activated = Object.freeze({
      snapshot: { runtimeId: OLD_ID },
      replacement: { replacementRuntimeId: NEW_ID },
    }) as ManagedBootstrapActivatedTransaction;
    adapterMocks.prepare.mockImplementation(async (_adapter, input) => {
      await input.create.launch({
        heldWorkloadArgv: seed.handle.heldWorkloadArgv,
        bootstrapIdentity: IDENTITY,
      });
      return prepared;
    });
    adapterMocks.activate.mockResolvedValue(activated);
    adapterMocks.finalize.mockRejectedValue(new Error("commit acknowledgement lost"));
    const onPatchFailure = vi.fn((error: unknown): never => {
      throw error;
    });
    const lifecycle = createDockerManagedBootstrapSurface().createLifecycle({
      providerId: "docker",
      stateRoot,
      bootstrapIdentity: IDENTITY,
      request: seed.request,
      image: seed.plan.image,
      agentIdentity: seed.plan.agentIdentity,
      intendedWorkloadArgv: seed.plan.intendedWorkloadArgv,
      expectedSupervisorArgv: seed.plan.expectedSupervisorArgv,
      launchArgv: ["openshell", "sandbox", "create", "--name", "alpha"],
      heldWorkloadArgv: seed.handle.heldWorkloadArgv,
      authorityStore: {
        recordPreparedAuthority: vi.fn(),
      },
      route: "none",
      persistStartupCommand: false,
      sandboxName: "alpha",
      sandboxGpuConfig: {
        mode: "0",
        hostGpuDetected: false,
        hostGpuPlatform: null,
        sandboxGpuEnabled: false,
        sandboxGpuDevice: null,
        errors: [],
      },
      requiredLimits: [],
      timeoutSecs: 30,
      onPatchFailure,
      network: {
        inferenceProvider: "openai",
        gatewayUsesContainerBridge: false,
        gatewayPort: 0,
      },
      dependencies: {},
    });

    await expect(
      lifecycle.runCreate(async () => ({ value: "launched", receipt: seed.handle.createReceipt })),
    ).resolves.toBe("launched");
    const failure = (await Promise.resolve(lifecycle.patch.commitAfterReady()).catch(
      (error: unknown) => error,
    )) as Error & { managedBootstrapRollbackError?: Error };

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe("commit acknowledgement lost");
    expect(failure.managedBootstrapRollbackError?.message).toBe(
      "Managed bootstrap rollback is no longer legal after commit finalization began.",
    );
    expect(adapterMocks.finalize).toHaveBeenCalledOnce();
    expect(adapterMocks.finalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "commit", transaction: activated }),
    );
    expect(onPatchFailure).toHaveBeenCalledOnce();
    await expect(lifecycle.recoverUnfinished()).resolves.toEqual({ receipts: [], failures: [] });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
});
