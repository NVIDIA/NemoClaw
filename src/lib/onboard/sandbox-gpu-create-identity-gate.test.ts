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
import { formatRetainedApfSandboxRecoveryReceipt } from "./created-sandbox-failure";
import { runSandboxGpuCreateFlow } from "./sandbox-gpu-create-flow";
import { fingerprintSandboxRecreateValue } from "./sandbox-recreate-transaction";
import { printOnboardResumeHint, resetOnboardResumeHintForTests } from "./resume-hint";

function sandboxListJson(sandboxId: string, labels: Readonly<Record<string, string>>): string {
  return JSON.stringify([
    {
      id: sandboxId,
      name: "alpha",
      labels,
      resource_version: 1,
      created_at: "2026-08-25T00:00:00Z",
      phase: "Ready",
      current_policy_version: 1,
    },
  ]);
}

function createAttemptNonce(args: readonly string[]): string {
  const labelIndex = args.indexOf("--label");
  return (args[labelIndex + 1] ?? "").slice(NEMOCLAW_CREATE_ATTEMPT_LABEL.length + 1);
}

function noGpuInput() {
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
  return input;
}

function refuseEffectStartingWith(prefix: string): (operation: string) => void {
  return (operation) => {
    expect(operation, "checkpoint changed").not.toMatch(new RegExp(`^${prefix}`, "u"));
  };
}

beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(() => {
  resetGpuFlowMocks();
  resetOnboardResumeHintForTests();
});

describe("created sandbox identity gate", () => {
  it("verifies the exact created sandbox before runtime and readiness effects (#9833)", async () => {
    const events: string[] = [];
    let nonce = "";
    const input = noGpuInput();
    const patch = createGpuPatchFixture();
    input.verifyCreatedSandboxBeforeEffects = vi.fn(async (identity) => {
      events.push("verify-created");
      expect(identity).toEqual({
        sandboxId: "alpha-sandbox-id",
        liveIdentityFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        route: "none",
      });
      expect(patch.ensureApplied).not.toHaveBeenCalled();
      expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
    });
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn((operation) =>
      events.push(`revalidate:${operation}`),
    );
    patch.exitOnPatchError.mockImplementation(() => events.push("runtime-check"));
    patch.ensureApplied.mockImplementation(() => events.push("runtime-patch"));
    patch.waitForSupervisorReconnectIfNeeded.mockImplementation(() => events.push("reconnect"));
    patch.commitAfterReady.mockImplementation(() => events.push("commit"));
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args, _env, options) => {
      events.push("create");
      expect(options.onPoll).toBeUndefined();
      expect(args.indexOf("--label")).toBeGreaterThan(0);
      expect(args.indexOf("--label")).toBeLessThan(args.indexOf("--"));
      nonce = createAttemptNonce(args);
      expect(nonce).toMatch(/^[0-9a-f]{62}$/u);
      expect(nonce).toHaveLength(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH);
      expect(nonce.length).toBeLessThanOrEqual(63);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    mocks.waitForCreatedSandboxReadyWithTrace.mockImplementation(() => {
      events.push("readiness");
      return { ready: true, reason: "ready", failurePhase: null };
    });
    const deps = createGpuFlowDeps();
    deps.installPortableDemoLifecycle = vi.fn(() => {
      events.push("portable-lifecycle");
      return "generation-1";
    });
    vi.mocked(deps.runCaptureOpenshell).mockImplementationOnce(() =>
      sandboxListJson("alpha-sandbox-id", { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce }),
    );

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({ route: "none" });

    expect(events).toEqual([
      "create",
      "verify-created",
      "revalidate:validate runtime patch for sandbox 'alpha'",
      "runtime-check",
      "revalidate:apply runtime patch for sandbox 'alpha'",
      "runtime-patch",
      "reconnect",
      "revalidate:reconnect sandbox supervisor for 'alpha'",
      "readiness",
      "revalidate:commit runtime readiness for sandbox 'alpha'",
      "commit",
      "revalidate:record portable lifecycle for sandbox 'alpha'",
      "portable-lifecycle",
    ]);
    expect(deps.runCaptureOpenshell).toHaveBeenCalledWith(
      [
        "sandbox",
        "list",
        "-g",
        "nemoclaw",
        "--selector",
        `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`,
        "--output",
        "json",
        "--limit",
        "2",
      ],
      {
        ignoreError: false,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL",
        killProcessTreeOnTimeout: true,
      },
    );
  });

  it("rejects a same-name replacement before post-create effects (#9833)", async () => {
    let nonce = "";
    const outputCanary = "replacement-output-must-not-be-reported";
    const input = noGpuInput();
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    const patch = createGpuPatchFixture();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args) => {
      nonce = createAttemptNonce(args);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockImplementationOnce(() =>
      sandboxListJson("replacement-id", {
        [NEMOCLAW_CREATE_ATTEMPT_LABEL]: "0".repeat(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH),
        untrusted: outputCanary,
      }),
    );

    const error = await runSandboxGpuCreateFlow(input, deps).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(
      "did not return one exact durable sandbox identity before post-create effects",
    );
    expect(String(error)).not.toContain(nonce);
    expect(String(error)).not.toContain(outputCanary);
    expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
    expect(patch.ensureApplied).not.toHaveBeenCalled();
    expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
  });

  it("persists unresolved APF recovery before rejecting a missing post-create identity (#9833)", async () => {
    let nonce = "";
    const input = noGpuInput();
    input.requirePolicylessCreate = true;
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    const persistRetainedApfSandboxRecovery = vi.fn(() => true);
    input.persistRetainedApfSandboxRecovery = persistRetainedApfSandboxRecovery;
    const patch = createGpuPatchFixture();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args) => {
      nonce = createAttemptNonce(args);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockReturnValue("[]");
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit:${code}`);
    });

    const error = await runSandboxGpuCreateFlow(input, deps).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(
      "did not return one exact durable sandbox identity before post-create effects",
    );
    expect(persistRetainedApfSandboxRecovery).toHaveBeenCalledExactlyOnceWith({
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      createAttemptNonce: nonce,
      liveIdentityFingerprint: null,
      message: formatRetainedApfSandboxRecoveryReceipt({
        createAttemptNonce: nonce,
        liveIdentityFingerprint: null,
      }),
    });
    expect(exit).not.toHaveBeenCalled();
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain(`${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`);
    expect(output).toContain("Recovery is blocked");
    expect(output).toContain("onboard --fresh --apf-interceptor --name <new-sandbox>");
    expect(output).not.toContain("onboard --resume");
    expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
    expect(patch.ensureApplied).not.toHaveBeenCalled();
    expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("requires checkpoint revalidation before the first post-create effect (#9833)", async () => {
    let nonce = "";
    const input = noGpuInput();
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    const patch = createGpuPatchFixture();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args) => {
      nonce = createAttemptNonce(args);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockImplementationOnce(() =>
      sandboxListJson("alpha-sandbox-id", { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce }),
    );

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "has no post-create effect revalidation",
    );

    expect(patch.exitOnPatchError).not.toHaveBeenCalled();
    expect(patch.ensureApplied).not.toHaveBeenCalled();
    expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
  });

  it("uses a distinct identity label for each create attempt (#9833)", async () => {
    const input = createGpuFlowInput();
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    const nonces: string[] = [];
    mocks.streamSandboxCreate
      .mockImplementationOnce(async (_command, args) => {
        nonces.push(createAttemptNonce(args));
        return {
          status: 1,
          output: "error: unexpected argument '--gpu' found",
          sawProgress: false,
        };
      })
      .mockImplementationOnce(async (_command, args) => {
        nonces.push(createAttemptNonce(args));
        return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
      });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockImplementationOnce(() =>
      sandboxListJson("alpha-sandbox-id", {
        [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonces[1] ?? "",
      }),
    );

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      route: "compatibility",
    });

    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toMatch(/^[0-9a-f]{62}$/u);
    expect(nonces[1]).toMatch(/^[0-9a-f]{62}$/u);
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(input.verifyCreatedSandboxBeforeEffects).toHaveBeenCalledOnce();
  });

  it("persists exact APF recovery evidence before refusing native fallback (#9833)", async () => {
    let nonce = "";
    const input = createGpuFlowInput();
    input.requirePolicylessCreate = true;
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    input.persistRetainedApfSandboxRecovery = vi.fn(() => true);
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
      sandboxListJson("alpha-sandbox-id", { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce }),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");

    const fingerprint = fingerprintSandboxRecreateValue("alpha-sandbox-id");
    expect(input.persistRetainedApfSandboxRecovery).toHaveBeenCalledExactlyOnceWith({
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      createAttemptNonce: nonce,
      liveIdentityFingerprint: fingerprint,
      message: formatRetainedApfSandboxRecoveryReceipt({
        createAttemptNonce: nonce,
        liveIdentityFingerprint: fingerprint,
      }),
    });
    expect(input.persistRetainedApfSandboxRecovery).toHaveBeenCalledBefore(exit);
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain(`${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`);
    expect(output).toContain(`Durable sandbox identity fingerprint: ${fingerprint}`);
    expect(output).toContain("onboard --fresh --apf-interceptor --name <new-sandbox>");
    expect(output).not.toContain("onboard --resume");
    const genericRecovery: string[] = [];
    printOnboardResumeHint(false, (line) => genericRecovery.push(line));
    expect(genericRecovery).toEqual([]);
    expect(output).not.toContain("alpha-sandbox-id");
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
  });

  it("persists the APF create-attempt label when exact recovery identity is unavailable (#9833)", async () => {
    let nonce = "";
    const input = createGpuFlowInput();
    input.requirePolicylessCreate = true;
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    input.persistRetainedApfSandboxRecovery = vi.fn(() => true);
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
    vi.mocked(deps.runCaptureOpenshell).mockReturnValue("[]");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");

    expect(input.persistRetainedApfSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        createAttemptNonce: nonce,
        liveIdentityFingerprint: null,
        message: formatRetainedApfSandboxRecoveryReceipt({
          createAttemptNonce: nonce,
          liveIdentityFingerprint: null,
        }),
      }),
    );
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain(`${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`);
    expect(output).toContain("Recovery is blocked");
    expect(output).toContain("onboard --fresh --apf-interceptor --name <new-sandbox>");
    expect(output).not.toContain("onboard --resume");
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("persists identifiable APF recovery evidence before a non-fallback create exit (#9833)", async () => {
    let nonce = "";
    const input = noGpuInput();
    input.requirePolicylessCreate = true;
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    input.persistRetainedApfSandboxRecovery = vi.fn(() => true);
    mocks.streamSandboxCreate.mockImplementationOnce(async (_command, args) => {
      nonce = createAttemptNonce(args);
      return {
        status: 2,
        output: "sandbox create transport failed",
        sawProgress: true,
      };
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockImplementation(() =>
      sandboxListJson("alpha-sandbox-id", { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce }),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:2");
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:2");

    const fingerprint = fingerprintSandboxRecreateValue("alpha-sandbox-id");
    expect(input.persistRetainedApfSandboxRecovery).toHaveBeenCalledExactlyOnceWith({
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      createAttemptNonce: nonce,
      liveIdentityFingerprint: fingerprint,
      message: formatRetainedApfSandboxRecoveryReceipt({
        createAttemptNonce: nonce,
        liveIdentityFingerprint: fingerprint,
      }),
    });
    expect(input.persistRetainedApfSandboxRecovery).toHaveBeenCalledBefore(exit);
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain(`${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`);
    expect(output).toContain(`Durable sandbox identity fingerprint: ${fingerprint}`);
    expect(output).toContain("onboard --fresh --apf-interceptor --name <new-sandbox>");
    expect(output).not.toContain("onboard --resume");
    expect(output).not.toContain("alpha-sandbox-id");
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("persists non-identifiable APF recovery before a non-fallback create exit (#9833)", async () => {
    let nonce = "";
    const input = noGpuInput();
    input.requirePolicylessCreate = true;
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    input.persistRetainedApfSandboxRecovery = vi.fn(() => true);
    mocks.streamSandboxCreate.mockImplementationOnce(async (_command, args) => {
      nonce = createAttemptNonce(args);
      return {
        status: 2,
        output: "sandbox create transport failed",
        sawProgress: true,
      };
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockReturnValue("[]");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:2");
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:2");

    expect(input.persistRetainedApfSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        createAttemptNonce: nonce,
        liveIdentityFingerprint: null,
        message: formatRetainedApfSandboxRecoveryReceipt({
          createAttemptNonce: nonce,
          liveIdentityFingerprint: null,
        }),
      }),
    );
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain(`${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`);
    expect(output).toContain("Recovery is blocked");
    expect(output).toContain("onboard --fresh --apf-interceptor --name <new-sandbox>");
    expect(output).not.toContain("onboard --resume");
  });

  it("persists identifiable APF recovery before a terminal readiness exit (#9833)", async () => {
    let nonce = "";
    const input = noGpuInput();
    input.requirePolicylessCreate = true;
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    const persistRetainedApfSandboxRecovery = vi.fn(() => true);
    input.persistRetainedApfSandboxRecovery = persistRetainedApfSandboxRecovery;
    const patch = createGpuPatchFixture();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args) => {
      nonce = createAttemptNonce(args);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
      ready: false,
      reason: "terminal_failure_phase",
      failurePhase: "Error",
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockImplementation(() =>
      sandboxListJson("alpha-sandbox-id", { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce }),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit:${code}`);
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");

    const fingerprint = fingerprintSandboxRecreateValue("alpha-sandbox-id");
    expect(persistRetainedApfSandboxRecovery).toHaveBeenCalledExactlyOnceWith({
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      createAttemptNonce: nonce,
      liveIdentityFingerprint: fingerprint,
      message: formatRetainedApfSandboxRecoveryReceipt({
        createAttemptNonce: nonce,
        liveIdentityFingerprint: fingerprint,
      }),
    });
    expect(persistRetainedApfSandboxRecovery).toHaveBeenCalledBefore(
      patch.rollbackManagedStartupAfterCreateFailure,
    );
    expect(persistRetainedApfSandboxRecovery).toHaveBeenCalledBefore(exit);
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain(`${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`);
    expect(output).toContain(`Durable sandbox identity fingerprint: ${fingerprint}`);
    expect(output).toContain("onboard --fresh --apf-interceptor --name <new-sandbox>");
    expect(output).not.toContain("onboard --resume");
    expect(output).not.toContain("alpha-sandbox-id");
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it.each([
    ["returns false", () => false],
    [
      "throws",
      () => {
        throw new Error("injected persistence failure");
      },
    ],
  ])(
    "preserves the APF create status when recovery persistence %s (#9833)",
    async (_caseName, persist) => {
      let nonce = "";
      const input = noGpuInput();
      input.requirePolicylessCreate = true;
      input.verifyCreatedSandboxBeforeEffects = vi.fn();
      input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
      input.persistRetainedApfSandboxRecovery = vi.fn(persist);
      mocks.streamSandboxCreate.mockImplementationOnce(async (_command, args) => {
        nonce = createAttemptNonce(args);
        return {
          status: 7,
          output: "sandbox create transport failed",
          sawProgress: true,
        };
      });
      const deps = createGpuFlowDeps();
      vi.mocked(deps.runCaptureOpenshell).mockReturnValue("[]");
      const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit:${code}`);
      });

      await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:7");

      expect(input.persistRetainedApfSandboxRecovery).toHaveBeenCalledBefore(exit);
      const output = vi.mocked(console.error).mock.calls.flat().join("\n");
      expect(output).toContain(`${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`);
      expect(output).toContain(
        "APF recovery is blocked because NemoClaw could not save this create-attempt evidence",
      );
      expect(output).toContain("onboard --fresh --apf-interceptor --name <new-sandbox>");
      expect(output).not.toContain("onboard --resume");
    },
  );

  it("persists APF recovery once when post-create revalidation fails (#9833)", async () => {
    const events: string[] = [];
    let nonce = "";
    const revalidationFailure = new Error("checkpoint changed");
    const input = noGpuInput();
    input.requirePolicylessCreate = true;
    input.verifyCreatedSandboxBeforeEffects = vi.fn(async () => {
      events.push("verify");
    });
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn(() => {
      events.push("revalidate");
      throw revalidationFailure;
    });
    const persistRetainedApfSandboxRecovery = vi.fn(() => {
      events.push("persist");
      return false;
    });
    input.persistRetainedApfSandboxRecovery = persistRetainedApfSandboxRecovery;
    const patch = createGpuPatchFixture();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args) => {
      nonce = createAttemptNonce(args);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockImplementation(() =>
      sandboxListJson("alpha-sandbox-id", { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce }),
    );

    const error = await runSandboxGpuCreateFlow(input, deps).catch((caught: unknown) => caught);

    expect(error).toBe(revalidationFailure);
    const fingerprint = fingerprintSandboxRecreateValue("alpha-sandbox-id");
    expect(persistRetainedApfSandboxRecovery).toHaveBeenCalledExactlyOnceWith({
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      createAttemptNonce: nonce,
      liveIdentityFingerprint: fingerprint,
      message: formatRetainedApfSandboxRecoveryReceipt({
        createAttemptNonce: nonce,
        liveIdentityFingerprint: fingerprint,
      }),
    });
    expect(events).toEqual(["verify", "revalidate", "persist"]);
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain(
      "APF recovery is blocked because NemoClaw could not save this create-attempt evidence",
    );
    expect(output).not.toContain("onboard --resume");
    expect(patch.exitOnPatchError).not.toHaveBeenCalled();
    expect(patch.ensureApplied).not.toHaveBeenCalled();
    expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("stops before a runtime patch when the durable checkpoint drifts (#9833)", async () => {
    let nonce = "";
    const input = noGpuInput();
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn(
      refuseEffectStartingWith("apply runtime patch"),
    );
    const patch = createGpuPatchFixture();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args) => {
      nonce = createAttemptNonce(args);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockImplementationOnce(() =>
      sandboxListJson("alpha-sandbox-id", { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce }),
    );

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("checkpoint changed");

    expect(patch.ensureApplied).not.toHaveBeenCalled();
    expect(patch.waitForSupervisorReconnectIfNeeded).not.toHaveBeenCalled();
    expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
    expect(mocks.verifyGpuSandboxAccessAfterReady).not.toHaveBeenCalled();
  });

  it("reconnects before rejecting lifecycle drift from the transient recreate state (#9833)", async () => {
    let nonce = "";
    const input = noGpuInput();
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn(
      refuseEffectStartingWith("reconnect sandbox supervisor"),
    );
    const patch = createGpuPatchFixture();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args) => {
      nonce = createAttemptNonce(args);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockImplementationOnce(() =>
      sandboxListJson("alpha-sandbox-id", { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce }),
    );

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("checkpoint changed");

    expect(patch.ensureApplied).toHaveBeenCalledOnce();
    expect(patch.waitForSupervisorReconnectIfNeeded).toHaveBeenCalledOnce();
    expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
    expect(mocks.verifyGpuSandboxAccessAfterReady).not.toHaveBeenCalled();
  });

  it("stops before GPU proof when the durable checkpoint drifts (#9833)", async () => {
    let nonce = "";
    const input = createGpuFlowInput();
    input.gpuRoutePlan = "native-only";
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn(
      refuseEffectStartingWith("verify GPU access"),
    );
    const patch = createGpuPatchFixture();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args) => {
      nonce = createAttemptNonce(args);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockImplementationOnce(() =>
      sandboxListJson("alpha-sandbox-id", { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce }),
    );

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("checkpoint changed");

    expect(mocks.waitForCreatedSandboxReadyWithTrace).toHaveBeenCalledOnce();
    expect(mocks.verifyGpuSandboxAccessAfterReady).not.toHaveBeenCalled();
    expect(patch.commitAfterReady).not.toHaveBeenCalled();
  });
});
