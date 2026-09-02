// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostLocalInferenceReceipt,
  serializedLlamaCppHostLocalInferenceReceipt,
} from "../../../../test/helpers/host-local-inference-receipt";
import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import { resolveTestAgentBaselinePolicy } from "../../../../test/support/snapshot-policy-test-fixture";
import {
  serializeHostLocalInferenceReceipt,
  type HostLocalInferenceOperation,
  type HostLocalInferenceRuntime,
} from "../../onboard/runtime-provider/host-local-inference";
import type { SnapshotStreamSandboxCreateMock } from "./snapshot-create-stream-test-types";
import { createSandboxHostLocalInferenceProvenance } from "../../state/registry/host-local-inference";

const harness = vi.hoisted(() => ({
  entries: new Map<string, Record<string, unknown>>(),
  preserveForRebuild: vi.fn((value: unknown) => value),
  prepareDestroy: vi.fn((value: unknown) => value),
  destroy: vi.fn((value: unknown) => ({ status: "removed", receipt: value })),
}));
const captureOpenshellMock = vi.fn((args: string[]) => ({
  status: 0,
  output:
    args[0] === "policy"
      ? "version: 1\nnetwork_policies: {}\n"
      : "alpha Ready\nbeta Ready\nId: beta-runtime-id\n",
}));
const readSandboxPolicyMock = vi.fn(() => ({
  ok: true as const,
  value: {
    document: "version: 1\nnetwork_policies: {}\n",
    appliedRevision: null,
  },
}));
const getSandboxMock = vi.fn((name?: string) => harness.entries.get(name ?? "") ?? null);
const registerSandboxMock = vi.fn(
  (
    entry: Record<string, unknown>,
    _routeReservation?: unknown,
    options: { pending?: boolean } = {},
  ) => {
    harness.entries.set(String(entry.name), {
      ...entry,
      ...(options.pending === true ? { pendingRouteReservation: true } : {}),
    });
  },
);
const finalizePendingSandboxRegistrationMock = vi.fn((name: string) => {
  const entry = harness.entries.get(name);
  const finalized =
    entry?.pendingRouteReservation === true
      ? { ...entry, pendingRouteReservation: undefined }
      : null;
  return finalized === null ? false : Boolean(harness.entries.set(name, finalized));
});
const reserveSandboxInferenceRouteMock = vi.fn((name: string, route: Record<string, unknown>) => {
  harness.entries.set(name, {
    name,
    pendingRouteReservation: true,
    ...route,
  });
  return true;
});
const restoreSandboxStateMock = vi.fn();
const captureSnapshotRestoreAuthorityMock = vi.fn();
const streamSandboxCreateMock = vi.fn<SnapshotStreamSandboxCreateMock>(async () => ({
  status: 7,
  output: "create failed before registry write",
  sawProgress: false,
  forcedReady: false,
}));
const removeSandboxRegistryEntryOutcomeMock = vi.fn((name: string) => {
  const removed = harness.entries.delete(name);
  return { status: removed ? ("complete" as const) : ("not-found" as const), removed };
});

const managedRuntime: HostLocalInferenceRuntime = {
  providerId: "mxc",
  authorityId: "mxc:host-local",
  services: ["ollama", "nim", "vllm"],
  translateContainerArgs: (args) => args,
  qualifyOllama: vi.fn(),
  startManaged: vi.fn(),
  inspectManaged: vi.fn((value) => ({ running: true, receipt: value })),
  stopManaged: vi.fn((value) => ({ running: false, receipt: value })),
  preserveForRebuild: harness.preserveForRebuild as HostLocalInferenceRuntime["preserveForRebuild"],
  prepareDestroy: harness.prepareDestroy as HostLocalInferenceRuntime["prepareDestroy"],
  destroy: harness.destroy as HostLocalInferenceRuntime["destroy"],
};
const operation: HostLocalInferenceOperation = {
  providerId: "mxc",
  engine: {
    operation: "host-local-inference",
    engineId: "memory",
    displayName: "In-memory",
    authorityId: "mxc:host-local",
    capture: vi.fn(),
    captureHost: vi.fn(),
  },
  bindingSha256: "a".repeat(64),
  assertAuthority: vi.fn(),
  spawn: vi.fn() as HostLocalInferenceOperation["spawn"],
  createLlamaCppLifecycle: vi.fn() as HostLocalInferenceOperation["createLlamaCppLifecycle"],
  managedRuntime,
};
const runtimeProvider = createInMemoryRuntimeProviderBundle({
  providerId: "mxc",
  workloadProfile: {
    support: null,
    hostArchitectures: ["x64"],
    managedImageSelectionPolicy: "prefer-managed",
    legacyDockerfileBuilds: false,
  },
  hostLocalInference: {
    services: ["ollama", "nim", "vllm"],
    createOperation: () => operation,
  },
});

function managedHostLocalReceipt(): string {
  const receipt = hostLocalInferenceReceipt("mxc");
  return serializeHostLocalInferenceReceipt({
    ...receipt,
    engineAuthority: { ...receipt.engineAuthority, engineId: "memory" },
  });
}

function sourceEntry(receipt?: string): Record<string, unknown> {
  return {
    name: "alpha",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    imageTag: "nemoclaw-alpha:test",
    openshellDriver: receipt ? "mxc" : "docker",
    provider: "vllm-local",
    model: "model-a",
    endpointUrl: "https://inference.local/v1",
    lifecycleGeneration: "alpha-generation-1",
    ...(receipt ? { hostLocalInferenceReceipt: receipt } : {}),
  };
}

vi.mock("../../adapters/docker", () => ({
  dockerCapture: vi.fn(() => ""),
  dockerForceRm: vi.fn(),
  dockerRunDetached: vi.fn(),
}));
vi.mock("../../adapters/openshell/runtime", () => ({
  buildOpenShellSubprocessEnv: vi.fn(() => ({})),
  captureOpenshell: captureOpenshellMock,
  captureResolvedOpenshell: captureOpenshellMock,
  getOpenshellBinary: vi.fn(() => "openshell"),
  runOpenshell: vi.fn(() => ({ status: 0, output: "" })),
}));
vi.mock("../../adapters/openshell/sandbox-policy-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/sandbox-policy-cli")>()),
  syncCliOpenShellSandboxPolicyReader: {
    inspectSandboxPolicy: vi.fn(),
    readSandboxPolicy: readSandboxPolicyMock,
    readSandboxPolicyRevision: vi.fn(),
  },
}));
vi.mock("../../credentials/store", () => ({
  deleteCredential: vi.fn(),
  getCredential: vi.fn(() => null),
  prompt: vi.fn(),
  saveCredential: vi.fn(),
}));
vi.mock("../../domain/sandbox/destroy", () => ({
  getSandboxDeleteOutcome: vi.fn(() => ({ alreadyGone: false, gatewayUnreachable: false })),
}));
vi.mock("../../inference/gateway-route-compatibility", () => ({
  checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true })),
  formatGatewayRouteConflict: vi.fn(() => "route conflict"),
}));
vi.mock("../../inference/gateway-route-mutation-lock", () => ({
  withGatewayRouteMutationLock: vi.fn((_gateway, fn) => fn()),
}));
vi.mock("../../inference/nim", () => ({
  stopNimContainer: vi.fn(),
  stopNimContainerByName: vi.fn(),
}));
vi.mock("../../messaging/channels", () => ({
  BUILT_IN_CHANNEL_MANIFESTS: [],
  getMessagingConfigEnvAliases: vi.fn(() => ({})),
  getMessagingCredentialEnvKeysByChannel: vi.fn(() => ({})),
  getMessagingProviderSuffixesByChannel: vi.fn(() => ({})),
  listBuiltInMessagingChannelManifests: vi.fn(() => []),
  listMessagingProviderSuffixes: vi.fn(() => []),
  listMessagingCredentialMetadata: vi.fn(() => []),
}));
vi.mock("../../policy", () => ({
  applyPreset: vi.fn(() => true),
  applyPresetContent: vi.fn(() => true),
  getAppliedPresets: vi.fn(() => []),
  getPresetContentGatewayState: vi.fn(() => "absent"),
  loadPresetForSandbox: vi.fn(() => null),
  parseCurrentPolicy: (raw: unknown) => String(raw),
  removePreset: vi.fn(() => true),
  resolveAgentBaselinePolicy: resolveTestAgentBaselinePolicy,
}));
vi.mock("../../runner", () => ({
  ROOT: "/repo",
  run: vi.fn(() => ({ status: 0 })),
  shellQuote: (value: string) => `'${value}'`,
  validateName: vi.fn((value: string) => value),
}));
vi.mock("../../runtime-recovery", () => ({
  parseLiveSandboxNames: vi.fn(() => new Set(["alpha"])),
}));
vi.mock("../../sandbox/create-stream", () => ({ streamSandboxCreate: streamSandboxCreateMock }));
vi.mock("../../shields", () => ({
  get isShieldsDown() {
    return true;
  },
  recoverCompletedAutoRestoreBeforeCommand: vi.fn(),
  repairMutableConfigPerms: vi.fn(() => ({ applied: true, verified: true, errors: [] })),
  shieldsUp: vi.fn(),
}));
vi.mock("../../shields/timer-bound-lock", () => ({
  withTimerBoundShieldsMutationLock: vi.fn((_sandbox, _command, fn) => fn()),
}));
vi.mock("../../shields/timer-control", () => ({
  isProcessAlive: vi.fn(() => true),
  readProcessStartIdentity: vi.fn(() => "snapshot-test-process-start"),
  readTimerMarker: vi.fn(() => null),
}));
vi.mock("../../state/gateway", () => ({
  isGatewayHealthy: vi.fn(() => true),
  isSandboxReady: vi.fn((output: string, sandboxName: string) =>
    output.includes(`${sandboxName} Ready`),
  ),
}));
vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withMcpLifecycleLock: vi.fn((_key, fn) => fn()),
  withSandboxMutationLock: vi.fn((_sandbox, fn) => fn()),
}));
vi.mock("../../state/registry", () => ({
  getSandbox: getSandboxMock,
  listSandboxes: vi.fn(() => ({
    sandboxes: [...harness.entries.values()],
    defaultSandbox: "alpha",
  })),
  finalizePendingSandboxRegistration: finalizePendingSandboxRegistrationMock,
  registerSandbox: registerSandboxMock,
  reserveSandboxInferenceRoute: reserveSandboxInferenceRouteMock,
  removeSandbox: vi.fn((name: string) => harness.entries.delete(name)),
  updateSandbox: vi.fn(),
}));
vi.mock("../../state/sandbox", () => ({
  backupSandboxState: vi.fn(),
  captureSnapshotRestoreAuthority: captureSnapshotRestoreAuthorityMock,
  findBackup: vi.fn(() => ({ match: null })),
  getLatestBackup: vi.fn(() => ({
    timestamp: "2026-06-15T00:00:00.000Z",
    backupPath: "/tmp/backup-alpha",
  })),
  listBackups: vi.fn(() => []),
  restoreSandboxState: restoreSandboxStateMock,
}));
vi.mock("./destroy", () => ({
  cleanupShieldsDestroyArtifacts: vi.fn(),
  removeSandboxRegistryEntryOutcome: removeSandboxRegistryEntryOutcomeMock,
  requireSandboxDestructiveCleanupAuthority: vi.fn(() => ({ provider: runtimeProvider })),
}));
vi.mock("./restore-gateway-pairing", () => ({
  establishRestoredSandboxGatewayPairing: vi.fn(),
  waitForRestoredSandboxGatewaySupervisor: vi.fn(() => true),
}));
vi.mock("./sandbox-gateway-routing", () => ({
  probeGatewayRunning: vi.fn(() => true),
  selectSandboxGatewayIfRegistered: vi.fn(() => true),
  usesGatewayMetadataProbe: vi.fn(() => true),
}));
vi.mock("./snapshot/dependencies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./snapshot/dependencies")>()),
  requireCurrentSnapshotRuntimeProvider: vi.fn(() => runtimeProvider),
}));

describe("snapshot restore auto-create failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.entries.clear();
    harness.entries.set("alpha", sourceEntry());
    streamSandboxCreateMock.mockResolvedValue({
      status: 7,
      output: "create failed before registry write",
      sawProgress: false,
      forcedReady: false,
    });
  });

  it("does not register a ghost sandbox when auto-create fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(streamSandboxCreateMock).toHaveBeenCalledWith(
      "openshell",
      expect.arrayContaining(["sandbox", "create", "--name", "beta"]),
      expect.any(Object),
      expect.objectContaining({ initialPhase: "create" }),
    );
    expect(registerSandboxMock).not.toHaveBeenCalled();
    expect(restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("releases an exact host-local clone reservation when auto-create fails", async () => {
    const receipt = serializedLlamaCppHostLocalInferenceReceipt();
    harness.entries.set("alpha", {
      ...sourceEntry(),
      openshellDriver: "docker",
      provider: "llama-cpp-local",
      model: "llama-cpp-model",
      endpointUrl: "https://inference.local/v1",
      endpointSource: "inference-set",
      credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
      preferredInferenceApi: "openai-completions",
      gatewayPort: 8080,
      hostLocalInferenceReceipt: receipt,
      hostLocalInferenceProvenance: createSandboxHostLocalInferenceProvenance("alpha", receipt),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(reserveSandboxInferenceRouteMock).toHaveBeenCalledWith(
      "beta",
      expect.objectContaining({
        hostLocalInferenceReceipt: receipt,
        hostLocalInferenceProvenance: expect.objectContaining({
          runtimeOwnerSandboxName: "alpha",
        }),
      }),
    );
    expect(getSandboxMock("beta")).toBeNull();
    expect(registerSandboxMock).not.toHaveBeenCalled();
  });

  it("releases an exact host-local clone reservation when auto-create rejects", async () => {
    const receipt = serializedLlamaCppHostLocalInferenceReceipt();
    harness.entries.set("alpha", {
      ...sourceEntry(),
      openshellDriver: "docker",
      provider: "llama-cpp-local",
      model: "llama-cpp-model",
      endpointUrl: "https://inference.local/v1",
      endpointSource: "inference-set",
      credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
      preferredInferenceApi: "openai-completions",
      gatewayPort: 8080,
      hostLocalInferenceReceipt: receipt,
      hostLocalInferenceProvenance: createSandboxHostLocalInferenceProvenance("alpha", receipt),
    });
    streamSandboxCreateMock.mockRejectedValue(new Error("injected create rejection"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore", to: "beta" })).rejects.toThrow(
      "injected create rejection",
    );

    expect(reserveSandboxInferenceRouteMock).toHaveBeenCalledWith(
      "beta",
      expect.objectContaining({
        hostLocalInferenceReceipt: receipt,
        hostLocalInferenceProvenance: expect.objectContaining({
          runtimeOwnerSandboxName: "alpha",
        }),
      }),
    );
    expect(getSandboxMock("beta")).toBeNull();
    expect(registerSandboxMock).not.toHaveBeenCalled();
  });

  it("removes a registered clone when live inference re-proof fails", async () => {
    const receipt = managedHostLocalReceipt();
    harness.entries.set("alpha", sourceEntry(receipt));
    harness.preserveForRebuild
      .mockImplementationOnce((value) => value)
      .mockImplementationOnce(() => {
        throw new Error("injected live route failure");
      });
    streamSandboxCreateMock.mockResolvedValue({
      status: 0,
      output: "beta Ready",
      sawProgress: true,
      forcedReady: false,
    });
    const { getLatestBackup } = await import("../../state/sandbox");
    vi.mocked(getLatestBackup).mockReturnValue({
      timestamp: "2026-08-02T00-00-00-000Z",
      backupPath: "/tmp/backup-alpha",
      hostLocalInferenceReceipt: receipt,
    } as ReturnType<typeof getLatestBackup>);
    captureSnapshotRestoreAuthorityMock.mockReturnValue({
      schemaVersion: 1,
      backupPath: "/tmp/backup-alpha",
      contentSha256: "e".repeat(64),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(harness.preserveForRebuild).toHaveBeenCalledTimes(2);
    expect(registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta", hostLocalInferenceReceipt: receipt }),
      undefined,
      { pending: true },
    );
    expect(finalizePendingSandboxRegistrationMock).toHaveBeenCalledWith("beta");
    expect(registerSandboxMock.mock.invocationCallOrder[0]).toBeLessThan(
      finalizePendingSandboxRegistrationMock.mock.invocationCallOrder[0]!,
    );
    expect(finalizePendingSandboxRegistrationMock.mock.invocationCallOrder[0]).toBeLessThan(
      harness.preserveForRebuild.mock.invocationCallOrder[1]!,
    );
    expect(harness.prepareDestroy).toHaveBeenCalledTimes(2);
    expect(harness.destroy).not.toHaveBeenCalled();
    const nimRuntime = await import("../../inference/nim");
    expect(nimRuntime.stopNimContainer).not.toHaveBeenCalled();
    expect(nimRuntime.stopNimContainerByName).not.toHaveBeenCalled();
    expect(removeSandboxRegistryEntryOutcomeMock).toHaveBeenCalledWith("beta");
    expect(getSandboxMock("beta")).toBeNull();
    expect(consoleError.mock.calls.flat().join("\n")).toContain("injected live route failure");
    expect(restoreSandboxStateMock).not.toHaveBeenCalled();
  });
});
