// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { StreamSandboxCreateCommand } from "../../adapters/openshell/sandbox-lifecycle-cli";
import { createSandboxHostLocalInferenceProvenance } from "../../state/registry/host-local-inference";

const harness = vi.hoisted(() => ({
  entries: new Map<string, Record<string, unknown>>(),
  preserveForRebuild: vi.fn((value: unknown) => value),
  prepareDestroy: vi.fn((value: unknown) => value),
  destroy: vi.fn((value: unknown) => ({ status: "removed", receipt: value })),
}));
const parseLiveSandboxNamesMock = vi.hoisted(() => vi.fn(() => new Set(["alpha"])));
function defaultCaptureOpenshell(args: string[]) {
  const selectorIndex = args.indexOf("--selector");
  const selector = args[selectorIndex + 1] ?? "";
  const separatorIndex = selector.indexOf("=");
  return selectorIndex >= 0
    ? {
        status: 0,
        output: JSON.stringify([
          {
            id: "beta-runtime-id",
            name: "beta",
            labels: { [selector.slice(0, separatorIndex)]: selector.slice(separatorIndex + 1) },
            resource_version: 1,
            created_at: "2026-09-22T00:00:00.000Z",
            phase: "Ready",
            current_policy_version: 1,
          },
        ]),
      }
    : {
        status: 0,
        output:
          args[0] === "policy"
            ? "version: 1\nnetwork_policies: {}\n"
            : "alpha Ready\nbeta Ready\nId: beta-runtime-id\n",
      };
}
const captureOpenshellMock = vi.fn(defaultCaptureOpenshell);
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
    options: { pending?: boolean; reservationSessionId?: string } = {},
  ) => {
    const registered = {
      ...entry,
      ...(options.pending === true
        ? {
            pendingRouteReservation: true,
            ...(options.reservationSessionId
              ? { reservationSessionId: options.reservationSessionId }
              : {}),
          }
        : {}),
    };
    harness.entries.set(String(entry.name), registered);
    return registered;
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
const reserveSandboxInferenceRouteMock = vi.fn(
  (name: string, route: Record<string, unknown>, options: { requireAbsent?: boolean } = {}) => {
    const unavailable = options.requireAbsent === true && harness.entries.has(name);
    return unavailable
      ? false
      : Boolean(
          harness.entries.set(name, {
            name,
            pendingRouteReservation: true,
            ...route,
          }),
        );
  },
);
const finalizeSandboxRouteReservationMock = vi.fn((name: string, sessionId: string) => {
  const entry = harness.entries.get(name);
  const owned = entry?.pendingRouteReservation === true && entry.reservationSessionId === sessionId;
  return owned
    ? Boolean(
        harness.entries.set(name, {
          ...entry,
          pendingRouteReservation: undefined,
        }),
      )
    : false;
});
const finalizePendingSandboxRegistrationIfCurrentMock = vi.fn(
  (expected: Record<string, unknown>) => {
    const name = String(expected.name);
    return (
      harness.entries.get(name) === expected &&
      Boolean(
        harness.entries.set(name, {
          ...expected,
          pendingRouteReservation: undefined,
        }),
      )
    );
  },
);
const removeSandboxRouteReservationIfCurrentMock = vi.fn((expected: Record<string, unknown>) => {
  const name = String(expected.name);
  return harness.entries.get(name) === expected ? harness.entries.delete(name) : false;
});
const removeSandboxMock = vi.fn((name: string) => harness.entries.delete(name));
const restoreSandboxStateMock = vi.fn();
const captureSnapshotRestoreAuthorityMock = vi.fn();
const streamSandboxCreateMock = vi.fn<StreamSandboxCreateCommand>(async () => ({
  status: 7,
  output: "spawn failed: injected create failure (ENOENT)",
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

function hostLocalRouteSourceEntry(): Record<string, unknown> {
  const receipt = serializedLlamaCppHostLocalInferenceReceipt();
  return {
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
  runOpenshell: vi.fn((args: string[]) =>
    args.join(" ") === "sandbox get -g nemoclaw beta"
      ? {
          status: 1,
          stdout: "",
          stderr:
            "Error: code: 'Some requested entity was not found', message: \"sandbox not found\"",
        }
      : { status: 0, stdout: "", stderr: "" },
  ),
}));
vi.mock("../../adapters/openshell/sandbox-policy-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/sandbox-policy-cli")>()),
  cliOpenShellSandboxPolicyReader: {
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
  createBuiltInChannelManifestRegistry: vi.fn(() => ({ list: () => [] })),
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
  parseLiveSandboxNames: parseLiveSandboxNamesMock,
}));
vi.mock("../../sandbox/create-stream", () => ({ streamSandboxCreate: streamSandboxCreateMock }));
vi.mock("../../sandbox/mutable-config-perms", () => ({
  repairMutableConfigPerms: vi.fn(() => ({ applied: true, verified: true, errors: [] })),
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
  finalizePendingSandboxRegistrationIfCurrent: finalizePendingSandboxRegistrationIfCurrentMock,
  finalizeSandboxRouteReservation: finalizeSandboxRouteReservationMock,
  registerSandbox: registerSandboxMock,
  reserveSandboxInferenceRoute: reserveSandboxInferenceRouteMock,
  removeSandboxRouteReservationIfCurrent: removeSandboxRouteReservationIfCurrentMock,
  isRouteOnlySandboxReservation: vi.fn(
    (entry: Record<string, unknown>) =>
      entry.pendingRouteReservation === true && entry.createdAt === undefined,
  ),
  removeSandbox: removeSandboxMock,
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
vi.mock("./snapshot/forward-port-allocation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./snapshot/forward-port-allocation")>()),
  allocateSnapshotCloneForwardPorts: vi.fn(async () => ({
    dashboardPort: null,
    hermesApiPort: null,
  })),
}));

describe("snapshot restore auto-create failures", () => {
  beforeAll(async () => {
    // Load the mocked action graph before measuring the individual cleanup operations.
    await import("./snapshot");
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    captureOpenshellMock.mockImplementation(defaultCaptureOpenshell);
    parseLiveSandboxNamesMock.mockImplementation(() => new Set(["alpha"]));
    harness.entries.clear();
    harness.entries.set("alpha", sourceEntry());
    streamSandboxCreateMock.mockResolvedValue({
      status: 7,
      output: "spawn failed: injected create failure (ENOENT)",
      sawProgress: false,
      forcedReady: false,
    });
  });
  afterEach(() => vi.unstubAllEnvs());

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

  it("reconciles one ambiguous create by exact create-attempt identity without retrying", async () => {
    vi.stubEnv("NVIDIA_API_KEY", "must-not-cross-clone-boundary");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    streamSandboxCreateMock.mockResolvedValue({
      status: 1,
      output: "connection lost after submission NVIDIA_API_KEY=must-not-cross-clone-boundary",
      sawProgress: true,
      forcedReady: false,
    });
    restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: [],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).resolves.toBeUndefined();

    expect(streamSandboxCreateMock).toHaveBeenCalledOnce();
    const createArgs = streamSandboxCreateMock.mock.calls[0]?.[1] ?? [];
    const createEnvironment = streamSandboxCreateMock.mock.calls[0]?.[2] ?? {};
    expect(createArgs).toContain("--auto-providers");
    expect(createArgs).toEqual(
      expect.arrayContaining([
        "--label",
        expect.stringMatching(/^ai\.nvidia\.nemoclaw\.create-attempt=[0-9a-f]{62}$/u),
      ]),
    );
    expect(JSON.stringify({ createArgs, createEnvironment })).not.toContain(
      "must-not-cross-clone-boundary",
    );
    expect(registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta" }),
      undefined,
      { pending: true },
    );
    expect(restoreSandboxStateMock).toHaveBeenCalledOnce();
  });

  it("settles incomplete identity metadata after a successful create", async () => {
    let selectorReads = 0;
    captureOpenshellMock.mockImplementation((args: string[]) => {
      const selectorIndex = args.indexOf("--selector");
      const selector = args[selectorIndex + 1] ?? "";
      const separatorIndex = selector.indexOf("=");
      const isSelectorRead = selectorIndex >= 0;
      selectorReads += Number(isSelectorRead);
      return isSelectorRead
        ? {
            status: 0,
            output: JSON.stringify([
              {
                id: "beta-runtime-id",
                name: "beta",
                labels: {
                  [selector.slice(0, separatorIndex)]: selector.slice(separatorIndex + 1),
                },
                ...(selectorReads === 1
                  ? {}
                  : {
                      resource_version: 1,
                      created_at: "2026-09-22T00:00:00.000Z",
                      phase: "Ready",
                      current_policy_version: 1,
                    }),
              },
            ]),
          }
        : {
            status: 0,
            output:
              args[0] === "policy"
                ? "version: 1\nnetwork_policies: {}\n"
                : "alpha Ready\nbeta Ready\nId: beta-runtime-id\n",
          };
    });
    streamSandboxCreateMock.mockResolvedValue({
      status: 0,
      output: "created",
      sawProgress: true,
      forcedReady: true,
    });
    restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: [],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).resolves.toBeUndefined();

    expect(streamSandboxCreateMock).toHaveBeenCalledOnce();
    expect(selectorReads).toBeGreaterThanOrEqual(4);
    expect(registerSandboxMock).toHaveBeenCalledOnce();
    expect(restoreSandboxStateMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["capture", 2],
    ["revalidation", 3],
  ])("retains route authority when clone identity changes during %s", async (_phase, changeAt) => {
    harness.entries.set("alpha", hostLocalRouteSourceEntry());
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    let selectorReads = 0;
    captureOpenshellMock.mockImplementation((args: string[]) => {
      const selectorIndex = args.indexOf("--selector");
      const selector = args[selectorIndex + 1] ?? "";
      const separatorIndex = selector.indexOf("=");
      selectorReads += selectorIndex >= 0 ? 1 : 0;
      return selectorIndex >= 0
        ? {
            status: 0,
            output: JSON.stringify([
              {
                id: selectorReads < changeAt ? "beta-runtime-id" : "beta-replacement-id",
                name: "beta",
                labels: {
                  [selector.slice(0, separatorIndex)]: selector.slice(separatorIndex + 1),
                },
                resource_version: selectorReads,
                created_at: "2026-09-22T00:00:00.000Z",
                phase: "Ready",
                current_policy_version: 1,
              },
            ]),
          }
        : {
            status: 0,
            output:
              args[0] === "policy"
                ? "version: 1\nnetwork_policies: {}\n"
                : "alpha Ready\nbeta Ready\nId: beta-runtime-id\n",
          };
    });
    streamSandboxCreateMock.mockResolvedValue({
      status: 0,
      output: "created",
      sawProgress: true,
      forcedReady: false,
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({
      exitCode: 1,
      lines: expect.arrayContaining([
        expect.stringMatching(/^  Create-attempt label: ai\.nvidia\.nemoclaw\.create-attempt=/u),
      ]),
    });

    expect(streamSandboxCreateMock).toHaveBeenCalledOnce();
    expect(getSandboxMock("beta")).toMatchObject({
      pendingRouteReservation: true,
      reservationSessionId: expect.stringMatching(/^[0-9a-f]{62}$/u),
    });
    expect(registerSandboxMock).not.toHaveBeenCalled();
    expect(restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("retains route authority when a successful create has no exact identity", async () => {
    harness.entries.set("alpha", hostLocalRouteSourceEntry());
    captureOpenshellMock.mockImplementation((args: string[]) => ({
      status: 0,
      output:
        args[0] === "policy"
          ? "version: 1\nnetwork_policies: {}\n"
          : args.includes("--selector")
            ? "malformed selector output"
            : "alpha Ready\nbeta Ready\n",
    }));
    streamSandboxCreateMock.mockResolvedValue({
      status: 0,
      output: "created",
      sawProgress: true,
      forcedReady: true,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({
      exitCode: 1,
      lines: expect.arrayContaining([
        expect.stringMatching(/^  Create-attempt label: ai\.nvidia\.nemoclaw\.create-attempt=/u),
      ]),
    });

    expect(getSandboxMock("beta")).toMatchObject({
      pendingRouteReservation: true,
      reservationSessionId: expect.stringMatching(/^[0-9a-f]{62}$/u),
    });
    expect(registerSandboxMock).not.toHaveBeenCalled();
    expect(restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("keeps waiting when create-attempt identity metadata is pending (#12118)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    captureOpenshellMock.mockImplementation((args: string[]) => {
      const selectorIndex = args.indexOf("--selector");
      const selector = args[selectorIndex + 1] ?? "";
      const separatorIndex = selector.indexOf("=");
      return selectorIndex >= 0
        ? {
            status: 0,
            output: JSON.stringify([
              {
                id: "beta-runtime-id",
                name: "beta",
                labels: {
                  [selector.slice(0, separatorIndex)]: selector.slice(separatorIndex + 1),
                },
              },
            ]),
          }
        : {
            status: 0,
            output:
              args[0] === "policy"
                ? "version: 1\nnetwork_policies: {}\n"
                : "alpha Ready\nbeta Ready\nId: beta-runtime-id\n",
          };
    });
    streamSandboxCreateMock.mockImplementationOnce(async (_command, _args, _env, options) => {
      expect(options.readyCheck?.()).toBe(false);
      return {
        status: 7,
        output: "spawn failed: injected create failure (ENOENT)",
        sawProgress: false,
        forcedReady: false,
      };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

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

  it("retains exact route authority when an ambiguous create cannot be reconciled", async () => {
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
    captureOpenshellMock.mockImplementation((args: string[]) => ({
      status: 0,
      output:
        args[0] === "policy"
          ? "version: 1\nnetwork_policies: {}\n"
          : args.includes("--selector")
            ? "malformed selector output"
            : "alpha Ready\nbeta Ready\nId: beta-runtime-id\n",
    }));
    streamSandboxCreateMock.mockResolvedValue({
      status: 1,
      output: "connection lost after submission",
      sawProgress: true,
      forcedReady: false,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({
      exitCode: 1,
      lines: expect.arrayContaining([
        expect.stringMatching(/^  Create-attempt label: ai\.nvidia\.nemoclaw\.create-attempt=/u),
      ]),
    });

    expect(streamSandboxCreateMock).toHaveBeenCalledOnce();
    expect(getSandboxMock("beta")).toMatchObject({
      pendingRouteReservation: true,
      reservationSessionId: expect.stringMatching(/^[0-9a-f]{62}$/u),
      hostLocalInferenceReceipt: receipt,
    });
    expect(registerSandboxMock).not.toHaveBeenCalled();
    expect(restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("preserves a changed destination row when route publication fails", async () => {
    const source = hostLocalRouteSourceEntry();
    let replacement: Record<string, unknown> | null = null;
    harness.entries.set("alpha", source);
    streamSandboxCreateMock.mockResolvedValue({
      status: 0,
      output: "created",
      sawProgress: true,
      forcedReady: false,
    });
    finalizePendingSandboxRegistrationIfCurrentMock.mockImplementationOnce((expected) => {
      replacement = {
        ...expected,
        lifecycleGeneration: "replacement-generation",
      };
      harness.entries.set("beta", replacement);
      return false;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({
      lines: expect.arrayContaining([
        "Snapshot state was not restored. The current registry row was preserved.",
      ]),
    });

    expect(finalizePendingSandboxRegistrationIfCurrentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        reservationSessionId: expect.stringMatching(/^[0-9a-f]{62}$/u),
      }),
    );
    expect(getSandboxMock("beta")).toEqual(replacement);
    expect(removeSandboxMock).not.toHaveBeenCalled();
    expect(restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("retains a matching clone before absence permits a retry (#12118)", async () => {
    const receipt = serializedLlamaCppHostLocalInferenceReceipt();
    const source = {
      ...sourceEntry(),
      openshellDriver: "docker",
      provider: "llama-cpp-local",
      model: "llama-cpp-model",
      endpointUrl: "https://inference.local/v1",
      endpointSource: "inference-set",
      credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
      preferredInferenceApi: "openai-completions",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      hostLocalInferenceReceipt: receipt,
      hostLocalInferenceProvenance: createSandboxHostLocalInferenceProvenance("alpha", receipt),
    };
    const retainedNonce = "b".repeat(62);
    let createSubmitted = false;
    harness.entries.set("alpha", source);
    harness.entries.set("beta", {
      name: "beta",
      pendingRouteReservation: true,
      reservationSessionId: retainedNonce,
      provider: source.provider,
      model: source.model,
      endpointUrl: source.endpointUrl,
      endpointSource: source.endpointSource,
      credentialEnv: source.credentialEnv,
      preferredInferenceApi: source.preferredInferenceApi,
      gatewayName: source.gatewayName,
      gatewayPort: source.gatewayPort,
      openshellDriver: source.openshellDriver,
      hostLocalInferenceReceipt: source.hostLocalInferenceReceipt,
      hostLocalInferenceProvenance: source.hostLocalInferenceProvenance,
    });
    captureOpenshellMock.mockImplementation((args: string[]) => {
      const selectorIndex = args.indexOf("--selector");
      const selector = args[selectorIndex + 1] ?? "";
      return selector.endsWith(retainedNonce)
        ? defaultCaptureOpenshell(args)
        : {
            status: 0,
            output: args[0] === "policy" ? "version: 1\nnetwork_policies: {}\n" : "alpha Ready\n",
          };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({
      lines: expect.arrayContaining([
        expect.stringContaining("OpenShell still reports a sandbox for the create-attempt label"),
      ]),
    });

    expect(streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(getSandboxMock("beta")).toMatchObject({ reservationSessionId: retainedNonce });

    captureOpenshellMock.mockImplementation((args: string[]) => {
      const selectorIndex = args.indexOf("--selector");
      const selector = args[selectorIndex + 1] ?? "";
      return selector.endsWith(retainedNonce)
        ? { status: 0, output: "[]" }
        : selectorIndex >= 0
          ? defaultCaptureOpenshell(args)
          : {
              status: 0,
              output:
                args[0] === "policy"
                  ? "version: 1\nnetwork_policies: {}\n"
                  : createSubmitted
                    ? "alpha Ready\nbeta Ready\nId: beta-runtime-id\n"
                    : "alpha Ready\n",
            };
    });
    streamSandboxCreateMock.mockImplementationOnce(async () => {
      createSubmitted = true;
      return {
        status: 0,
        output: "created",
        sawProgress: true,
        forcedReady: false,
      };
    });
    restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: [],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).resolves.toBeUndefined();

    expect(removeSandboxRouteReservationIfCurrentMock).toHaveBeenCalledWith(
      expect.objectContaining({ reservationSessionId: retainedNonce }),
    );
    expect(streamSandboxCreateMock).toHaveBeenCalledOnce();
    expect(reserveSandboxInferenceRouteMock).toHaveBeenCalledWith(
      "beta",
      expect.objectContaining({
        reservationSessionId: expect.not.stringMatching(new RegExp(`^${retainedNonce}$`, "u")),
      }),
    );
    expect(finalizePendingSandboxRegistrationIfCurrentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        reservationSessionId: expect.stringMatching(/^[0-9a-f]{62}$/u),
      }),
    );
    expect(restoreSandboxStateMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["a null receipt", null],
    ["a legacy receipt without provenance", managedHostLocalReceipt()],
  ])(
    "retains an ordinary ambiguous clone with %s until label and name are absent",
    async (_receiptState, sourceReceipt) => {
      harness.entries.set("alpha", {
        ...sourceEntry(),
        hostLocalInferenceReceipt: sourceReceipt,
      });
      captureOpenshellMock.mockImplementation((args: string[]) => ({
        status: 0,
        output:
          args[0] === "policy"
            ? "version: 1\nnetwork_policies: {}\n"
            : args.includes("--selector")
              ? "malformed selector output"
              : "alpha Ready\nbeta Ready\n",
      }));
      streamSandboxCreateMock.mockResolvedValue({
        status: 1,
        output: "connection lost after submission",
        sawProgress: true,
        forcedReady: false,
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { runSandboxSnapshot } = await import("./snapshot");

      await expect(
        runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
      ).rejects.toMatchObject({ exitCode: 1 });

      const retainedNonce = String(getSandboxMock("beta")?.reservationSessionId ?? "");
      expect(getSandboxMock("beta")).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: expect.stringMatching(/^[0-9a-f]{62}$/u),
        provider: "vllm-local",
        model: "model-a",
        hostLocalInferenceReceipt: sourceReceipt,
      });
      expect(getSandboxMock("beta")).not.toHaveProperty("hostLocalInferenceProvenance");
      expect(reserveSandboxInferenceRouteMock).toHaveBeenCalledWith(
        "beta",
        expect.objectContaining({ reservationSessionId: retainedNonce }),
        { requireAbsent: true },
      );

      streamSandboxCreateMock.mockClear();
      const runtime = await import("../../adapters/openshell/runtime");
      vi.mocked(runtime.runOpenshell).mockClear();
      captureOpenshellMock.mockImplementation((args: string[]) => {
        const selectorIndex = args.indexOf("--selector");
        const selector = args[selectorIndex + 1] ?? "";
        return selector.endsWith(retainedNonce)
          ? { status: 0, output: "[]" }
          : {
              status: 0,
              output:
                args[0] === "policy"
                  ? "version: 1\nnetwork_policies: {}\n"
                  : "alpha Ready\nbeta Ready\n",
            };
      });
      parseLiveSandboxNamesMock
        .mockReturnValueOnce(new Set(["alpha"]))
        .mockReturnValueOnce(new Set(["alpha", "beta"]));

      await expect(
        runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
      ).rejects.toMatchObject({
        lines: expect.arrayContaining([
          expect.stringContaining("OpenShell still reports the destination name"),
        ]),
      });

      expect(streamSandboxCreateMock).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(runtime.runOpenshell)
          .mock.calls.some(([args]) => args[0] === "sandbox" && args[1] === "delete"),
      ).toBe(false);
      expect(getSandboxMock("beta")).toMatchObject({ reservationSessionId: retainedNonce });

      parseLiveSandboxNamesMock
        .mockImplementation(() => new Set(["alpha"]))
        .mockReturnValueOnce(new Set(["alpha"]))
        .mockReturnValueOnce(new Set(["alpha"]));
      let createSubmitted = false;
      captureOpenshellMock.mockImplementation((args: string[]) => {
        const selectorIndex = args.indexOf("--selector");
        const selector = args[selectorIndex + 1] ?? "";
        return selector.endsWith(retainedNonce)
          ? { status: 0, output: "[]" }
          : selectorIndex >= 0
            ? defaultCaptureOpenshell(args)
            : {
                status: 0,
                output:
                  args[0] === "policy"
                    ? "version: 1\nnetwork_policies: {}\n"
                    : createSubmitted
                      ? "alpha Ready\nbeta Ready\nId: beta-runtime-id\n"
                      : "alpha Ready\n",
              };
      });
      streamSandboxCreateMock.mockImplementationOnce(async () => {
        createSubmitted = true;
        return {
          status: 0,
          output: "created",
          sawProgress: true,
          forcedReady: false,
        };
      });
      restoreSandboxStateMock.mockReturnValue({
        success: true,
        restoredDirs: [],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      });

      await expect(
        runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
      ).resolves.toBeUndefined();

      expect(removeSandboxRouteReservationIfCurrentMock).toHaveBeenCalledWith(
        expect.objectContaining({ reservationSessionId: retainedNonce }),
      );
      expect(streamSandboxCreateMock).toHaveBeenCalledOnce();
      expect(registerSandboxMock).toHaveBeenCalledOnce();
      expect(restoreSandboxStateMock).toHaveBeenCalledOnce();
    },
  );

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
    streamSandboxCreateMock.mockRejectedValue(
      Object.assign(new Error("injected create rejection"), { code: "ENOENT" }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(consoleError.mock.calls.flat().join("\n")).toContain("injected create rejection");
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
    expect(finalizePendingSandboxRegistrationIfCurrentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta" }),
    );
    expect(registerSandboxMock.mock.invocationCallOrder[0]).toBeLessThan(
      finalizePendingSandboxRegistrationIfCurrentMock.mock.invocationCallOrder[0]!,
    );
    expect(
      finalizePendingSandboxRegistrationIfCurrentMock.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.preserveForRebuild.mock.invocationCallOrder[1]!);
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
