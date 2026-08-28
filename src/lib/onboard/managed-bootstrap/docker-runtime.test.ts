// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamSandboxCreate } from "../../sandbox/create-stream";
import {
  dockerEnv,
  FakeChild,
  makePollingOptions,
} from "../../sandbox/create-stream-test-fixtures";
import { getReadyCheckOutputPatternsForAgent } from "../../sandbox/create-stream-ready-gate";
import type { DockerGpuPatchDeps } from "../docker-gpu-patch-types";

const dockerAdapterMocks = vi.hoisted(() => ({
  imageInspect: vi.fn(),
  pullWithProgressWatchdog: vi.fn(),
}));

const adapterMocks = vi.hoisted(() => ({
  activate: vi.fn<typeof import("./adapter").activateManagedBootstrapSequence>(),
  finalize: vi.fn<typeof import("./adapter").finalizeManagedBootstrapSequence>(),
  prepare: vi.fn<typeof import("./adapter").prepareManagedBootstrapSequence>(),
}));
const runtimeSnapshotMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));
const sandboxCreateMocks = vi.hoisted(() => ({
  isDockerDesktopWslRuntime: vi.fn(),
}));

vi.mock("../../adapters/docker/inspect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/docker/inspect")>()),
  dockerImageInspect: dockerAdapterMocks.imageInspect,
}));

vi.mock("../../adapters/docker/pull", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/docker/pull")>()),
  dockerPullWithProgressWatchdog: dockerAdapterMocks.pullWithProgressWatchdog,
}));

vi.mock("./adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./adapter")>()),
  activateManagedBootstrapSequence: adapterMocks.activate,
  finalizeManagedBootstrapSequence: adapterMocks.finalize,
  prepareManagedBootstrapSequence: adapterMocks.prepare,
}));

vi.mock("../docker-gpu-sandbox-create", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../docker-gpu-sandbox-create")>()),
  isDockerDesktopWslRuntime: sandboxCreateMocks.isDockerDesktopWslRuntime,
}));

vi.mock("../openshell-docker-sandbox-containers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../openshell-docker-sandbox-containers")>()),
  queryOpenShellDockerSandboxRuntimeSnapshot: runtimeSnapshotMocks.query,
}));

import type {
  ManagedBootstrapActivatedTransaction,
  ManagedBootstrapPreparedTransaction,
} from "./adapter";
import {
  createDockerManagedBootstrapSurface,
  formatDockerGpuModeFailureDetails,
} from "./docker-runtime";
import { authority, IDENTITY, NEW_ID, OLD_ID } from "./docker-test-fixture";
import type { ManagedBootstrapRuntimeCreateLifecycleInput } from "./runtime-create";

const temporaryStateRoots: string[] = [];

function compatibilityLifecycleInput(
  seed: ReturnType<typeof authority>,
  dependencies: ManagedBootstrapRuntimeCreateLifecycleInput["dependencies"] & DockerGpuPatchDeps,
): ManagedBootstrapRuntimeCreateLifecycleInput {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-runtime-probe-"));
  temporaryStateRoots.push(stateRoot);
  return {
    providerId: "docker",
    stateRoot,
    bootstrapIdentity: IDENTITY,
    request: seed.request,
    image: seed.plan.image,
    agentIdentity: seed.plan.agentIdentity,
    intendedWorkloadArgv: seed.plan.intendedWorkloadArgv,
    expectedSupervisorArgv: seed.plan.expectedSupervisorArgv,
    launchArgv: ["openshell", "sandbox", "create", "--name", "alpha"],
    heldWorkloadArgv: seed.handle.heldWorkloadArgv,
    authorityStore: {
      recordPreparedAuthority: vi.fn(),
    },
    route: "compatibility",
    persistStartupCommand: false,
    sandboxName: "alpha",
    sandboxGpuConfig: {
      mode: "1",
      hostGpuDetected: true,
      hostGpuPlatform: "n1x",
      sandboxGpuEnabled: true,
      sandboxGpuDevice: null,
      errors: [],
    },
    requiredLimits: [],
    timeoutSecs: 30,
    network: {
      inferenceProvider: "openai",
      gatewayUsesContainerBridge: true,
      gatewayPort: 8080,
    },
    dependencies,
  };
}

async function runCompatibilityCreate(
  input: ManagedBootstrapRuntimeCreateLifecycleInput,
  seed: ReturnType<typeof authority>,
): Promise<void> {
  const prepared = Object.freeze({}) as ManagedBootstrapPreparedTransaction;
  const activated = Object.freeze({
    snapshot: { runtimeId: OLD_ID },
    replacement: { replacementRuntimeId: NEW_ID },
  }) as ManagedBootstrapActivatedTransaction;
  adapterMocks.prepare.mockImplementation(async (_adapter, preparation) => {
    const receipt = await preparation.create.launch({
      heldWorkloadArgv: seed.handle.heldWorkloadArgv,
      bootstrapIdentity: IDENTITY,
    });
    expect(receipt).toEqual(seed.handle.createReceipt);
    return prepared;
  });
  adapterMocks.activate.mockResolvedValue(activated);
  const lifecycle = createDockerManagedBootstrapSurface().createLifecycle(input);

  await expect(
    lifecycle.runCreate(async () => ({ value: "created", receipt: seed.handle.createReceipt })),
  ).resolves.toBe("created");
}

function gpuModeDependencies() {
  const dockerRun = vi.fn<NonNullable<DockerGpuPatchDeps["dockerRun"]>>(() => ({
    status: 0,
    stdout: "probe-id",
  }));
  return {
    dockerRun,
    dependencies: {
      dockerCapture: vi.fn(() => ""),
      dockerRun,
      dockerRm: vi.fn(() => ({ status: 0 })),
      readDir: vi.fn(() => null),
      readFile: vi.fn(() => null),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dockerAdapterMocks.imageInspect.mockReturnValue({ status: 0 });
  dockerAdapterMocks.pullWithProgressWatchdog.mockResolvedValue({
    status: 0,
    signal: null,
    output: "",
    timedOut: false,
    timeoutKind: null,
  });
  sandboxCreateMocks.isDockerDesktopWslRuntime.mockReturnValue(false);
  runtimeSnapshotMocks.query.mockReturnValue({
    ok: true,
    imageId: `sha256:${"a".repeat(64)}`,
    bookkeepingImageRef: "openshell/sandbox-from:alpha",
    stateError: "",
    deviceRequests: null,
    devices: [],
    runtime: "runc",
    nvidiaVisibleDevices: null,
    nativeGpuAttachmentState: "absent",
    containerId: NEW_ID,
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const stateRoot of temporaryStateRoots.splice(0)) {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

describe("Docker managed-bootstrap pre-create GPU fallback", () => {
  it("reuses the exact managed image when native create is rejected before runtime discovery (#10155)", () => {
    const managedImageReference = `registry.example/nemoclaw-hermes@sha256:${"d".repeat(64)}`;
    const routing = createDockerManagedBootstrapSurface().createOnboardRouting({
      sandboxName: "alpha",
      openshellArgv: (args) => ["openshell", ...args],
      nativeFallbackEnabled: false,
    });

    expect(
      routing.prepareCompatibilityLaunch({
        createArgs: [
          "--from",
          "registry.example/native-source",
          "--name",
          "alpha",
          "--gpu",
          "--policy",
          "/tmp/native-policy.yaml",
        ],
        currentRegistryImageRef: managedImageReference,
        managedImageReference,
        prebuildImageId: null,
        allowUnbuiltSource: false,
        compatibilityPolicyPath: "/tmp/compatibility-policy.yaml",
        startupCommand: ["managed-hold"],
        runtimeSnapshot: null,
      }),
    ).toEqual({
      createArgv: [
        "openshell",
        "sandbox",
        "create",
        "--from",
        managedImageReference,
        "--name",
        "alpha",
        "--policy",
        "/tmp/compatibility-policy.yaml",
        "--",
        "managed-hold",
      ],
      registryImageRef: managedImageReference,
    });
  });
});

describe("Docker managed-bootstrap GPU probe diagnostics", () => {
  it("includes each failed mode without exposing credentials", () => {
    const details = formatDockerGpuModeFailureDetails([
      {
        mode: {
          kind: "gpus",
          label: "--gpus all",
          device: "all",
          args: ["--gpus", "all"],
        },
        ok: false,
        error: "proxy request failed with token=secret-value",
      },
    ]);

    expect(details).toContain("--gpus all");
    expect(details).toContain("token=<REDACTED>");
    expect(details).not.toContain("secret-value");
  });
});

describe("Docker managed-bootstrap GPU probe image", () => {
  it("pulls an uncached WSL sandbox image before bounded GPU mode probes", async () => {
    const { dependencies, dockerRun } = gpuModeDependencies();
    const seed = authority("openclaw");
    const input = compatibilityLifecycleInput(seed, dependencies);
    const sandboxImage = `${input.image.repository}@${input.image.manifestDigest}`;
    sandboxCreateMocks.isDockerDesktopWslRuntime.mockReturnValue(true);
    dockerAdapterMocks.imageInspect.mockReturnValue({ status: 1 });
    dockerRun.mockReturnValueOnce({ status: 1, stderr: "probe rejected" });

    await runCompatibilityCreate(input, seed);

    expect(dockerAdapterMocks.imageInspect).toHaveBeenCalledWith(
      sandboxImage,
      expect.objectContaining({ ignoreError: true, suppressOutput: true, timeout: 30_000 }),
    );
    expect(dockerAdapterMocks.pullWithProgressWatchdog).toHaveBeenCalledWith(
      sandboxImage,
      expect.objectContaining({ maxTimeoutMs: 30 * 60 * 1000 }),
    );
    expect(dockerAdapterMocks.pullWithProgressWatchdog.mock.invocationCallOrder[0]).toBeLessThan(
      dockerRun.mock.invocationCallOrder[0] ?? 0,
    );
    expect(dockerRun.mock.calls).toHaveLength(2);
    const firstProbeArgs = dockerRun.mock.calls[0]?.[0] ?? [];
    const secondProbeArgs = dockerRun.mock.calls[1]?.[0] ?? [];
    expect(firstProbeArgs).toEqual(expect.arrayContaining(["--gpus", "all", "--pull", "never"]));
    expect(secondProbeArgs).toEqual(
      expect.arrayContaining(["--runtime", "nvidia", "--pull", "never"]),
    );
    expect(firstProbeArgs.slice(-2)).toEqual([sandboxImage, "true"]);
    expect(secondProbeArgs.slice(-2)).toEqual([sandboxImage, "true"]);
    expect(dockerRun.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ timeout: 30_000 }));
    expect(dockerRun.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ timeout: 30_000 }));
  });

  it("skips the pull when the exact WSL sandbox image is already local", async () => {
    const { dependencies, dockerRun } = gpuModeDependencies();
    const seed = authority("openclaw");
    const input = compatibilityLifecycleInput(seed, dependencies);
    const sandboxImage = `${input.image.repository}@${input.image.manifestDigest}`;
    sandboxCreateMocks.isDockerDesktopWslRuntime.mockReturnValue(true);

    await runCompatibilityCreate(input, seed);

    expect(dockerAdapterMocks.imageInspect).toHaveBeenCalledOnce();
    expect(dockerAdapterMocks.pullWithProgressWatchdog).not.toHaveBeenCalled();
    const probeArgs = dockerRun.mock.calls[0]?.[0] ?? [];
    expect(probeArgs).toEqual(expect.arrayContaining(["--pull", "never"]));
    expect(probeArgs.slice(-2)).toEqual([sandboxImage, "true"]);
  });

  it("retains implicit pull behaviour on other Docker hosts", async () => {
    const { dependencies, dockerRun } = gpuModeDependencies();
    const seed = authority("openclaw");
    const input = compatibilityLifecycleInput(seed, dependencies);
    const sandboxImage = `${input.image.repository}@${input.image.manifestDigest}`;

    await runCompatibilityCreate(input, seed);

    expect(dockerAdapterMocks.imageInspect).not.toHaveBeenCalled();
    expect(dockerAdapterMocks.pullWithProgressWatchdog).not.toHaveBeenCalled();

    const probeArgs = dockerRun.mock.calls[0]?.[0] ?? [];
    expect(probeArgs.slice(-2)).toEqual([sandboxImage, "true"]);
    expect(probeArgs).not.toContain("--pull");
  });

  it("stops before GPU mode probing when the WSL image pull exceeds its limit", async () => {
    const { dependencies, dockerRun } = gpuModeDependencies();
    const seed = authority("openclaw");
    const input = compatibilityLifecycleInput(seed, dependencies);
    sandboxCreateMocks.isDockerDesktopWslRuntime.mockReturnValue(true);
    dockerAdapterMocks.imageInspect.mockReturnValue({ status: 1 });
    dockerAdapterMocks.pullWithProgressWatchdog.mockResolvedValue({
      status: 124,
      signal: "SIGTERM",
      output: "pull stopped",
      timedOut: true,
      timeoutKind: "max",
    });
    const lifecycle = createDockerManagedBootstrapSurface().createLifecycle(input);

    await expect(
      lifecycle.runCreate(async () => ({ value: "created", receipt: seed.handle.createReceipt })),
    ).rejects.toThrow(
      "Docker managed sandbox image pull failed before GPU mode selection: exceeded the 30-minute safety limit.",
    );
    expect(dockerRun).not.toHaveBeenCalled();
    expect(adapterMocks.prepare).not.toHaveBeenCalled();
  });

  it.each([
    {
      outcome: "exits nonzero",
      pullResult: {
        status: 23,
        signal: null,
        output: "pull rejected",
        timedOut: false,
        timeoutKind: null,
      },
      reason: "exited with status 23",
    },
    {
      outcome: "does not start",
      pullResult: {
        status: 1,
        signal: null,
        output: "",
        timedOut: false,
        timeoutKind: null,
        error: new Error("spawn docker failed"),
      },
      reason: "could not start (spawn docker failed)",
    },
  ])(
    "stops before GPU mode probing when the WSL image pull $outcome",
    async ({ pullResult, reason }) => {
      const { dependencies, dockerRun } = gpuModeDependencies();
      const seed = authority("openclaw");
      const input = compatibilityLifecycleInput(seed, dependencies);
      sandboxCreateMocks.isDockerDesktopWslRuntime.mockReturnValue(true);
      dockerAdapterMocks.imageInspect.mockReturnValue({ status: 1 });
      dockerAdapterMocks.pullWithProgressWatchdog.mockResolvedValue(pullResult);
      const lifecycle = createDockerManagedBootstrapSurface().createLifecycle(input);

      await expect(
        lifecycle.runCreate(async () => ({ value: "created", receipt: seed.handle.createReceipt })),
      ).rejects.toThrow(
        `Docker managed sandbox image pull failed before GPU mode selection: ${reason}.`,
      );
      expect(dockerRun).not.toHaveBeenCalled();
      expect(adapterMocks.prepare).not.toHaveBeenCalled();
    },
  );
});

describe("Docker managed-bootstrap lifecycle composition", () => {
  it("activates a Ready managed hold before post-activation startup output", async () => {
    vi.useFakeTimers();
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-runtime-"));
    const seed = authority("hermes");
    const prepared = Object.freeze({}) as ManagedBootstrapPreparedTransaction;
    const activated = Object.freeze({
      snapshot: { runtimeId: OLD_ID },
      replacement: { replacementRuntimeId: NEW_ID },
    }) as ManagedBootstrapActivatedTransaction;
    const order: string[] = [];
    adapterMocks.prepare.mockImplementation(async (_adapter, input) => {
      order.push("prepare");
      const receipt = await input.create.launch({
        heldWorkloadArgv: seed.handle.heldWorkloadArgv,
        bootstrapIdentity: IDENTITY,
      });
      order.push("create-returned");
      expect(receipt).toEqual(seed.handle.createReceipt);
      return prepared;
    });
    adapterMocks.activate.mockImplementation(async () => {
      order.push("activate");
      return activated;
    });
    const lifecycle = createDockerManagedBootstrapSurface().createLifecycle({
      providerId: "docker",
      stateRoot,
      bootstrapIdentity: IDENTITY,
      request: seed.request,
      image: seed.plan.image,
      agentIdentity: seed.plan.agentIdentity,
      intendedWorkloadArgv: seed.plan.intendedWorkloadArgv,
      expectedSupervisorArgv: seed.plan.expectedSupervisorArgv,
      launchArgv: ["openshell", "sandbox", "create", "--name", "alpha"],
      heldWorkloadArgv: seed.handle.heldWorkloadArgv,
      authorityStore: {
        recordPreparedAuthority: vi.fn(),
      },
      route: "none",
      persistStartupCommand: false,
      sandboxName: "alpha",
      sandboxGpuConfig: {
        mode: "0",
        hostGpuDetected: false,
        hostGpuPlatform: null,
        sandboxGpuEnabled: false,
        sandboxGpuDevice: null,
        errors: [],
      },
      requiredLimits: [],
      timeoutSecs: 30,
      network: {
        inferenceProvider: "openai",
        gatewayUsesContainerBridge: false,
        gatewayPort: 0,
      },
      dependencies: {},
    });
    const child = new FakeChild();
    let ready = false;

    try {
      const result = lifecycle.runCreate(async () => {
        order.push("stream-start");
        const stream = streamSandboxCreate("openshell", ["sandbox", "create"], dockerEnv, {
          ...makePollingOptions(child),
          readyCheck: () => ready,
          readyCheckOutputPatterns: getReadyCheckOutputPatternsForAgent({
            isTerminalAgent: false,
            startupRunsDuringCreate: false,
            env: dockerEnv,
          }),
          initialPhase: "create",
        });
        child.stdout.emit("data", Buffer.from("Created sandbox: alpha\n"));
        ready = true;
        await vi.advanceTimersByTimeAsync(6);
        expect(order).not.toContain("activate");
        return { value: await stream, receipt: seed.handle.createReceipt };
      });

      await expect(result).resolves.toMatchObject({ status: 0, forcedReady: true });
      expect(order).toEqual(["prepare", "stream-start", "create-returned", "activate"]);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(adapterMocks.activate).toHaveBeenCalledOnce();
      expect(lifecycle.inspectNativeRuntime?.()).toEqual({
        imageId: `sha256:${"a".repeat(64)}`,
        bookkeepingImageRef: "openshell/sandbox-from:alpha",
        stateError: "",
        nativeGpuAttachmentState: "absent",
      });
      expect(runtimeSnapshotMocks.query).toHaveBeenCalledWith(
        "alpha",
        {},
        { expectedContainerId: NEW_ID },
      );
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("does not finalize rollback after a claimed commit loses acknowledgement", async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-runtime-"));
    const seed = authority("openclaw");
    const prepared = Object.freeze({}) as ManagedBootstrapPreparedTransaction;
    const activated = Object.freeze({
      snapshot: { runtimeId: OLD_ID },
      replacement: { replacementRuntimeId: NEW_ID },
    }) as ManagedBootstrapActivatedTransaction;
    adapterMocks.prepare.mockImplementation(async (_adapter, input) => {
      await input.create.launch({
        heldWorkloadArgv: seed.handle.heldWorkloadArgv,
        bootstrapIdentity: IDENTITY,
      });
      return prepared;
    });
    adapterMocks.activate.mockResolvedValue(activated);
    adapterMocks.finalize.mockRejectedValue(new Error("commit acknowledgement lost"));
    const onPatchFailure = vi.fn((error: unknown): never => {
      throw error;
    });
    const lifecycle = createDockerManagedBootstrapSurface().createLifecycle({
      providerId: "docker",
      stateRoot,
      bootstrapIdentity: IDENTITY,
      request: seed.request,
      image: seed.plan.image,
      agentIdentity: seed.plan.agentIdentity,
      intendedWorkloadArgv: seed.plan.intendedWorkloadArgv,
      expectedSupervisorArgv: seed.plan.expectedSupervisorArgv,
      launchArgv: ["openshell", "sandbox", "create", "--name", "alpha"],
      heldWorkloadArgv: seed.handle.heldWorkloadArgv,
      authorityStore: {
        recordPreparedAuthority: vi.fn(),
      },
      route: "none",
      persistStartupCommand: false,
      sandboxName: "alpha",
      sandboxGpuConfig: {
        mode: "0",
        hostGpuDetected: false,
        hostGpuPlatform: null,
        sandboxGpuEnabled: false,
        sandboxGpuDevice: null,
        errors: [],
      },
      requiredLimits: [],
      timeoutSecs: 30,
      onPatchFailure,
      network: {
        inferenceProvider: "openai",
        gatewayUsesContainerBridge: false,
        gatewayPort: 0,
      },
      dependencies: {},
    });

    await expect(
      lifecycle.runCreate(async () => ({ value: "launched", receipt: seed.handle.createReceipt })),
    ).resolves.toBe("launched");
    const failure = (await Promise.resolve(lifecycle.patch.commitAfterReady()).catch(
      (error: unknown) => error,
    )) as Error & { managedBootstrapRollbackError?: Error };

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe("commit acknowledgement lost");
    expect(failure.managedBootstrapRollbackError?.message).toBe(
      "Managed bootstrap rollback is no longer legal after commit finalization began.",
    );
    expect(adapterMocks.finalize).toHaveBeenCalledOnce();
    expect(adapterMocks.finalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "commit", transaction: activated }),
    );
    expect(onPatchFailure).toHaveBeenCalledOnce();
    await expect(lifecycle.recoverUnfinished()).resolves.toEqual({ receipts: [], failures: [] });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
});
