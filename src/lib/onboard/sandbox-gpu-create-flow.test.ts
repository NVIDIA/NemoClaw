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
  helperResponds: vi.fn(),
  dockerSpawnSync: vi.fn(),
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

vi.mock("../adapters/docker/credential-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker/credential-store")>()),
  dockerDesktopCredentialHelperResponds: mocks.helperResponds,
}));

vi.mock("../adapters/docker/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker/exec")>()),
  dockerSpawnSync: mocks.dockerSpawnSync,
}));

vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  isWsl: (opts: { env?: NodeJS.ProcessEnv; isWsl?: boolean } = {}) =>
    typeof opts.isWsl === "boolean" ? opts.isWsl : Boolean(opts.env?.WSL_DISTRO_NAME),
}));

import {
  NEMOCLAW_CREATE_ATTEMPT_LABEL,
  NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH,
} from "../adapters/openshell/sandbox-identity";
import {
  createGpuFlowDeps as createDeps,
  createGpuFlowInput as createInput,
  createGpuPatchFixture as createPatch,
  createGpuFlowTestHarness,
  GPU_IMAGE_ID as IMAGE_ID,
  VERIFIED_GPU_PROOF as VERIFIED_PROOF,
} from "./__test-helpers__/sandbox-gpu-create-flow";
import { runSandboxGpuCreateFlow } from "./sandbox-gpu-create-flow";

const {
  READY_CHECK_OPTIONS,
  FAILED_PROOF,
  NVIDIA_SMI_FAILED_PROOF,
  DEFAULT_RUNTIME_SNAPSHOT,
  PORTABLE_RUNTIME_AUTHORITY,
  readySandboxGetResult,
  createSequencedOpenShellRunner,
  failNativeCreate,
  expectFlowExit,
  mockExit,
  mockRuntimeSnapshot,
  mockReadinessFailure,
  expectNativeStateKept,
  errorOutput,
  createSourceInput,
  setupHarness,
  resetHarness,
} = createGpuFlowTestHarness(mocks);
const READY_CHECK_ARGS = ["sandbox", "list", "-g", "nemoclaw"];
const SEMANTIC_CREATE_ARGS = [
  "sandbox",
  "create",
  "-g",
  "nemoclaw",
  "--from",
  "openshell/sandbox-from:test",
  "--name",
  "alpha",
  "--gpu",
  "--",
  "nemoclaw-start",
];

function createVerifiedNoGpuInput() {
  const input = createInput();
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
  input.createRequest = { ...input.createRequest!, gpu: undefined };
  input.persistRetainedSandboxRecovery = vi.fn(() => true);
  input.verifyCreatedSandboxBeforeEffects = vi.fn();
  input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
  return input;
}

function sandboxListWithAttempt(nonce: string): string {
  return JSON.stringify([
    {
      id: "alpha-sandbox-id",
      name: "alpha",
      labels: { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce },
      resource_version: 1,
      created_at: "2026-08-25T00:00:00Z",
      phase: "Ready",
      current_policy_version: 1,
    },
  ]);
}

beforeEach(setupHarness);
afterEach(resetHarness);

describe("runSandboxGpuCreateFlow proof authorization", () => {
  it("does not retry compatibility when the native proof throws an exec/policy error (#6110)", async () => {
    const deps = createDeps();
    vi.mocked(deps.verifyDirectSandboxGpu).mockImplementation(() => {
      throw new Error("openshell sandbox exec denied by policy");
    });

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow(
      "openshell sandbox exec denied by policy",
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    const calls = vi.mocked(deps.runOpenshell).mock.calls;
    expect(calls.flat()).not.toContain("delete");
  });

  it("does not let sandbox-controlled CUDA output authorize compatibility fallback (#6110)", async () => {
    const deps = createDeps();
    vi.mocked(deps.verifyDirectSandboxGpu).mockReturnValue(FAILED_PROOF);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "cannot authorize a less-confined compatibility retry",
    );
  });

  it("inspects the exact recreated native container before authorizing compatibility fallback", async () => {
    const deps = createDeps();
    const replacementContainerId = "b".repeat(64);
    vi.mocked(deps.verifyDirectSandboxGpu)
      .mockReturnValueOnce(NVIDIA_SMI_FAILED_PROOF)
      .mockReturnValue(VERIFIED_PROOF);
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValueOnce({
      ...createPatch(),
      replacementRuntimeId: vi.fn(() => replacementContainerId),
    });
    mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockImplementation(
      (_sandboxName, _deps, options) =>
        options?.expectedContainerId === replacementContainerId
          ? { ...DEFAULT_RUNTIME_SNAPSHOT, containerId: replacementContainerId }
          : { ok: false, error: "expected one labeled sandbox container, found 2" },
    );

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).resolves.toMatchObject({
      route: "compatibility",
      registryImageRef: "openshell/sandbox-from:test",
    });

    expect(mocks.streamSandboxCreate).toHaveBeenCalledTimes(2);
    expect(mocks.queryOpenShellDockerSandboxRuntimeSnapshot).toHaveBeenCalledWith(
      "alpha",
      {},
      { expectedContainerId: replacementContainerId },
    );
    expect(deps.runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ suppressOutput: true }),
    );
  });

  it.each(["present", "unknown"] as const)(
    "fails closed on sandbox nvidia-smi text when host GPU attachment is %s",
    async (nativeGpuAttachmentState) => {
      const deps = createDeps();
      vi.mocked(deps.verifyDirectSandboxGpu).mockReturnValue(NVIDIA_SMI_FAILED_PROOF);
      mockRuntimeSnapshot({ nativeGpuAttachmentState });
      mockExit();

      await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

      expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
      expect(mocks.queryOpenShellDockerSandboxRuntimeSnapshot).toHaveBeenCalledOnce();
      expect(deps.runOpenshell).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
      expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
        "without corroborating host evidence cannot authorize",
      );
    },
  );

  it("stops after one compatibility retry when its GPU proof also fails", async () => {
    const deps = createDeps();
    vi.mocked(deps.verifyDirectSandboxGpu).mockReturnValue(NVIDIA_SMI_FAILED_PROOF);
    mockRuntimeSnapshot();
    const nativePatch = createPatch();
    const compatibilityPatch = createPatch();
    compatibilityPatch.verifyGpuOrExit.mockReturnValue(NVIDIA_SMI_FAILED_PROOF);
    mocks.createDockerGpuSandboxCreatePatch
      .mockReturnValueOnce(nativePatch)
      .mockReturnValueOnce(compatibilityPatch);

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow(
      "Sandbox GPU proof returned failed status",
    );

    expect(mocks.streamSandboxCreate).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(deps.runOpenshell)
        .mock.calls.filter(([args]) => (args as string[]).includes("delete")),
    ).toHaveLength(1);
  });

  it("hard-stops a returned failed proof in compatibility-only mode", async () => {
    const input = createInput();
    input.gpuRoutePlan = "compatibility-only";
    input.initialGpuRoute = "compatibility";
    mocks.createDockerGpuSandboxCreatePatch.mockImplementation(() => {
      const patch = createPatch();
      patch.verifyGpuOrExit.mockReturnValue(NVIDIA_SMI_FAILED_PROOF);
      return patch;
    });

    await expect(runSandboxGpuCreateFlow(input, createDeps())).rejects.toThrow(
      "Sandbox GPU proof returned failed status",
    );

    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
  });
});

describe("runSandboxGpuCreateFlow native failure and readiness", () => {
  it("rejects APF policy authority before lifecycle submission or mutable-name cleanup (#12119)", async () => {
    const input = createVerifiedNoGpuInput();
    const startupCommand = [...input.createRequest!.startupCommand];
    input.requirePolicylessCreate = true;
    input.createRequest = {
      ...input.createRequest!,
      policyPath: "/tmp/caller-policy.yaml",
      startupCommand,
    };
    const deps = createDeps();
    deps.createSandbox = vi.fn();

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "APF interceptor sandbox creation must not supply a caller policy",
    );

    expect(deps.createSandbox).not.toHaveBeenCalled();
    expect(input.createRequest.startupCommand).toEqual(startupCommand);
    expect(
      vi
        .mocked(deps.runOpenshell)
        .mock.calls.filter(([args]) => (args as string[]).includes("delete")),
    ).toHaveLength(0);
  });

  it("settles an ambiguous create submission before post-create effects", async () => {
    let nonce = "";
    const input = createVerifiedNoGpuInput();
    const deps = createDeps();
    deps.createSandbox = vi.fn(async (request) => {
      nonce = request.labels?.[NEMOCLAW_CREATE_ATTEMPT_LABEL] ?? "";
      return {
        status: 1,
        output: "OpenShell create handoff was interrupted.",
        sawProgress: false,
        ambiguous: true,
        diagnostic: "OpenShell create handoff was interrupted.",
      };
    });
    vi.mocked(deps.runCaptureOpenshell).mockImplementationOnce(() => sandboxListWithAttempt(nonce));
    const exit = vi.spyOn(process, "exit");

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({ route: "none" });

    expect(nonce).toHaveLength(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH);
    expect(input.verifyCreatedSandboxBeforeEffects).toHaveBeenCalledOnce();
    expect(input.persistRetainedSandboxRecovery).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("persists recovery when an ambiguous create submission has no settled identity", async () => {
    let nonce = "";
    const input = createVerifiedNoGpuInput();
    const deps = createDeps();
    deps.createSandbox = vi.fn(async (request) => {
      nonce = request.labels?.[NEMOCLAW_CREATE_ATTEMPT_LABEL] ?? "";
      return {
        status: 1,
        output: "OpenShell create handoff was interrupted.",
        sawProgress: false,
        ambiguous: true,
        diagnostic: "OpenShell create handoff was interrupted.",
      };
    });
    vi.mocked(deps.runCaptureOpenshell).mockReturnValue("[]");
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(30_000);

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "did not return one exact durable sandbox identity before post-create effects",
    );

    expect(input.persistRetainedSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`),
      undefined,
      nonce,
    );
    expect(input.verifyCreatedSandboxBeforeEffects).not.toHaveBeenCalled();
    expect(deps.createSandbox).toHaveBeenCalledOnce();
  });

  it("bounds the streamed sandbox readiness probe", async () => {
    const deps = createDeps();
    mocks.streamSandboxCreate.mockImplementationOnce(async (...args) => {
      expect(args[3].readyCheck()).toBe(true);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    const result = await runSandboxGpuCreateFlow(createInput(), deps);
    expect(result).toMatchObject({ route: "native" });
    expect(deps.runCaptureOpenshell).toHaveBeenCalledWith(READY_CHECK_ARGS, READY_CHECK_OPTIONS);
  });

  it("retains the onboarding-qualified OpenShell executable for ordinary create", async () => {
    vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", "/ambient/openshell");
    const deps = createDeps();
    deps.openshellArgv = vi.fn((args: string[]) => ["/qualified/openshell", ...args]);

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).resolves.toMatchObject({
      route: "native",
    });

    expect(deps.openshellArgv).toHaveBeenCalledExactlyOnceWith([]);
    expect(mocks.streamSandboxCreate).toHaveBeenCalledWith(
      "/qualified/openshell",
      SEMANTIC_CREATE_ARGS,
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("defers restart-safe no-GPU recreation until the create process exits (#8720)", async () => {
    const input = createInput();
    const patch = createPatch();
    const createHandoff: string[] = [];
    let completeCreate!: () => void;
    const createPending = new Promise<void>((resolve) => {
      completeCreate = resolve;
    });
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValueOnce(patch);
    mocks.streamSandboxCreate.mockImplementationOnce(async (...args) => {
      const options = args[3];
      createHandoff.push("poll");
      options.onPoll();
      await createPending;
      createHandoff.push("create-complete");
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    patch.ensureApplied.mockImplementationOnce(() => {
      createHandoff.push("ensure-applied");
    });
    input.sandboxGpuConfig = {
      ...input.sandboxGpuConfig,
      mode: "0",
      sandboxGpuEnabled: false,
    };
    input.gpuRoutePlan = "none";
    input.initialGpuRoute = "none";
    input.createRequest = { ...input.createRequest!, gpu: undefined };
    input.persistStartupCommand = true;
    input.requiredUlimits = [
      { name: "nproc", soft: 512, hard: 512 },
      { name: "nofile", soft: 65_536, hard: 65_536 },
    ];

    const flow = runSandboxGpuCreateFlow(input, createDeps());
    await vi.waitFor(() => expect(createHandoff).toEqual(["poll"]));
    expect(patch.ensureApplied).not.toHaveBeenCalled();
    completeCreate();

    await expect(flow).resolves.toMatchObject({ route: "none" });

    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "none",
        persistStartupCommand: true,
        requiredUlimits: input.requiredUlimits,
      }),
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledWith(
      expect.stringMatching(/openshell$/u),
      SEMANTIC_CREATE_ARGS.filter((value) => value !== "--gpu"),
      input.sandboxEnv,
      expect.objectContaining({ waitForReadyTermination: true }),
    );
    expect(patch.maybeApplyDuringCreate).not.toHaveBeenCalled();
    expect(createHandoff).toEqual(["poll", "create-complete", "ensure-applied"]);
    expect(mocks.waitForCreatedSandboxReadyWithTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        stableReadyPolls: 2,
        checkReadyIdentity: expect.any(Function),
      }),
    );
  });

  it("keeps managed DCode on the exact OpenShell-created runtime", async () => {
    const input = createInput();
    const patch = createPatch();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValueOnce(patch);
    input.sandboxGpuConfig = {
      ...input.sandboxGpuConfig,
      mode: "0",
      sandboxGpuEnabled: false,
    };
    input.gpuRoutePlan = "none";
    input.initialGpuRoute = "none";
    input.createRequest = { ...input.createRequest!, gpu: undefined };
    input.persistStartupCommand = true;
    input.managedImage = true;
    input.requiredUlimits = [
      { name: "nproc", soft: 512, hard: 512 },
      { name: "nofile", soft: 65_536, hard: 65_536 },
    ];

    await expect(runSandboxGpuCreateFlow(input, createDeps())).resolves.toMatchObject({
      route: "none",
    });

    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "none",
        persistStartupCommand: true,
        externalRecreation: true,
        requiredUlimits: null,
      }),
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledWith(
      expect.stringMatching(/openshell$/u),
      SEMANTIC_CREATE_ARGS.filter((value) => value !== "--gpu"),
      input.sandboxEnv,
      expect.objectContaining({ waitForReadyTermination: false }),
    );
    expect(patch.ensureApplied).toHaveBeenCalled();
  });

  it("does not delete a recreated sandbox when the exact readiness probe fails (#9050)", async () => {
    const input = createInput();
    const patch = createPatch();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValueOnce(patch);
    input.sandboxGpuConfig = {
      ...input.sandboxGpuConfig,
      mode: "0",
      sandboxGpuEnabled: false,
    };
    input.gpuRoutePlan = "none";
    input.initialGpuRoute = "none";
    input.persistStartupCommand = true;
    input.requiredUlimits = [
      { name: "nproc", soft: 512, hard: 512 },
      { name: "nofile", soft: 65_536, hard: 65_536 },
    ];
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockImplementation(
      createSequencedOpenShellRunner([
        ["sandbox get -g nemoclaw alpha", [readySandboxGetResult(), readySandboxGetResult()]],
      ]),
    );
    vi.mocked(deps.commandExecutor.runBuffered).mockResolvedValueOnce({
      outcome: { kind: "completed", exitCode: 1, signal: null },
      stdout: "",
      stderr: "permission denied",
    });
    mocks.waitForCreatedSandboxReadyWithTrace.mockImplementationOnce(async (options) => {
      await expect(options.checkReadyIdentity?.()).resolves.toBe("probe_failed");
      return {
        ready: false,
        reason: "identity_probe_failed",
        failurePhase: null,
      };
    });
    mockExit();

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");

    expect(patch.rollbackManagedStartupAfterCreateFailure).toHaveBeenCalledOnce();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(mocks.printSandboxCreateFailureDiagnostics).toHaveBeenCalledWith("alpha", {
      backupPath: null,
    });
    expect(errorOutput()).toContain(
      "NemoClaw left the sandbox in place for inspection and recovery",
    );
  });

  it("keeps a transient recreated-sandbox not-ready response inside the readiness wait (#9050)", async () => {
    const input = createInput();
    const patch = createPatch();
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValueOnce(patch);
    input.sandboxGpuConfig = {
      ...input.sandboxGpuConfig,
      mode: "0",
      sandboxGpuEnabled: false,
    };
    input.gpuRoutePlan = "none";
    input.initialGpuRoute = "none";
    input.persistStartupCommand = true;
    input.requiredUlimits = [
      { name: "nproc", soft: 512, hard: 512 },
      { name: "nofile", soft: 65_536, hard: 65_536 },
    ];
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockImplementation(
      createSequencedOpenShellRunner([
        [
          "sandbox get -g nemoclaw alpha",
          [readySandboxGetResult(), readySandboxGetResult(), readySandboxGetResult()],
        ],
      ]),
    );
    vi.mocked(deps.commandExecutor.runBuffered)
      .mockResolvedValueOnce({
        outcome: { kind: "completed", exitCode: 1, signal: null },
        stdout: "",
        stderr:
          `Error:   × code: 'The system is not in a state required for the operation's\n` +
          '  │ execution\', message: "sandbox is not ready"\n',
      })
      .mockResolvedValueOnce({
        outcome: { kind: "completed", exitCode: 0, signal: null },
        stdout: "",
        stderr: "",
      });
    mocks.waitForCreatedSandboxReadyWithTrace.mockImplementationOnce(async (options) => {
      await expect(options.checkReadyIdentity?.()).resolves.toBe("not_ready");
      await expect(options.checkReadyIdentity?.()).resolves.toBe("ready");
      return { ready: true, reason: "ready", failurePhase: null };
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      route: "none",
    });

    expect(deps.commandExecutor.runBuffered).toHaveBeenCalledTimes(2);
    expect(patch.rollbackManagedStartupAfterCreateFailure).not.toHaveBeenCalled();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("preserves a native non-terminal startup command after create ownership ends", async () => {
    const input = createInput();
    const patch = createPatch();
    const order: string[] = [];
    input.persistStartupCommand = true;
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValueOnce(patch);
    mocks.streamSandboxCreate.mockImplementationOnce(async (...args) => {
      order.push("poll");
      args[3].onPoll();
      order.push("create-complete");
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });
    patch.ensureApplied.mockImplementationOnce(() => {
      order.push("ensure-applied");
    });

    await expect(runSandboxGpuCreateFlow(input, createDeps())).resolves.toMatchObject({
      route: "native",
    });

    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ route: "native", persistStartupCommand: true }),
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledWith(
      expect.stringMatching(/openshell$/u),
      SEMANTIC_CREATE_ARGS,
      input.sandboxEnv,
      expect.objectContaining({ waitForReadyTermination: true }),
    );
    expect(patch.maybeApplyDuringCreate).not.toHaveBeenCalled();
    expect(order).toEqual(["poll", "create-complete", "ensure-applied"]);
  });

  it("keeps a native terminal startup command on the create lifecycle", async () => {
    const input = createInput();
    input.persistStartupCommand = true;
    input.terminalAgent = true;

    await expect(runSandboxGpuCreateFlow(input, createDeps())).resolves.toMatchObject({
      route: "native",
    });

    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ route: "native", persistStartupCommand: false }),
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledWith(
      expect.stringMatching(/openshell$/u),
      SEMANTIC_CREATE_ARGS,
      input.sandboxEnv,
      expect.objectContaining({ waitForReadyTermination: false }),
    );
  });

  it("waits for native non-terminal startup output before detaching the create client", async () => {
    const input = createInput();
    input.sandboxEnv = { OPENSHELL_DRIVERS: "docker" };

    await expect(runSandboxGpuCreateFlow(input, createDeps())).resolves.toMatchObject({
      route: "native",
    });

    const streamOptions = mocks.streamSandboxCreate.mock.calls[0]?.[3];
    expect(streamOptions).toEqual(
      expect.objectContaining({
        readyCheckOutputPatterns: [expect.any(RegExp)],
      }),
    );
    expect(
      streamOptions?.readyCheckOutputPatterns?.some((pattern: RegExp) =>
        pattern.test("Setting up NemoClaw (Hermes)..."),
      ),
    ).toBe(true);
  });

  it("applies exact required limits while preserving the native GPU route", async () => {
    const input = createInput();
    input.persistStartupCommand = true;
    input.requiredUlimits = [
      { name: "nproc", soft: 512, hard: 512 },
      { name: "nofile", soft: 65_536, hard: 65_536 },
    ];

    await expect(runSandboxGpuCreateFlow(input, createDeps())).resolves.toMatchObject({
      route: "native",
    });

    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "native",
        persistStartupCommand: true,
        requiredUlimits: input.requiredUlimits,
      }),
    );
  });

  it("keeps managed-image limits inside the exact OpenShell-created runtime", async () => {
    const input = createInput();
    input.managedImage = true;
    input.persistStartupCommand = true;
    input.requiredUlimits = [
      { name: "nproc", soft: 512, hard: 512 },
      { name: "nofile", soft: 65_536, hard: 65_536 },
    ];

    await expect(runSandboxGpuCreateFlow(input, createDeps())).resolves.toMatchObject({
      route: "native",
    });

    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        externalRecreation: true,
        persistStartupCommand: true,
        requiredUlimits: null,
      }),
    );
  });

  it.each([
    {
      failure: "image build",
      output: "Docker build failed while compiling a GPU Python package for --gpu support",
    },
    {
      failure: "image upload",
      output: "[progress] Uploaded to gateway\nfailed to upload image tar into container",
    },
    {
      failure: "TLS handshake",
      output: "x509: certificate signed by unknown authority",
    },
    {
      failure: "provider credential validation",
      output: "Provider credential validation failed: required token is unavailable",
    },
    {
      failure: "policy application",
      output: "Sandbox policy application failed: requested policy was denied",
    },
  ])("retains an ambiguous post-progress $failure failure (#6110)", async ({ output }) => {
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output,
      sawProgress: true,
    });
    const deps = createDeps();
    const exit = mockExit();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow(
      "did not confirm whether sandbox 'alpha' was created",
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledOnce();
    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ route: "native" }),
    );
    expect(deps.runOpenshell).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("redacts an ambiguous post-progress create failure without ordinary cleanup (#6110)", async () => {
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 19,
      output: "provider failed with NVIDIA_API_KEY=super-secret-create-value",
      sawProgress: true,
    });
    const exit = mockExit(19);

    await expect(runSandboxGpuCreateFlow(createInput(), createDeps())).rejects.toThrow(
      "did not confirm whether sandbox 'alpha' was created",
    );

    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(exit).not.toHaveBeenCalled();
    expect(output).not.toContain("super-secret-create-value");
  });

  it("does not retry compatibility for a non-GPU native readiness failure (#6110)", async () => {
    mockReadinessFailure();
    const deps = createDeps();
    vi.mocked(deps.runCaptureOpenshell).mockReturnValue(
      "gpu-device-initialization-failed Failed\nother-sandbox Error NVIDIA GPU device unavailable",
    );
    mockExit();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");
    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(mocks.verifyGpuSandboxAccessAfterReady).not.toHaveBeenCalled();
    expect(deps.runOpenshell).not.toHaveBeenCalled();
    expect(errorOutput()).toContain("Recovery remains blocked while this sandbox exists");
    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
  });

  it("retains a post-progress nonzero result before separate readiness polling (#6110)", async () => {
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 23,
      output: "Created sandbox: alpha",
      sawProgress: true,
    });
    mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
      ready: false,
      reason: "timeout",
      failurePhase: null,
    });
    const exit = mockExit(23);

    await expect(runSandboxGpuCreateFlow(createInput(), createDeps())).rejects.toThrow(
      "did not confirm whether sandbox 'alpha' was created",
    );

    expect(exit).not.toHaveBeenCalled();
    expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
  });

  it("keeps native readiness on the single-Ready contract", async () => {
    const deps = createDeps();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).resolves.toMatchObject({
      route: "native",
    });

    expect(mocks.waitForCreatedSandboxReadyWithTrace).toHaveBeenCalledWith(
      expect.objectContaining({ stableReadyPolls: 1 }),
    );
    expect(mocks.enforceDockerGpuPatchPreserveNetwork).not.toHaveBeenCalled();
  });

  it("preserves standard lifecycle generation without enrolling Portable ownership", async () => {
    const input = createInput();
    input.lifecycleGeneration = "current-generation";
    input.portableRuntimeAuthority = PORTABLE_RUNTIME_AUTHORITY;
    const deps = createDeps();
    deps.installPortableDemoLifecycle = vi.fn(() => "unexpected-portable-generation");

    const result = await runSandboxGpuCreateFlow(input, deps);

    expect(result.route).toBe("native");
    expect(result.lifecycleRegistrationFields).toEqual({
      lifecycleGeneration: "current-generation",
    });

    expect(deps.installPortableDemoLifecycle).not.toHaveBeenCalled();
  });

  it("uses the exact portable lifecycle without Docker container substitution (#9068)", async () => {
    const input = createInput();
    input.gpuRoutePlan = "native-only";
    input.hostEnv = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };
    input.portableLifecycle = true;
    input.portableRuntimeAuthority = PORTABLE_RUNTIME_AUTHORITY;
    input.lifecycleGeneration = "checkpoint-generation";
    input.persistStartupCommand = true;
    const deps = createDeps();
    deps.installPortableDemoLifecycle = vi.fn(() => "installed-generation");

    const result = await runSandboxGpuCreateFlow(input, deps);

    expect(result).toMatchObject({
      route: "native",
      lifecycleRegistrationFields: { lifecycleGeneration: "installed-generation" },
    });
    expect(deps.installPortableDemoLifecycle).toHaveBeenCalledOnce();
    expect(deps.installPortableDemoLifecycle).toHaveBeenCalledWith(
      input.sandboxName,
      input.sandboxStartupCommand,
      input.hostEnv,
      {
        registryGeneration: "checkpoint-generation",
        runtimeAuthority: PORTABLE_RUNTIME_AUTHORITY,
      },
    );
    expect(mocks.waitForCreatedSandboxReadyWithTrace.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.installPortableDemoLifecycle).mock.invocationCallOrder[0]!,
    );
    expect(mocks.createDockerGpuSandboxCreatePatch).not.toHaveBeenCalled();
    expect(mocks.queryOpenShellDockerSandboxContainers).not.toHaveBeenCalled();
    expect(mocks.queryOpenShellDockerSandboxRuntimeSnapshot).not.toHaveBeenCalled();
    expect(mocks.streamSandboxCreate).toHaveBeenCalledWith(
      expect.stringMatching(/openshell$/u),
      expect.arrayContaining(["sandbox", "create", "--name", input.sandboxName]),
      input.sandboxEnv,
      expect.objectContaining({ waitForReadyTermination: false }),
    );
  });

  it("keeps a Ready portable sandbox in place when lifecycle enrollment fails (#9068)", async () => {
    const input = createInput();
    input.gpuRoutePlan = "native-only";
    input.hostEnv = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };
    input.portableLifecycle = true;
    input.portableRuntimeAuthority = PORTABLE_RUNTIME_AUTHORITY;
    const deps = createDeps();
    deps.installPortableDemoLifecycle = vi.fn(() => {
      throw new Error("portable authority changed");
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "portable authority changed",
    );

    expect(mocks.createDockerGpuSandboxCreatePatch).not.toHaveBeenCalled();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("does not enroll portable lifecycle ownership before GPU proof succeeds (#9068)", async () => {
    const input = createInput();
    input.gpuRoutePlan = "native-only";
    input.hostEnv = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };
    input.portableLifecycle = true;
    input.portableRuntimeAuthority = PORTABLE_RUNTIME_AUTHORITY;
    const deps = createDeps();
    deps.installPortableDemoLifecycle = vi.fn(() => "current-generation");
    vi.mocked(deps.verifyDirectSandboxGpu).mockImplementation(() => {
      throw new Error("GPU proof failed");
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("GPU proof failed");

    expect(deps.installPortableDemoLifecycle).not.toHaveBeenCalled();
    expect(mocks.createDockerGpuSandboxCreatePatch).not.toHaveBeenCalled();
  });

  it("rejects Docker compatibility before portable sandbox creation (#9068)", async () => {
    const input = createInput();
    input.hostEnv = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };
    input.portableLifecycle = true;

    await expect(runSandboxGpuCreateFlow(input, createDeps())).rejects.toThrow(
      "Docker GPU compatibility is unavailable",
    );

    expect(mocks.streamSandboxCreate).not.toHaveBeenCalled();
    expect(mocks.createDockerGpuSandboxCreatePatch).not.toHaveBeenCalled();
    expect(mocks.queryOpenShellDockerSandboxContainers).not.toHaveBeenCalled();
  });

  it("preserves an unready portable sandbox without lifecycle mutation (#9068)", async () => {
    const input = createInput();
    input.gpuRoutePlan = "native-only";
    input.hostEnv = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };
    input.portableLifecycle = true;
    const deps = createDeps();
    deps.installPortableDemoLifecycle = vi.fn(() => "current-generation");
    mockReadinessFailure();
    mockExit();

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");

    expect(deps.installPortableDemoLifecycle).not.toHaveBeenCalled();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(errorOutput()).toContain("left the portable sandbox in place");
  });
});

describe("runSandboxGpuCreateFlow fallback ordering", () => {
  it("retries readiness only for exact-container host runtime evidence (#6110)", async () => {
    mocks.waitForCreatedSandboxReadyWithTrace
      .mockReturnValueOnce({
        ready: false,
        reason: "terminal_failure_phase",
        failurePhase: "Error",
      })
      .mockReturnValue({ ready: true, reason: "ready", failurePhase: null });
    mockRuntimeSnapshot({
      stateError: "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
    });

    await expect(runSandboxGpuCreateFlow(createInput(), createDeps())).resolves.toMatchObject({
      route: "compatibility",
      registryImageRef: "openshell/sandbox-from:test",
    });

    expect(mocks.streamSandboxCreate).toHaveBeenCalledTimes(2);
  });

  it("streams native and compatibility attempts through the semantic lifecycle without a shell (#6110)", async () => {
    failNativeCreate();
    const input = createInput();
    const deps = createDeps();
    deps.openshellArgv = vi.fn((args: string[]) => ["/qualified/openshell", ...args]);
    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      route: "compatibility",
    });

    expect(mocks.streamSandboxCreate).toHaveBeenNthCalledWith(
      1,
      "/qualified/openshell",
      SEMANTIC_CREATE_ARGS,
      input.sandboxEnv,
      expect.objectContaining({
        onPoll: expect.any(Function),
        readyCheck: expect.any(Function),
      }),
    );
    expect(mocks.streamSandboxCreate).toHaveBeenNthCalledWith(
      2,
      "/qualified/openshell",
      expect.arrayContaining(["sandbox", "create", "--from", IMAGE_ID]),
      input.sandboxEnv,
      expect.any(Object),
    );
    expect(mocks.streamSandboxCreate.mock.calls.flat()).not.toContain("bash");
    expect(mocks.streamSandboxCreate.mock.calls.flat()).not.toContain("-lc");
    expect(deps.openshellArgv).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("discloses the compatibility container-swap confinement tradeoff and native-only opt-out", async () => {
    failNativeCreate();
    const deps = createDeps();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).resolves.toMatchObject({
      route: "compatibility",
    });

    const warning = vi.mocked(console.warn).mock.calls.flat().join("\n");
    expect(warning).toContain("recreating the OpenShell-managed Docker container");
    expect(warning).toContain("legacy GPU compatibility envelope");
    expect(warning).toContain("may relax container confinement");
    expect(warning).toContain("NEMOCLAW_DOCKER_GPU_PATCH=fallback");
    expect(warning).toContain("explicitly authorized");
    expect(mocks.streamSandboxCreate).toHaveBeenCalledTimes(2);
    expect(mocks.waitForCreatedSandboxReadyWithTrace).toHaveBeenCalledWith(
      expect.objectContaining({ stableReadyPolls: 2 }),
    );
  });

  it("recreates a managed compatibility route with the complete GPU envelope", async () => {
    const input = createInput();
    input.managedImage = true;
    failNativeCreate();

    await expect(runSandboxGpuCreateFlow(input, createDeps())).resolves.toMatchObject({
      route: "compatibility",
    });

    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        route: "compatibility",
        externalRecreation: false,
      }),
    );
  });

  it("runs the local-provider bridge preflight only after selecting compatibility fallback", async () => {
    const input = createInput();
    input.provider = "ollama-local";
    input.sandboxEnv = {
      NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "host",
    };
    input.sandboxGpuConfig.sandboxGpuProof = VERIFIED_PROOF;
    failNativeCreate();
    const deps = createDeps();

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      route: "compatibility",
    });

    expect(mocks.enforceDockerGpuPatchPreserveNetwork).toHaveBeenCalledOnce();
    expect(mocks.enforceDockerGpuPatchPreserveNetwork).toHaveBeenCalledWith(
      "ollama-local",
      input.sandboxGpuConfig,
      expect.objectContaining({
        dockerDriverGateway: true,
        selectedRoute: "compatibility",
        gatewayPort: 8080,
      }),
    );
    const cleanupComplete =
      mocks.queryOpenShellDockerSandboxContainers.mock.invocationCallOrder.at(-1) ??
      Number.POSITIVE_INFINITY;
    const networkPrepared = mocks.enforceDockerGpuPatchPreserveNetwork.mock.invocationCallOrder[0];
    const compatibilityCreate = mocks.streamSandboxCreate.mock.invocationCallOrder[1];
    expect(cleanupComplete).toBeLessThan(networkPrepared);
    expect(networkPrepared).toBeLessThan(compatibilityCreate);
    expect(input.sandboxGpuConfig.sandboxGpuProof).toBeNull();
  });

  it("validates the full compatibility command before proving native state absent (#6110)", async () => {
    const input = createInput();
    input.compatibilityPolicyPath = null;
    failNativeCreate();
    const deps = createDeps();
    await expectFlowExit(input, deps);
    expectNativeStateKept(deps);
    expect(errorOutput()).toContain("Compatibility retry policy was not materialized");
  });

  it("rejects a malformed semantic request before process spawn (#6110)", async () => {
    const deps = createDeps();
    const input = createInput();
    input.createRequest = { ...input.createRequest!, driverConfigJson: "{" };
    await expectFlowExit(input, deps);
    expect(mocks.streamSandboxCreate).not.toHaveBeenCalled();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      expect.arrayContaining(["delete"]),
      expect.anything(),
    );
    expect(errorOutput()).toContain("Invalid OpenShell sandbox create request");
  });

  it("runs compatibility network preflight only after native cleanup succeeds (#6110)", async () => {
    const input = createInput();
    input.provider = "ollama-local";
    failNativeCreate();
    mocks.enforceDockerGpuPatchPreserveNetwork.mockRejectedValueOnce(
      new Error("compatibility bridge is unreachable"),
    );
    const deps = createDeps();
    await expectFlowExit(input, deps);
    expect(deps.openshellArgv).toHaveBeenCalledExactlyOnceWith([]);
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(errorOutput()).toContain("compatibility bridge is unreachable");
  });
});

describe("runSandboxGpuCreateFlow cleanup and provenance", () => {
  it("does not let a stale same-label container authorize or receive fallback cleanup", async () => {
    mocks.queryOpenShellDockerSandboxContainers.mockReturnValue({
      ok: true,
      ids: ["stale-container"],
    });
    failNativeCreate();
    const deps = createDeps();
    await expectFlowExit(createInput(), deps);

    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(mocks.queryOpenShellDockerSandboxRuntimeSnapshot).not.toHaveBeenCalled();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("preserves the sandbox when ordinary readiness cleanup is name-only (#6110)", async () => {
    mockReadinessFailure();
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockReturnValue({ status: 7, stderr: "gateway unavailable" });
    await expectFlowExit(createInput(), deps);

    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      expect.arrayContaining(["delete"]),
      expect.anything(),
    );
    expect(output).toContain("left sandbox 'alpha' in place");
    expect(output).toContain("Recovery remains blocked while this sandbox exists");
    expect(output).not.toContain("openshell sandbox delete");
    expect(output).not.toContain("Retry: nemoclaw onboard");
  });

  it("does not infer absence through a mutable-name readiness cleanup", async () => {
    mockReadinessFailure();
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockReturnValue({
      status: 1,
      stderr: "sandbox alpha not found",
    });
    await expectFlowExit(createInput(), deps);

    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(deps.runOpenshell).not.toHaveBeenCalled();
    expect(output).toContain("left sandbox 'alpha' in place");
    expect(output).toContain("Recovery remains blocked while this sandbox exists");
    expect(output).not.toContain("Retry: nemoclaw onboard");
  });

  it("fully redacts command diagnostics when cleanup cannot be proven safe", async () => {
    failNativeCreate();
    const input = createInput();
    input.provider = "ollama-local";
    input.sandboxGpuConfig.sandboxGpuProof = VERIFIED_PROOF;
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockImplementation((args) =>
      args[1] === "delete"
        ? { status: 0 }
        : { status: 1, stderr: "NVIDIA_API_KEY=super-secret-cleanup-value" },
    );
    await expectFlowExit(input, deps);

    const diagnostic = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(diagnostic).toContain("Cleanup could not be proven safe");
    expect(diagnostic).toContain("NVIDIA_API_KEY=<REDACTED>");
    expect(diagnostic).not.toContain("super-secret-cleanup-value");
    expect(deps.openshellArgv).toHaveBeenCalledExactlyOnceWith([]);
    expect(mocks.enforceDockerGpuPatchPreserveNetwork).not.toHaveBeenCalled();
    expect(input.sandboxGpuConfig.sandboxGpuProof).toBe(VERIFIED_PROOF);
  });

  it("refuses nvidia-smi fallback when exact native container provenance is unavailable (#6110)", async () => {
    const input = createSourceInput();
    mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockReturnValue({
      ok: false,
      error: "expected one labeled sandbox container, found 2",
    });
    const deps = createDeps();
    vi.mocked(deps.verifyDirectSandboxGpu).mockReturnValue({
      ...NVIDIA_SMI_FAILED_PROOF,
      detail: "No devices were found",
    });
    await expectFlowExit(input, deps);

    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(deps.openshellArgv).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("does not inspect or retry an ambiguous create-stream image reference", async () => {
    const input = createSourceInput();
    mockRuntimeSnapshot({
      bookkeepingImageRef: "openshell/sandbox-from:built",
      stateError: "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
    });
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output:
        "Built image attacker.example/redirect:latest\nCDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
      sawProgress: true,
    });
    const deps = createDeps();

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "did not confirm whether sandbox 'alpha' was created",
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(mocks.queryOpenShellDockerSandboxRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it("does not reuse an immutable image ID after an ambiguous create result", async () => {
    const input = createSourceInput();
    mockRuntimeSnapshot({
      bookkeepingImageRef: IMAGE_ID,
      stateError: "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
    });
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output: "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
      sawProgress: true,
    });
    const deps = createDeps();

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "did not confirm whether sandbox 'alpha' was created",
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(mocks.queryOpenShellDockerSandboxRuntimeSnapshot).not.toHaveBeenCalled();
  });
});
