// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { createInMemoryRuntimeProviderBundle } from "../../../test/helpers/runtime-provider-bundle";

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

import type { CheckpointPortableRuntimeAuthority } from "../state/onboard-checkpoint-types";
import type { SandboxGpuProofResult } from "../state/registry";
import {
  createGpuFlowDeps as createDeps,
  createGpuFlowInput as createInput,
  createGpuPatchFixture as createPatch,
  GPU_IMAGE_ID as IMAGE_ID,
  resetGpuFlowMocks,
  setupGpuFlowMocks,
  VERIFIED_GPU_PROOF as VERIFIED_PROOF,
} from "./__test-helpers__/sandbox-gpu-create-flow";
import {
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  type ManagedBootstrapRecoveryReport,
} from "./managed-bootstrap/adapter";
import type {
  ManagedBootstrapRuntimeCreateLifecycleInput,
  ManagedBootstrapRuntimePatch,
} from "./managed-bootstrap/runtime-create";
import { encodeManagedStartupProfile } from "./managed-startup/profile";
import { createManagedStartupRootApplyRequest } from "./managed-startup/root-apply";
import type {
  RuntimeProviderBundle,
  RuntimeProviderManagedImageBootstrapSurface,
} from "./runtime-provider/contract";
import { createRuntimeProviderBundleRegistry } from "./runtime-provider/registry";
import { prepareSandboxCreateLaunch } from "./sandbox-create-launch";
import {
  runSandboxGpuCreateFlow,
  type SandboxGpuCreateFlowDeps,
  type SandboxGpuCreateFlowInput,
} from "./sandbox-gpu-create-flow";

const READY_CHECK_OPTIONS = { ignoreError: true, timeout: 5_000 };
const FAILED_PROOF: SandboxGpuProofResult = {
  status: "failed",
  cudaVerified: false,
  label: "cuInit(0) via libcuda.so.1",
  detail: "cuInit(0)=999",
  at: "2026-07-06T00:00:00.000Z",
};
const NVIDIA_SMI_FAILED_PROOF: SandboxGpuProofResult = {
  status: "failed",
  cudaVerified: false,
  label: "nvidia-smi when available",
  detail: "Failed to initialize NVML: Driver/library version mismatch",
  at: "2026-07-06T00:00:00.000Z",
};
const DEFAULT_RUNTIME_SNAPSHOT = {
  ok: true as const,
  imageId: IMAGE_ID,
  bookkeepingImageRef: "openshell/sandbox-from:test",
  stateError: "",
  deviceRequests: null,
  devices: null,
  runtime: "runc",
  nvidiaVisibleDevices: null,
  nativeGpuAttachmentState: "absent" as const,
  containerId: "container-a",
};

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

type OpenShellResult = ReturnType<SandboxGpuCreateFlowDeps["runOpenshell"]>;

function readySandboxGetResult(sandboxId = "alpha-sandbox-id"): OpenShellResult {
  return {
    status: 0,
    stdout: `Name: alpha\nId: ${sandboxId}\nState: Ready\n`,
    stderr: "",
  };
}

function createSequencedOpenShellRunner(
  entries: Array<[string, OpenShellResult[]]>,
): SandboxGpuCreateFlowDeps["runOpenshell"] {
  const resultsByCommand = new Map(entries);
  return (args) =>
    resultsByCommand.get(args.join(" "))?.shift() ?? { status: 0, stdout: "", stderr: "" };
}

function failNativeCreate(output = "error: unexpected argument '--gpu' found"): void {
  mocks.streamSandboxCreate.mockResolvedValueOnce({ status: 1, output, sawProgress: false });
}

async function expectFlowExit(
  input: SandboxGpuCreateFlowInput,
  deps: SandboxGpuCreateFlowDeps,
): Promise<void> {
  mockExit();
  await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");
}

function mockExit(status = 1) {
  return vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error(`process.exit:${status}`);
  });
}

function mockRuntimeSnapshot(overrides: Record<string, unknown> = {}): void {
  mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockReturnValue({
    ...DEFAULT_RUNTIME_SNAPSHOT,
    ...overrides,
  });
}

function mockReadinessFailure(failurePhase = "Failed"): void {
  mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
    ready: false,
    reason: "terminal_failure_phase",
    failurePhase,
  });
}

function expectNativeStateKept(deps: ReturnType<typeof createDeps>): void {
  expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
  expect(deps.runOpenshell).not.toHaveBeenCalledWith(
    ["sandbox", "delete", "alpha"],
    expect.anything(),
  );
}

function errorOutput(): string {
  return vi.mocked(console.error).mock.calls.flat().join("\n");
}

function createSourceInput(): SandboxGpuCreateFlowInput {
  const input = createInput();
  input.prebuild = {
    createArgs: ["--from", "/tmp/build/Dockerfile", "--name", "alpha", "--gpu"],
    imageRef: null,
    imageId: null,
  };
  return input;
}

beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(resetGpuFlowMocks);

describe("runSandboxGpuCreateFlow provider-owned managed create", () => {
  it("recovers before an MXC-style create without a Docker branch in central orchestration", async () => {
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
    const request = createManagedStartupRootApplyRequest({
      agent: "openclaw",
      encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile("openclaw")),
    });
    const launch = prepareSandboxCreateLaunch({
      agent: null,
      sandboxName: "alpha",
      chatUiUrl: "",
      createArgs: ["--name", "alpha"],
      env: {},
      extraPlaceholderKeys: [],
      getDashboardForwardPort: () => "0",
      hermesDashboardState: { config: null, enabled: false },
      manageDashboard: false,
      openshellShellCommand: (args) => args.join(" "),
      openshellArgv: (args) => ["openshell", ...args],
      buildEnv: () => ({}),
      managedStartupRootApplyRequest: request,
    });
    input.createArgv = launch.createArgv;
    input.sandboxEnv = launch.sandboxEnv;
    input.sandboxStartupCommand = launch.sandboxStartupCommand;
    const patch = createPatch() as unknown as ManagedBootstrapRuntimePatch;
    const recoveryReport = (
      sandboxName: string | null,
      detail = "opaque MXC recovery detail",
    ): ManagedBootstrapRecoveryReport =>
      Object.freeze({
        receipts: Object.freeze([]),
        failures: Object.freeze([
          Object.freeze({
            schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
            providerId: "mxc",
            sourcePhase: "provider-owned-cleanup",
            sandbox:
              sandboxName === null
                ? null
                : Object.freeze({
                    sandboxName,
                    sandboxId: `mxc-${sandboxName}`,
                    driverId: "mxc",
                  }),
            bootstrapIdentity: "e".repeat(64),
            code: "mxc-recovery-retry",
            retryable: true,
            detail,
          }),
        ]),
      });
    const recoverUnfinished = vi.fn(async () => recoveryReport("bravo"));
    const prepareNetwork = vi.fn(async () => undefined);
    const createLifecycle = vi.fn(
      (lifecycleInput: ManagedBootstrapRuntimeCreateLifecycleInput) => ({
        launchArgv: ["mxc-launch", ...lifecycleInput.launchArgv.slice(1)],
        patch,
        recoverUnfinished,
        prepareNetwork,
        runCreate: async <T>(
          start: (held: {
            readonly heldWorkloadArgv: readonly string[];
            readonly bootstrapIdentity: string;
          }) => Promise<{ readonly value: T }>,
        ): Promise<T> =>
          (
            await start({
              heldWorkloadArgv: lifecycleInput.heldWorkloadArgv,
              bootstrapIdentity: lifecycleInput.bootstrapIdentity,
            })
          ).value,
      }),
    );
    const source = createInMemoryRuntimeProviderBundle({
      providerId: "mxc",
      workloadProfile: {
        support: null,
        hostArchitectures: [],
        managedImageSelectionPolicy: "prefer-managed",
        legacyDockerfileBuilds: true,
      },
    });
    const registered = createRuntimeProviderBundleRegistry([
      [
        "mxc",
        {
          ...source,
          bootstrap: {
            providerId: "mxc",
            supported: true,
            bootstrapKind: "managed-image",
            createAuthorityStore: vi.fn(() => ({
              recordPreparedAuthority: vi.fn(),
            })),
            createLifecycle,
            createOnboardRouting: vi.fn(() => ({
              nativeFallbackHasCleanBaseline: false,
              inspectNativeRuntime: vi.fn(() => null),
              isNativeCreateRoutingFailure: vi.fn(() => false),
              isTrustedNativeRuntimeError: vi.fn(() => false),
              isNativeReadinessRoutingFailure: vi.fn(() => false),
              prepareCompatibilityLaunch: vi.fn(() => ({
                createArgv: [],
                registryImageRef: null,
              })),
            })),
          },
        },
      ],
    ]);
    const runtimeProvider = registered.mxc as RuntimeProviderBundle & {
      readonly bootstrap: RuntimeProviderManagedImageBootstrapSurface;
    };
    input.managedBootstrap = {
      bootstrapIdentity: launch.managedBootstrapIdentity!,
      stateRoot: "/tmp/nemoclaw-mxc-bootstrap",
      runtimeProvider,
      authorityStore: {
        async recordPreparedAuthority(authority) {
          return {
            schemaVersion: 1,
            sandbox: authority.sandbox,
            bootstrapIdentity: authority.bootstrapIdentity,
            authorityFingerprint: authority.authorityFingerprint,
            recordId: "mxc-record-alpha",
            recordedAt: "2026-07-31T00:00:00.000Z",
          };
        },
      },
      request,
      image: {
        repository: "registry.example/nemoclaw-openclaw",
        manifestDigest: `sha256:${"d".repeat(64)}`,
      },
      agentIdentity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
      intendedWorkloadArgv: launch.intendedSandboxStartupCommand,
      expectedSupervisorArgv: ["/mxc/supervisor"],
    };
    const deps = createDeps();
    const adapterOverride = {} as never;
    deps.createManagedBootstrapAdapter = vi.fn(() => adapterOverride);
    deps.runOpenshell = vi.fn(() => readySandboxGetResult("alpha-sandbox-id"));
    vi.mocked(deps.runCaptureOpenshell).mockImplementation((args) =>
      args[1] === "get" ? "ID: alpha-sandbox-id\n" : "alpha Ready",
    );
    recoverUnfinished.mockRejectedValueOnce(new Error("unfinished recovery failed"));

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "unfinished recovery failed",
    );
    expect(prepareNetwork).not.toHaveBeenCalled();
    expect(mocks.streamSandboxCreate).not.toHaveBeenCalled();
    recoverUnfinished.mockClear();
    createLifecycle.mockClear();
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 23,
      output: "Created sandbox: alpha",
      sawProgress: true,
    });

    const result = await runSandboxGpuCreateFlow(input, deps);

    expect(result).toMatchObject({ route: "none", runtimePatch: patch });
    expect(createLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "mxc",
        route: "none",
        stateRoot: "/tmp/nemoclaw-mxc-bootstrap",
        adapterOverride,
      }),
    );
    expect(deps.createManagedBootstrapAdapter).toHaveBeenCalledWith("/tmp/nemoclaw-mxc-bootstrap");
    expect(mocks.streamSandboxCreate).toHaveBeenCalledWith(
      "mxc-launch",
      input.createArgv.slice(1),
      input.sandboxEnv,
      expect.objectContaining({ readyCheckOutputPatterns: [] }),
    );
    expect(recoverUnfinished.mock.invocationCallOrder[0]).toBeLessThan(
      prepareNetwork.mock.invocationCallOrder[0],
    );
    expect(prepareNetwork.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.streamSandboxCreate.mock.invocationCallOrder[0],
    );
    expect(mocks.createDockerGpuSandboxCreatePatch).not.toHaveBeenCalled();
    expect(mocks.queryOpenShellDockerSandboxContainers).not.toHaveBeenCalled();
    expect(mocks.queryOpenShellDockerSandboxRuntimeSnapshot).not.toHaveBeenCalled();
    expect(mocks.enforceDockerGpuPatchPreserveNetwork).not.toHaveBeenCalled();
    expect(
      mocks.waitForCreatedSandboxReadyWithTrace.mock.calls.map(
        ([options]) => options.stableReadyPolls,
      ),
    ).toEqual([2, 2]);

    vi.mocked(deps.runCaptureOpenshell).mockClear();
    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({ route: "none" });
    expect(deps.runCaptureOpenshell).toHaveBeenCalledWith(["sandbox", "list"], READY_CHECK_OPTIONS);

    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toContain(
      "unrelated sandbox 'bravo'",
    );
    const recoverySecret = "opaque-recovery-token";
    recoverUnfinished.mockResolvedValueOnce(
      recoveryReport("alpha", `Authorization: Bearer ${recoverySecret}`),
    );
    prepareNetwork.mockClear();
    mocks.streamSandboxCreate.mockClear();
    mockExit();

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");
    expect(prepareNetwork).not.toHaveBeenCalled();
    expect(mocks.streamSandboxCreate).not.toHaveBeenCalled();
    expect(errorOutput()).toContain("recovery stopped before sandbox 'alpha' was created");
    expect(errorOutput()).toContain("Transaction");
    expect(errorOutput()).toContain("durable sandbox ID mxc-alpha");
    expect(errorOutput()).toContain("OpenShell's sandbox get command");
    expect(errorOutput()).toContain("never delete a runtime by mutable sandbox name");
    expect(errorOutput()).toContain("Authorization: Bearer <REDACTED>");
    expect(errorOutput()).not.toContain(recoverySecret);
  });

  it("reports the terminal phase when an incomplete managed create cannot become ready (#9819)", async () => {
    const input = createInput();
    const bootstrapIdentity = "e".repeat(64);
    input.managedBootstrap = {
      bootstrapIdentity,
      stateRoot: "/tmp/nemoclaw-managed-bootstrap",
      runtimeProvider: {
        identity: { id: "mxc" },
        bootstrap: {
          createOnboardRouting: () => ({ nativeFallbackHasCleanBaseline: false }),
          createLifecycle: (options: ManagedBootstrapRuntimeCreateLifecycleInput) => ({
            launchArgv: options.launchArgv,
            patch: createPatch(),
            recoverUnfinished: async () => null,
            prepareNetwork: async () => undefined,
            runCreate: async <T>(
              start: (held: {
                readonly heldWorkloadArgv: readonly string[];
                readonly bootstrapIdentity: string;
              }) => Promise<{ readonly value: T }>,
            ): Promise<T> =>
              (
                await start({
                  heldWorkloadArgv: options.heldWorkloadArgv,
                  bootstrapIdentity: options.bootstrapIdentity,
                })
              ).value,
          }),
        },
      },
    } as unknown as NonNullable<SandboxGpuCreateFlowInput["managedBootstrap"]>;
    const deps = createDeps();
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 23,
      output: "Created sandbox: alpha",
      sawProgress: true,
    });
    mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValueOnce({
      ready: false,
      reason: "terminal_failure_phase",
      failurePhase: "Failed",
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(
      "Sandbox 'alpha' entered Failed phase before it became ready (waited up to 60s).",
    );
    expect(mocks.waitForCreatedSandboxReadyWithTrace).toHaveBeenCalledOnce();
  });
});
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
      ["sandbox", "delete", "alpha"],
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
  it("bounds the streamed sandbox readiness probe", async () => {
    const deps = createDeps();
    mocks.streamSandboxCreate.mockImplementationOnce(async (...args) => {
      expect(args[3].readyCheck()).toBe(true);
      return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
    });

    const result = await runSandboxGpuCreateFlow(createInput(), deps);
    expect(result).toMatchObject({ route: "native" });
    expect(deps.runCaptureOpenshell).toHaveBeenCalledWith(["sandbox", "list"], READY_CHECK_OPTIONS);
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
    input.createArgv = ["openshell", "sandbox", "create"];
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
      "openshell",
      ["sandbox", "create"],
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
    input.createArgv = ["openshell", "sandbox", "create"];
    input.persistStartupCommand = true;
    input.requiredUlimits = [
      { name: "nproc", soft: 512, hard: 512 },
      { name: "nofile", soft: 65_536, hard: 65_536 },
    ];
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockImplementation(
      createSequencedOpenShellRunner([
        ["sandbox get alpha", [readySandboxGetResult(), readySandboxGetResult()]],
        [
          "sandbox exec --name alpha -- true",
          [{ status: 1, stdout: "", stderr: "permission denied" }],
        ],
      ]),
    );
    mocks.waitForCreatedSandboxReadyWithTrace.mockImplementationOnce((options) => {
      expect(options.checkReadyIdentity?.()).toBe("probe_failed");
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
    input.createArgv = ["openshell", "sandbox", "create"];
    input.persistStartupCommand = true;
    input.requiredUlimits = [
      { name: "nproc", soft: 512, hard: 512 },
      { name: "nofile", soft: 65_536, hard: 65_536 },
    ];
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockImplementation(
      createSequencedOpenShellRunner([
        [
          "sandbox get alpha",
          [readySandboxGetResult(), readySandboxGetResult(), readySandboxGetResult()],
        ],
        [
          "sandbox exec --name alpha -- true",
          [
            {
              status: 1,
              stdout: "",
              stderr:
                `Error:   × code: 'The system is not in a state required for the operation's\n` +
                '  │ execution\', message: "sandbox is not ready"\n',
            },
            { status: 0, stdout: "", stderr: "" },
          ],
        ],
      ]),
    );
    mocks.waitForCreatedSandboxReadyWithTrace.mockImplementationOnce((options) => {
      expect(options.checkReadyIdentity?.()).toBe("not_ready");
      expect(options.checkReadyIdentity?.()).toBe("ready");
      return { ready: true, reason: "ready", failurePhase: null };
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      route: "none",
    });

    expect(
      vi
        .mocked(deps.runOpenshell)
        .mock.calls.filter(([args]) => args.join(" ") === "sandbox exec --name alpha -- true"),
    ).toHaveLength(2);
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
      "openshell",
      input.createArgv.slice(1),
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
      "openshell",
      input.createArgv.slice(1),
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
  ])("does not retry compatibility for a $failure failure (#6110)", async ({ output }) => {
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output,
      sawProgress: true,
    });
    const deps = createDeps();
    mockExit();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");
    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledOnce();
    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ route: "native" }),
    );
    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("redacts create errors and preserves their exact nonzero status (#6110)", async () => {
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 19,
      output: "provider failed with NVIDIA_API_KEY=super-secret-create-value",
      sawProgress: true,
    });
    const exit = mockExit(19);

    await expect(runSandboxGpuCreateFlow(createInput(), createDeps())).rejects.toThrow(
      "process.exit:19",
    );

    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(exit).toHaveBeenCalledWith(19);
    expect(output).toMatch(/NVIDIA_API_KEY=[^\n]*\*+/);
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
    expect(errorOutput()).toContain("Verify the sandbox identity before manual cleanup");
    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
  });

  it("preserves a nonzero create status when separate readiness polling fails (#6110)", async () => {
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
      "process.exit:23",
    );

    expect(exit).toHaveBeenCalledWith(23);
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

  it("uses the provided lifecycle generation for portable setup and registration (#8942)", async () => {
    const input = createInput();
    input.lifecycleGeneration = "current-generation";
    input.portableRuntimeAuthority = PORTABLE_RUNTIME_AUTHORITY;
    const deps = createDeps();
    deps.installPortableDemoLifecycle = vi.fn(
      (_sandboxName, _startupCommand, _env, options) => options.registryGeneration ?? null,
    );

    const result = await runSandboxGpuCreateFlow(input, deps);

    expect(result.route).toBe("native");
    expect(result.lifecycleRegistrationFields).toEqual({
      lifecycleGeneration: "current-generation",
    });

    expect(deps.installPortableDemoLifecycle).toHaveBeenCalledWith(
      input.sandboxName,
      input.sandboxStartupCommand,
      process.env,
      {
        registryGeneration: "current-generation",
        runtimeAuthority: PORTABLE_RUNTIME_AUTHORITY,
      },
    );
  });

  it("preserves the provided lifecycle generation when portable setup is unavailable (#8942)", async () => {
    const input = createInput();
    input.lifecycleGeneration = "fresh-generation";
    input.portableRuntimeAuthority = PORTABLE_RUNTIME_AUTHORITY;
    const deps = createDeps();
    deps.installPortableDemoLifecycle = vi.fn(() => null);

    const result = await runSandboxGpuCreateFlow(input, deps);

    expect(result.lifecycleRegistrationFields).toEqual({
      lifecycleGeneration: "fresh-generation",
    });
    expect(deps.installPortableDemoLifecycle).toHaveBeenCalledWith(
      input.sandboxName,
      input.sandboxStartupCommand,
      process.env,
      {
        registryGeneration: "fresh-generation",
        runtimeAuthority: PORTABLE_RUNTIME_AUTHORITY,
      },
    );
  });

  it("keeps a created sandbox when portable lifecycle setup fails (#8441)", async () => {
    const deps = createDeps();
    deps.installPortableDemoLifecycle = vi.fn(() => {
      throw new Error("Authorization: Bearer portable-secret");
    });

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).resolves.toMatchObject({
      route: "native",
    });

    const warning = vi.mocked(console.warn).mock.calls.flat().join("\n");
    expect(warning).toContain("Portable demo lifecycle setup did not complete");
    expect(warning).toContain("Authorization: Bearer <REDACTED>");
    expect(warning).not.toContain("portable-secret");
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
      "openshell",
      input.createArgv.slice(1),
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

  it("rejects managed bootstrap before portable Docker lifecycle access (#9068)", async () => {
    const input = createInput();
    input.gpuRoutePlan = "native-only";
    input.hostEnv = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };
    input.portableLifecycle = true;
    const createOnboardRouting = vi.fn();
    const createLifecycle = vi.fn();
    input.managedBootstrap = {
      runtimeProvider: {
        bootstrap: { createOnboardRouting, createLifecycle },
      },
    } as unknown as NonNullable<SandboxGpuCreateFlowInput["managedBootstrap"]>;

    await expect(runSandboxGpuCreateFlow(input, createDeps())).rejects.toThrow(
      "Portable OpenClaw onboarding cannot use managed-image bootstrap",
    );

    expect(createOnboardRouting).not.toHaveBeenCalled();
    expect(createLifecycle).not.toHaveBeenCalled();
    expect(mocks.streamSandboxCreate).not.toHaveBeenCalled();
    expect(mocks.createDockerGpuSandboxCreatePatch).not.toHaveBeenCalled();
    expect(mocks.queryOpenShellDockerSandboxContainers).not.toHaveBeenCalled();
    expect(mocks.queryOpenShellDockerSandboxRuntimeSnapshot).not.toHaveBeenCalled();
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

  it("streams native and compatibility attempts through direct argv without a shell (#6110)", async () => {
    failNativeCreate();
    const input = createInput();
    await expect(runSandboxGpuCreateFlow(input, createDeps())).resolves.toMatchObject({
      route: "compatibility",
    });

    expect(mocks.streamSandboxCreate).toHaveBeenNthCalledWith(
      1,
      "openshell",
      ["sandbox", "create", "--gpu"],
      input.sandboxEnv,
      expect.objectContaining({
        onPoll: expect.any(Function),
        readyCheck: expect.any(Function),
      }),
    );
    expect(mocks.streamSandboxCreate).toHaveBeenNthCalledWith(
      2,
      "openshell",
      expect.arrayContaining(["sandbox", "create", "--from", IMAGE_ID]),
      input.sandboxEnv,
      expect.any(Object),
    );
    expect(mocks.streamSandboxCreate.mock.calls.flat()).not.toContain("bash");
    expect(mocks.streamSandboxCreate.mock.calls.flat()).not.toContain("-lc");
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

  it("keeps native state when compatibility command rendering fails (#6110)", async () => {
    failNativeCreate();
    const deps = createDeps();
    vi.mocked(deps.openshellArgv).mockImplementation(() => {
      throw new Error("compatibility command render rejected");
    });
    await expectFlowExit(createInput(), deps);
    expectNativeStateKept(deps);
    expect(errorOutput()).toContain("compatibility command render rejected");
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
    expect(deps.openshellArgv).toHaveBeenCalledOnce();
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
    expect(deps.runOpenshell).not.toHaveBeenCalled();
    expect(output).toContain("left sandbox 'alpha' in place");
    expect(output).toContain("Verify the sandbox identity before manual cleanup");
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
    expect(output).toContain("Verify the sandbox identity before manual cleanup");
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
    expect(deps.openshellArgv).toHaveBeenCalledOnce();
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
    expect(deps.openshellArgv).not.toHaveBeenCalled();
  });

  it("ignores create-stream tags and reuses only the inspected immutable image", async () => {
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

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      route: "compatibility",
      registryImageRef: "openshell/sandbox-from:built",
    });

    expect(deps.openshellArgv).toHaveBeenCalledWith(expect.arrayContaining(["--from", IMAGE_ID]));
    expect(deps.openshellArgv).not.toHaveBeenCalledWith(
      expect.arrayContaining(["--from", "attacker.example/redirect:latest"]),
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledTimes(2);
    expect(mocks.queryOpenShellDockerSandboxRuntimeSnapshot).toHaveBeenCalledOnce();
  });

  it("does not persist an immutable retry ID as the registry image tag", async () => {
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

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      route: "compatibility",
      registryImageRef: null,
    });

    expect(deps.openshellArgv).toHaveBeenCalledWith(expect.arrayContaining(["--from", IMAGE_ID]));
  });
});
