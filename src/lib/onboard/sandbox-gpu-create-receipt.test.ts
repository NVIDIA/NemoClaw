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
vi.mock("./sandbox-readiness-tracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-readiness-tracing")>()),
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

import { NEMOCLAW_CREATE_ATTEMPT_LABEL } from "../adapters/openshell/sandbox-identity";
import {
  createGpuFlowDeps,
  createGpuFlowInput,
  createGpuPatchFixture,
  resetGpuFlowMocks,
  setupGpuFlowMocks,
} from "./__test-helpers__/sandbox-gpu-create-flow";
import { runSandboxGpuCreateFlow } from "./sandbox-gpu-create-flow";

const fingerprint = "8174fa2a5d65755138d8339e086c03d736633130b22dca10952e80e74750c01d";
function nonce(args: readonly string[]): string {
  const index = args.indexOf("--label");
  return (args[index + 1] ?? "").slice(NEMOCLAW_CREATE_ATTEMPT_LABEL.length + 1);
}
function input() {
  const value = createGpuFlowInput();
  value.sandboxGpuConfig = {
    mode: "0",
    hostGpuDetected: false,
    hostGpuPlatform: null,
    sandboxGpuEnabled: false,
    sandboxGpuDevice: null,
    errors: [],
  };
  value.gpuRoutePlan = "none";
  value.initialGpuRoute = "none";
  value.persistRetainedSandboxRecovery = vi.fn(() => true);
  return value;
}
function list(sandboxNonce: string): string {
  return JSON.stringify([
    {
      id: "alpha-sandbox-id",
      name: "alpha",
      labels: { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: sandboxNonce },
      resource_version: 1,
      created_at: "2026-08-25T00:00:00Z",
      phase: "Ready",
      current_policy_version: 1,
    },
  ]);
}
beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(resetGpuFlowMocks);

describe("created sandbox receipt", () => {
  it("returns a post-verification readiness failure to the recovery owner (#9833)", async () => {
    let createNonce = "";
    const value = input();
    value.verifyCreatedSandboxBeforeEffects = vi.fn();
    value.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(createGpuPatchFixture());
    mocks.streamSandboxCreate.mockImplementation(async (_command, args) => {
      createNonce = nonce(args);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
      ready: false,
      reason: "timeout",
      failurePhase: null,
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockImplementationOnce(() => list(createNonce));
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("direct process exit bypassed the recovery owner");
    });

    await expect(runSandboxGpuCreateFlow(value, deps)).rejects.toThrow(
      "Sandbox 'alpha' did not become ready after verified creation",
    );

    expect(value.verifyCreatedSandboxBeforeEffects).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it("persists the create receipt before startup verification fails (#12290)", async () => {
    let createNonce = "";
    const value = input();
    value.persistUnverifiedCreateIdentity = vi.fn();
    const verifyCreatedSandboxBeforeEffects = vi.fn(() => {
      throw new Error("startup verification failed");
    });
    value.verifyCreatedSandboxBeforeEffects = verifyCreatedSandboxBeforeEffects;
    mocks.streamSandboxCreate.mockImplementation(async (_command, args) => {
      createNonce = nonce(args);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockImplementationOnce(() => list(createNonce));
    await expect(runSandboxGpuCreateFlow(value, deps)).rejects.toThrow(
      "startup verification failed",
    );
    expect(value.persistUnverifiedCreateIdentity).toHaveBeenCalledExactlyOnceWith({
      createAttemptNonce: createNonce,
      liveIdentityFingerprint: fingerprint,
      route: "none",
    });
    expect(value.persistUnverifiedCreateIdentity).toHaveBeenCalledBefore(
      verifyCreatedSandboxBeforeEffects,
    );
  });

  it("stops before startup verification when receipt persistence fails (#12290)", async () => {
    let createNonce = "";
    const value = input();
    value.persistUnverifiedCreateIdentity = vi.fn(() => {
      throw new Error("registry write failed");
    });
    value.verifyCreatedSandboxBeforeEffects = vi.fn();
    mocks.streamSandboxCreate.mockImplementation(async (_command, args) => {
      createNonce = nonce(args);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockImplementationOnce(() => list(createNonce));
    await expect(runSandboxGpuCreateFlow(value, deps)).rejects.toThrow(
      "could not persist the exact unverified create identity",
    );
    expect(value.persistUnverifiedCreateIdentity).toHaveBeenCalledTimes(1);
    expect(value.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
  });
});
