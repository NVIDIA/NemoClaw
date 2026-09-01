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

const ALPHA_SANDBOX_IDENTITY_FINGERPRINT =
  "8174fa2a5d65755138d8339e086c03d736633130b22dca10952e80e74750c01d";

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

beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(resetGpuFlowMocks);

describe("created sandbox create-client handoff", () => {
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
    [
      "throws",
      (): boolean => {
        throw new Error("recovery writer failed");
      },
    ],
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
          `Durable sandbox identity fingerprint: ${ALPHA_SANDBOX_IDENTITY_FINGERPRINT}`,
        ),
        ALPHA_SANDBOX_IDENTITY_FINGERPRINT,
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
});
