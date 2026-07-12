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

describe("runSandboxGpuCreateFlow native failure and readiness", () => {
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

  it("persists the Hermes startup command on the no-GPU Docker route", async () => {
    const input = createInput();
    input.sandboxGpuConfig = {
      ...input.sandboxGpuConfig,
      mode: "0",
      sandboxGpuEnabled: false,
    };
    input.gpuRoutePlan = "none";
    input.initialGpuRoute = "none";
    input.createArgv = ["openshell", "sandbox", "create"];
    input.persistStartupCommand = true;

    await expect(runSandboxGpuCreateFlow(input, createDeps())).resolves.toMatchObject({
      route: "none",
    });

    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ route: "none", persistStartupCommand: true }),
    );
  });

  it("does not replace a native GPU container solely to persist its startup command", async () => {
    const input = createInput();
    input.persistStartupCommand = true;

    await expect(runSandboxGpuCreateFlow(input, createDeps())).resolves.toMatchObject({
      route: "native",
    });

    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ route: "native", persistStartupCommand: false }),
    );
  });

  it.each([
    {
      failure: "image build",
      output: "Docker build failed while compiling a GPU Python package for --gpu support",
    },
    {
      failure: "image upload",
      output: "[progress] Uploaded to gateway\nfailed to upload image tar into container",
    },
    {
      failure: "TLS handshake",
      output: "x509: certificate signed by unknown authority",
    },
    {
      failure: "provider credential validation",
      output: "Provider credential validation failed: required token is unavailable",
    },
    {
      failure: "policy application",
      output: "Sandbox policy application failed: requested policy was denied",
    },
  ])("does not retry compatibility for a $failure failure (#6110)", async ({ output }) => {
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output,
      sawProgress: true,
    });
    const deps = createDeps();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");
    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledOnce();
    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ route: "native" }),
    );
    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("redacts create errors and preserves their exact nonzero status (#6110)", async () => {
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 19,
      output: "provider failed with NVIDIA_API_KEY=super-secret-create-value",
      sawProgress: true,
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:19");
    });

    await expect(runSandboxGpuCreateFlow(createInput(), createDeps())).rejects.toThrow(
      "process.exit:19",
    );

    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(exit).toHaveBeenCalledWith(19);
    expect(output).toMatch(/NVIDIA_API_KEY=[^\n]*\*+/);
    expect(output).not.toContain("super-secret-create-value");
  });

  it("does not retry compatibility for a non-GPU native readiness failure (#6110)", async () => {
    mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
      ready: false,
      reason: "terminal_failure_phase",
      failurePhase: "Failed",
    });
    const deps = createDeps();
    vi.mocked(deps.runCaptureOpenshell).mockReturnValue(
      "gpu-device-initialization-failed Failed\nother-sandbox Error NVIDIA GPU device unavailable",
    );
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");
    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(mocks.verifyGpuSandboxAccessAfterReady).not.toHaveBeenCalled();
    expect(deps.runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
  });

  it("preserves a nonzero create status when separate readiness polling fails (#6110)", async () => {
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 23,
      output: "Created sandbox: alpha",
      sawProgress: true,
    });
    mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
      ready: false,
      reason: "timeout",
      failurePhase: null,
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:23");
    });

    await expect(runSandboxGpuCreateFlow(createInput(), createDeps())).rejects.toThrow(
      "process.exit:23",
    );

    expect(exit).toHaveBeenCalledWith(23);
  });

  it("keeps native readiness on the single-Ready contract", async () => {
    const deps = createDeps();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).resolves.toMatchObject({
      route: "native",
    });

    expect(mocks.waitForCreatedSandboxReadyWithTrace).toHaveBeenCalledWith(
      expect.objectContaining({ stableReadyPolls: 1 }),
    );
    expect(mocks.enforceDockerGpuPatchPreserveNetwork).not.toHaveBeenCalled();
  });
});
