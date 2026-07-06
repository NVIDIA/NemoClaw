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
  queryOpenShellDockerSandboxImage: vi.fn(),
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
  queryOpenShellDockerSandboxImage: mocks.queryOpenShellDockerSandboxImage,
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
    createCommand: "openshell sandbox create --gpu",
    sandboxEnv: {},
    sandboxStartupCommand: ["nemoclaw-start"],
    prebuild: {
      createArgs: ["--from", "openshell/sandbox-from:test", "--name", "alpha", "--gpu"],
      imageRef: "openshell/sandbox-from:test",
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
    openshellShellCommand: vi.fn((args: string[]) => args.join(" ")),
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

describe("runSandboxGpuCreateFlow fallback eligibility", () => {
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
      options.verifyDirectSandboxGpu(options.sandboxName),
    );
    mocks.enforceDockerGpuPatchPreserveNetwork.mockResolvedValue(false);
    mocks.collectDockerGpuPatchDiagnostics.mockReturnValue(null);
    mocks.queryOpenShellDockerSandboxContainers.mockReturnValue({ ok: true, ids: [] });
    mocks.queryOpenShellDockerSandboxImage.mockReturnValue({
      ok: true,
      imageRef: "openshell/sandbox-from:test",
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
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

  it("does not retry compatibility for a non-GPU native readiness failure (#6110)", async () => {
    mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
      ready: false,
      reason: "terminal_failure_phase",
      failurePhase: "Failed",
    });
    const deps = createDeps();
    vi.mocked(deps.runCaptureOpenshell).mockReturnValue("alpha Failed policy denied startup exec");
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

  it("discloses the compatibility container-swap confinement tradeoff and native-only opt-out", async () => {
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output: "error: unexpected argument '--gpu' found",
      sawProgress: false,
    });
    const deps = createDeps();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).resolves.toMatchObject({
      route: "compatibility",
    });

    const warning = vi.mocked(console.warn).mock.calls.flat().join("\n");
    expect(warning).toContain("recreating the OpenShell-managed Docker container");
    expect(warning).toContain("legacy GPU compatibility envelope");
    expect(warning).toContain("may relax container confinement");
    expect(warning).toContain("NEMOCLAW_DOCKER_GPU_PATCH=0");
    expect(warning).toContain("native-only behavior");
    expect(mocks.streamSandboxCreate).toHaveBeenCalledTimes(2);
    expect(mocks.waitForCreatedSandboxReadyWithTrace).toHaveBeenCalledWith(
      expect.objectContaining({ stableReadyPolls: 2 }),
    );
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

  it("runs the local-provider bridge preflight only after selecting compatibility fallback", async () => {
    const input = createInput();
    input.provider = "ollama-local";
    input.sandboxEnv = {
      NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "host",
    };
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output: "error: unexpected argument '--gpu' found",
      sawProgress: false,
    });

    await expect(runSandboxGpuCreateFlow(input, createDeps())).resolves.toMatchObject({
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

  it("reuses the built image when native CDI injection fails after the build", async () => {
    const input = createInput();
    input.prebuild = {
      createArgs: ["--from", "/tmp/build/Dockerfile", "--name", "alpha", "--gpu"],
      imageRef: null,
    };
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output:
        "Built image openshell/sandbox-from:built\nCDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
      sawProgress: true,
    });
    const deps = createDeps();

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      route: "compatibility",
      selectedCreateImageRef: "openshell/sandbox-from:built",
    });

    expect(deps.openshellShellCommand).toHaveBeenCalledWith(
      expect.arrayContaining(["--from", "openshell/sandbox-from:built"]),
    );
    expect(deps.openshellShellCommand).not.toHaveBeenCalledWith(
      expect.arrayContaining(["--from", "/tmp/build/Dockerfile"]),
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledTimes(2);
  });
});
