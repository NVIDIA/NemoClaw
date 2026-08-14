// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import { privateBridgeFixture } from "../../onboard/runtime-provider/docker-llama-cpp-private-bridge.test-support";
import type { RuntimeProviderWorkloadProfile } from "../../onboard/runtime-provider/contract";
import type {
  HostLocalInferenceOperation,
  HostLocalInferenceRuntime,
} from "../../onboard/runtime-provider/host-local-inference";
import {
  createManagedState,
  engineHarness,
  NETWORK_ID,
  RUNTIME_ID,
} from "../local-model-profile/cleanup.test-support";
import { finalizeManagedLlamaCppLifecycleCleanup } from "../local-model-profile/cleanup";
import { createManagedLlamaCppLifecycleAdapter } from "./managed-lifecycle-adapter";
import { loadManagedLlamaCppReceipt, managedLlamaCppStatePaths } from "./managed-state";

const TEST_WORKLOAD_PROFILE = {
  support: null,
  hostArchitectures: ["arm64"],
  managedImageSelectionPolicy: "prefer-managed",
  legacyDockerfileBuilds: false,
} as const satisfies RuntimeProviderWorkloadProfile;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-llama-lifecycle-adapter-"));
  const canonicalHome = fs.realpathSync(home);
  temporaryDirectories.push(canonicalHome);
  return canonicalHome;
}

describe("managed llama.cpp lifecycle adapter", () => {
  it("uses one exact operation and exposes rollback only before publication", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine);
    const receipt = loadManagedLlamaCppReceipt(managedLlamaCppStatePaths(homeDir))!;
    const operation: HostLocalInferenceOperation = {
      providerId: "docker",
      engine: harness.engine,
      bindingSha256: receipt.engineAuthority.bindingSha256,
      assertAuthority: vi.fn(),
      spawn: vi.fn(),
      createLlamaCppLifecycle: vi.fn(),
    };
    const inspectManaged = vi.fn((value) => ({
      running: false,
      receipt: value,
    }));
    const stopManaged = vi.fn((value) => ({ running: false, receipt: value }));
    const preserveForRebuild = vi.fn((value) => value);
    const runtime: HostLocalInferenceRuntime = {
      providerId: "docker",
      authorityId: harness.engine.authorityId,
      services: ["llama-cpp"],
      translateContainerArgs: (args) => args,
      qualifyOllama: vi.fn(),
      startManaged: vi.fn(),
      inspectManaged,
      stopManaged,
      preserveForRebuild,
      prepareDestroy: vi.fn((value) => value),
      destroy: vi.fn((value) => ({ status: "removed" as const, receipt: value })),
    };
    const resume = vi.fn((value) => value);
    const runtimeProvider = createInMemoryRuntimeProviderBundle({
      providerId: "docker",
      workloadProfile: TEST_WORKLOAD_PROFILE,
      hostLocalInference: {
        services: ["llama-cpp"],
        createOperation: () => operation,
      },
    });
    const adapter = createManagedLlamaCppLifecycleAdapter({
      runtimeProvider,
      runtimeOwnerSandboxName: "spark-agent",
      expectedModel: "llama-cpp-model",
      expectedReceipt: receipt,
      gatewayPort: 8080,
      homeDir,
      operation,
      rehydrate: vi.fn(
        () =>
          ({
            lifecycle: { resume, runtime },
            operation,
            receipt,
            selection: {
              recipe: { spec: { model: { servedName: "llama-cpp-model" } } },
            },
          }) as never,
      ),
    });

    expect(adapter.operation).toBe(operation);
    const committed = adapter.prepareStartup();
    expect(committed.publicationState()).toBe("unpublished");
    expect(committed.validateBeforeCommit()).toEqual(receipt);
    expect(committed.publicationState()).toBe("unpublished");
    expect(committed.commit()).toEqual(receipt);
    expect(committed.publicationState()).toBe("published");
    expect(() => committed.rollback()).toThrow("terminal state 'committed'");

    const rolledBack = adapter.prepareStartup();
    expect(rolledBack.rollback()).toEqual({
      status: "restored",
      priorState: "stopped",
      receipt,
    });
    expect(rolledBack.publicationState()).toBe("unpublished");
    expect(stopManaged).toHaveBeenCalledWith(receipt);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("uses the retained receipt for an idempotent destroy retry after private state is gone", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine);
    const paths = managedLlamaCppStatePaths(homeDir);
    const receipt = loadManagedLlamaCppReceipt(paths)!;
    fs.rmSync(paths.stateDir, { recursive: true });
    const operation: HostLocalInferenceOperation = {
      providerId: "docker",
      engine: harness.engine,
      bindingSha256: receipt.engineAuthority.bindingSha256,
      assertAuthority: vi.fn(),
      spawn: vi.fn(),
      createLlamaCppLifecycle: () => {
        throw new Error("destroy retry must not reconstruct a missing private lifecycle");
      },
    };
    const runtimeProvider = createInMemoryRuntimeProviderBundle({
      providerId: "docker",
      workloadProfile: TEST_WORKLOAD_PROFILE,
      hostLocalInference: {
        services: ["llama-cpp"],
        createOperation: () => operation,
      },
    });
    const privateBridge = privateBridgeFixture();
    const adapter = createManagedLlamaCppLifecycleAdapter({
      runtimeProvider,
      runtimeOwnerSandboxName: "spark-agent",
      expectedModel: "llama-cpp-model",
      expectedReceipt: receipt,
      gatewayPort: 8080,
      homeDir,
      operation,
      finalizeCleanup: (owner, expected, options) =>
        finalizeManagedLlamaCppLifecycleCleanup(owner, expected, {
          ...options,
          privateBridge,
        }),
    });

    expect(() => adapter.prepareStartup()).toThrow("private lifecycle state is unavailable");
    expect(adapter.runtime.prepareDestroy(receipt)).toEqual(receipt);
    expect(adapter.runtime.destroy(receipt)).toEqual({
      status: "removed",
      receipt,
    });
    expect(adapter.runtime.destroy(receipt)).toEqual({
      status: "already-absent",
      receipt,
    });
    expect(harness.capture).toHaveBeenCalledWith(["rm", "--force", RUNTIME_ID], expect.any(Number));
    expect(harness.capture).toHaveBeenCalledWith(["network", "rm", NETWORK_ID], expect.any(Number));
  });
});
