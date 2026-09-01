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
  ALPHA_SANDBOX_IDENTITY_FINGERPRINT,
  createAttemptNonce,
  createGpuFlowDeps,
  createGpuFlowInput,
  resetGpuFlowMocks,
  sandboxListJson,
  setupGpuFlowMocks,
} from "./__test-helpers__/sandbox-gpu-create-flow";

import {
  refuseApfMutableNameFallbackCleanup,
  runSandboxGpuCreateFlow,
} from "./sandbox-gpu-create-flow";
import { assertPolicylessSandboxCreateArgv } from "./sandbox-gpu-create-run-attempt";

function expectNoSandboxDelete(deps: ReturnType<typeof createGpuFlowDeps>): void {
  expect(
    vi
      .mocked(deps.runOpenshell)
      .mock.calls.some(([args]) => args[0] === "sandbox" && args[1] === "delete"),
  ).toBe(false);
}

function createApfFallbackRecoveryFixture(captureExactIdentity = true) {
  let nonce = "";
  const input = createGpuFlowInput();
  input.requirePolicylessCreate = true;
  input.verifyCreatedSandboxBeforeEffects = vi.fn();
  input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
  input.persistRetainedSandboxRecovery = vi.fn(() => true);
  mocks.streamSandboxCreate.mockImplementationOnce(async (_command, args) => {
    nonce = createAttemptNonce(args);
    return {
      status: 1,
      output: "native runtime failed after sandbox creation",
      sawProgress: true,
    };
  });
  mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockReturnValue({
    ok: true,
    imageId: "sha256:" + "a".repeat(64),
    bookkeepingImageRef: "openshell/sandbox-from:test",
    stateError: "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
    deviceRequests: null,
    devices: null,
    runtime: "runc",
    nvidiaVisibleDevices: null,
    nativeGpuAttachmentState: "absent",
    containerId: "container-a",
  });
  const deps = createGpuFlowDeps();
  vi.mocked(deps.runCaptureOpenshell).mockImplementation(() =>
    captureExactIdentity
      ? sandboxListJson("alpha-sandbox-id", { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce })
      : "[]",
  );
  return { deps, input, readNonce: () => nonce };
}

beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(resetGpuFlowMocks);

describe("APF policyless sandbox create attempts", () => {
  it("accepts create arguments without a caller policy (#9833)", () => {
    expect(() =>
      assertPolicylessSandboxCreateArgv([
        "openshell",
        "sandbox",
        "create",
        "--from",
        "image",
        "--name",
        "alpha",
      ]),
    ).not.toThrow();
  });

  it.each([
    ["separate flag", ["openshell", "sandbox", "create", "--policy", "/tmp/policy.yaml"]],
    ["joined flag", ["openshell", "sandbox", "create", "--policy=/tmp/policy.yaml"]],
  ])("refuses a caller policy passed with the %s form (#9833)", (_label, argv) => {
    expect(() => assertPolicylessSandboxCreateArgv(argv)).toThrow(
      /must not supply a caller policy/u,
    );
  });

  it("does not interpret workload arguments after -- as create options (#9833)", () => {
    expect(() =>
      assertPolicylessSandboxCreateArgv([
        "openshell",
        "sandbox",
        "create",
        "--from",
        "image",
        "--",
        "agent",
        "--policy",
        "workload-value",
      ]),
    ).not.toThrow();
  });

  it("refuses compatibility fallback cleanup that can address only a mutable name (#9833)", () => {
    expect(refuseApfMutableNameFallbackCleanup("alpha")).toEqual({
      safe: false,
      reason:
        "APF-selected sandbox 'alpha' cannot be deleted by mutable name for a compatibility retry",
      deleteStatus: null,
      sandboxPresent: null,
      containerIds: null,
    });
  });

  it("persists exact APF recovery evidence before refusing native fallback (#9833)", async () => {
    const { deps, input, readNonce } = createApfFallbackRecoveryFixture();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");

    const nonce = readNonce();
    const fingerprint = ALPHA_SANDBOX_IDENTITY_FINGERPRINT;
    expect(input.persistRetainedSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        new RegExp(
          `^Create-attempt label: ${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}\\. Durable sandbox identity fingerprint: ${fingerprint}\\.`,
          "u",
        ),
      ),
      fingerprint,
      nonce,
    );
    expect(input.persistRetainedSandboxRecovery).toHaveBeenCalledBefore(exit);
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain(`${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`);
    expect(output).toContain(`Durable sandbox identity fingerprint: ${fingerprint}`);
    expect(output).not.toContain("alpha-sandbox-id");
    expectNoSandboxDelete(deps);
    expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
  });

  it("persists the APF create-attempt label when exact recovery identity is unavailable (#9833)", async () => {
    const { deps, input, readNonce } = createApfFallbackRecoveryFixture(false);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");

    const nonce = readNonce();
    expect(input.persistRetainedSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        new RegExp(
          `^Create-attempt label: ${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}\\..*Recovery is blocked until an OpenShell administrator resolves the create-attempt label`,
          "u",
        ),
      ),
      undefined,
      nonce,
    );
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain(`${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`);
    expect(output).toContain("Recovery is blocked");
    expectNoSandboxDelete(deps);
  });

  it.each([
    ["returns false", (): boolean => false],
    [
      "throws",
      (): boolean => {
        throw new Error("durable writer failed");
      },
    ],
  ] as const)(
    "blocks APF fallback when durable recovery persistence %s (#9833)",
    async (_name, writer) => {
      const { deps, input, readNonce } = createApfFallbackRecoveryFixture();
      const persist = vi.fn(writer);
      input.persistRetainedSandboxRecovery = persist;
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit:1");
      });

      await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
        "The APF recovery-only session remains blocked until its durable recovery record can be saved.",
      );

      expect(persist).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
      const output = vi.mocked(console.error).mock.calls.flat().join("\n");
      expect(output).toContain(`${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${readNonce()}`);
      expect(output).toContain("APF recovery is blocked because NemoClaw could not save");
      expectNoSandboxDelete(deps);
      expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
    },
  );
});
