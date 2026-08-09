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
  RuntimeProviderBootstrapSurface,
  RuntimeProviderBundle,
} from "./runtime-provider/contract";
import { createRuntimeProviderBundleRegistry } from "./runtime-provider/registry";
import { prepareSandboxCreateLaunch } from "./sandbox-create-launch";
import {
  runSandboxGpuCreateFlow,
  type SandboxGpuCreateFlowDeps,
  type SandboxGpuCreateFlowInput,
} from "./sandbox-gpu-create-flow";

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
      readonly bootstrap: Extract<RuntimeProviderBootstrapSurface, { readonly supported: true }>;
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
    vi.mocked(deps.runCaptureOpenshell).mockImplementation((args) =>
      args[1] === "get" ? "ID: mxc-alpha\n" : "alpha Ready",
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
      expect.objectContaining({ providerId: "mxc", route: "none" }),
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledWith(
      "mxc-launch",
      input.createArgv.slice(1),
      input.sandboxEnv,
      expect.anything(),
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
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
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

  it("retries structured nvidia-smi failure only when host config proves no GPU attachment (#6110)", async () => {
    const deps = createDeps();
    vi.mocked(deps.verifyDirectSandboxGpu)
      .mockReturnValueOnce(NVIDIA_SMI_FAILED_PROOF)
      .mockReturnValue(VERIFIED_PROOF);
    mockRuntimeSnapshot();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).resolves.toMatchObject({
      route: "compatibility",
      registryImageRef: "openshell/sandbox-from:test",
    });

    expect(mocks.streamSandboxCreate).toHaveBeenCalledTimes(2);
    expect(deps.runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ suppressOutput: true }),
    );
  });

  it.each([
    "present",
    "unknown",
  ] as const)("fails closed on sandbox nvidia-smi text when host GPU attachment is %s", async (nativeGpuAttachmentState) => {
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
  });

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
  it("threads restart-safe startup resource limits on the no-GPU Docker route", async () => {
    const input = createInput();
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

    await expect(runSandboxGpuCreateFlow(input, createDeps())).resolves.toMatchObject({
      route: "none",
    });

    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "none",
        persistStartupCommand: true,
        requiredUlimits: input.requiredUlimits,
      }),
    );
  });

  it("does not replace a native GPU container solely to persist its startup command", async () => {
    const input = createInput();
    input.persistStartupCommand = true;

    await expect(runSandboxGpuCreateFlow(input, createDeps())).resolves.toMatchObject({
      route: "native",
    });

    expect(mocks.createDockerGpuSandboxCreatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ route: "native", persistStartupCommand: false }),
    );
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
    expect(deps.runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
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

  it("configures the portable lifecycle after sandbox creation succeeds (#8441)", async () => {
    const input = createInput();
    input.lifecycleRegistrationFields = {
      lifecycleGeneration: "current-generation",
      lifecycleLiveIdentityFingerprint: "current-fingerprint",
    };
    const deps = createDeps();
    deps.installPortableDemoLifecycle = vi.fn(
      () => input.lifecycleRegistrationFields?.lifecycleGeneration ?? null,
    );

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      lifecycleRegistrationFields: {
        lifecycleGeneration: "current-generation",
        lifecycleLiveIdentityFingerprint: "current-fingerprint",
      },
      route: "native",
    });

    expect(deps.installPortableDemoLifecycle).toHaveBeenCalledWith(
      input.sandboxName,
      input.sandboxStartupCommand,
      process.env,
      { registryGeneration: "current-generation" },
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

  it("validates the full compatibility command before deleting native state (#6110)", async () => {
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
    expect(deps.runOpenshell).toHaveBeenCalledWith(
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

  it("reports manual cleanup when ordinary readiness deletion fails (#6110)", async () => {
    mockReadinessFailure();
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockReturnValue({ status: 7, stderr: "gateway unavailable" });
    await expectFlowExit(createInput(), deps);

    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("could not be removed automatically");
    expect(output).toContain('Manual cleanup: openshell sandbox delete "alpha"');
    expect(output).not.toContain("Retry: nemoclaw onboard");
  });

  it("treats an already-absent sandbox as successful ordinary readiness cleanup", async () => {
    mockReadinessFailure();
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockReturnValue({
      status: 1,
      stderr: "sandbox alpha not found",
    });
    await expectFlowExit(createInput(), deps);

    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("Retry: nemoclaw onboard");
    expect(output).not.toContain("could not be removed automatically");
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
