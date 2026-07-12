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
  GPU_IMAGE_ID as IMAGE_ID,
  resetGpuFlowMocks,
  setupGpuFlowMocks,
  VERIFIED_GPU_PROOF as VERIFIED_PROOF,
} from "./__test-helpers__/sandbox-gpu-create-flow";
import { runSandboxGpuCreateFlow } from "./sandbox-gpu-create-flow";

function failNativeCreate(): void {
  mocks.streamSandboxCreate.mockResolvedValueOnce({
    status: 1,
    output: "error: unexpected argument '--gpu' found",
    sawProgress: false,
  });
}

async function expectFlowExit(
  input: ReturnType<typeof createInput>,
  deps: ReturnType<typeof createDeps>,
): Promise<void> {
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit:1");
  });
  await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");
}

function expectNativeStateKept(deps: ReturnType<typeof createDeps>): void {
  expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
  expect(deps.runOpenshell).not.toHaveBeenCalledWith(
    ["sandbox", "delete", "alpha"],
    expect.anything(),
  );
}

function errorOutput(): string {
  return vi.mocked(console.error).mock.calls.flat().join("\n");
}

describe("runSandboxGpuCreateFlow fallback ordering", () => {
  beforeEach(() => setupGpuFlowMocks(mocks));
  afterEach(resetGpuFlowMocks);

  it("retries readiness only for exact-container host runtime evidence (#6110)", async () => {
    mocks.waitForCreatedSandboxReadyWithTrace
      .mockReturnValueOnce({
        ready: false,
        reason: "terminal_failure_phase",
        failurePhase: "Error",
      })
      .mockReturnValue({ ready: true, reason: "ready", failurePhase: null });
    mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockReturnValue({
      ok: true,
      imageId: IMAGE_ID,
      bookkeepingImageRef: "openshell/sandbox-from:test",
      stateError: "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
      nativeGpuAttachmentState: "absent",
      containerId: "container-a",
    });

    await expect(runSandboxGpuCreateFlow(createInput(), createDeps())).resolves.toMatchObject({
      route: "compatibility",
      registryImageRef: "openshell/sandbox-from:test",
    });

    expect(mocks.streamSandboxCreate).toHaveBeenCalledTimes(2);
  });

  it("streams native and compatibility attempts through direct argv without a shell (#6110)", async () => {
    failNativeCreate();
    const input = createInput();

    await expect(runSandboxGpuCreateFlow(input, createDeps())).resolves.toMatchObject({
      route: "compatibility",
    });

    expect(mocks.streamSandboxCreate).toHaveBeenNthCalledWith(
      1,
      "openshell",
      ["sandbox", "create", "--gpu"],
      input.sandboxEnv,
      expect.objectContaining({
        onPoll: expect.any(Function),
        readyCheck: expect.any(Function),
      }),
    );
    expect(mocks.streamSandboxCreate).toHaveBeenNthCalledWith(
      2,
      "openshell",
      expect.arrayContaining(["sandbox", "create", "--from", IMAGE_ID]),
      input.sandboxEnv,
      expect.any(Object),
    );
    expect(mocks.streamSandboxCreate.mock.calls.flat()).not.toContain("bash");
    expect(mocks.streamSandboxCreate.mock.calls.flat()).not.toContain("-lc");
  });

  it("discloses the compatibility container-swap confinement tradeoff and native-only opt-out", async () => {
    failNativeCreate();
    const deps = createDeps();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).resolves.toMatchObject({
      route: "compatibility",
    });

    const warning = vi.mocked(console.warn).mock.calls.flat().join("\n");
    expect(warning).toContain("recreating the OpenShell-managed Docker container");
    expect(warning).toContain("legacy GPU compatibility envelope");
    expect(warning).toContain("may relax container confinement");
    expect(warning).toContain("NEMOCLAW_DOCKER_GPU_PATCH=fallback");
    expect(warning).toContain("explicitly authorized");
    expect(mocks.streamSandboxCreate).toHaveBeenCalledTimes(2);
    expect(mocks.waitForCreatedSandboxReadyWithTrace).toHaveBeenCalledWith(
      expect.objectContaining({ stableReadyPolls: 2 }),
    );
  });

  it("runs the local-provider bridge preflight only after selecting compatibility fallback", async () => {
    const input = createInput();
    input.provider = "ollama-local";
    input.sandboxEnv = {
      NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "host",
    };
    input.sandboxGpuConfig.sandboxGpuProof = VERIFIED_PROOF;
    failNativeCreate();
    const deps = createDeps();

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      route: "compatibility",
    });

    expect(mocks.enforceDockerGpuPatchPreserveNetwork).toHaveBeenCalledOnce();
    expect(mocks.enforceDockerGpuPatchPreserveNetwork).toHaveBeenCalledWith(
      "ollama-local",
      input.sandboxGpuConfig,
      expect.objectContaining({
        dockerDriverGateway: true,
        selectedRoute: "compatibility",
        gatewayPort: 8080,
      }),
    );
    const cleanupComplete =
      mocks.queryOpenShellDockerSandboxContainers.mock.invocationCallOrder.at(-1) ??
      Number.POSITIVE_INFINITY;
    const networkPrepared = mocks.enforceDockerGpuPatchPreserveNetwork.mock.invocationCallOrder[0];
    const compatibilityCreate = mocks.streamSandboxCreate.mock.invocationCallOrder[1];
    expect(cleanupComplete).toBeLessThan(networkPrepared);
    expect(networkPrepared).toBeLessThan(compatibilityCreate);
    expect(input.sandboxGpuConfig.sandboxGpuProof).toBeNull();
  });

  it("validates the full compatibility command before deleting native state (#6110)", async () => {
    const input = createInput();
    input.compatibilityPolicyPath = null;
    failNativeCreate();
    const deps = createDeps();
    await expectFlowExit(input, deps);
    expectNativeStateKept(deps);
    expect(errorOutput()).toContain("Compatibility retry policy was not materialized");
  });

  it("keeps native state when compatibility command rendering fails (#6110)", async () => {
    failNativeCreate();
    const deps = createDeps();
    vi.mocked(deps.openshellArgv).mockImplementation(() => {
      throw new Error("compatibility command render rejected");
    });
    await expectFlowExit(createInput(), deps);
    expectNativeStateKept(deps);
    expect(errorOutput()).toContain("compatibility command render rejected");
  });

  it("runs compatibility network preflight only after native cleanup succeeds (#6110)", async () => {
    const input = createInput();
    input.provider = "ollama-local";
    failNativeCreate();
    mocks.enforceDockerGpuPatchPreserveNetwork.mockRejectedValueOnce(
      new Error("compatibility bridge is unreachable"),
    );
    const deps = createDeps();
    await expectFlowExit(input, deps);
    expect(deps.openshellArgv).toHaveBeenCalledOnce();
    expect(deps.runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(errorOutput()).toContain("compatibility bridge is unreachable");
  });
});
