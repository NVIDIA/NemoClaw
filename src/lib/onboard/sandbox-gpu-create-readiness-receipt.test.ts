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

import {
  createGpuFlowDeps as createDeps,
  createGpuFlowInput as createInput,
  createGpuPatchFixture as createPatch,
  GPU_IMAGE_ID as IMAGE_ID,
  resetGpuFlowMocks,
  setupGpuFlowMocks,
} from "./__test-helpers__/sandbox-gpu-create-flow";
import {
  runSandboxGpuCreateFlow,
  type SandboxGpuCreateFlowDeps,
  type SandboxGpuCreateFlowInput,
} from "./sandbox-gpu-create-flow";

function mockExit(status = 1) {
  return vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error(`process.exit:${status}`);
  });
}

async function expectFlowExit(
  input: SandboxGpuCreateFlowInput,
  deps: SandboxGpuCreateFlowDeps,
): Promise<void> {
  mockExit();
  await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");
}

function errorOutput(): string {
  return vi.mocked(console.error).mock.calls.flat().join("\n");
}

function expectLifecycleReceipt(expected: readonly string[]): void {
  const lines = vi.mocked(console.error).mock.calls.flat().map(String);
  const start = lines.indexOf("  Sandbox lifecycle receipt:");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(lines.slice(start, start + expected.length)).toEqual(expected);
}

function mockTimeout(): void {
  mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
    ready: false,
    reason: "timeout",
    failurePhase: null,
  });
}

function mockTerminalFailure(failurePhase = "Failed"): void {
  mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
    ready: false,
    reason: "terminal_failure_phase",
    failurePhase,
  });
}

function mockRuntimeSnapshot(overrides: Record<string, unknown> = {}): void {
  mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockReturnValue({
    ok: true,
    imageId: IMAGE_ID,
    bookkeepingImageRef: "openshell/sandbox-from:test",
    stateError: "",
    deviceRequests: null,
    devices: null,
    runtime: "nvidia",
    nvidiaVisibleDevices: "all",
    nativeGpuAttachmentState: "present",
    containerId: "container-a",
    ...overrides,
  });
}

beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(resetGpuFlowMocks);

describe("runSandboxGpuCreateFlow readiness receipts", () => {
  it("emits a terminal-phase receipt after ordinary cleanup succeeds (#3344)", async () => {
    mockTerminalFailure();
    const deps = createDeps();

    await expectFlowExit(createInput(), deps);

    expect(deps.runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expectLifecycleReceipt([
      "  Sandbox lifecycle receipt:",
      "    state: created_but_not_ready",
      "    sandbox: alpha",
      "    readiness_gate: sandbox_list:Failed",
      "    readiness_reason: terminal_failure_phase",
      "    create_stream_status: 0",
      "    timeout_seconds: 60",
      "    terminal_resolution: terminal_failure_deleted",
    ]);
    expect(errorOutput()).toContain("Retry: nemoclaw onboard");
  });

  it("preserves a nonzero create status in a timeout receipt and process exit (#3344)", async () => {
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 23,
      output: "Created sandbox: alpha",
      sawProgress: true,
    });
    mockTimeout();
    const exit = mockExit(23);

    await expect(runSandboxGpuCreateFlow(createInput(), createDeps())).rejects.toThrow(
      "process.exit:23",
    );

    expect(exit).toHaveBeenCalledWith(23);
    expectLifecycleReceipt([
      "  Sandbox lifecycle receipt:",
      "    state: created_but_not_ready",
      "    sandbox: alpha",
      "    readiness_gate: sandbox_list:not_ready_timeout",
      "    readiness_reason: timeout",
      "    create_stream_status: 23",
      "    timeout_seconds: 60",
      "    terminal_resolution: timed_out_deleted",
    ]);
  });

  it("defers compatibility cleanup without advertising an unsafe retry (#3344)", async () => {
    const input = createInput();
    input.gpuRoutePlan = "compatibility-only";
    input.initialGpuRoute = "compatibility";
    mockTimeout();
    const compatibilityPatch = createPatch();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(compatibilityPatch);
    const deps = createDeps();

    await expectFlowExit(input, deps);

    expectLifecycleReceipt([
      "  Sandbox lifecycle receipt:",
      "    state: created_but_not_ready",
      "    sandbox: alpha",
      "    readiness_gate: sandbox_list:not_ready_timeout",
      "    readiness_reason: timeout",
      "    create_stream_status: 0",
      "    timeout_seconds: 60",
      "    terminal_resolution: deferred_to_docker_gpu_patch",
    ]);
    expect(compatibilityPatch.printReadinessFailureIfEnabled).toHaveBeenCalledOnce();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(errorOutput()).not.toContain("Retry: nemoclaw onboard");
  });

  it("keeps native readiness fallback diagnostic nonterminal until compatibility runs (#3344)", async () => {
    mocks.waitForCreatedSandboxReadyWithTrace
      .mockReturnValueOnce({
        ready: false,
        reason: "terminal_failure_phase",
        failurePhase: "Error",
      })
      .mockReturnValueOnce({ ready: true, reason: "ready", failurePhase: null });
    mockRuntimeSnapshot({
      stateError: "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
    });

    await expect(runSandboxGpuCreateFlow(createInput(), createDeps())).resolves.toMatchObject({
      route: "compatibility",
    });

    expect(mocks.printReadinessFailure).toHaveBeenCalledOnce();
    expect(errorOutput()).not.toContain("Sandbox lifecycle receipt");
  });

  it("retains the sandbox and suppresses retry when ordinary deletion fails (#3344)", async () => {
    mockTerminalFailure();
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockReturnValue({ status: 7, stderr: "gateway unavailable" });

    await expectFlowExit(createInput(), deps);

    expectLifecycleReceipt([
      "  Sandbox lifecycle receipt:",
      "    state: created_but_not_ready",
      "    sandbox: alpha",
      "    readiness_gate: sandbox_list:Failed",
      "    readiness_reason: terminal_failure_phase",
      "    create_stream_status: 0",
      "    timeout_seconds: 60",
      "    terminal_resolution: terminal_failure_retained",
    ]);
    expect(errorOutput()).toContain("Could not remove the failed sandbox. Manual cleanup:");
    expect(errorOutput()).toContain('openshell sandbox delete "alpha"');
    expect(errorOutput()).not.toContain("Retry: nemoclaw onboard");
  });

  it("treats an already-absent sandbox as resolved cleanup and permits retry (#3344)", async () => {
    mockTerminalFailure();
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockReturnValue({
      status: 1,
      stderr: "sandbox alpha not found",
    });

    await expectFlowExit(createInput(), deps);

    expectLifecycleReceipt([
      "  Sandbox lifecycle receipt:",
      "    state: created_but_not_ready",
      "    sandbox: alpha",
      "    readiness_gate: sandbox_list:Failed",
      "    readiness_reason: terminal_failure_phase",
      "    create_stream_status: 0",
      "    timeout_seconds: 60",
      "    terminal_resolution: terminal_failure_deleted",
    ]);
    expect(errorOutput()).toContain(
      "Sandbox 'alpha' was already absent after the readiness gate failed; retry can recreate it.",
    );
    expect(errorOutput()).toContain("Retry: nemoclaw onboard");
    expect(errorOutput()).not.toContain("Could not remove the failed sandbox");
  });
});
