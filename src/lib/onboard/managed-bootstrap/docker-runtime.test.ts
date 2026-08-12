// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  activate: vi.fn<typeof import("./adapter").activateManagedBootstrapSequence>(),
  finalize: vi.fn<typeof import("./adapter").finalizeManagedBootstrapSequence>(),
  prepare: vi.fn<typeof import("./adapter").prepareManagedBootstrapSequence>(),
}));

vi.mock("./adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./adapter")>()),
  activateManagedBootstrapSequence: adapterMocks.activate,
  finalizeManagedBootstrapSequence: adapterMocks.finalize,
  prepareManagedBootstrapSequence: adapterMocks.prepare,
}));

import type {
  ManagedBootstrapActivatedTransaction,
  ManagedBootstrapPreparedTransaction,
} from "./adapter";
import { createDockerManagedBootstrapSurface } from "./docker-runtime";
import { authority, IDENTITY, NEW_ID, OLD_ID } from "./docker-test-fixture";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Docker managed-bootstrap lifecycle composition", () => {
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
