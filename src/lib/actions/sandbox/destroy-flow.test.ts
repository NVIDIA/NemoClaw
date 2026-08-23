// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  expectAbsentSandboxMcpFinalize,
  expectActiveTimerDestroyOrder,
  expectFailedDeletePreservesHostState,
  expectFailedHardeningMcpRestore,
  expectFailedHardeningRefusesForcedCleanup,
  expectFailedHardeningStillDeletes,
  expectFailedMcpFinalizePreservesRegistry,
  expectFailedMcpRestorePreservesDestroyFailure,
  expectMcpFinalizeAfterDelete,
  expectMcpFinalizeBridgeErrorReturnsFailure,
  expectMcpPrepareBridgeErrorAborts,
  expectMcpRestoreAfterDeleteFailure,
  expectShieldsUpRefusalBeforeMutation,
  expectStrictSandboxPresenceClassification,
  expectSuccessfulLiveDestroy,
} from "../../../../test/helpers/destroy-flow-test-assertions";
import {
  createDestroyHarness,
  resetDestroyModuleCache,
  traceDestroyBoundaryCalls,
} from "../../../../test/helpers/destroy-flow-test-harness";
import { serializedLlamaCppHostLocalInferenceReceipt } from "../../../../test/helpers/host-local-inference-receipt";
import { createSandboxHostLocalInferenceProvenance } from "../../state/registry/host-local-inference";
import type { SandboxWorkloadReceipt } from "../../state/registry";
import * as dockerLlamaCppOperation from "../../onboard/runtime-provider/docker-llama-cpp-operation";
import { prepareManagedLlamaCppRuntimeCleanupForSandbox } from "../../inference/local-model-profile/cleanup";
import {
  createManagedState,
  engineHarness,
  NETWORK_ID,
  RUNTIME_ID,
} from "../../inference/local-model-profile/cleanup.test-support";

const managedHermesWorkload = {
  schemaVersion: 1,
  kind: "managed-image",
  reference: `ghcr.io/nvidia/nemoclaw/hermes@sha256:${"a".repeat(64)}`,
  platform: "linux/amd64",
  release: "v0.0.0",
  sourceRevision: "a".repeat(40),
  sourceCohort: "test-cohort",
  capabilityContractVersion: 1,
  startupProfileContractVersion: 1,
  encodedProfile: "e30",
  startupProfileSha256: "b".repeat(64),
  credentialProxyReplayRequired: true,
  shared: true,
} satisfies SandboxWorkloadReceipt;

describe("destroySandbox flow", () => {
  let exitSpy: MockInstance;
  let originalGatewayEnv: string | undefined;

  beforeEach(() => {
    originalGatewayEnv = process.env.OPENSHELL_GATEWAY;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    originalGatewayEnv === undefined
      ? delete process.env.OPENSHELL_GATEWAY
      : (process.env.OPENSHELL_GATEWAY = originalGatewayEnv);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
  });

  it("trusts absence only from a successful, error-free sandbox list", { timeout: 30_000 }, () => {
    expectStrictSandboxPresenceClassification();
  });

  it("selects the sandbox gateway, deletes live resources, cleans host state, and removes registry state", async () => {
    const harness = createDestroyHarness();

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
    ).resolves.toBeUndefined();

    expectSuccessfulLiveDestroy(harness, exitSpy);
    expect(harness.retirePortableLifecycleReceiptSpy).toHaveBeenCalledWith("alpha");
    expect(harness.removeSandboxSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.retirePortableLifecycleReceiptSpy.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ["--yes", false],
    ["--yes --force", true],
  ] as const)(
    "keeps managed llama.cpp cleanup authority across the sandbox delete boundary with %s (#9888)",
    async (_flags, force) => {
      const trace: string[] = [];
      const cleanup = vi.fn(() => {
        trace.push("cleanup");
        return { ok: true as const, removed: [], preserved: [] };
      });
      const harness = createDestroyHarness({
        provider: "llama-cpp-local",
        hostLocalInferenceReceipt: serializedLlamaCppHostLocalInferenceReceipt(),
        preparedManagedLlamaCppRuntimeCleanup: { abort: vi.fn(), cleanup },
        onPrepareManagedLlamaCppRuntimeCleanup: () => trace.push("prepare"),
      });
      harness.runOpenshellSpy.mockImplementation((args: unknown) => {
        const argv = Array.isArray(args) ? args : [];
        switch (`${String(argv[0])}:${String(argv[1])}`) {
          case "sandbox:delete":
            trace.push("delete");
            return { status: 0, stdout: "", stderr: "" };
          case "sandbox:list":
            trace.push("list");
            return { status: 0, stdout: '[{"name":"alpha","phase":"Ready"}]', stderr: "" };
          default:
            return { status: 0, stdout: "", stderr: "" };
        }
      });

      await expect(harness.destroySandbox("alpha", { yes: true, force })).resolves.toBeUndefined();

      expect(harness.prepareManagedLlamaCppRuntimeCleanupSpy).toHaveBeenCalledWith("alpha", {
        gatewayPort: 19080,
      });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(trace).toEqual(["prepare", "list", "delete", "cleanup"]);
      expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
      expect(harness.retirePortableLifecycleReceiptSpy).toHaveBeenCalledWith("alpha");
      expect(exitSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["--yes", false],
    ["--yes --force", true],
  ] as const)(
    "runs the real retained llama.cpp cleanup capability after sandbox deletion with %s (#9888)",
    async (_flags, force) => {
      const homeDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-destroy-cleanup-")),
      );
      try {
        const qualified = engineHarness({ authorityId: "docker:qualified" });
        const drifted = engineHarness({ authorityId: "docker:drifted" });
        createManagedState(homeDir, qualified.engine, {
          gatewayPort: 19080,
          sandboxName: "alpha",
        });
        let crossedDeleteBoundary = false;
        const createEngine = vi
          .spyOn(dockerLlamaCppOperation, "createManagedLlamaCppEngine")
          .mockImplementation(() => (crossedDeleteBoundary ? drifted.engine : qualified.engine));
        const prepared = prepareManagedLlamaCppRuntimeCleanupForSandbox("alpha", {
          gatewayPort: 19080,
          homeDir,
        });
        const harness = createDestroyHarness({
          provider: "llama-cpp-local",
          hostLocalInferenceReceipt: serializedLlamaCppHostLocalInferenceReceipt(),
          preparedManagedLlamaCppRuntimeCleanup: prepared,
        });
        harness.runOpenshellSpy.mockImplementation((args: unknown) => {
          const argv = Array.isArray(args) ? args : [];
          switch (`${String(argv[0])}:${String(argv[1])}`) {
            case "sandbox:delete":
              crossedDeleteBoundary = true;
              return { status: 0, stdout: "", stderr: "" };
            case "sandbox:list":
              return {
                status: 0,
                stdout: '[{"name":"alpha","phase":"Ready"}]',
                stderr: "",
              };
            default:
              return { status: 0, stdout: "", stderr: "" };
          }
        });

        await expect(
          harness.destroySandbox("alpha", { yes: true, force }),
        ).resolves.toBeUndefined();

        expect(createEngine).toHaveBeenCalledOnce();
        expect(qualified.capture).toHaveBeenCalledWith(
          ["rm", "--force", RUNTIME_ID],
          expect.any(Number),
        );
        expect(qualified.capture).toHaveBeenCalledWith(
          ["network", "rm", NETWORK_ID],
          expect.any(Number),
        );
        expect(drifted.capture).not.toHaveBeenCalled();
        expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
      } finally {
        fs.rmSync(homeDir, { force: true, recursive: true });
      }
    },
  );

  it("does not let legacy llama.cpp state block an unrelated provider destroy (#9888)", async () => {
    const harness = createDestroyHarness({
      provider: "nvidia-prod",
      onPrepareManagedLlamaCppRuntimeCleanup: () => {
        throw new Error("foreign managed llama.cpp state is corrupt");
      },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.prepareManagedLlamaCppRuntimeCleanupSpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["--yes", false],
    ["--yes --force", true],
  ] as const)(
    "refuses sandbox deletion when managed llama.cpp cleanup authority cannot be qualified with %s (#9888)",
    async (_flags, force) => {
      const harness = createDestroyHarness({
        provider: "llama-cpp-local",
        hostLocalInferenceReceipt: serializedLlamaCppHostLocalInferenceReceipt(),
        onPrepareManagedLlamaCppRuntimeCleanup: () => {
          throw new Error("qualified container endpoint does not match persisted authority");
        },
      });

      await expect(harness.destroySandbox("alpha", { yes: true, force })).rejects.toThrow(
        "process.exit(1)",
      );

      expect(
        harness.runOpenshellSpy.mock.calls.map(([args]) => (args as string[]).slice(0, 2)),
      ).not.toContainEqual(["sandbox", "delete"]);
      expect(harness.errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
        "The sandbox was not deleted. Resolve the reported cleanup preflight failure and retry destroy.",
      );
      expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    },
  );

  it("preserves the registry when prepared managed llama.cpp cleanup fails after deletion (#9888)", async () => {
    const harness = createDestroyHarness({
      provider: "llama-cpp-local",
      hostLocalInferenceReceipt: serializedLlamaCppHostLocalInferenceReceipt(),
      preparedManagedLlamaCppRuntimeCleanup: {
        abort: vi.fn(),
        cleanup: () => ({
          ok: false,
          reason: "qualified cleanup failed",
          removed: [],
          preserved: ["managed llama.cpp runtime"],
        }),
      },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
      "qualified cleanup failed",
    );
  });

  it("does not run prepared managed llama.cpp cleanup when OpenShell deletion fails (#9888)", async () => {
    const abort = vi.fn();
    const cleanup = vi.fn(() => ({ ok: true as const, removed: [], preserved: [] }));
    const harness = createDestroyHarness({
      deleteStatus: 7,
      provider: "llama-cpp-local",
      hostLocalInferenceReceipt: serializedLlamaCppHostLocalInferenceReceipt(),
      preparedManagedLlamaCppRuntimeCleanup: { abort, cleanup },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expect(abort).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });

  it("releases prepared managed llama.cpp cleanup when destroy execution throws (#9888)", async () => {
    const abort = vi.fn();
    const cleanup = vi.fn(() => ({ ok: true as const, removed: [], preserved: [] }));
    const harness = createDestroyHarness({
      provider: "llama-cpp-local",
      hostLocalInferenceReceipt: serializedLlamaCppHostLocalInferenceReceipt(),
      preparedManagedLlamaCppRuntimeCleanup: { abort, cleanup },
    });
    harness.executeSandboxDestroySpy.mockRejectedValueOnce(
      new Error("injected destroy execution failure"),
    );

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
      "injected destroy execution failure",
    );

    expect(abort).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });

  it("releases prepared managed llama.cpp cleanup when service cleanup throws (#9888)", async () => {
    const abort = vi.fn();
    const cleanup = vi.fn(() => ({ ok: true as const, removed: [], preserved: [] }));
    const harness = createDestroyHarness({
      provider: "llama-cpp-local",
      hostLocalInferenceReceipt: serializedLlamaCppHostLocalInferenceReceipt(),
      preparedManagedLlamaCppRuntimeCleanup: { abort, cleanup },
      registeredSandboxCount: 1,
    });
    harness.stopAllSpy.mockImplementationOnce(() => {
      throw new Error("injected service cleanup failure");
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
      "injected service cleanup failure",
    );

    expect(abort).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });

  it("reconciles prepared managed llama.cpp cleanup after OpenShell already deleted the sandbox (#9888)", async () => {
    const cleanup = vi.fn(() => ({ ok: true as const, removed: [], preserved: [] }));
    const harness = createDestroyHarness({
      sandboxPresent: false,
      provider: "llama-cpp-local",
      hostLocalInferenceReceipt: serializedLlamaCppHostLocalInferenceReceipt(),
      preparedManagedLlamaCppRuntimeCleanup: { abort: vi.fn(), cleanup },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(harness.retirePortableLifecycleReceiptSpy).toHaveBeenCalledWith("alpha");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("prepares leftover managed llama.cpp cleanup when the registry row is already absent (#9888)", async () => {
    const cleanup = vi.fn(() => ({ ok: true as const, removed: [], preserved: [] }));
    const harness = createDestroyHarness({
      registryEntryPresent: false,
      sandboxPresent: false,
      preparedManagedLlamaCppRuntimeCleanup: { abort: vi.fn(), cleanup },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.prepareManagedLlamaCppRuntimeCleanupSpy).toHaveBeenCalledWith("alpha", {});
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not discover unprepared llama.cpp state after sandbox deletion (#9888)", async () => {
    const harness = createDestroyHarness({
      provider: "llama-cpp-local",
      hostLocalInferenceReceipt: serializedLlamaCppHostLocalInferenceReceipt(),
      preparedManagedLlamaCppRuntimeCleanup: null,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.prepareManagedLlamaCppRuntimeCleanupSpy).toHaveBeenCalledOnce();
    expect(harness.cleanupManagedLlamaCppRuntimeForSandboxSpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("completes destroy through common cleanup for provenance-tracked llama.cpp (#9888)", async () => {
    const receipt = serializedLlamaCppHostLocalInferenceReceipt();
    const harness = createDestroyHarness({
      provider: "llama-cpp-local",
      hostLocalInferenceReceipt: receipt,
      hostLocalInferenceProvenance: createSandboxHostLocalInferenceProvenance("alpha", receipt),
      executeSandboxDestroyResult: {
        ok: true,
        alreadyGone: false,
        deleteOutput: "",
        deleteResult: { status: 0, stdout: "", stderr: "" },
        detachOutcome: { detached: [], failures: [] },
        forcedLocalCleanup: false,
        commonLlamaCppAuthorityRetired: true,
      },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.prepareManagedLlamaCppRuntimeCleanupSpy).not.toHaveBeenCalled();
    expect(harness.executeSandboxDestroySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox: expect.objectContaining({ hostLocalInferenceProvenance: expect.any(Object) }),
      }),
    );
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("rejects schema-5 inside the destroy lifecycle fence before Docker or OpenShell (#9203)", async () => {
    const harness = createDestroyHarness({ portableCommandError: "schema-5 rejected" });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
      "schema-5 rejected",
    );

    expect(harness.assertHermesPortableCommandUnavailableSpy).toHaveBeenCalledWith(
      "alpha",
      "sandbox:destroy",
    );
    expect(harness.dockerRunSpy).not.toHaveBeenCalled();
    expect(harness.dockerCaptureSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();
  });

  it("revalidates schema-4 Portable identity at every destroy checkpoint without Docker preflight (#9189)", async () => {
    const harness = createDestroyHarness({
      dockerRunResult: { status: 0, stdout: `${"f".repeat(64)}\t\tforeign\t` },
      portableDestroyAuthority: true,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.preparePortableDestroyAuthoritySpy).toHaveBeenCalledOnce();
    expect(harness.portableDestroyRevalidateSpy).toHaveBeenCalledTimes(6);
    expect(harness.portableDestroyVerifyAbsentSpy).toHaveBeenCalledOnce();
    expect(harness.dockerRunSpy).not.toHaveBeenCalled();
    expect(harness.portableDestroyVerifyAbsentSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.removeSandboxSpy.mock.invocationCallOrder[0],
    );
    expect(harness.removeSandboxSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.retirePortableLifecycleReceiptSpy.mock.invocationCallOrder[0],
    );
  });

  it("releases lifecycle locks before exiting on Portable identity drift and permits retry", async () => {
    const harness = createDestroyHarness({ portableDestroyAuthority: true });
    const recordRevalidation = () => harness.events.push("portable-revalidate");
    const revalidateAtDeleteBoundary = vi.fn(recordRevalidation).mockImplementationOnce(() => {
      throw new Error("Portable receipt changed during destroy");
    });
    harness.portableDestroyRevalidateSpy.mockImplementation(() =>
      harness.events.at(-1) === "detach" ? revalidateAtDeleteBoundary() : recordRevalidation(),
    );
    exitSpy.mockImplementationOnce(((code?: number | string | null) => {
      harness.lifecycleLockEvents.push("process-exit");
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.lifecycleLockEvents).toEqual(["acquired", "released", "process-exit"]);
    expect(harness.events).not.toContain("delete");
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();
    expect(harness.lifecycleLockEvents).toEqual([
      "acquired",
      "released",
      "process-exit",
      "acquired",
      "released",
    ]);
    expect(harness.events.filter((event) => event === "delete")).toHaveLength(1);
    expect(harness.removeSandboxSpy).toHaveBeenCalledOnce();
    expect(harness.retirePortableLifecycleReceiptSpy).toHaveBeenCalledOnce();
  });

  it("redacts credentials from an invalid schema-4 Portable receipt refusal and releases the lifecycle lock before retry (#9189)", async () => {
    const harness = createDestroyHarness({
      portableDestroyPrepareError: "portable receipt API_KEY=opaque-portable-secret is invalid",
    });

    const refusal = await harness.destroySandbox("alpha", { yes: true }).catch((error) => error);

    expect(String(refusal)).toContain("API_KEY=<REDACTED>");
    expect(String(refusal)).not.toContain("opaque-portable-secret");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(harness.dockerRunSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();

    harness.preparePortableDestroyAuthoritySpy.mockReturnValue(null);
    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();
    expect(harness.preparePortableDestroyAuthoritySpy).toHaveBeenCalledTimes(2);
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.any(Object),
    );
  });

  it("preserves the sandbox registry record and Portable receipt when Podman absence is unproven (#9189)", async () => {
    const harness = createDestroyHarness({
      portableDestroyAuthority: true,
      portableDestroyVerifyAbsentError: "recorded Podman container remains",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.events).toContain("delete");
    expect(harness.portableDestroyVerifyAbsentSpy).toHaveBeenCalledOnce();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();
  });

  it("refuses forced local cleanup while schema-4 Portable authority is retained (#9189)", async () => {
    const harness = createDestroyHarness({
      deleteStatus: 1,
      deleteOutput: "error trying to connect: connection refused",
      portableDestroyAuthority: true,
    });

    await expect(harness.destroySandbox("alpha", { force: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errorOutput).toContain("--force cannot discard this ownership state");
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();
  });

  it(
    "removes the owned managed Hermes state volume after confirmed sandbox deletion",
    { timeout: 30_000 },
    async () => {
      const harness = createDestroyHarness({
        agent: "hermes",
        openshellDriver: "docker",
        workload: managedHermesWorkload,
        managedHermesStateVolumeCleanupResult: { status: "removed" },
      });

      await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

      expect(harness.removeManagedHermesStateVolumeSpy).toHaveBeenCalledWith({
        agentName: "hermes",
        runtimeProviderId: "docker",
        sandboxName: "alpha",
        workloadKind: "managed-image",
      });
      expect(harness.removeManagedHermesStateVolumeSpy.mock.invocationCallOrder[0]).toBeLessThan(
        harness.removeSandboxSpy.mock.invocationCallOrder[0],
      );
    },
  );

  it("preserves the registry when owned managed Hermes state-volume cleanup fails", async () => {
    const harness = createDestroyHarness({
      agent: "hermes",
      openshellDriver: "docker",
      workload: managedHermesWorkload,
      managedHermesStateVolumeCleanupResult: {
        status: "failed",
        detail: "volume is still in use",
        volumeName: "nemoclaw-hermes-state-v1-alpha",
      },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "volume is still in use",
    );
  });

  it("leaves a foreign same-name Hermes volume untouched and completes registry cleanup", async () => {
    const harness = createDestroyHarness({
      agent: "hermes",
      openshellDriver: "docker",
      workload: managedHermesWorkload,
      managedHermesStateVolumeCleanupResult: {
        status: "not-owned",
        detail: "the exact NemoClaw ownership labels are absent or changed",
        volumeName: "nemoclaw-hermes-state-v1-alpha",
      },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.warnSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Left Docker volume 'nemoclaw-hermes-state-v1-alpha' untouched",
    );
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
  });

  it("runs routed teardown under the gateway and host router-port locks (#9098)", async () => {
    const harness = createDestroyHarness({ provider: "nvidia-router" });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.withGatewayRouteMutationLockSpy).toHaveBeenCalledWith(
      "nemoclaw-19080",
      expect.any(Function),
    );
    expect(harness.withModelRouterPortLifecycleLockSpy).toHaveBeenCalledWith(
      4000,
      expect.any(Function),
    );
  });

  it("leaves an active same-name replacement onboarding session unchanged", async () => {
    const harness = createDestroyHarness({
      provider: "nvidia-router",
      endpointUrl: "http://host.openshell.internal:4000/v1",
      replaceSessionAfterRegistryRemoval: true,
      sessionRouterPid: 4242,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.stopModelRouterForDestroyedSandboxSpy).toHaveBeenCalledOnce();
    expect(harness.compareAndSwapSessionSpy).not.toHaveBeenCalled();
    expect(harness.updateSessionSpy).not.toHaveBeenCalled();
    expect(harness.sessionState).toMatchObject({
      sessionId: "replacement-session",
      sandboxName: "alpha",
      endpointUrl: "http://host.openshell.internal:4000/v1",
      routerPid: 6262,
      routerCredentialHash: "replacement-hash",
    });
    expect(harness.warnSpy).toHaveBeenCalledWith(expect.stringContaining("owns the session lock"));
  });

  it("revokes the prior HTTPS-pin route only after confirmed deletion and registry removal", async () => {
    const routeId = "a".repeat(64);
    const harness = createDestroyHarness({
      endpointUrl: `http://host.openshell.internal:11438/route/${routeId}`,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.revokeHttpsPinRuntimeAdapterRouteSpy).toHaveBeenCalledWith(routeId);
    expect(harness.removeSandboxSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.revokeHttpsPinRuntimeAdapterRouteSpy.mock.invocationCallOrder[0],
    );
  });

  it("stops the routed sandbox proxy after registry removal under the gateway route lock (#9098)", async () => {
    const harness = createDestroyHarness({
      provider: "nvidia-router",
      endpointUrl: "http://host.openshell.internal:4000/v1",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.stopModelRouterForDestroyedSandboxSpy).toHaveBeenCalledOnce();
    expect(harness.withGatewayRouteMutationLockSpy).toHaveBeenCalledWith(
      "nemoclaw-19080",
      expect.any(Function),
    );
    expect(harness.removeSandboxSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.withGatewayRouteMutationLockSpy.mock.invocationCallOrder[0],
    );
    expect(harness.withGatewayRouteMutationLockSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.stopModelRouterForDestroyedSandboxSpy.mock.invocationCallOrder[0],
    );
  });

  it("does not stop the routed sandbox proxy when registry removal does not complete (#9098)", async () => {
    const harness = createDestroyHarness({
      provider: "nvidia-router",
      endpointUrl: "http://host.openshell.internal:4000/v1",
      removeSandboxResult: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(harness.withGatewayRouteMutationLockSpy).not.toHaveBeenCalled();
    expect(harness.stopModelRouterForDestroyedSandboxSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["--yes", "darwin", { yes: true }, "", true],
    ["NEMOCLAW_NON_INTERACTIVE=1", "darwin", {}, "1", true],
    [
      "an explicit preservation override",
      "darwin",
      { yes: true, cleanupGateway: false },
      "",
      false,
    ],
    ["NEMOCLAW_NON_INTERACTIVE=1", "linux", {}, "1", false],
  ] as const)(
    "applies the final-gateway default for %s on %s (#4662)",
    async (_scenario, platform, options, nonInteractive, cleanupExpected) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", nonInteractive);
      const harness = createDestroyHarness();

      await expect(harness.destroySandbox("alpha", options)).resolves.toBeUndefined();

      expect(harness.promptSpy).not.toHaveBeenCalled();
      expect(harness.cleanupGatewaySpy.mock.calls).toEqual(
        cleanupExpected ? [["nemoclaw-19080", harness.runOpenshellSpy]] : [],
      );
    },
  );

  it("stops before local cleanup when OpenShell fails to delete the live sandbox", async () => {
    const harness = createDestroyHarness({
      deleteStatus: 7,
      deleteOutput: "delete failed",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expectFailedDeletePreservesHostState(harness, exitSpy);
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();
    expect(harness.withGatewayRouteMutationLockSpy).not.toHaveBeenCalled();
    expect(harness.stopModelRouterForDestroyedSandboxSpy).not.toHaveBeenCalled();
  });

  it("refuses before destructive work when Docker identity cannot be inspected", async () => {
    const harness = createDestroyHarness({
      dockerRunResult: { status: 1, stderr: "Docker daemon unavailable" },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Docker container identity could not be inspected",
    );
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
    expect(harness.selectGatewaySpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.updateSessionSpy).not.toHaveBeenCalled();
    expect(harness.stopAllSpy).not.toHaveBeenCalled();
    expect(harness.killTimerSpy).not.toHaveBeenCalled();
    expect(harness.prepareMcpBridgesForDestroySpy).not.toHaveBeenCalled();
    expect(harness.stopNimByNameSpy).not.toHaveBeenCalled();
    expect(harness.killStaleProxySpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();
    expect(harness.dockerRunSpy).toHaveBeenCalledOnce();
  });

  it("refuses before destructive work when multiple Docker identities share the name", async () => {
    const rows = [
      "aaaa000000000000\topenshell\tdefault\tsb-real",
      "ffff000000000000\t\tforeign\t",
    ].join("\n");
    const harness = createDestroyHarness({
      dockerRunResult: { status: 0, stdout: rows },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errorOutput).toContain("could not verify one complete container identity");
    expect(errorOutput).toContain("Managed sandbox container: aaaa00000000");
    expect(errorOutput).toContain("Conflicting container: ffff00000000");
    expect(errorOutput).toContain("sb-real");
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
    expect(harness.events).not.toContain("wipe");
    expect(harness.events).not.toContain("detach");
    expect(harness.selectGatewaySpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.updateSessionSpy).not.toHaveBeenCalled();
    expect(harness.prepareMcpBridgesForDestroySpy).not.toHaveBeenCalled();
    expect(harness.stopNimByNameSpy).not.toHaveBeenCalled();
    expect(harness.killStaleProxySpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();
    expect(harness.dockerRunSpy).toHaveBeenCalledOnce();
  });

  it("refuses identity drift after read-only destroy preflight (#8999)", async () => {
    const managed = "aaaa000000000000\topenshell\tdefault\tsb-alpha";
    const foreign = "ffff000000000000\t\tforeign\t";
    const harness = createDestroyHarness({
      dockerRunResultSequence: [
        { status: 0, stdout: managed },
        { status: 0, stdout: [managed, foreign].join("\n") },
      ],
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.selectGatewaySpy).toHaveBeenCalledOnce();
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "list", "-o", "json"],
      expect.any(Object),
    );
    expect(harness.events).toEqual([]);
    expect(harness.stopNimByNameSpy).not.toHaveBeenCalled();
    expect(harness.killStaleProxySpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.updateSessionSpy).not.toHaveBeenCalled();
    expect(harness.prepareMcpBridgesForDestroySpy).not.toHaveBeenCalled();
    expect(harness.stopAllSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();
    expect(harness.dockerRunSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "a replacement identity",
      { status: 0, stdout: "bbbb000000000000\topenshell\tdefault\tsb-beta" },
    ],
    ["container absence", { status: 0, stdout: "" }],
    ["a failed revalidation probe", { status: 1, stderr: "daemon unavailable" }],
  ])("refuses %s before sandbox mutation", async (_scenario, changedIdentity) => {
    const managed = { status: 0, stdout: "aaaa000000000000\topenshell\tdefault\tsb-alpha" };
    const harness = createDestroyHarness({
      dockerRunResultSequence: [managed, managed, changedIdentity],
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.events).toEqual([]);
    expect(harness.stopNimByNameSpy).not.toHaveBeenCalled();
    expect(harness.killStaleProxySpy).not.toHaveBeenCalled();
    expect(harness.prepareMcpBridgesForDestroySpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();
    expect(harness.dockerRunSpy).toHaveBeenCalledTimes(3);
  });

  it("refuses an absent-to-present replacement before sandbox mutation", async () => {
    const absent = { status: 0, stdout: "" };
    const replacement = {
      status: 0,
      stdout: "bbbb000000000000\topenshell\tdefault\tsb-beta",
    };
    const harness = createDestroyHarness({
      sandboxPresent: false,
      dockerRunResultSequence: [absent, absent, replacement],
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.events).toEqual([]);
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();
    expect(harness.dockerRunSpy).toHaveBeenCalledTimes(3);
  });

  it("restores MCP preparation when identity changes before wipe", async () => {
    const managed = { status: 0, stdout: "aaaa000000000000\topenshell\tdefault\tsb-alpha" };
    const replacement = {
      status: 0,
      stdout: "bbbb000000000000\topenshell\tdefault\tsb-beta",
    };
    const harness = createDestroyHarness({
      mcpServers: ["github"],
      dockerRunResultSequence: [managed, managed, managed, replacement],
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.events).toEqual(["mcp-prepare", "mcp-restore"]);
    expect(harness.stopNimByNameSpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();
    expect(harness.dockerRunSpy).toHaveBeenCalledTimes(4);
  });

  it("restores MCP preparation when managed inference cleanup fails before wipe", async () => {
    const inferenceSecretMarker = "inference-cleanup-secret";
    const recoverySecretMarker = "mcp-recovery-secret";
    const harness = createDestroyHarness({
      mcpServers: ["github"],
      restoreMcpError: `OPENAI_API_KEY=${recoverySecretMarker}`,
      stopInferenceError: `OPENAI_API_KEY=${inferenceSecretMarker}`,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.events).toEqual(["mcp-prepare", "mcp-restore"]);
    expect(harness.stopNimByNameSpy).toHaveBeenCalledOnce();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "exec", "alpha"],
      expect.anything(),
    );
    expect(harness.events).not.toContain("wipe");
    expect(harness.events).not.toContain("detach");
    expect(harness.events).not.toContain("delete");
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errorOutput).toContain("Could not stop managed inference resources");
    expect(errorOutput).not.toContain(inferenceSecretMarker);
    expect(errorOutput).not.toContain(recoverySecretMarker);
  });

  it.each([
    [
      "a replacement identity",
      { status: 0, stdout: "bbbb000000000000\topenshell\tdefault\tsb-beta" },
      "Container identity changed after managed inference cleanup",
    ],
    [
      "a failed Docker reinspection",
      { status: 1, stderr: "daemon unavailable" },
      "Container identity could not be inspected after managed inference cleanup: daemon unavailable",
    ],
  ])(
    "restores MCP preparation and refuses workspace wipe after %s",
    async (_scenario, changedIdentity, expectedMessage) => {
      const managed = { status: 0, stdout: "aaaa000000000000\topenshell\tdefault\tsb-alpha" };
      const harness = createDestroyHarness({
        mcpServers: ["github"],
        dockerRunResultSequence: [managed, managed, managed, managed, changedIdentity],
      });

      await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
        "process.exit(1)",
      );

      expect(harness.events).toEqual(["mcp-prepare", "mcp-restore"]);
      expect(harness.stopNimByNameSpy).toHaveBeenCalledOnce();
      expect(harness.events).not.toContain("wipe");
      expect(harness.events).not.toContain("detach");
      expect(harness.events).not.toContain("delete");
      expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
      const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(errorOutput).toContain(expectedMessage);
      expect(errorOutput).toContain("Managed inference cleanup may already be partial");
    },
  );

  it("revalidates immediately before delete and reports partial provider preparation", async () => {
    const managed = { status: 0, stdout: "aaaa000000000000\topenshell\tdefault\tsb-alpha" };
    const replacement = {
      status: 0,
      stdout: "bbbb000000000000\topenshell\tdefault\tsb-beta",
    };
    const harness = createDestroyHarness({
      detachedProviders: ["provider-a"],
      dockerRunResultSequence: [
        managed, // Initial guard before read-only preflight.
        managed, // Guard after preflight and before mutation.
        managed, // Execution-entry continuity guard.
        managed, // Guard after MCP destroy preparation.
        managed, // Guard after managed inference cleanup.
        managed, // Guard before provider cleanup.
        replacement, // Final guard immediately before sandbox deletion.
      ],
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.events).toEqual(["wipe", "detach", "mcp-restore"]);
    expect(
      harness.runOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "delete",
      ),
    ).toBe(false);
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();
    expect(harness.dockerRunSpy).toHaveBeenCalledTimes(7);
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errorOutput).toContain("Provider cleanup detached provider-a");
  });

  it("keeps the final exact probe immediately adjacent to sandbox delete", async () => {
    const managed = { status: 0, stdout: "aaaa000000000000\topenshell\tdefault\tsb-alpha" };
    const trace: string[] = [];
    let identityProbeCalls = 0;
    const harness = createDestroyHarness({
      dockerRunResult: managed,
      onDockerRun: (call) => {
        identityProbeCalls = call;
        trace.push(`probe:${String(call)}`);
      },
    });
    traceDestroyBoundaryCalls(harness, trace);

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(trace.slice(-2)).toEqual([`probe:${String(identityProbeCalls)}`, "delete"]);
  });

  it("preserves provider and registry ownership when runtime authority is unknown", async () => {
    const harness = createDestroyHarness({
      openshellDriver: "unknown-runtime",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errorOutput).toContain("unknown-runtime");
    expect(errorOutput).toContain("is not registered for this operation");
    expect(
      harness.runOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "delete",
      ),
    ).toBe(false);
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });

  it("blocks deletion and preserves ownership when image authority is unproven", async () => {
    const harness = createDestroyHarness({
      imageTag: "local/alpha:current",
      workload: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "local/alpha:recorded",
        shared: false,
      },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    const logOutput = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errorOutput).toContain("Runtime provider 'docker'");
    expect(errorOutput).toContain("recorded workload receipt");
    expect(logOutput).not.toContain("Sandbox 'alpha' destroyed");
    expect(harness.events).not.toContain("delete");
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.updateSessionSpy).not.toHaveBeenCalled();
  });

  it("retires registry and session ownership after the workload receipt is repaired", async () => {
    const imageTag = "local/alpha:current";
    const harness = createDestroyHarness({
      imageTag,
      workload: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: imageTag,
        shared: false,
      },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.dockerRunSpy).toHaveBeenCalledWith(["rmi", imageTag], {
      ignoreError: true,
      timeout: 30_000,
    });
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(harness.compareAndSwapSessionSpy).toHaveBeenCalledOnce();
    expect(harness.updateSessionSpy).not.toHaveBeenCalled();
    expect(harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Sandbox 'alpha' destroyed",
    );
  });

  it("refuses shields-up Hermes MCP destroy before stopping services or preparing MCP state", async () => {
    const harness = createDestroyHarness({
      agent: "hermes",
      mcpServers: ["github"],
      shieldsDown: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
      "has shields up or an unreadable shields posture",
    );

    expectShieldsUpRefusalBeforeMutation(harness);
  });

  it("does not require mutable Hermes config for a prepared-only add", async () => {
    const harness = createDestroyHarness({
      agent: "hermes",
      mcpAddState: "prepared",
      mcpServers: ["github"],
      shieldsDown: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.prepareMcpBridgesForDestroySpy).toHaveBeenCalledWith("alpha");
  });

  it("does not require mutable Hermes config for absent-sandbox cleanup", async () => {
    const harness = createDestroyHarness({
      agent: "hermes",
      mcpServers: ["github"],
      sandboxPresent: false,
      shieldsDown: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.prepareMcpBridgesForAbsentSandboxDestroySpy).toHaveBeenCalledWith("alpha", {
      force: false,
    });
  });

  it("removes the exact Docker container when OpenShell reports the sandbox absent (#9073)", async () => {
    const containerId = "a".repeat(64);
    const harness = createDestroyHarness({
      sandboxPresent: false,
      dockerOrphanIds: [containerId],
      dockerRunResult: {
        status: 0,
        stdout: `${containerId}\topenshell\tdefault\tsb-alpha`,
      },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.dockerRunSpy).toHaveBeenCalledWith(
      ["rm", "-f", containerId],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
  });

  it("preserves registry state when the absent sandbox has a replacement Docker identity (#9073)", async () => {
    const expectedContainerId = "a".repeat(64);
    const replacementContainerId = "b".repeat(64);
    const harness = createDestroyHarness({
      sandboxPresent: false,
      dockerOrphanIds: [replacementContainerId],
      dockerRunResult: {
        status: 0,
        stdout: `${expectedContainerId}\topenshell\tdefault\tsb-alpha`,
      },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.dockerRunSpy).not.toHaveBeenCalledWith(
      ["rm", "-f", replacementContainerId],
      expect.anything(),
    );
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();
  });

  it("preserves registry state until exact Docker container removal succeeds on retry (#9073)", async () => {
    const containerId = "a".repeat(64);
    const options = {
      sandboxPresent: false,
      dockerOrphanIds: [containerId],
      dockerRemoveStatus: 1,
      dockerRunResult: {
        status: 0,
        stdout: `${containerId}\topenshell\tdefault\tsb-alpha`,
      },
    };
    const harness = createDestroyHarness(options);

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();

    options.dockerRemoveStatus = 0;
    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.dockerRunSpy).toHaveBeenCalledWith(
      ["rm", "-f", containerId],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(harness.retirePortableLifecycleReceiptSpy).toHaveBeenCalledWith("alpha");
  });

  it("preserves registry state when exact Docker container inspection fails (#9073)", async () => {
    const containerId = "a".repeat(64);
    const harness = createDestroyHarness({
      sandboxPresent: false,
      dockerOrphanIds: [containerId],
      dockerOrphanQueryStatus: 1,
      dockerRunResult: {
        status: 0,
        stdout: `${containerId}\topenshell\tdefault\tsb-alpha`,
      },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.dockerRunSpy).not.toHaveBeenCalledWith(
      ["rm", "-f", containerId],
      expect.anything(),
    );
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.retirePortableLifecycleReceiptSpy).not.toHaveBeenCalled();
  });

  it("does not remove the Docker container during forced local cleanup (#9073)", async () => {
    const containerId = "a".repeat(64);
    const harness = createDestroyHarness({
      deleteStatus: 1,
      deleteOutput: "error trying to connect: connection refused",
      dockerOrphanIds: [containerId],
      dockerRunResult: {
        status: 0,
        stdout: `${containerId}\topenshell\tdefault\tsb-alpha`,
      },
    });

    await expect(harness.destroySandbox("alpha", { force: true })).resolves.toBeUndefined();

    expect(harness.events).toContain("delete");
    expect(harness.dockerRunSpy).not.toHaveBeenCalledWith(
      ["rm", "-f", containerId],
      expect.anything(),
    );
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not stop shared host services when --force cleans up the last sandbox with the gateway down (#6046)", async () => {
    // Gateway-unreachable delete failure + --force triggers forcedLocalCleanup:
    // the local record is removed but the gateway-side delete was never
    // confirmed, so the sandbox may still exist. Even as the only registered
    // sandbox, that must not tear down shared host services (CodeRabbit #6050).
    const harness = createDestroyHarness({
      deleteStatus: 1,
      deleteOutput: "error trying to connect: connection refused",
      registeredSandboxCount: 1,
    });

    await expect(harness.destroySandbox("alpha", { force: true })).resolves.toBeUndefined();

    // Local cleanup still proceeds...
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    // ...but shared host services are preserved on the unconfirmed delete.
    expect(harness.stopAllSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(harness.revokeHttpsPinRuntimeAdapterRouteSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("fails closed and restores MCP state when --force cannot confirm sandbox deletion", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      deleteStatus: 1,
      deleteOutput: "error trying to connect: connection refused",
      mcpServers: ["github"],
      registeredSandboxCount: 1,
    });

    await expect(harness.destroySandbox("alpha", { force: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expectMcpRestoreAfterDeleteFailure(harness);
    expect(harness.stopAllSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errorOutput).toContain("MCP ownership required for exact provider cleanup");
    expect(errorOutput).toContain("--force cannot safely discard MCP ownership");
    expect(errorOutput).not.toContain("re-run with --force to remove the local sandbox record");
  });

  it("wipes while mutable, hardens an active timer window, then deletes and clears it", async () => {
    const harness = createDestroyHarness({ activeTimer: true });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expectActiveTimerDestroyOrder(harness);
  });

  it("warns and still deletes when active-window hardening fails after the wipe (#7727)", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      shieldsUpError: new Error("injected hardening failure"),
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expectFailedHardeningStillDeletes(harness);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("keeps the timer and local record when --force cannot confirm deletion after failed hardening (#7727)", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      deleteStatus: 1,
      deleteOutput: "error trying to connect: connection refused",
      registeredSandboxCount: 1,
      shieldsUpError: new Error("injected hardening failure"),
    });

    await expect(harness.destroySandbox("alpha", { force: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expectFailedHardeningRefusesForcedCleanup(harness);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("restores MCP runtime state without a rollback window when delete fails after failed hardening (#7727)", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      deleteStatus: 7,
      deleteOutput: "delete failed",
      mcpServers: ["github"],
      shieldsUpError: new Error("injected hardening failure"),
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expectFailedHardeningMcpRestore(harness);
    expect(exitSpy).toHaveBeenCalledWith(7);
  });

  it("detaches MCP providers before delete and finalizes them only after delete succeeds", async () => {
    const harness = createDestroyHarness({ mcpServers: ["github", "slack"] });

    await harness.destroySandbox("alpha", { yes: true });

    expectMcpFinalizeAfterDelete(harness);
  });

  it("restores MCP runtime state when sandbox delete fails", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      deleteStatus: 7,
      deleteOutput: "delete failed",
      mcpServers: ["github"],
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expectMcpRestoreAfterDeleteFailure(harness);
  });

  it("relocks shields and preserves destroy failure when MCP rollback fails", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      deleteStatus: 7,
      deleteOutput: "delete failed",
      mcpServers: ["github"],
      restoreMcpError: "injected MCP restore failure",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expectFailedMcpRestorePreservesDestroyFailure(harness);
  });

  it("preserves the registry when post-delete MCP cleanup fails, even with force", async () => {
    const harness = createDestroyHarness({
      finalizeMcpError: "provider delete failed",
      mcpServers: ["github"],
    });

    await expect(harness.destroySandbox("alpha", { yes: true, force: true })).rejects.toThrow(
      "provider delete failed",
    );

    expectFailedMcpFinalizePreservesRegistry(harness);
  });

  it("finalizes exact MCP providers when the sandbox was already externally removed", async () => {
    const harness = createDestroyHarness({
      deleteStatus: 1,
      deleteOutput: "Error: sandbox alpha not found",
      mcpServers: ["github"],
      sandboxPresent: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expectAbsentSandboxMcpFinalize(harness);
  });

  it("exits with code 1 when MCP bridge prepare throws McpBridgeError, gateway down (#8103)", async () => {
    const harness = createDestroyHarness({
      mcpServers: ["github"],
      prepareMcpBridgeError: "Could not inspect OpenShell provider: gateway unreachable",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expectMcpPrepareBridgeErrorAborts(harness);
  });

  it("redacts MCP bridge finalize errors after sandbox deletion (#8103)", async () => {
    const secretMarker = "destroy-secret-marker";
    const harness = createDestroyHarness({
      mcpServers: ["github"],
      finalizeMcpBridgeError: `Could not inspect OpenShell provider: OPENAI_API_KEY=${secretMarker}`,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expectMcpFinalizeBridgeErrorReturnsFailure(harness, secretMarker);
  });

  it("retires retained MCP state when destroy retries after finalization failure (#8103)", async () => {
    const harness = createDestroyHarness({
      mcpServers: ["github"],
      finalizeMcpBridgeError: "Could not inspect OpenShell provider: gateway unreachable",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    harness.setSandboxPresent(false);
    harness.finalizeMcpBridgesAfterSandboxDeleteSpy.mockResolvedValue(undefined);

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
    ).resolves.toBeUndefined();

    expect(harness.prepareMcpBridgesForAbsentSandboxDestroySpy).toHaveBeenCalledWith("alpha", {
      force: false,
    });
    expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).toHaveBeenCalledTimes(2);
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(harness.compareAndSwapSessionSpy).toHaveBeenCalledOnce();
    expect(harness.updateSessionSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).toHaveBeenCalledWith(
      "nemoclaw-19080",
      harness.runOpenshellSpy,
    );
  });
});
