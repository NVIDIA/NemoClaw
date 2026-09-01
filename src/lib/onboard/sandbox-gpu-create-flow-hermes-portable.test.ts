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

import { NEMOCLAW_CREATE_ATTEMPT_LABEL } from "../adapters/openshell/sandbox-identity";
import type { CheckpointPortableRuntimeAuthority } from "../state/onboard-checkpoint-types";
import {
  createAttemptNonce,
  createGpuFlowDeps as createDeps,
  createGpuFlowInput as createInput,
  createGpuPatchFixture,
  createNoGpuFlowInput as createNoGpuInput,
  resetGpuFlowMocks,
  sandboxListJson,
  setupGpuFlowMocks,
} from "./__test-helpers__/sandbox-gpu-create-flow";
import {
  createHermesPortableReadyCapture,
  createHermesPortableReadyRunner,
} from "./experimental/hermes-portable-onboarding";
import { runSandboxGpuCreateFlow, type SandboxGpuCreateFlowInput } from "./sandbox-gpu-create-flow";
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

  it("carries Hermes receipt authority from selector settlement through publication lookup (#10423)", async () => {
    let nonce = "";
    const input = createNoGpuInput();
    const patch = createGpuPatchFixture();
    input.verifyCreatedSandboxBeforeEffects = vi.fn();
    input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockImplementation(async (_command, args, _env, options) => {
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
        [["sandbox", "list", "-g", "nemoclaw"].join("\0")]: () => ({
          status: 0,
          stdout: Buffer.from("alpha Ready"),
          stderr: Buffer.alloc(0),
        }),
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
        ].join("\0")]: () => ({
          status: 0,
          stdout: Buffer.from(
            sandboxListJson("alpha-sandbox-id", {
              [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce,
            }),
          ),
          stderr: Buffer.alloc(0),
        }),
        [["sandbox", "get", "-g", "nemoclaw", "alpha"].join("\0")]: () => ({
          status: 0,
          stdout: Buffer.from("ID: alpha-sandbox-id\n"),
          stderr: Buffer.alloc(0),
        }),
      } satisfies Readonly<
        Record<string, () => { status: number; stdout: Buffer; stderr: Buffer }>
      >;
      return (
        results[args.join("\0") as keyof typeof results] ??
        (() => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
      )();
    });
    const deps = createDeps();
    deps.runOpenshell = createHermesPortableReadyRunner("alpha", "nemoclaw", capture);
    deps.runCaptureOpenshell = createHermesPortableReadyCapture("alpha", "nemoclaw", capture);

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({ route: "none" });

    expect(input.verifyCreatedSandboxBeforeEffects).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith([
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
    ]);
    expect(capture).toHaveBeenCalledWith(["sandbox", "get", "-g", "nemoclaw", "alpha"]);
  });
});
