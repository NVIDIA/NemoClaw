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

import { NEMOCLAW_CREATE_ATTEMPT_LABEL } from "../adapters/openshell/sandbox-identity";
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
  labels: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify([
    {
      id: sandboxId,
      name: "alpha",
      labels,
      resource_version: 1,
      created_at: "2026-08-25T00:00:00Z",
      phase: "Ready",
      current_policy_version: 1,
      ...overrides,
    },
  ]);
}

function createAttemptNonce(args: readonly string[]): string {
  const labelIndex = args.indexOf("--label");
  return (args[labelIndex + 1] ?? "").slice(NEMOCLAW_CREATE_ATTEMPT_LABEL.length + 1);
}

beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(resetGpuFlowMocks);

describe("compatibility cutover failure diagnostics", () => {
  it.each(
    [
      { status: 1, expected: "exit status 1" },
      { status: null, expected: "missing exit status" },
      { status: null, signal: "SIGKILL", expected: "terminated by signal" },
      {
        status: null,
        signal: "SIGKILL",
        error: Object.assign(new Error("private native error"), { code: "ETIMEDOUT" }),
        expected: "command timed out",
      },
      { status: 0, error: new Error("private native error"), expected: "process error" },
    ].flatMap((failure) =>
      [
        { action: "start", patchCalls: 1 },
        { action: "stop", patchCalls: 0 },
      ].map((operation) => ({ ...failure, ...operation })),
    ),
  )("retains a private compatibility $action failure as $expected", async (failure) => {
    let nonce = "";
    const input = createGpuFlowInput();
    input.gpuRoutePlan = "compatibility-only";
    input.initialGpuRoute = "compatibility";
    input.persistRetainedSandboxRecovery = vi.fn(() => true);
    input.verifyCreatedSandboxBeforeEffects = vi.fn(
      async (_identity, beforeEffects, afterEffects) => {
        await beforeEffects?.();
        await afterEffects?.();
      },
    );
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    const patch = createGpuPatchFixture();
    patch.replacementRuntimeId.mockReturnValue("b".repeat(64));
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args) => {
      nonce = createAttemptNonce(args);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockImplementation((args) =>
      args.includes("--selector")
        ? sandboxListJson("alpha-sandbox-id", { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce })
        : "alpha Ready",
    );
    const defaultRun = vi.mocked(deps.runOpenshell).getMockImplementation()!;
    vi.mocked(deps.runOpenshell).mockImplementation((args, options) =>
      args[0] === "sandbox" && args[1] === failure.action
        ? { ...failure, stdout: "private native stdout", stderr: "private native stderr" }
        : defaultRun(args, options),
    );

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toEqual(
      new Error(
        `OpenShell could not ${failure.action} sandbox 'alpha' for the exact compatibility cutover (${failure.expected}).`,
      ),
    );
    expect(patch.commitAfterReady).not.toHaveBeenCalled();
    expect(patch.verifyGpuOrExit).not.toHaveBeenCalled();
    expect(deps.runOpenshell).toHaveBeenCalledWith(
      ["sandbox", failure.action, "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ timeout: 5_000, killProcessTreeOnTimeout: true }),
    );
    expect(
      vi.mocked(deps.runOpenshell).mock.calls.filter(([args]) => args[1] === failure.action),
    ).toHaveLength(1);
    expect(patch.ensureApplied).toHaveBeenCalledTimes(failure.patchCalls);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).not.toContain("private native");
  });
});
