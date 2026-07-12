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

describe("runSandboxGpuCreateFlow cleanup and provenance", () => {
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

  it("does not let a stale same-label container authorize or receive fallback cleanup", async () => {
    mocks.queryOpenShellDockerSandboxContainers.mockReturnValue({
      ok: true,
      ids: ["stale-container"],
    });
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output: "error: unexpected argument '--gpu' found",
      sawProgress: false,
    });
    const deps = createDeps();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(mocks.queryOpenShellDockerSandboxRuntimeSnapshot).not.toHaveBeenCalled();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("reports manual cleanup when ordinary readiness deletion fails (#6110)", async () => {
    mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
      ready: false,
      reason: "terminal_failure_phase",
      failurePhase: "Failed",
    });
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockReturnValue({ status: 7, stderr: "gateway unavailable" });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("could not be removed automatically");
    expect(output).toContain('Manual cleanup: openshell sandbox delete "alpha"');
    expect(output).not.toContain("Retry: nemoclaw onboard");
  });

  it("treats an already-absent sandbox as successful ordinary readiness cleanup", async () => {
    mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
      ready: false,
      reason: "terminal_failure_phase",
      failurePhase: "Failed",
    });
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockReturnValue({
      status: 1,
      stderr: "sandbox alpha not found",
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("Retry: nemoclaw onboard");
    expect(output).not.toContain("could not be removed automatically");
  });

  it("fully redacts command diagnostics when cleanup cannot be proven safe", async () => {
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output: "error: unexpected argument '--gpu' found",
      sawProgress: false,
    });
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockImplementation((args) =>
      args[1] === "delete"
        ? { status: 0 }
        : { status: 1, stderr: "NVIDIA_API_KEY=super-secret-cleanup-value" },
    );
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

    const diagnostic = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(diagnostic).toContain("Cleanup could not be proven safe");
    expect(diagnostic).toContain("NVIDIA_API_KEY=<REDACTED>");
    expect(diagnostic).not.toContain("super-secret-cleanup-value");
  });

  it("refuses nvidia-smi fallback when exact native container provenance is unavailable (#6110)", async () => {
    const input = createInput();
    input.prebuild = {
      createArgs: ["--from", "/tmp/build/Dockerfile", "--name", "alpha", "--gpu"],
      imageRef: null,
      imageId: null,
    };
    mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockReturnValue({
      ok: false,
      error: "expected one labeled sandbox container, found 2",
    });
    const deps = createDeps();
    vi.mocked(deps.verifyDirectSandboxGpu).mockReturnValue({
      ...NVIDIA_SMI_FAILED_PROOF,
      detail: "No devices were found",
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });
    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");

    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(deps.openshellArgv).not.toHaveBeenCalled();
  });

  it("ignores create-stream tags and reuses only the inspected immutable image", async () => {
    const input = createInput();
    input.prebuild = {
      createArgs: ["--from", "/tmp/build/Dockerfile", "--name", "alpha", "--gpu"],
      imageRef: null,
      imageId: null,
    };
    mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockReturnValue({
      ok: true,
      imageId: IMAGE_ID,
      bookkeepingImageRef: "openshell/sandbox-from:built",
      stateError: "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
      nativeGpuAttachmentState: "absent",
      containerId: "container-a",
    });
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output:
        "Built image attacker.example/redirect:latest\nCDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
      sawProgress: true,
    });
    const deps = createDeps();

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      route: "compatibility",
      registryImageRef: "openshell/sandbox-from:built",
    });

    expect(deps.openshellArgv).toHaveBeenCalledWith(expect.arrayContaining(["--from", IMAGE_ID]));
    expect(deps.openshellArgv).not.toHaveBeenCalledWith(
      expect.arrayContaining(["--from", "attacker.example/redirect:latest"]),
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledTimes(2);
    expect(mocks.queryOpenShellDockerSandboxRuntimeSnapshot).toHaveBeenCalledOnce();
  });

  it("does not persist an immutable retry ID as the registry image tag", async () => {
    const input = createInput();
    input.prebuild = {
      createArgs: ["--from", "/tmp/build/Dockerfile", "--name", "alpha", "--gpu"],
      imageRef: null,
      imageId: null,
    };
    mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockReturnValue({
      ok: true,
      imageId: IMAGE_ID,
      bookkeepingImageRef: IMAGE_ID,
      stateError: "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
      nativeGpuAttachmentState: "absent",
      containerId: "container-a",
    });
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output: "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
      sawProgress: true,
    });
    const deps = createDeps();

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      route: "compatibility",
      registryImageRef: null,
    });

    expect(deps.openshellArgv).toHaveBeenCalledWith(expect.arrayContaining(["--from", IMAGE_ID]));
  });
});
