// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import { privateBridgeFixture } from "../../onboard/runtime-provider/docker-llama-cpp-managed-lifecycle.test-support";
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
import {
  finalizeManagedLlamaCppLifecycleCleanup,
  prepareManagedLlamaCppRuntimeCleanupForSandbox,
} from "../local-model-profile/cleanup";
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
    const gatewayPort = 8080;
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine, { gatewayPort });
    const receipt = loadManagedLlamaCppReceipt(managedLlamaCppStatePaths(homeDir, gatewayPort))!;
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
      gatewayPort,
      homeDir,
      operation,
      rehydrate: vi.fn(
        () =>
          ({
            lifecycle: { resume, runtime },
            operation,
            receipt,
            owner: { sandboxName: "spark-agent" },
            selection: {
              preset: {
                metadata: { id: "llama-cpp.dgx-spark-gb10.single.nemotron-3-nano-30b-a3b" },
              },
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

    const legacyStationAdapter = createManagedLlamaCppLifecycleAdapter({
      runtimeProvider,
      runtimeOwnerSandboxName: "spark-agent",
      expectedModel: "llama-cpp-model",
      expectedReceipt: receipt,
      gatewayPort,
      homeDir,
      operation,
      rehydrate: vi.fn(
        () =>
          ({
            lifecycle: { resume, runtime },
            operation,
            receipt,
            owner: { sandboxName: "spark-agent" },
            selection: {
              preset: {
                metadata: { id: "llama-cpp.station-gb300-wsl-arm64.single.qwen3-6-35b-a3b" },
              },
              recipe: { spec: { model: { servedName: "llama-cpp-model" } } },
            },
          }) as never,
      ),
    });
    expect(() => legacyStationAdapter.prepareStartup()).toThrow("destroy --yes");
    expect(legacyStationAdapter.runtime.prepareDestroy(receipt)).toEqual(receipt);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("uses the retained receipt for an idempotent destroy retry after private state is gone", () => {
    const homeDir = temporaryHome();
    const gatewayPort = 8080;
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine, { gatewayPort });
    const paths = managedLlamaCppStatePaths(homeDir, gatewayPort);
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
    const adapter = createManagedLlamaCppLifecycleAdapter({
      runtimeProvider,
      runtimeOwnerSandboxName: "spark-agent",
      expectedModel: "llama-cpp-model",
      expectedReceipt: receipt,
      gatewayPort,
      homeDir,
      operation,
      finalizeCleanup: (owner, expected, options) =>
        finalizeManagedLlamaCppLifecycleCleanup(owner, expected, {
          ...options,
          privateBridge: privateBridgeFixture(),
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

  it.each([false, true])(
    "uses the journal cleanup owner for a retired runtime [historical selection: %s]",
    (historical) => {
      const homeDir = temporaryHome();
      const gatewayPort = 8080;
      const harness = engineHarness();
      createManagedState(homeDir, harness.engine, { gatewayPort });
      const receipt = loadManagedLlamaCppReceipt(managedLlamaCppStatePaths(homeDir, gatewayPort))!;
      const operation: HostLocalInferenceOperation = {
        providerId: "docker",
        engine: harness.engine,
        bindingSha256: receipt.engineAuthority.bindingSha256,
        assertAuthority: vi.fn(),
        spawn: vi.fn(),
        createLlamaCppLifecycle: vi.fn(),
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
      const prepareRuntimeCleanup = vi.fn<typeof prepareManagedLlamaCppRuntimeCleanupForSandbox>(
        (owner, options) =>
          prepareManagedLlamaCppRuntimeCleanupForSandbox(owner, { ...options, privateBridge }),
      );
      const finalizeCleanup = vi.fn(() => ({ ok: true as const, removed: [], preserved: [] }));
      const cache = path.join(homeDir, ".cache", "huggingface", "shared-model");
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      fs.writeFileSync(cache, "keep");
      const adapter = createManagedLlamaCppLifecycleAdapter({
        runtimeProvider,
        runtimeOwnerSandboxName: "spark-agent",
        expectedModel: "llama-cpp-model",
        expectedReceipt: receipt,
        gatewayPort,
        homeDir,
        operation,
        prepareRuntimeCleanup,
        finalizeCleanup,
        ...(historical
          ? {
              rehydrate: vi.fn(
                () =>
                  ({
                    operation,
                    receipt,
                    selection: {
                      recipeDigest:
                        "sha256:b1032bb63f7f0772ddc96576219269fe42a086814eca561d1b28d69394dc72e1",
                      recipe: { spec: { model: { servedName: "llama-cpp-model" } } },
                    },
                  }) as never,
              ),
            }
          : {}),
      });
      expect(() => adapter.prepareStartup()).toThrow(
        historical
          ? "former WSL managed llama.cpp image cannot resume"
          : "private lifecycle state is unavailable",
      );
      expect(adapter.runtime.prepareDestroy(receipt)).toEqual(receipt);
      expect(adapter.runtime.destroy(receipt)).toEqual({ status: "removed", receipt });
      expect(prepareRuntimeCleanup).toHaveBeenCalledWith(
        "spark-agent",
        expect.objectContaining({ engine: harness.engine }),
      );
      expect(finalizeCleanup).not.toHaveBeenCalled();
      expect(privateBridge.stopTransaction).toHaveBeenCalledWith(
        receipt.runtime.kind === "container" ? receipt.runtime.model!.generation : "",
      );
      expect(harness.capture).toHaveBeenCalledWith(
        ["rm", "--force", RUNTIME_ID],
        expect.any(Number),
      );
      expect(harness.capture).toHaveBeenCalledWith(
        ["network", "rm", NETWORK_ID],
        expect.any(Number),
      );
      expect(fs.existsSync(managedLlamaCppStatePaths(homeDir, gatewayPort).stateDir)).toBe(false);
      expect(fs.readFileSync(cache, "utf8")).toBe("keep");
    },
  );
});
