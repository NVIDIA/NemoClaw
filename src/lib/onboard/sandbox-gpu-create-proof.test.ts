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

vi.mock("../sandbox/create-stream", () => ({
  streamSandboxCreate: mocks.streamSandboxCreate,
}));

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

import type { SandboxGpuProofResult } from "../state/registry";
import {
  runSandboxGpuCreateFlow,
  type SandboxGpuCreateFlowDeps,
  type SandboxGpuCreateFlowInput,
} from "./sandbox-gpu-create-flow";

const VERIFIED_PROOF: SandboxGpuProofResult = {
  status: "verified",
  cudaVerified: true,
  label: "CUDA initialization",
  detail: null,
  at: "2026-07-06T00:00:00.000Z",
};
const FAILED_PROOF: SandboxGpuProofResult = {
  status: "failed",
  cudaVerified: false,
  label: "cuInit(0) via libcuda.so.1",
  detail: "cuInit(0)=999",
  at: "2026-07-06T00:00:00.000Z",
};
const NVIDIA_SMI_FAILED_PROOF: SandboxGpuProofResult = {
  status: "failed",
  cudaVerified: false,
  label: "nvidia-smi when available",
  detail: "Failed to initialize NVML: Driver/library version mismatch",
  at: "2026-07-06T00:00:00.000Z",
};
const IMAGE_ID = `sha256:${"a".repeat(64)}`;

function createInput(): SandboxGpuCreateFlowInput {
  return {
    sandboxName: "alpha",
    provider: "nim",
    sandboxGpuConfig: {
      mode: "1",
      hostGpuDetected: true,
      hostGpuPlatform: null,
      sandboxGpuEnabled: true,
      sandboxGpuDevice: null,
      errors: [],
    },
    gpuRoutePlan: "native-with-fallback",
    initialGpuRoute: "native",
    compatibilityPolicyPath: "/tmp/compatibility-policy.yaml",
    dockerDriverGateway: true,
    gatewayPort: 8080,
    sandboxReadyTimeoutSecs: 60,
    createArgv: ["openshell", "sandbox", "create", "--gpu"],
    sandboxEnv: {},
    sandboxStartupCommand: ["nemoclaw-start"],
    prebuild: {
      createArgs: ["--from", "openshell/sandbox-from:test", "--name", "alpha", "--gpu"],
      imageRef: "openshell/sandbox-from:test",
      imageId: IMAGE_ID,
    },
    restoreBackupPath: null,
    terminalAgent: false,
  };
}

function createDeps(): SandboxGpuCreateFlowDeps {
  return {
    runOpenshell: vi.fn(() => ({ status: 0 })),
    runCaptureOpenshell: vi.fn(() => "alpha Ready"),
    sleep: vi.fn(),
    openshellArgv: vi.fn((args: string[]) => ["openshell", ...args]),
    verifyDirectSandboxGpu: vi.fn(() => VERIFIED_PROOF),
  };
}

function createPatch() {
  return {
    maybeApplyDuringCreate: vi.fn(),
    createFailureMessage: vi.fn(() => null),
    exitOnPatchError: vi.fn(),
    ensureApplied: vi.fn(),
    waitForSupervisorReconnectIfNeeded: vi.fn(),
    selectedMode: vi.fn(() => null),
    printReadinessFailureIfEnabled: vi.fn(),
    verifyGpuOrExit: vi.fn(() => VERIFIED_PROOF),
  };
}

describe("runSandboxGpuCreateFlow proof authorization", () => {
  beforeEach(() => {
    mocks.streamSandboxCreate.mockResolvedValue({
      status: 0,
      output: "Created sandbox: alpha",
      sawProgress: true,
    });
    mocks.createDockerGpuSandboxCreatePatch.mockImplementation(createPatch);
    mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
      ready: true,
      reason: "ready",
      failurePhase: null,
    });
    mocks.verifyGpuSandboxAccessAfterReady.mockImplementation((_config, options) =>
      options.verifyGpuOrExit
        ? options.verifyGpuOrExit(options.verifyDirectSandboxGpu)
        : options.verifyDirectSandboxGpu(options.sandboxName),
    );
    mocks.enforceDockerGpuPatchPreserveNetwork.mockResolvedValue(false);
    mocks.collectDockerGpuPatchDiagnostics.mockReturnValue(null);
    mocks.queryOpenShellDockerSandboxContainers.mockReturnValue({ ok: true, ids: [] });
    mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockReturnValue({
      ok: true,
      imageId: IMAGE_ID,
      bookkeepingImageRef: "openshell/sandbox-from:test",
      stateError: "",
      nativeGpuAttachmentState: "present",
      containerId: "container-a",
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("does not retry compatibility when the native proof throws an exec/policy error (#6110)", async () => {
    const deps = createDeps();
    vi.mocked(deps.verifyDirectSandboxGpu).mockImplementation(() => {
      throw new Error("openshell sandbox exec denied by policy");
    });

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow(
      "openshell sandbox exec denied by policy",
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("does not let sandbox-controlled CUDA output authorize compatibility fallback (#6110)", async () => {
    const deps = createDeps();
    vi.mocked(deps.verifyDirectSandboxGpu).mockReturnValue(FAILED_PROOF);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "cannot authorize a less-confined compatibility retry",
    );
  });

  it("retries structured nvidia-smi failure only when host config proves no GPU attachment (#6110)", async () => {
    const deps = createDeps();
    vi.mocked(deps.verifyDirectSandboxGpu)
      .mockReturnValueOnce(NVIDIA_SMI_FAILED_PROOF)
      .mockReturnValue(VERIFIED_PROOF);
    mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockReturnValue({
      ok: true,
      imageId: IMAGE_ID,
      bookkeepingImageRef: "openshell/sandbox-from:test",
      stateError: "",
      nativeGpuAttachmentState: "absent",
      containerId: "container-a",
    });

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).resolves.toMatchObject({
      route: "compatibility",
      registryImageRef: "openshell/sandbox-from:test",
    });

    expect(mocks.streamSandboxCreate).toHaveBeenCalledTimes(2);
    expect(deps.runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ suppressOutput: true }),
    );
  });

  it.each([
    "present",
    "unknown",
  ] as const)("fails closed on sandbox nvidia-smi text when host GPU attachment is %s", async (nativeGpuAttachmentState) => {
    const deps = createDeps();
    vi.mocked(deps.verifyDirectSandboxGpu).mockReturnValue(NVIDIA_SMI_FAILED_PROOF);
    mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockReturnValue({
      ok: true,
      imageId: IMAGE_ID,
      bookkeepingImageRef: "openshell/sandbox-from:test",
      stateError: "",
      nativeGpuAttachmentState,
      containerId: "container-a",
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(mocks.queryOpenShellDockerSandboxRuntimeSnapshot).toHaveBeenCalledOnce();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "without corroborating host evidence cannot authorize",
    );
  });

  it("stops after one compatibility retry when its GPU proof also fails", async () => {
    const deps = createDeps();
    vi.mocked(deps.verifyDirectSandboxGpu).mockReturnValue(NVIDIA_SMI_FAILED_PROOF);
    mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockReturnValue({
      ok: true,
      imageId: IMAGE_ID,
      bookkeepingImageRef: "openshell/sandbox-from:test",
      stateError: "",
      nativeGpuAttachmentState: "absent",
      containerId: "container-a",
    });
    const nativePatch = createPatch();
    const compatibilityPatch = createPatch();
    compatibilityPatch.verifyGpuOrExit.mockReturnValue(NVIDIA_SMI_FAILED_PROOF);
    mocks.createDockerGpuSandboxCreatePatch
      .mockReturnValueOnce(nativePatch)
      .mockReturnValueOnce(compatibilityPatch);

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow(
      "Sandbox GPU proof returned failed status",
    );

    expect(mocks.streamSandboxCreate).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(deps.runOpenshell)
        .mock.calls.filter(([args]) => (args as string[]).includes("delete")),
    ).toHaveLength(1);
  });

  it("hard-stops a returned failed proof in compatibility-only mode", async () => {
    const input = createInput();
    input.gpuRoutePlan = "compatibility-only";
    input.initialGpuRoute = "compatibility";
    mocks.createDockerGpuSandboxCreatePatch.mockImplementation(() => {
      const patch = createPatch();
      patch.verifyGpuOrExit.mockReturnValue(NVIDIA_SMI_FAILED_PROOF);
      return patch;
    });

    await expect(runSandboxGpuCreateFlow(input, createDeps())).rejects.toThrow(
      "Sandbox GPU proof returned failed status",
    );

    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
  });
});
