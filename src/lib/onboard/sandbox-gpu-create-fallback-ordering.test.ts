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

describe("runSandboxGpuCreateFlow fallback ordering", () => {
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
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output: "error: unexpected argument '--gpu' found",
      sawProgress: false,
    });
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

  it("validates the full compatibility command before deleting native state (#6110)", async () => {
    const input = createInput();
    input.compatibilityPolicyPath = null;
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output: "error: unexpected argument '--gpu' found",
      sawProgress: false,
    });
    const deps = createDeps();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");

    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "Compatibility retry policy was not materialized",
    );
  });

  it("keeps native state when compatibility command rendering fails (#6110)", async () => {
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output: "error: unexpected argument '--gpu' found",
      sawProgress: false,
    });
    const deps = createDeps();
    vi.mocked(deps.openshellArgv).mockImplementation(() => {
      throw new Error("compatibility command render rejected");
    });
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
      "compatibility command render rejected",
    );
  });

  it("keeps native state when compatibility network preflight fails (#6110)", async () => {
    const input = createInput();
    input.provider = "ollama-local";
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output: "error: unexpected argument '--gpu' found",
      sawProgress: false,
    });
    mocks.enforceDockerGpuPatchPreserveNetwork.mockRejectedValueOnce(
      new Error("compatibility bridge is unreachable"),
    );
    const deps = createDeps();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");

    expect(deps.openshellArgv).toHaveBeenCalledOnce();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "compatibility bridge is unreachable",
    );
  });
});
