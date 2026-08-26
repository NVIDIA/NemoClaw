// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  streamSandboxCreate: vi.fn(),
  waitForCreatedSandboxReadyWithTrace: vi.fn(),
  printReadinessFailure: vi.fn(),
  enforceDockerGpuPatchPreserveNetwork: vi.fn(),
  verifyGpuSandboxAccessAfterReady: vi.fn(),
  createDockerGpuSandboxCreatePatch: vi.fn(),
  printSandboxCreateFailureDiagnostics: vi.fn(),
  collectDockerGpuPatchDiagnostics: vi.fn(),
  queryOpenShellDockerSandboxContainers: vi.fn(),
  queryOpenShellDockerSandboxRuntimeSnapshot: vi.fn(),
}));

vi.mock("../sandbox/create-stream", () => ({ streamSandboxCreate: mocks.streamSandboxCreate }));
vi.mock("./sandbox-readiness-tracing", () => ({
  waitForCreatedSandboxReadyWithTrace: mocks.waitForCreatedSandboxReadyWithTrace,
  printReadinessFailure: mocks.printReadinessFailure,
}));
vi.mock("./docker-gpu-local-inference", () => ({
  enforceDockerGpuPatchPreserveNetwork: mocks.enforceDockerGpuPatchPreserveNetwork,
  verifyGpuSandboxAccessAfterReady: mocks.verifyGpuSandboxAccessAfterReady,
}));
vi.mock("./docker-gpu-sandbox-create", () => ({
  createDockerGpuSandboxCreatePatch: mocks.createDockerGpuSandboxCreatePatch,
}));
vi.mock("./sandbox-create-failure", () => ({
  printSandboxCreateFailureDiagnostics: mocks.printSandboxCreateFailureDiagnostics,
}));
vi.mock("./docker-gpu-patch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./docker-gpu-patch")>()),
  collectDockerGpuPatchDiagnostics: mocks.collectDockerGpuPatchDiagnostics,
}));
vi.mock("./openshell-docker-sandbox-containers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openshell-docker-sandbox-containers")>()),
  queryOpenShellDockerSandboxContainers: mocks.queryOpenShellDockerSandboxContainers,
  queryOpenShellDockerSandboxRuntimeSnapshot: mocks.queryOpenShellDockerSandboxRuntimeSnapshot,
}));

import {
  createGpuFlowDeps as createDeps,
  createGpuFlowInput as createInput,
  createGpuPatchFixture,
  GPU_IMAGE_ID,
  resetGpuFlowMocks,
  setupGpuFlowMocks,
} from "./__test-helpers__/sandbox-gpu-create-flow";
import type {
  ManagedBootstrapNativeGpuFallbackOwnerCleanupHandoff,
  ManagedBootstrapRuntimeCreateLifecycleInput,
  ManagedBootstrapRuntimePatch,
  ManagedBootstrapRuntimeSnapshot,
} from "./managed-bootstrap/runtime-create";
import {
  cleanupNativeGpuFailureForFallback,
  executeSandboxGpuCreatePlan,
} from "./sandbox-gpu-create-attempt";
import type {
  SandboxGpuCreateFlowDeps,
  SandboxGpuCreateFlowInput,
} from "./sandbox-gpu-create-flow";
import { createSandboxGpuCreateAttemptRunner } from "./sandbox-gpu-create-run-attempt";

const HANDOFF: ManagedBootstrapNativeGpuFallbackOwnerCleanupHandoff = Object.freeze({
  kind: "openshell-owner-cleanup-required",
  sandboxName: "alpha",
  sandboxId: "sandbox-alpha",
  runtimeId: "runtime-alpha",
});

const SNAPSHOT: ManagedBootstrapRuntimeSnapshot = Object.freeze({
  imageId: GPU_IMAGE_ID,
  bookkeepingImageRef: "openshell/sandbox-from:test",
  stateError: "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
  nativeGpuAttachmentState: "absent",
});

function createManagedFallbackScenario(): {
  input: SandboxGpuCreateFlowInput;
  deps: SandboxGpuCreateFlowDeps;
  rollback: ReturnType<typeof vi.fn>;
  completeOwnerCleanup: ReturnType<typeof vi.fn>;
} {
  const input = createInput();
  const deps = createDeps();
  vi.mocked(deps.runCaptureOpenshell).mockImplementation((args) =>
    args[1] === "get" ? "Name: alpha\nID: sandbox-alpha\nState: Ready\n" : "alpha Ready",
  );
  const rollback = vi.fn(async (request) =>
    request?.ownerCleanupHandoff === "native-gpu-fallback" ? HANDOFF : undefined,
  );
  const patch: ManagedBootstrapRuntimePatch = {
    ...createGpuPatchFixture(),
    rollbackManagedStartupAfterCreateFailure: rollback,
    verifyGpuOrExit: async (verifyDirectSandboxGpu) => verifyDirectSandboxGpu(input.sandboxName),
  };
  const completeOwnerCleanup = vi.fn(async () => HANDOFF);
  const createLifecycle = (options: ManagedBootstrapRuntimeCreateLifecycleInput) => ({
    launchArgv: options.launchArgv,
    patch,
    inspectNativeRuntime: () => SNAPSHOT,
    completeNativeGpuFallbackOwnerCleanup: completeOwnerCleanup,
    recoverUnfinished: async () => ({ receipts: [], failures: [] }),
    prepareNetwork: async () => undefined,
    runCreate: async <T>(
      start: (held: {
        readonly heldWorkloadArgv: readonly string[];
        readonly bootstrapIdentity: string;
      }) => Promise<{ readonly value: T }>,
    ): Promise<T> =>
      (
        await start({
          heldWorkloadArgv: options.heldWorkloadArgv,
          bootstrapIdentity: options.bootstrapIdentity,
        })
      ).value,
  });
  input.managedBootstrap = {
    bootstrapIdentity: "e".repeat(64),
    stateRoot: "/tmp/nemoclaw-managed-fallback-test",
    runtimeProvider: {
      identity: { id: "docker" },
      bootstrap: {
        createOnboardRouting: () => ({
          nativeFallbackHasCleanBaseline: true,
          inspectNativeRuntime: () => SNAPSHOT,
          isNativeCreateRoutingFailure: () => false,
          isTrustedNativeRuntimeError: () => true,
          isNativeReadinessRoutingFailure: () => true,
          prepareCompatibilityLaunch: () => ({
            createArgv: ["openshell", "sandbox", "create", "--from", GPU_IMAGE_ID],
            registryImageRef: "openshell/sandbox-from:test",
          }),
        }),
        createLifecycle,
      },
    },
    request: {},
    image: {
      repository: "registry.example/nemoclaw-hermes",
      manifestDigest: `sha256:${"d".repeat(64)}`,
    },
    agentIdentity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
    intendedWorkloadArgv: ["hermes"],
    expectedSupervisorArgv: ["/sandbox/supervisor"],
    authorityStore: {},
  } as unknown as NonNullable<SandboxGpuCreateFlowInput["managedBootstrap"]>;
  return { input, deps, rollback, completeOwnerCleanup };
}

beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(resetGpuFlowMocks);

describe("managed-bootstrap native GPU fallback cleanup", () => {
  it.each([
    {
      stage: "create" as const,
      arrange: () =>
        mocks.streamSandboxCreate.mockResolvedValueOnce({
          status: 1,
          output: SNAPSHOT.stateError,
          sawProgress: true,
        }),
    },
    {
      stage: "readiness" as const,
      arrange: () =>
        mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValueOnce({
          ready: false,
          reason: "terminal_failure_phase",
          failurePhase: "Error",
        }),
    },
  ])(
    "retains exact owner cleanup after a managed $stage failure (#10155)",
    async ({ stage, arrange }) => {
      const { input, deps, rollback, completeOwnerCleanup } = createManagedFallbackScenario();
      arrange();
      const attemptRunner = createSandboxGpuCreateAttemptRunner(input, deps);
      const runAttempt = vi.fn(attemptRunner.runAttempt);
      const activateCompatibilityAttempt = vi.fn();

      const result = await executeSandboxGpuCreatePlan("native-with-fallback", {
        runAttempt,
        prepareCompatibilityAttempt: vi.fn(),
        cleanupNativeFailure: (failure) =>
          cleanupNativeGpuFailureForFallback(input.sandboxName, failure, {
            runOpenshell: deps.runOpenshell,
            sleep: deps.sleep,
          }),
        activateCompatibilityAttempt,
      });

      expect(result).toMatchObject({
        ok: false,
        route: "native",
        stage,
        nativeCleanupHandoff: HANDOFF,
        cleanupRefused:
          "managed bootstrap owner cleanup is required for the exact sandbox and runtime identities",
      });
      expect(runAttempt).toHaveBeenCalledOnce();
      expect(runAttempt).toHaveBeenCalledWith("native");
      expect(activateCompatibilityAttempt).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledWith({ ownerCleanupHandoff: "native-gpu-fallback" });
      expect(completeOwnerCleanup).toHaveBeenCalledWith(HANDOFF);
      expect(deps.runOpenshell).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
    },
  );
});
