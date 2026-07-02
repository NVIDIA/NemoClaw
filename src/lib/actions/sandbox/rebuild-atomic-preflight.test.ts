// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

type RebuildSandbox = typeof import("./rebuild")["rebuildSandbox"];

type FailureStage = "target" | "image" | "route" | null;

type AtomicRebuildHarness = {
  backupSpy: MockInstance;
  events: string[];
  imagePreflightSpy: MockInstance;
  onboardSpy: MockInstance;
  openShieldsSpy: MockInstance;
  preflightTargetSpy: MockInstance;
  rebuildSandbox: RebuildSandbox;
  recoverGatewaySpy: MockInstance;
  removeRegistrySpy: MockInstance;
  routeReadySpy: MockInstance;
  runOpenshellSpy: MockInstance;
};

const requireSource = createRequire(import.meta.url);
const rebuildModulePath = "./rebuild.js";
const targetGatewayName = "nemoclaw-19080";
const targetGatewayPort = 19080;
const recordedProvider = "nvidia-prod";
const recordedModel = "nvidia/nemotron-3-super-120b-a12b";
const ambientEnvNames = [
  "NEMOCLAW_AGENT",
  "NEMOCLAW_PROVIDER",
  "NEMOCLAW_PROVIDER_KEY",
  "NEMOCLAW_ENDPOINT_URL",
  "NEMOCLAW_MODEL",
  "NVIDIA_INFERENCE_API_KEY",
  "OPENSHELL_GATEWAY",
  "OPENSHELL_LOCAL_TLS_DIR",
] as const;

// Loading the large CommonJS graph outside the first test keeps the regression
// focused on orchestration rather than one-time source transpilation.
requireSource(rebuildModulePath);
delete require.cache[requireSource.resolve(rebuildModulePath)];

let restoreEnvironment: () => void;

function snapshotEnvironment(): () => void {
  const saved = ambientEnvNames.map((name) => [name, process.env[name]] as const);
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function installHostileAmbientSelection(): void {
  process.env.NEMOCLAW_AGENT = "openclaw";
  process.env.NEMOCLAW_PROVIDER = "openai";
  process.env.NEMOCLAW_PROVIDER_KEY = "bogus-hostile-provider-key";
  process.env.NEMOCLAW_ENDPOINT_URL = "https://hostile.invalid/v1";
  process.env.NEMOCLAW_MODEL = "hostile/model";
  process.env.NVIDIA_INFERENCE_API_KEY = "recorded-provider-test-key";
}

function createAtomicRebuildHarness(failureStage: FailureStage): AtomicRebuildHarness {
  delete require.cache[requireSource.resolve(rebuildModulePath)];

  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const gatewayDrift = requireSource("../../adapters/openshell/gateway-drift.js");
  const openshellRuntime = requireSource("../../adapters/openshell/runtime.js");
  const gatewayRuntime = requireSource("../../gateway-runtime-action.js");
  const sandboxList = requireSource("../../openshell-sandbox-list.js");
  const resolve = requireSource("../../adapters/openshell/resolve.js");
  const agentOnboard = requireSource("../../agent/onboard.js");
  const agentRuntime = requireSource("../../agent/runtime.js");
  const onboard = requireSource("../../onboard.js");
  const onboardSession = requireSource("../../state/onboard-session.js");
  const registry = requireSource("../../state/registry.js");
  const sandboxSession = requireSource("../../state/sandbox-session.js");
  const sandboxState = requireSource("../../state/sandbox.js");
  const sandboxVersion = requireSource("../../sandbox/version.js");
  const userManagedFiles = requireSource("../../state/user-managed-files-probe.js");
  const destroy = requireSource("./destroy.js");
  const messagingHostForward = requireSource("./messaging-host-forward-lifecycle.js");
  const rebuildImage = requireSource("./rebuild-custom-image-preflight.js");
  const rebuildInference = requireSource("./rebuild-inference-preflight.js");
  const rebuildShields = requireSource("./rebuild-shields.js");

  const events: string[] = [];
  const sandboxEntry = {
    name: "dcode-workspace",
    agent: "langchain-deepagents-code",
    agentVersion: "0.1.0",
    nemoclawVersion: "0.0.72",
    provider: recordedProvider,
    model: recordedModel,
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    preferredInferenceApi: "openai-completions",
    compatibleEndpointReasoning: null,
    nimContainer: null,
    policies: [],
    dashboardPort: null,
    gatewayName: targetGatewayName,
    gatewayPort: targetGatewayPort,
    sandboxGpuMode: "0",
  };
  const session = {
    sandboxName: sandboxEntry.name,
    agent: sandboxEntry.agent,
    provider: recordedProvider,
    model: recordedModel,
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    preferredInferenceApi: "openai-completions",
    compatibleEndpointReasoning: null,
    nimContainer: null,
    metadata: {},
    hermesToolGateways: [],
    status: "in_progress",
  };

  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null);
  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null);
  const recoverGatewaySpy = vi
    .spyOn(gatewayRuntime, "recoverNamedGatewayRuntime")
    .mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as { gatewayName: string };
      events.push(`gateway:${options.gatewayName}`);
      return {
        recovered: true,
        attempted: false,
        before: { state: "healthy_named" },
        after: { state: "healthy_named" },
      };
    });
  vi.spyOn(sandboxList, "captureSandboxListWithGatewayRecovery").mockImplementation(
    async (...args: unknown[]) => {
      const options = args[0] as { gatewayName: string };
      events.push(`liveness:${options.gatewayName}`);
      return { result: { status: 0, output: `${sandboxEntry.name} Ready` } };
    },
  );
  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null);
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: sandboxEntry.agent });
  vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("Deep Agents Code");
  vi.spyOn(agentOnboard, "ensureAgentBaseImage").mockImplementation(() => {
    events.push("base-image");
    return { imageTag: "nemoclaw-dcode-base:test", built: true };
  });
  vi.spyOn(onboardSession, "loadSession").mockImplementation(() => session);
  vi.spyOn(onboardSession, "updateSession").mockImplementation((...args: unknown[]) => {
    const mutator = args[0] as (value: typeof session) => typeof session | void;
    mutator(session);
    return session;
  });
  vi.spyOn(onboardSession, "acquireOnboardLock").mockReturnValue({ acquired: true });
  vi.spyOn(onboardSession, "releaseOnboardLock").mockImplementation(() => undefined);
  vi.spyOn(registry, "getSandbox").mockReturnValue(sandboxEntry);
  vi.spyOn(registry, "load").mockReturnValue({
    defaultSandbox: sandboxEntry.name,
    sandboxes: { [sandboxEntry.name]: sandboxEntry },
  });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [] });
  vi.spyOn(registry, "listExtraProviders").mockReturnValue([]);
  vi.spyOn(registry, "updateSandbox").mockImplementation(() => undefined);
  vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
    detected: false,
    sessions: [],
  });
  vi.spyOn(sandboxVersion, "checkAgentVersion").mockReturnValue({
    expectedVersion: "0.2.0",
    sandboxVersion: "0.1.0",
  });
  vi.spyOn(userManagedFiles, "probeUserManagedFiles").mockReturnValue({
    declared: [],
    existing: [],
  });

  const preflightTargetSpy = vi
    .spyOn(onboard, "preflightAuthoritativeRebuildTarget")
    .mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as Record<string, unknown>;
      events.push("target-preflight");
      expect(process.env.OPENSHELL_GATEWAY).toBe(targetGatewayName);
      expect(options).toEqual(
        expect.objectContaining({
          agent: sandboxEntry.agent,
          authoritativeResumeConfig: true,
          controlUiPort: null,
          model: recordedModel,
          onboardLockAlreadyHeld: true,
          provider: recordedProvider,
          sandboxName: sandboxEntry.name,
          targetGatewayName,
          targetGatewayPort,
        }),
      );
      if (failureStage === "target") throw new Error("fatal target preflight failed");
      return {
        gpu: null,
        host: { dockerReachable: true, runtime: "docker", notes: [] },
        sandboxGpuConfig: {
          mode: "0",
          hostGpuDetected: false,
          hostGpuPlatform: null,
          sandboxGpuEnabled: false,
          sandboxGpuDevice: null,
          errors: [],
        },
      };
    });
  const routeReadySpy = vi
    .spyOn(onboard, "isInferenceRouteReady")
    .mockImplementation((...args: unknown[]) => {
      const [provider, model] = args as [string, string];
      events.push("final-route");
      expect(process.env.OPENSHELL_GATEWAY).toBe(targetGatewayName);
      expect([provider, model]).toEqual([recordedProvider, recordedModel]);
      return failureStage !== "route";
    });
  const imagePreflightSpy = vi
    .spyOn(rebuildImage, "preflightRebuildImage")
    .mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as Record<string, unknown>;
      events.push("final-image");
      expect(options).toEqual(
        expect.objectContaining({
          chatUiUrl: "",
          gatewayPort: targetGatewayPort,
          model: recordedModel,
          provider: recordedProvider,
        }),
      );
      return failureStage === "image"
        ? { ok: false, detail: "replacement image build failed" }
        : {
            ok: true,
            preparedBuildContext: {
              buildCtx: "/tmp/dcode-atomic-preflight",
              stagedDockerfile: "/tmp/dcode-atomic-preflight/Dockerfile",
              buildId: "atomic-build",
              dockerGpuPatchNetwork: null,
              cleanupBuildCtx: vi.fn(() => true),
            },
          };
    });
  vi.spyOn(rebuildInference, "preflightRebuildInferenceRoute").mockImplementation(() => {
    events.push("inference-probe");
    return { ok: true };
  });

  const openShieldsSpy = vi
    .spyOn(rebuildShields, "openRebuildShieldsWindow")
    .mockImplementation(() => {
      events.push("shields-unlock");
      return { relocked: false, wasLocked: false };
    });
  vi.spyOn(rebuildShields, "relockRebuildShieldsWindow").mockImplementation(() => true);
  const backupSpy = vi.spyOn(sandboxState, "backupSandboxState").mockImplementation(() => {
    events.push("backup");
    return {
      success: true,
      backedUpDirs: ["workspace"],
      backedUpFiles: [],
      failedDirs: [],
      failedFiles: [],
      manifest: {
        backupPath: "/tmp/dcode-rebuild-backup",
        timestamp: "2026-07-02T00:00:00.000Z",
        policyPresets: [],
      },
    };
  });
  vi.spyOn(sandboxState, "restoreSandboxState").mockReturnValue({
    success: true,
    restoredDirs: ["workspace"],
    restoredFiles: [],
    failedDirs: [],
    failedFiles: [],
  });

  const runOpenshellSpy = vi
    .spyOn(openshellRuntime, "runOpenshell")
    .mockImplementation((...callArgs: unknown[]) => {
      const args = callArgs[0] as string[];
      if (args[0] === "sandbox" && args[1] === "delete") events.push("sandbox-delete");
      return { status: 0, output: "" };
    });
  const removeRegistrySpy = vi
    .spyOn(destroy, "removeSandboxRegistryEntry")
    .mockImplementation(() => {
      events.push("registry-remove");
    });
  const onboardSpy = vi.spyOn(onboard, "onboard").mockImplementation(async (options: unknown) => {
    events.push("onboard");
    for (const name of [
      "NEMOCLAW_AGENT",
      "NEMOCLAW_PROVIDER",
      "NEMOCLAW_PROVIDER_KEY",
      "NEMOCLAW_ENDPOINT_URL",
      "NEMOCLAW_MODEL",
    ]) {
      expect(process.env[name]).toBeUndefined();
    }
    expect(options).toEqual(
      expect.objectContaining({
        agent: sandboxEntry.agent,
        authoritativeResumeConfig: true,
        controlUiPort: null,
        onboardLockAlreadyHeld: true,
        targetGatewayName,
        targetGatewayPort,
      }),
    );
  });
  vi.spyOn(messagingHostForward, "ensureMessagingHostForwardAfterRebuild").mockReturnValue(true);

  return {
    backupSpy,
    events,
    imagePreflightSpy,
    onboardSpy,
    openShieldsSpy,
    preflightTargetSpy,
    rebuildSandbox: requireSource(rebuildModulePath).rebuildSandbox,
    recoverGatewaySpy,
    removeRegistrySpy,
    routeReadySpy,
    runOpenshellSpy,
  };
}

function expectNoDestructiveWork(harness: AtomicRebuildHarness): void {
  expect(harness.openShieldsSpy).not.toHaveBeenCalled();
  expect(harness.backupSpy).not.toHaveBeenCalled();
  expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
    ["sandbox", "delete", "dcode-workspace"],
    expect.anything(),
  );
  expect(harness.removeRegistrySpy).not.toHaveBeenCalled();
  expect(harness.onboardSpy).not.toHaveBeenCalled();
}

describe("atomic dcode rebuild preflight (#6195)", () => {
  beforeEach(() => {
    restoreEnvironment = snapshotEnvironment();
    installHostileAmbientSelection();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[requireSource.resolve(rebuildModulePath)];
    restoreEnvironment();
  });

  it("preflights the recorded gateway without a dashboard probe before any destructive work", async () => {
    const harness = createAtomicRebuildHarness("target");

    await expect(
      harness.rebuildSandbox("dcode-workspace", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("fatal target preflight failed");

    expect(harness.preflightTargetSpy).toHaveBeenCalledOnce();
    expect(harness.recoverGatewaySpy).toHaveBeenCalledWith({
      gatewayName: targetGatewayName,
      recoverableStates: [
        "missing_named",
        "named_unhealthy",
        "named_unreachable",
        "connected_other",
      ],
    });
    expect(harness.imagePreflightSpy).not.toHaveBeenCalled();
    expect(harness.routeReadySpy).not.toHaveBeenCalled();
    expectNoDestructiveWork(harness);
  });

  it("keeps the sandbox intact when the exact replacement image cannot be built", async () => {
    const harness = createAtomicRebuildHarness("image");

    await expect(
      harness.rebuildSandbox("dcode-workspace", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Replacement sandbox image preflight failed");

    expect(harness.preflightTargetSpy).toHaveBeenCalledOnce();
    expect(harness.imagePreflightSpy).toHaveBeenCalledOnce();
    expect(harness.routeReadySpy).not.toHaveBeenCalled();
    expectNoDestructiveWork(harness);
  });

  it("keeps the sandbox intact when the final recorded route recheck fails", async () => {
    const harness = createAtomicRebuildHarness("route");

    await expect(
      harness.rebuildSandbox("dcode-workspace", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("OpenShell inference route changed during rebuild preflight");

    expect(harness.preflightTargetSpy).toHaveBeenCalledTimes(2);
    expect(harness.imagePreflightSpy).toHaveBeenCalledOnce();
    expect(harness.routeReadySpy).toHaveBeenCalledWith(recordedProvider, recordedModel);
    expectNoDestructiveWork(harness);
  });

  it("finishes all target checks before backup/delete and isolates hostile ambient selection", async () => {
    const harness = createAtomicRebuildHarness(null);

    await expect(
      harness.rebuildSandbox("dcode-workspace", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.events).toEqual([
      `gateway:${targetGatewayName}`,
      "target-preflight",
      "base-image",
      "final-image",
      `liveness:${targetGatewayName}`,
      "target-preflight",
      "final-route",
      "shields-unlock",
      "backup",
      "target-preflight",
      "inference-probe",
      "final-route",
      "sandbox-delete",
      "registry-remove",
      "onboard",
    ]);
    expect(process.env.NEMOCLAW_PROVIDER_KEY).toBe("bogus-hostile-provider-key");
    expect(process.env.NEMOCLAW_PROVIDER).toBe("openai");
    expect(process.env.NEMOCLAW_MODEL).toBe("hostile/model");
  });
});
