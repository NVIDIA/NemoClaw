// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks";

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
import {
  createHermesPortableReadyCapture,
  createHermesPortableReadyRunner,
} from "./experimental/hermes-portable-onboarding";
import { runSandboxGpuCreateFlow } from "./sandbox-gpu-create-flow";
import { fingerprintSandboxRecreateValue } from "./sandbox-recreate-transaction";

const ALPHA_SANDBOX_ID_FINGERPRINT =
  "8174fa2a5d65755138d8339e086c03d736633130b22dca10952e80e74750c01d";

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
  input.persistRetainedSandboxRecovery = vi.fn(() => true);
  return input;
}

function refuseEffectStartingWith(prefix: string): (operation: string) => void {
  return (operation) => {
    expect(operation, "checkpoint changed").not.toMatch(new RegExp(`^${prefix}`, "u"));
  };
}

beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(resetGpuFlowMocks);

describe("created sandbox identity gate", () => {
  it("keeps fresh-create readiness probes on the owning gateway (#9803)", async () => {
    const gatewayName = "nemoclaw-18080";
    const input = createGpuFlowInput();
    input.gatewayName = gatewayName;
    const deps = createGpuFlowDeps(gatewayName, true);
    mocks.streamSandboxCreate.mockImplementationOnce(async (...args) => {
      expect(args[3].readyCheck()).toBe(true);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    mocks.waitForCreatedSandboxReadyWithTrace.mockImplementationOnce(async (options) => {
      expect(options.target).toEqual({ kind: "named", gatewayName });
      await expect(
        options.observer.listSandboxes({ target: options.target }),
      ).resolves.toMatchObject({ ok: true });
      expect(options.checkReadyIdentity?.()).toBe("ready");
      return { ready: true, reason: "ready", failurePhase: null };
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      route: "native",
    });

    expect(deps.runCaptureOpenshell).toHaveBeenCalledWith(["sandbox", "list", "-g", gatewayName], {
      ignoreError: true,
      timeout: 5_000,
    });
    expect(deps.runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", gatewayName, "alpha"],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    expect(deps.runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "exec", "-g", gatewayName, "--name", "alpha", "--", "true"],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
  });

  it("resumes the exact verified sandbox without issuing another create (#9833)", async () => {
    const events: string[] = [];
    const sandboxId = "alpha-sandbox-id";
    const gatewayName = "nemoclaw-18080";
    const input = noGpuInput();
    input.gatewayName = gatewayName;
    input.resumeVerifiedCreate = {
      route: "none",
      liveIdentityFingerprint: fingerprintSandboxRecreateValue(sandboxId),
      createAttemptNonce: "a".repeat(62),
    };
    input.verifyCreatedSandboxBeforeEffects = vi.fn(async (identity) => {
      events.push("verify-created");
      expect(identity).toEqual({
        sandboxId,
        liveIdentityFingerprint: fingerprintSandboxRecreateValue(sandboxId),
        createAttemptNonce: "a".repeat(62),
        route: "none",
      });
    });
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn((operation) =>
      events.push(`revalidate:${operation}`),
    );
    const patch = createGpuPatchFixture();
    patch.exitOnPatchError.mockImplementation(() => events.push("runtime-check"));
    patch.ensureApplied.mockImplementation(() => events.push("runtime-patch"));
    patch.waitForSupervisorReconnectIfNeeded.mockImplementation(() => events.push("reconnect"));
    patch.commitAfterReady.mockImplementation(() => events.push("commit"));
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.waitForCreatedSandboxReadyWithTrace.mockImplementation(() => {
      events.push("readiness");
      return { ready: true, reason: "ready", failurePhase: null };
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runOpenshell).mockImplementation((args) =>
      args.join(" ") === `sandbox get -g ${gatewayName} alpha`
        ? { status: 0, stdout: `Name: alpha\nId: ${sandboxId}\nState: Ready\n`, stderr: "" }
        : { status: 0, stdout: "", stderr: "" },
    );
    deps.installPortableDemoLifecycle = vi.fn(() => {
      events.push("portable-lifecycle");
      return "generation-1";
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      origin: "resumed",
      route: "none",
    });

    expect(mocks.streamSandboxCreate).not.toHaveBeenCalled();
    expect(deps.runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", gatewayName, "alpha"],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    expect(events).toEqual([
      "verify-created",
      "revalidate:activate managed sandbox network for 'alpha'",
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
  });

  it("refuses a changed live identity before resumed effects (#9833)", async () => {
    const input = noGpuInput();
    input.resumeVerifiedCreate = {
      route: "none",
      liveIdentityFingerprint: fingerprintSandboxRecreateValue("expected-id"),
      createAttemptNonce: "a".repeat(62),
    };
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    const patch = createGpuPatchFixture();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runOpenshell).mockImplementation((args) =>
      args.join(" ") === "sandbox get -g nemoclaw alpha"
        ? { status: 0, stdout: "Name: alpha\nId: replacement-id\nState: Ready\n", stderr: "" }
        : { status: 0, stdout: "", stderr: "" },
    );

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "live identity changed after the verified checkpoint",
    );

    expect(mocks.streamSandboxCreate).not.toHaveBeenCalled();
    expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
    expect(patch.ensureApplied).not.toHaveBeenCalled();
  });

  it("refuses a resume checkpoint without durable create-attempt authority (#9833)", async () => {
    const input = noGpuInput();
    input.resumeVerifiedCreate = {
      route: "none",
      liveIdentityFingerprint: fingerprintSandboxRecreateValue("expected-id"),
    };
    const deps = createGpuFlowDeps();

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "durable create-attempt authority",
    );

    expect(deps.runOpenshell).not.toHaveBeenCalled();
    expect(mocks.streamSandboxCreate).not.toHaveBeenCalled();
  });

  it("requires a durable recovery owner for verified create attempts (#9211)", async () => {
    const input = noGpuInput();
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    delete input.persistRetainedSandboxRecovery;

    await expect(runSandboxGpuCreateFlow(input, createGpuFlowDeps())).rejects.toThrow(
      "Verified sandbox creation requires durable create-attempt recovery evidence.",
    );

    expect(mocks.streamSandboxCreate).not.toHaveBeenCalled();
  });

  it("ends the create-client handoff after a nonce-owned ID appears and settles metadata before effects (#10769)", async () => {
    const events: string[] = [];
    let nonce = "";
    const input = noGpuInput();
    const patch = createGpuPatchFixture();
    input.verifyCreatedSandboxBeforeEffects = vi.fn(async (identity) => {
      events.push("verify-created");
      expect(identity).toEqual({
        sandboxId: "alpha-sandbox-id",
        liveIdentityFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        createAttemptNonce: expect.stringMatching(/^[0-9a-f]{62}$/u),
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
      expect(options.waitForReadyTermination).toBe(true);
      expect(args.indexOf("--label")).toBeGreaterThan(0);
      expect(args.indexOf("--label")).toBeLessThan(args.indexOf("--"));
      nonce = createAttemptNonce(args);
      expect(nonce).toMatch(/^[0-9a-f]{62}$/u);
      expect(nonce).toHaveLength(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH);
      expect(nonce.length).toBeLessThanOrEqual(63);
      expect(options.readyCheck?.()).toBe(true);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    mocks.waitForCreatedSandboxReadyWithTrace.mockImplementation(() => {
      events.push("readiness");
      return { ready: true, reason: "ready", failurePhase: null };
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.sleep).mockImplementation(() => {
      events.push("identity-settle");
      expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
      expect(patch.exitOnPatchError).not.toHaveBeenCalled();
      expect(patch.ensureApplied).not.toHaveBeenCalled();
    });
    deps.installPortableDemoLifecycle = vi.fn(() => {
      events.push("portable-lifecycle");
      return "generation-1";
    });
    vi.mocked(deps.runCaptureOpenshell)
      .mockImplementationOnce((args) => {
        expect(args).not.toContain("--selector");
        events.push("ready-visible");
        return "alpha Ready";
      })
      .mockImplementationOnce((args) => {
        expect(args).toContain("--selector");
        events.push("identity-metadata-pending");
        expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
        expect(patch.exitOnPatchError).not.toHaveBeenCalled();
        return sandboxListJson(
          "alpha-sandbox-id",
          { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce },
          {
            resource_version: null,
            created_at: null,
            phase: null,
            current_policy_version: null,
          },
        );
      })
      .mockImplementationOnce((args) => {
        expect(args).toContain("--selector");
        events.push("identity-matched");
        expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
        expect(patch.exitOnPatchError).not.toHaveBeenCalled();
        return sandboxListJson("alpha-sandbox-id", {
          [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce,
        });
      });

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({ route: "none" });

    expect(events).toEqual([
      "create",
      "ready-visible",
      "identity-metadata-pending",
      "identity-matched",
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
    expect(deps.runCaptureOpenshell).toHaveBeenNthCalledWith(
      2,
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
        timeout: expect.any(Number),
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL",
        killProcessTreeOnTimeout: true,
      },
    );
    const firstIdentityTimeout = vi.mocked(deps.runCaptureOpenshell).mock.calls[1]?.[1]?.timeout;
    expect(firstIdentityTimeout).toEqual(expect.any(Number));
    expect(firstIdentityTimeout as number).toBeGreaterThan(0);
    expect(firstIdentityTimeout as number).toBeLessThanOrEqual(30_000);
    expect(deps.runCaptureOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "get", "-g", "nemoclaw", "alpha"],
      expect.anything(),
    );
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("returns false and blocks effects when the create-attempt selector returns no sandbox ID (#10769)", async () => {
    const input = noGpuInput();
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    const patch = createGpuPatchFixture();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, _args, _env, options) => {
      expect(options.readyCheck?.()).toBe(false);
      return { status: 0, output: "", sawProgress: true };
    });
    const deps = createGpuFlowDeps();
    deps.installPortableDemoLifecycle = vi.fn();
    vi.mocked(deps.runCaptureOpenshell)
      .mockReturnValueOnce("alpha Ready")
      .mockReturnValueOnce("[]");

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "did not return one exact durable sandbox identity before post-create effects",
    );

    expect(input.persistRetainedSandboxRecovery).toHaveBeenCalledOnce();
    expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
    expect(input.revalidateVerifiedSandboxBeforeEffect).not.toHaveBeenCalled();
    expect(patch.exitOnPatchError).not.toHaveBeenCalled();
    expect(patch.ensureApplied).not.toHaveBeenCalled();
    expect(patch.waitForSupervisorReconnectIfNeeded).not.toHaveBeenCalled();
    expect(patch.commitAfterReady).not.toHaveBeenCalled();
    expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
    expect(deps.installPortableDemoLifecycle).not.toHaveBeenCalled();
  });

  it("persists recovery before reporting a handoff timeout that looks like an incomplete create (#10769)", async () => {
    const events: string[] = [];
    let nonce = "";
    const input = noGpuInput();
    input.persistRetainedSandboxRecovery = vi.fn(() => {
      events.push("persist-recovery");
      return true;
    });
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    const patch = createGpuPatchFixture();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args, _env, options) => {
      nonce = createAttemptNonce(args);
      expect(options.readyCheck?.()).toBe(true);
      return {
        status: 1,
        output:
          "Created sandbox: alpha\nOpenShell create client did not exit after Ready; aborting cutover.",
        sawProgress: true,
        readyTerminationTimedOut: true,
      };
    });
    const deps = createGpuFlowDeps();
    deps.installPortableDemoLifecycle = vi.fn();
    vi.mocked(deps.runCaptureOpenshell)
      .mockReturnValueOnce("alpha Ready")
      .mockImplementationOnce(() =>
        sandboxListJson("alpha-sandbox-id", { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce }),
      );
    vi.mocked(console.error).mockImplementation(() => {
      events.push("report-recovery");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "OpenShell create client did not exit after Ready for sandbox 'alpha'",
    );

    const fingerprint = ALPHA_SANDBOX_ID_FINGERPRINT;
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
    expect(events.slice(0, 2)).toEqual(["persist-recovery", "report-recovery"]);
    expect(exit).not.toHaveBeenCalled();
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain(`${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`);
    expect(output).toContain(`Durable sandbox identity fingerprint: ${fingerprint}`);
    expect(output).toContain("Run 'nemoclaw alpha destroy'");
    expect(output).toContain("the command removes nothing and preserves the recovery record");
    expect(output).toContain("Give the create-attempt label to an OpenShell administrator");
    expect(output).toContain("After OpenShell confirms removal");
    expect(output).toContain("run 'nemoclaw alpha destroy --yes'");
    expect(output).not.toContain("alpha-sandbox-id");
    expect(output).not.toContain("Recovery:");
    expect(output).not.toContain("Or:      nemoclaw onboard");
    expect(output).not.toContain("onboard --resume");
    expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
    expect(input.revalidateVerifiedSandboxBeforeEffect).not.toHaveBeenCalled();
    expect(patch.exitOnPatchError).not.toHaveBeenCalled();
    expect(patch.ensureApplied).not.toHaveBeenCalled();
    expect(patch.waitForSupervisorReconnectIfNeeded).not.toHaveBeenCalled();
    expect(patch.commitAfterReady).not.toHaveBeenCalled();
    expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
    expect(deps.installPortableDemoLifecycle).not.toHaveBeenCalled();
  });

  it("blocks a restart-safe handoff timeout without create-attempt identity (#10769)", async () => {
    const input = noGpuInput();
    input.persistStartupCommand = true;
    const patch = createGpuPatchFixture();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, _args, _env, options) => {
      expect(options.waitForReadyTermination).toBe(true);
      expect(options.readyCheck?.()).toBe(true);
      return {
        status: 1,
        output:
          "Created sandbox: alpha\nOpenShell create client did not exit after Ready; aborting cutover.",
        sawProgress: true,
        readyTerminationTimedOut: true,
      };
    });
    const deps = createGpuFlowDeps();

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "No create-attempt identity was available for retained recovery",
    );

    expect(input.persistRetainedSandboxRecovery).not.toHaveBeenCalled();
    expect(patch.exitOnPatchError).not.toHaveBeenCalled();
    expect(patch.ensureApplied).not.toHaveBeenCalled();
    expect(patch.waitForSupervisorReconnectIfNeeded).not.toHaveBeenCalled();
    expect(patch.commitAfterReady).not.toHaveBeenCalled();
    expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
  });

  it.each([
    ["returns false", (): boolean => false],
    ["throws", (): boolean => {
      throw new Error("recovery writer failed");
    }],
  ] as const)(
    "blocks the create after retained recovery persistence %s (#10769)",
    async (_failureMode, persistRecovery) => {
      let nonce = "";
      const input = noGpuInput();
      input.persistRetainedSandboxRecovery = vi.fn(persistRecovery);
      input.verifyCreatedSandboxBeforeEffects = vi.fn();
      input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
      const patch = createGpuPatchFixture();
      mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
      mocks.streamSandboxCreate.mockImplementation(async (_command, args, _env, options) => {
        nonce = createAttemptNonce(args);
        expect(options.readyCheck?.()).toBe(true);
        return {
          status: 1,
          output: "OpenShell create client did not exit after Ready; aborting cutover.",
          sawProgress: true,
          readyTerminationTimedOut: true,
        };
      });
      const deps = createGpuFlowDeps();
      vi.mocked(deps.runCaptureOpenshell)
        .mockReturnValueOnce("alpha Ready")
        .mockImplementationOnce(() =>
          sandboxListJson("alpha-sandbox-id", { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce }),
        );

      await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
        "NemoClaw could not save the retained sandbox recovery record for this create attempt",
      );

      expect(input.persistRetainedSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          `Durable sandbox identity fingerprint: ${ALPHA_SANDBOX_ID_FINGERPRINT}`,
        ),
        ALPHA_SANDBOX_ID_FINGERPRINT,
        nonce,
      );
      const output = vi.mocked(console.error).mock.calls.flat().join("\n");
      expect(output).toContain(`${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`);
      expect(output).toContain(
        "NemoClaw could not save the retained sandbox recovery record for this create attempt",
      );
      expect(output).not.toContain("alpha-sandbox-id");
      expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
      expect(input.revalidateVerifiedSandboxBeforeEffect).not.toHaveBeenCalled();
      expect(patch.exitOnPatchError).not.toHaveBeenCalled();
      expect(patch.ensureApplied).not.toHaveBeenCalled();
      expect(patch.waitForSupervisorReconnectIfNeeded).not.toHaveBeenCalled();
      expect(patch.commitAfterReady).not.toHaveBeenCalled();
    },
  );

  it("carries Hermes receipt authority from selector settlement through publication lookup (#10423)", async () => {
    const events: string[] = [];
    let nonce = "";
    const input = noGpuInput();
    const patch = createGpuPatchFixture();
    input.verifyCreatedSandboxBeforeEffects = vi.fn(async () => {
      events.push("verify-policy");
    });
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args, _env, options) => {
      events.push("create");
      nonce = createAttemptNonce(args);
      expect(options.readyCheck?.()).toBe(true);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
      ready: true,
      reason: "ready",
      failurePhase: null,
    });
    const capture = vi.fn((args: readonly string[]) => {
      const results = {
        [["sandbox", "list", "-g", "nemoclaw"].join("\0")]: () => {
          events.push("ready-visible");
          return { status: 0, stdout: Buffer.from("alpha Ready"), stderr: Buffer.alloc(0) };
        },
        [[
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
        ].join("\0")]: () => {
          events.push("selector-settled");
          return {
            status: 0,
            stdout: Buffer.from(
              sandboxListJson("alpha-sandbox-id", {
                [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce,
              }),
            ),
            stderr: Buffer.alloc(0),
          };
        },
        [["sandbox", "get", "-g", "nemoclaw", "alpha"].join("\0")]: () => {
          events.push("publication-get");
          return {
            status: 0,
            stdout: Buffer.from("ID: alpha-sandbox-id\n"),
            stderr: Buffer.alloc(0),
          };
        },
      } satisfies Readonly<
        Record<string, () => { status: number; stdout: Buffer; stderr: Buffer }>
      >;
      return (
        results[args.join("\0") as keyof typeof results] ??
        (() => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
      )();
    });
    const deps = createGpuFlowDeps();
    deps.runOpenshell = createHermesPortableReadyRunner("alpha", "nemoclaw", capture);
    deps.runCaptureOpenshell = createHermesPortableReadyCapture("alpha", "nemoclaw", capture);

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({ route: "none" });

    expect(events.slice(0, 6)).toEqual([
      "create",
      "ready-visible",
      "selector-settled",
      "selector-settled",
      "publication-get",
      "verify-policy",
    ]);
    expect(input.verifyCreatedSandboxBeforeEffects).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(["sandbox", "get", "-g", "nemoclaw", "alpha"]);
  });

  it.each([
    [
      "changes durable ID",
      (nonce: string) => [
        sandboxListJson(
          "alpha-sandbox-id",
          { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce },
          { resource_version: null },
        ),
        sandboxListJson("replacement-sandbox-id", {
          [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce,
        }),
      ],
      2,
    ],
    [
      "disappears",
      (nonce: string) => [
        sandboxListJson(
          "alpha-sandbox-id",
          { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce },
          { resource_version: null },
        ),
        "[]",
      ],
      2,
    ],
    [
      "publishes malformed metadata",
      (nonce: string) => [
        sandboxListJson(
          "alpha-sandbox-id",
          { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce },
          { resource_version: "1" },
        ),
      ],
      1,
    ],
  ])(
    "withholds post-create effects when the nonce-owned row %s (#10423)",
    async (_case, observationsForNonce, expectedSelectorCalls) => {
      let nonce = "";
      let captureIndex = 0;
      const input = noGpuInput();
      input.verifyCreatedSandboxBeforeEffects = vi.fn();
      input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
      const patch = createGpuPatchFixture();
      mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
      mocks.streamSandboxCreate.mockImplementation(async (_command, args, _env, options) => {
        nonce = createAttemptNonce(args);
        expect(options.readyCheck).toEqual(expect.any(Function));
        options.readyCheck?.();
        return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
      });
      const deps = createGpuFlowDeps();
      vi.mocked(deps.runCaptureOpenshell).mockImplementation(
        () => ["alpha Ready", ...observationsForNonce(nonce)][captureIndex++] ?? "[]",
      );

      await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
        "OpenShell did not return one exact durable sandbox identity before post-create effects",
      );

      expect(
        vi
          .mocked(deps.runCaptureOpenshell)
          .mock.calls.filter(([args]) => args.includes("--selector")),
      ).toHaveLength(expectedSelectorCalls);
      expect(input.persistRetainedSandboxRecovery).toHaveBeenCalledOnce();
      expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
      expect(input.revalidateVerifiedSandboxBeforeEffect).not.toHaveBeenCalled();
      expect(patch.exitOnPatchError).not.toHaveBeenCalled();
      expect(patch.ensureApplied).not.toHaveBeenCalled();
      expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
    },
  );

  it("waits for the exact created sandbox to appear through its owning gateway (#9833)", async () => {
    let nonce = "";
    const input = noGpuInput();
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
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
    vi.mocked(deps.runOpenshell)
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr:
          "Error:   × code: 'Some requested entity was not found', message: \"sandbox not found\"",
      })
      .mockReturnValue({
        status: 0,
        stdout: "Name: alpha\nId: alpha-sandbox-id\nState: Ready\n",
        stderr: "",
      });

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({ route: "none" });

    expect(deps.sleep).toHaveBeenCalledExactlyOnceWith(1);
    expect(deps.runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["sandbox", "get", "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    expect(input.verifyCreatedSandboxBeforeEffects).toHaveBeenCalledOnce();
  });

  it("rejects a different owner-scoped sandbox identity before post-create effects (#9833)", async () => {
    let nonce = "";
    const input = noGpuInput();
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
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
    vi.mocked(deps.runOpenshell).mockReturnValue({
      status: 0,
      stdout: "Name: alpha\nId: replacement-sandbox-id\nState: Ready\n",
      stderr: "",
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "changed identity before identity verification completed",
    );

    expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
    expect(input.persistRetainedSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        `Durable sandbox identity fingerprint: ${fingerprintSandboxRecreateValue("alpha-sandbox-id")}`,
      ),
      fingerprintSandboxRecreateValue("alpha-sandbox-id"),
      nonce,
    );
    expect(patch.exitOnPatchError).not.toHaveBeenCalled();
    expect(patch.ensureApplied).not.toHaveBeenCalled();
    expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
  });

  it("stops when owner-scoped sandbox publication exceeds the deadline (#9833)", async () => {
    let nonce = "";
    const input = noGpuInput();
    input.sandboxReadyTimeoutSecs = 0.001;
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
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
    vi.mocked(deps.runOpenshell).mockReturnValue({
      status: 1,
      stdout: "",
      stderr:
        "Error:   × code: 'Some requested entity was not found', message: \"sandbox not found\"",
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "did not become visible through its owning gateway before identity verification completed",
    );

    expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
    expect(input.persistRetainedSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        `Durable sandbox identity fingerprint: ${fingerprintSandboxRecreateValue("alpha-sandbox-id")}`,
      ),
      fingerprintSandboxRecreateValue("alpha-sandbox-id"),
      nonce,
    );
    expect(patch.exitOnPatchError).not.toHaveBeenCalled();
    expect(patch.ensureApplied).not.toHaveBeenCalled();
    expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
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

  it("persists create-attempt recovery when Ready identity settlement reaches its deadline (#9211)", async () => {
    const events: string[] = [];
    let nonce = "";
    const input = noGpuInput();
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.persistRetainedSandboxRecovery = vi.fn(() => {
      events.push("persist-recovery");
      return true;
    });
    const patch = createGpuPatchFixture();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args) => {
      nonce = createAttemptNonce(args);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockReturnValue("[]");
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(30_000);

    const error = await runSandboxGpuCreateFlow(input, deps).catch((caught: unknown) => {
      events.push("rejected");
      return caught;
    });

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(
      "did not return one exact durable sandbox identity before post-create effects",
    );
    expect(input.persistRetainedSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        new RegExp(
          `^Create-attempt label: ${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}\\. Sandbox 'alpha'.*Gateway 'nemoclaw'`,
          "u",
        ),
      ),
      undefined,
      nonce,
    );
    expect(events).toEqual(["persist-recovery", "rejected"]);
    expect(deps.runCaptureOpenshell).toHaveBeenCalledOnce();
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
    expect(patch.exitOnPatchError).not.toHaveBeenCalled();
    expect(patch.ensureApplied).not.toHaveBeenCalled();
    expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
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

  it("returns a post-verification readiness failure to the recovery owner (#9833)", async () => {
    let nonce = "";
    const input = noGpuInput();
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    const patch = createGpuPatchFixture();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args) => {
      nonce = createAttemptNonce(args);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
      ready: false,
      reason: "timeout",
      failurePhase: null,
    });
    const deps = createGpuFlowDeps();
    vi.mocked(deps.runCaptureOpenshell).mockImplementationOnce(() =>
      sandboxListJson("alpha-sandbox-id", { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce }),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("direct process exit bypassed the recovery owner");
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "Sandbox 'alpha' did not become ready after verified creation",
    );

    expect(input.verifyCreatedSandboxBeforeEffects).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it("uses a distinct identity label for each create attempt (#9833)", async () => {
    const input = createGpuFlowInput();
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    input.persistRetainedSandboxRecovery = vi.fn(() => true);
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
      sandboxListJson("alpha-sandbox-id", { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce }),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");

    const fingerprint = fingerprintSandboxRecreateValue("alpha-sandbox-id");
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
    vi.mocked(deps.runCaptureOpenshell).mockReturnValue("[]");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");

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
    input.persistRetainedSandboxRecovery = vi.fn(() => true);
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
