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

import {
  NEMOCLAW_CREATE_ATTEMPT_LABEL,
  NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH,
} from "../adapters/openshell/sandbox-identity";
import {
  createGpuFlowDeps,
  createGpuFlowInput,
  createGpuPatchFixture,
  resetGpuFlowMocks,
  setupGpuFlowMocks,
} from "./__test-helpers__/sandbox-gpu-create-flow";
import { runSandboxGpuCreateFlow } from "./sandbox-gpu-create-flow";

function sandboxListJson(
  sandboxId: string,
  createAttemptNonce: string,
  incomplete = false,
): string {
  return JSON.stringify([
    {
      id: sandboxId,
      name: "alpha",
      labels: { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: createAttemptNonce },
      resource_version: incomplete ? null : 1,
      created_at: incomplete ? null : "2026-08-25T00:00:00Z",
      phase: incomplete ? null : "Ready",
      current_policy_version: incomplete ? null : 1,
    },
  ]);
}

function createAttemptNonce(args: readonly string[]): string {
  const labelIndex = args.indexOf("--label");
  return (args[labelIndex + 1] ?? "").slice(NEMOCLAW_CREATE_ATTEMPT_LABEL.length + 1);
}

beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(resetGpuFlowMocks);

describe("created sandbox identity settlement deadline", () => {
  it("allows identity-bound post-create effects after the former 30-second cap (#10652)", async () => {
    let nonce = "";
    let nowMs = 0;
    const input = createGpuFlowInput();
    input.sandboxGpuConfig = {
      mode: "0",
      hostGpuDetected: false,
      hostGpuPlatform: null,
      sandboxGpuEnabled: false,
      sandboxGpuDevice: null,
      errors: [],
    };
    input.gpuRoutePlan = "none";
    input.initialGpuRoute = "none";
    input.createArgv = ["openshell", "sandbox", "create", "--name", "alpha", "--", "agent"];
    input.sandboxReadyTimeoutSecs = 90;
    input.persistRetainedSandboxRecovery = vi.fn(() => true);
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();

    const patch = createGpuPatchFixture();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args, _env, options) => {
      nonce = createAttemptNonce(args);
      expect(nonce).toMatch(/^[0-9a-f]{62}$/u);
      expect(nonce).toHaveLength(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH);
      expect(options.readyCheck?.()).toBe(false);
      expect(options.readyCheck?.()).toBe(true);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });

    const deps = createGpuFlowDeps();
    deps.publicationNow = () => nowMs;
    vi.mocked(deps.sleep).mockImplementation((seconds) => {
      nowMs += seconds * 1_000;
    });
    deps.installPortableDemoLifecycle = vi.fn(() => "generation-1");
    vi.mocked(deps.runCaptureOpenshell)
      .mockReturnValueOnce("alpha Ready")
      .mockImplementationOnce(() => sandboxListJson("alpha-sandbox-id", nonce, true))
      .mockReturnValueOnce("alpha Ready")
      .mockImplementationOnce(() => sandboxListJson("alpha-sandbox-id", nonce))
      .mockImplementationOnce(() => {
        nowMs += 31_000;
        return sandboxListJson("alpha-sandbox-id", nonce, true);
      })
      .mockImplementationOnce(() => sandboxListJson("alpha-sandbox-id", nonce));

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({ route: "none" });

    expect(input.verifyCreatedSandboxBeforeEffects).toHaveBeenCalledExactlyOnceWith({
      sandboxId: "alpha-sandbox-id",
      liveIdentityFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      createAttemptNonce: nonce,
      route: "none",
    });
    expect(input.revalidateVerifiedSandboxBeforeEffect).toHaveBeenCalledWith(
      "apply runtime patch for sandbox 'alpha'",
    );
    expect(patch.ensureApplied).toHaveBeenCalledOnce();
    expect(patch.commitAfterReady).toHaveBeenCalledOnce();
    expect(deps.sleep).toHaveBeenCalledExactlyOnceWith(0.25);
  });
});
