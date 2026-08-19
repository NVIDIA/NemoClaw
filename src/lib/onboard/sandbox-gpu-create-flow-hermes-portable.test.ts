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

import type { CheckpointPortableRuntimeAuthority } from "../state/onboard-checkpoint-types";
import {
  createGpuFlowDeps as createDeps,
  createGpuFlowInput as createInput,
  resetGpuFlowMocks,
  setupGpuFlowMocks,
} from "./__test-helpers__/sandbox-gpu-create-flow";
import {
  cleanupSandboxCreateSource,
  runSandboxGpuCreateFlow,
  type SandboxGpuCreateFlowInput,
} from "./sandbox-gpu-create-flow";
import * as sandboxGpuCreateAttempt from "./sandbox-gpu-create-attempt";

const PORTABLE_RUNTIME_AUTHORITY: CheckpointPortableRuntimeAuthority = {
  schemaVersion: 1,
  kind: "podman",
  ownership: "current-user",
  uid: 1001,
  homeDir: "/home/tester",
  configHome: "/home/tester/.config",
  runtimeDir: "/run/user/1001",
  socketPath: "/run/user/1001/podman/podman.sock",
};

beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(resetGpuFlowMocks);

describe("Hermes portable sandbox create flow", () => {
  it("releases exit cleanup ownership only after successful retirement (#9203)", () => {
    const cleanup = vi.fn(() => true);
    process.on("exit", cleanup);
    try {
      expect(cleanupSandboxCreateSource(cleanup)).toBe(true);
      expect(process.listeners("exit")).not.toContain(cleanup);
    } finally {
      process.removeListener("exit", cleanup);
    }
  });

  it("preserves exit cleanup ownership when retirement is incomplete (#9203)", () => {
    const cleanup = vi.fn(() => false);
    process.on("exit", cleanup);
    try {
      expect(cleanupSandboxCreateSource(cleanup)).toBe(false);
      expect(process.listeners("exit")).toContain(cleanup);
    } finally {
      process.removeListener("exit", cleanup);
    }
  });

  it("requires and uses exact source cleanup for Hermes portable custody (#9203)", () => {
    const cleanup = vi.fn(() => true);
    const exactCleanup = vi.fn(() => true);
    process.on("exit", cleanup);
    try {
      expect(cleanupSandboxCreateSource(cleanup, { exactCleanup, requireExact: true })).toBe(true);
      expect(exactCleanup).toHaveBeenCalledOnce();
      expect(cleanup).not.toHaveBeenCalled();
      expect(process.listeners("exit")).not.toContain(cleanup);
      expect(() => cleanupSandboxCreateSource(cleanup, { requireExact: true })).toThrow(
        "has no exact cleanup authority",
      );
    } finally {
      process.removeListener("exit", cleanup);
    }
  });

  it("keeps non-OpenClaw portable creation on the existing runtime patch (#9068)", async () => {
    const input = createInput();
    input.hostEnv = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };
    input.portableLifecycle = false;
    input.hermesPortableLifecycle = false;
    input.persistStartupCommand = true;
    const deps = createDeps();
    deps.installPortableDemoLifecycle = vi.fn(() => null);

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({ route: "native" });

    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledOnce();
    expect(deps.installPortableDemoLifecycle).toHaveBeenCalledOnce();
  });

  it("uses the Hermes portable create handoff without Docker or OpenClaw lifecycle mutation (#9203)", async () => {
    const input = createInput();
    input.gpuRoutePlan = "native-only";
    input.hermesPortableLifecycle = true;
    input.portableLifecycle = false;
    input.lifecycleGeneration = "generation-1";
    input.portableRuntimeAuthority = PORTABLE_RUNTIME_AUTHORITY;
    const deps = createDeps();
    deps.installPortableDemoLifecycle = vi.fn(() => null);

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      route: "native",
      lifecycleRegistrationFields: { lifecycleGeneration: "generation-1" },
    });

    expect(mocks.createDockerGpuSandboxCreatePatch).not.toHaveBeenCalled();
    expect(mocks.queryOpenShellDockerSandboxContainers).not.toHaveBeenCalled();
    expect(mocks.queryOpenShellDockerSandboxRuntimeSnapshot).not.toHaveBeenCalled();
    expect(deps.installPortableDemoLifecycle).not.toHaveBeenCalled();
    expect(deps.verifyDirectSandboxGpu).toHaveBeenCalledOnce();
  });

  it("keeps schema-5 create failure diagnostics out of ambient gateway logs (#9203)", async () => {
    const input = createInput();
    input.gpuRoutePlan = "native-only";
    input.hermesPortableLifecycle = true;
    input.lifecycleGeneration = "generation-1";
    input.portableRuntimeAuthority = PORTABLE_RUNTIME_AUTHORITY;
    const deps = createDeps();
    const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 7,
      output: "create rejected",
      sawProgress: false,
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("exit 7");

    expect(exit).toHaveBeenCalledWith(7);
    expect(mocks.printSandboxCreateFailureDiagnostics).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("did not complete receipt-owned creation"),
    );
  });

  it("preserves receipt authority instead of suggesting name-only cleanup (#9203)", async () => {
    const input = createInput();
    input.gpuRoutePlan = "native-only";
    input.hermesPortableLifecycle = true;
    input.lifecycleGeneration = "generation-1";
    input.portableRuntimeAuthority = PORTABLE_RUNTIME_AUTHORITY;
    const deps = createDeps();
    vi.spyOn(sandboxGpuCreateAttempt, "executeSandboxGpuCreatePlan").mockResolvedValue({
      ok: false,
      route: "native",
      stage: "gpu-proof",
      error: new Error("GPU proof failed"),
      fallbackEligible: false,
    });
    vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("exit 1");

    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("Preserve its lifecycle receipt and resume onboarding");
    expect(output).not.toContain("openshell sandbox delete");
  });

  it("rejects compatibility and managed bootstrap before Hermes portable create effects (#9203)", async () => {
    const compatibility = createInput();
    compatibility.hermesPortableLifecycle = true;
    compatibility.lifecycleGeneration = "generation-1";
    compatibility.portableRuntimeAuthority = PORTABLE_RUNTIME_AUTHORITY;

    await expect(runSandboxGpuCreateFlow(compatibility, createDeps())).rejects.toThrow(
      "Docker GPU compatibility is unavailable",
    );

    const managed = createInput();
    managed.gpuRoutePlan = "native-only";
    managed.hermesPortableLifecycle = true;
    managed.lifecycleGeneration = "generation-1";
    managed.portableRuntimeAuthority = PORTABLE_RUNTIME_AUTHORITY;
    const createOnboardRouting = vi.fn();
    const createLifecycle = vi.fn();
    managed.managedBootstrap = {
      runtimeProvider: { bootstrap: { createOnboardRouting, createLifecycle } },
    } as unknown as NonNullable<SandboxGpuCreateFlowInput["managedBootstrap"]>;
    await expect(runSandboxGpuCreateFlow(managed, createDeps())).rejects.toThrow(
      "Hermes portable onboarding cannot use managed-image bootstrap",
    );

    expect(createOnboardRouting).not.toHaveBeenCalled();
    expect(createLifecycle).not.toHaveBeenCalled();
    expect(mocks.streamSandboxCreate).not.toHaveBeenCalled();
    expect(mocks.createDockerGpuSandboxCreatePatch).not.toHaveBeenCalled();
  });
});
