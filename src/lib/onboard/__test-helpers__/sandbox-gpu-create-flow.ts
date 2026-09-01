// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, vi } from "vitest";

import { NEMOCLAW_CREATE_ATTEMPT_LABEL } from "../../adapters/openshell/sandbox-identity";
import { createCliOpenShellSandboxObserver } from "../../adapters/openshell/sandbox-observer-cli";
import { isSandboxReady } from "../../state/gateway";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import type { SandboxGpuProofResult } from "../../state/registry";
import type { ManagedBootstrapRuntimeCreateLifecycleInput } from "../managed-bootstrap/runtime-create";
import type {
  SandboxGpuCreateFlowDeps,
  SandboxGpuCreateFlowInput,
} from "../sandbox-gpu-create-flow";
import { runSandboxGpuCreateFlow } from "../sandbox-gpu-create-flow";

export const VERIFIED_GPU_PROOF: SandboxGpuProofResult = {
  status: "verified",
  cudaVerified: true,
  label: "CUDA initialization",
  detail: null,
  at: "2026-07-06T00:00:00.000Z",
};
export const GPU_IMAGE_ID = `sha256:${"a".repeat(64)}`;
export const ALPHA_SANDBOX_IDENTITY_FINGERPRINT =
  "8174fa2a5d65755138d8339e086c03d736633130b22dca10952e80e74750c01d";

export function sandboxListJson(
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

export function createAttemptNonce(args: readonly string[]): string {
  const labelIndex = args.indexOf("--label");
  return (args[labelIndex + 1] ?? "").slice(NEMOCLAW_CREATE_ATTEMPT_LABEL.length + 1);
}

export function createTimedOutCreateResult(output: string) {
  return {
    status: 1,
    output,
    sawProgress: true,
    readyTerminationTimedOut: true,
  } as const;
}

export function createGpuFlowInput(): SandboxGpuCreateFlowInput {
  return {
    sandboxName: "alpha",
    provider: "nim",
    sandboxGpuConfig: {
      mode: "1",
      hostGpuDetected: true,
      hostGpuPlatform: null,
      sandboxGpuEnabled: true,
      sandboxGpuDevice: null,
      errors: [],
    },
    gpuRoutePlan: "native-with-fallback",
    initialGpuRoute: "native",
    compatibilityPolicyPath: "/tmp/compatibility-policy.yaml",
    dockerDriverGateway: true,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    sandboxReadyTimeoutSecs: 60,
    createArgv: ["openshell", "sandbox", "create", "--gpu"],
    sandboxEnv: {},
    sandboxStartupCommand: ["nemoclaw-start"],
    prebuild: {
      createArgs: ["--from", "openshell/sandbox-from:test", "--name", "alpha", "--gpu"],
      imageRef: "openshell/sandbox-from:test",
      imageId: GPU_IMAGE_ID,
    },
    restoreBackupPath: null,
    terminalAgent: false,
  };
}

export function createNoGpuFlowInput(): SandboxGpuCreateFlowInput {
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

export function createGpuFlowDeps(sandboxId?: string): SandboxGpuCreateFlowDeps;
export function createGpuFlowDeps(
  expectedGatewayName: string,
  requireTargetedSandboxProbes: boolean,
): SandboxGpuCreateFlowDeps;
export function createGpuFlowDeps(
  sandboxIdOrGatewayName = "alpha-sandbox-id",
  expectedGatewayNameOrRequireTargetedProbes: string | boolean = "nemoclaw",
): SandboxGpuCreateFlowDeps {
  const requiresTargetedSandboxProbes =
    typeof expectedGatewayNameOrRequireTargetedProbes === "boolean";
  const sandboxId = requiresTargetedSandboxProbes ? "alpha-sandbox-id" : sandboxIdOrGatewayName;
  const expectedGatewayName = requiresTargetedSandboxProbes
    ? sandboxIdOrGatewayName
    : expectedGatewayNameOrRequireTargetedProbes;
  const assertSandboxProbeTarget = (args: readonly string[]) => {
    if (!requiresTargetedSandboxProbes) return;
    if (args[0] !== "sandbox" || !["exec", "get", "list"].includes(args[1] ?? "")) return;
    const gatewayFlag = args.indexOf("-g");
    expect(gatewayFlag).toBeGreaterThan(1);
    expect(args[gatewayFlag + 1]).toBe(expectedGatewayName);
  };
  const runCaptureOpenshell = vi.fn((args: string[], _options?: Record<string, unknown>) => {
    assertSandboxProbeTarget(args);
    if (args[0] === "sandbox" && args[1] === "get") {
      return `Name: alpha\nId: ${sandboxId}\nState: Ready\n`;
    }
    if (args[0] === "sandbox" && args[1] === "list") return "alpha Ready";
    return "";
  });
  return {
    runOpenshell: vi.fn((args: string[]) => {
      assertSandboxProbeTarget(args);
      return args[0] === "sandbox" && args[1] === "get"
        ? {
            status: 0,
            stdout: `Name: alpha\nId: ${sandboxId}\nState: Ready\n`,
            stderr: "",
          }
        : { status: 0, stdout: "", stderr: "" };
    }),
    runCaptureOpenshell,
    sandboxObserver: createCliOpenShellSandboxObserver({
      capture: (args, options) => {
        const stdout = runCaptureOpenshell(args, {
          ignoreError: true,
          timeout: options.timeout,
        });
        return { status: 0, output: stdout, stdout, stderr: "" };
      },
    }),
    sleep: vi.fn(),
    openshellArgv: vi.fn((args: string[]) => ["openshell", ...args]),
    isSandboxReady,
    printCreateRecoveryHints: vi.fn(),
    verifyDirectSandboxGpu: vi.fn(() => VERIFIED_GPU_PROOF),
  };
}

export function createGpuPatchFixture() {
  return {
    maybeApplyDuringCreate: vi.fn(),
    replacementRuntimeId: vi.fn(() => null),
    createFailureMessage: vi.fn(() => null),
    exitOnPatchError: vi.fn(),
    rollbackManagedStartupAfterCreateFailure: vi.fn(),
    ensureApplied: vi.fn(),
    waitForSupervisorReconnectIfNeeded: vi.fn(),
    commitAfterReady: vi.fn(),
    selectedMode: vi.fn(() => null),
    printReadinessFailureIfEnabled: vi.fn(),
    verifyGpuOrExit: vi.fn(() => VERIFIED_GPU_PROOF),
  };
}

export function expectNoPostCreateEffects(
  input: SandboxGpuCreateFlowInput,
  patch: ReturnType<typeof createGpuPatchFixture>,
  deps: SandboxGpuCreateFlowDeps,
  readinessWait: ReturnType<typeof vi.fn>,
): void {
  for (const effect of [
    input.verifyCreatedSandboxBeforeEffects,
    input.revalidateVerifiedSandboxBeforeEffect,
    patch.exitOnPatchError,
    patch.ensureApplied,
    patch.waitForSupervisorReconnectIfNeeded,
    patch.commitAfterReady,
    readinessWait,
    deps.installPortableDemoLifecycle,
  ]) {
    if (effect) expect(effect).not.toHaveBeenCalled();
  }
}

export function setupGpuFlowMocks(mocks: Record<string, ReturnType<typeof vi.fn>>): void {
  mocks.streamSandboxCreate.mockResolvedValue({
    status: 0,
    output: "Created sandbox: alpha",
    sawProgress: true,
  });
  mocks.createDockerGpuSandboxCreatePatch.mockImplementation(createGpuPatchFixture);
  mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
    ready: true,
    reason: "ready",
    failurePhase: null,
  });
  mocks.verifyGpuSandboxAccessAfterReady.mockImplementation((_config, options) =>
    options.verifyGpuOrExit
      ? options.verifyGpuOrExit(options.verifyDirectSandboxGpu)
      : options.verifyDirectSandboxGpu(options.sandboxName),
  );
  mocks.enforceDockerGpuPatchPreserveNetwork.mockResolvedValue(false);
  mocks.collectDockerGpuPatchDiagnostics.mockReturnValue(null);
  mocks.queryOpenShellDockerSandboxContainers.mockReturnValue({ ok: true, ids: [] });
  mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockReturnValue({
    ok: true,
    imageId: GPU_IMAGE_ID,
    bookkeepingImageRef: "openshell/sandbox-from:test",
    stateError: "",
    deviceRequests: null,
    devices: null,
    runtime: "nvidia",
    nvidiaVisibleDevices: "all",
    nativeGpuAttachmentState: "present",
    containerId: "container-a",
  });
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
}

export function resetGpuFlowMocks(): void {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
}

export function createGpuFlowTestHarness(mocks: Record<string, ReturnType<typeof vi.fn>>) {
  const readyCheckOptions = { ignoreError: true, timeout: 5_000 };
  const failedProof: SandboxGpuProofResult = {
    status: "failed",
    cudaVerified: false,
    label: "cuInit(0) via libcuda.so.1",
    detail: "cuInit(0)=999",
    at: "2026-07-06T00:00:00.000Z",
  };
  const nvidiaSmiFailedProof: SandboxGpuProofResult = {
    status: "failed",
    cudaVerified: false,
    label: "nvidia-smi when available",
    detail: "Failed to initialize NVML: Driver/library version mismatch",
    at: "2026-07-06T00:00:00.000Z",
  };
  const defaultRuntimeSnapshot = {
    ok: true as const,
    imageId: GPU_IMAGE_ID,
    bookkeepingImageRef: "openshell/sandbox-from:test",
    stateError: "",
    deviceRequests: null,
    devices: null,
    runtime: "runc",
    nvidiaVisibleDevices: null,
    nativeGpuAttachmentState: "absent" as const,
    containerId: "container-a",
  };
  const portableRuntimeAuthority: CheckpointPortableRuntimeAuthority = {
    schemaVersion: 1,
    kind: "podman",
    ownership: "current-user",
    uid: 1001,
    homeDir: "/home/tester",
    configHome: "/home/tester/.config",
    runtimeDir: "/run/user/1001",
    socketPath: "/run/user/1001/podman/podman.sock",
  };
  const managedDockerConfigPreservationCases = [
    {
      title: "the Desktop helper responds",
      helperResponds: true,
      dockerHost: "unix:///var/run/docker.sock",
      contextStdout: "default\n",
    },
    {
      title: "the Docker context is not default",
      helperResponds: false,
      dockerHost: undefined,
      contextStdout: "remote-builder\n",
    },
    {
      title: "an explicit remote Docker host is selected",
      helperResponds: false,
      dockerHost: "tcp://remote-builder.example:2376",
      contextStdout: "default\n",
    },
  ];
  const temporaryDirectories: string[] = [];

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
      ...defaultRuntimeSnapshot,
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

  function expectNativeStateKept(deps: ReturnType<typeof createGpuFlowDeps>): void {
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
    const input = createGpuFlowInput();
    input.prebuild = {
      createArgs: ["--from", "/tmp/build/Dockerfile", "--name", "alpha", "--gpu"],
      imageRef: null,
      imageId: null,
    };
    return input;
  }

  function writeDesktopCredsStore(): string {
    const dockerConfig = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wsl-docker-config-"));
    temporaryDirectories.push(dockerConfig);
    fs.writeFileSync(
      path.join(dockerConfig, "config.json"),
      JSON.stringify({ credsStore: "desktop.exe" }),
    );
    return dockerConfig;
  }

  function attachManagedBootstrap(input: SandboxGpuCreateFlowInput): void {
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
    input.managedBootstrap = {
      bootstrapIdentity: "e".repeat(64),
      stateRoot: "/tmp/nemoclaw-managed-bootstrap",
      runtimeProvider: {
        identity: { id: "mxc" },
        bootstrap: {
          createOnboardRouting: () => ({ nativeFallbackHasCleanBaseline: false }),
          createLifecycle: (options: ManagedBootstrapRuntimeCreateLifecycleInput) => ({
            launchArgv: options.launchArgv,
            patch: createGpuPatchFixture(),
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
  }

  function captureCreateEnv(): {
    env: NodeJS.ProcessEnv;
    configExisted: boolean;
  } {
    const captured = { env: {} as NodeJS.ProcessEnv, configExisted: false };
    mocks.streamSandboxCreate.mockImplementation((_exe, _args, env: NodeJS.ProcessEnv) => {
      captured.env = env;
      captured.configExisted = fs.existsSync(String(env.DOCKER_CONFIG));
      return Promise.resolve({
        status: 0,
        output: "Created sandbox: alpha",
        sawProgress: true,
      });
    });
    return captured;
  }

  function cleanupTemporaryDirectories(): void {
    temporaryDirectories.splice(0).forEach((directory) => {
      fs.rmSync(directory, { recursive: true, force: true });
    });
  }

  function setupHarness(): void {
    setupGpuFlowMocks(mocks);
    mocks.helperResponds.mockReturnValue(false);
    mocks.dockerSpawnSync.mockReturnValue({
      status: 0,
      error: undefined,
      stdout: "default\n",
      stderr: "",
    });
  }

  function resetHarness(): void {
    cleanupTemporaryDirectories();
    resetGpuFlowMocks();
  }

  return {
    READY_CHECK_OPTIONS: readyCheckOptions,
    FAILED_PROOF: failedProof,
    NVIDIA_SMI_FAILED_PROOF: nvidiaSmiFailedProof,
    DEFAULT_RUNTIME_SNAPSHOT: defaultRuntimeSnapshot,
    PORTABLE_RUNTIME_AUTHORITY: portableRuntimeAuthority,
    managedDockerConfigPreservationCases,
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
    writeDesktopCredsStore,
    attachManagedBootstrap,
    captureCreateEnv,
    setupHarness,
    resetHarness,
  };
}
