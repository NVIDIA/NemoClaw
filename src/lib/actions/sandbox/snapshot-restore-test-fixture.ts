// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import { resolveTestAgentBaselinePolicy } from "../../../../test/support/snapshot-policy-test-fixture";
import type { SyncOpenShellSandboxPolicyReader } from "../../adapters/openshell/sandbox-policy";
import type {
  SandboxEntry,
  SandboxHostLocalInferenceProvenance,
  SandboxWorkloadReceipt,
} from "../../state/registry/types";
import { dcodeProbeOutput } from "./dcode-probe-test-fixture";
import { SANDBOX_EXEC_STARTED_MARKER } from "./sandbox-exec-output";
import type { SnapshotStreamSandboxCreateMock } from "./snapshot-create-stream-test-types";

export type OpenshellCaptureResult = {
  status: number | null;
  output: string;
  stdout?: string;
  stderr?: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
};
export type SandboxRecord = {
  name: string;
  createdAt?: string;
  pendingRouteReservation?: true;
  reservationSessionId?: string;
  agent?: string | null;
  fromDockerfile?: string | null;
  gatewayName?: string | null;
  gatewayPort?: number | null;
  imageTag?: string | null;
  workload?: SandboxWorkloadReceipt;
  openshellDriver?: string | null;
  observabilityEnabled?: boolean;
  provider?: string | null;
  model?: string | null;
  endpointUrl?: string | null;
  endpointSource?: SandboxEntry["endpointSource"];
  credentialEnv?: string | null;
  preferredInferenceApi?: string | null;
  lifecycleGeneration?: string;
  lifecycleLiveIdentityFingerprint?: string;
  hostLocalInferenceReceipt?: string | null;
  hostLocalInferenceProvenance?: SandboxHostLocalInferenceProvenance;
  dashboardPort?: number | null;
  hermesDashboardEnabled?: boolean;
  hermesDashboardPort?: number | null;
  hermesDashboardInternalPort?: number | null;
  hermesDashboardTui?: boolean;
};
export { type DcodeProbeState, dcodeProbeOutput } from "./dcode-probe-test-fixture";

export function captureOpenshellStreams(
  args: string[],
  result: OpenshellCaptureResult,
): OpenshellCaptureResult {
  const command = String(args.at(-1) ?? "");
  const marker = command.match(/printf '%s\\n' '([^']+)'/)?.[1] ?? SANDBOX_EXEC_STARTED_MARKER;
  const replaceMarker = (value: string) => value.replaceAll(SANDBOX_EXEC_STARTED_MARKER, marker);
  const stdout = replaceMarker(result.stdout ?? result.output);
  const stderr = replaceMarker(result.stderr ?? "");
  return { ...result, output: stdout, stdout, stderr };
}

export function openshellResponses(
  args: string[],
  responses: Record<string, OpenshellCaptureResult>,
): OpenshellCaptureResult {
  const command = `${args[0] ?? ""} ${args[1] ?? ""}`;
  const sandboxName = String(args.at(-1) ?? "sandbox");
  const result =
    responses[command] ??
    (command === "policy get"
      ? { status: 0, output: "version: 1\nnetwork_policies: {}\n" }
      : command === "sandbox get"
        ? {
            status: 0,
            output: `Name: ${sandboxName}\nId: ${sandboxName}-live-id\nPhase: Ready\n`,
          }
        : {
            status: 0,
            output: "",
          });
  return captureOpenshellStreams(args, result);
}

export function defaultOpenshellResponses(args: string[]): OpenshellCaptureResult {
  return openshellResponses(args, {
    "policy get": { status: 0, output: "version: 1\nnetwork_policies: {}\n" },
    "sandbox exec": { status: 0, output: dcodeProbeOutput("no-runtime") },
    "sandbox list": {
      status: 0,
      output: "alpha Ready\n",
    },
  });
}

const shieldsMock = vi.hoisted(() => {
  const isShieldsDownMock = vi.fn(() => true);
  const repairMutableConfigPermsMock = vi.fn(() => ({
    applied: true,
    verified: true,
    errors: [],
  }));
  const recoverCompletedAutoRestoreBeforeCommandMock = vi.fn(() => false);
  const shieldsUpMock = vi.fn();
  let isShieldsDownExport: unknown = isShieldsDownMock;
  return {
    isShieldsDownMock,
    repairMutableConfigPermsMock,
    recoverCompletedAutoRestoreBeforeCommandMock,
    shieldsUpMock,
    getIsShieldsDownExport: () => isShieldsDownExport,
    setIsShieldsDownExport: (value: unknown) => {
      isShieldsDownExport = value;
    },
  };
});

const lifecycleMock = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    cleanupShieldsDestroyArtifactsMock: vi.fn(() => events.push("cleanup-shields")),
    readTimerMarkerMock: vi.fn(() => null as Record<string, unknown> | null),
    withTimerBoundMock: vi.fn(
      (_sandboxName: string, command: string, fn: () => unknown): unknown => {
        events.push(`lock:${command}`);
        return fn();
      },
    ),
  };
});

export const backupSandboxStateMock = vi.fn();
export const assertHermesPortableCommandUnavailableMock = vi.fn();
export const captureSnapshotRestoreAuthorityMock = vi.fn(() => ({
  schemaVersion: 1 as const,
  backupPath: "/tmp/backup-alpha",
  contentSha256: "a".repeat(64),
}));
export const loadAgentMock = vi.fn((name: string) => ({
  name,
  policyAdditionsPath: name === "openclaw" ? null : `/repo/agents/${name}/policy-additions.yaml`,
}));
export const captureOpenshellMock = vi.fn<
  (args: string[], opts?: Record<string, unknown>) => OpenshellCaptureResult
>((args) => defaultOpenshellResponses(args));
export const readSandboxPolicyMock = vi.fn<SyncOpenShellSandboxPolicyReader["readSandboxPolicy"]>(
  () => ({
    ok: true,
    value: {
      document: "version: 1\nnetwork_policies: {}\n",
      appliedRevision: null,
    },
  }),
);
export const dockerInspectMock = vi.fn(() => ({ status: 0, stdout: "true\n" }));
export const establishRestoredSandboxGatewayPairingMock = vi.fn();
export const findBackupMock = vi.fn();
export const getAppliedPresetsMock = vi.fn(() => [] as string[]);
export const getLatestBackupMock = vi.fn(() => null as Record<string, unknown> | null);
export const applyPresetMock = vi.fn((_sandbox: string, _preset: string) => true);
export const applyPresetContentMock = vi.fn(
  (_sandbox: string, _name: string, _content: string, _options?: unknown) => true,
);
export const removePresetMock = vi.fn((_sandbox: string, _preset: string) => true);
export const getPresetContentGatewayStateMock = vi.fn<
  (_sandbox: string, _content: string, _policyKey?: string) => "match" | "absent" | "drift" | null
>(() => "absent");
export const resolveAgentBaselinePolicyMock = vi.fn(resolveTestAgentBaselinePolicy);
export const builtinObservabilityPolicy =
  "network_policies:\n  observability-otlp-local:\n    endpoints:\n      - host: host.openshell.internal\n";
export const loadPresetForSandboxMock = vi.fn((_sandbox: string, preset: string) =>
  preset === "observability-otlp-local" ? builtinObservabilityPolicy : null,
);
export const getSandboxMock = vi.fn<(name?: string) => SandboxRecord | null>(() => null);
export const isGatewayHealthyMock = vi.fn(() => true);
export const listBackupsMock = vi.fn<() => Array<Record<string, unknown>>>(() => []);
export const stopNimContainerMock = vi.fn();
export const stopNimContainerByNameMock = vi.fn();
export const parseLiveSandboxNamesMock = vi.fn((_output: string) => new Set(["alpha"]));
export const waitForRestoredSandboxGatewaySupervisorMock = vi.fn(() => true);
export const prepareInitialSandboxCreatePolicyMock = vi.fn(
  (
    policyPath: string,
  ): { policyPath: string; appliedPresets: string[]; cleanup?: () => boolean } => ({
    policyPath,
    appliedPresets: [],
  }),
);
export const registerSandboxMock = vi.fn();
export const reserveSandboxInferenceRouteMock = vi.fn(() => true);
export const removeSandboxMock = vi.fn();
export const updateSandboxMock = vi.fn();
export const finalizePendingSandboxRegistrationMock = vi.fn();
export const restoreSandboxStateMock = vi.fn();
export const removeSandboxRegistryEntryOutcomeMock = vi.fn<
  (
    name: string,
  ) =>
    | { status: "complete"; removed: true }
    | { status: "blocked"; reason: "authority-unproven"; removed: false }
>(() => ({ status: "complete", removed: true }));
export const runOpenshellMock = vi.fn((args: string[]) => {
  args[0] === "sandbox" && args[1] === "delete" && lifecycleMock.events.push("delete");
  return { status: 0, output: "" };
});
export const streamSandboxCreateMock = vi.fn<SnapshotStreamSandboxCreateMock>(async () => ({
  status: 0,
  output: "",
  sawProgress: false,
  forcedReady: false,
}));
export const latestBackupFixture = {
  timestamp: "2026-06-15T00:00:00.000Z",
  backupPath: "/tmp/backup-alpha",
};

export { lifecycleMock, shieldsMock };

vi.mock("../../adapters/docker", () => ({
  dockerCapture: vi.fn(() => ""),
  dockerForceRm: vi.fn(),
  dockerInspect: dockerInspectMock,
  dockerRunDetached: vi.fn(),
}));

vi.mock("../../agent/defs", () => ({
  loadAgent: loadAgentMock,
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: captureOpenshellMock,
  getOpenshellBinary: vi.fn(() => "openshell"),
  runOpenshell: runOpenshellMock,
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

vi.mock("../../inference/nim", () => ({
  stopNimContainer: stopNimContainerMock,
  stopNimContainerByName: stopNimContainerByNameMock,
}));

vi.mock("../../policy", () => ({
  applyPreset: applyPresetMock,
  applyPresetContent: applyPresetContentMock,
  getAppliedPresets: getAppliedPresetsMock,
  getPresetContentGatewayState: getPresetContentGatewayStateMock,
  loadPresetForSandbox: loadPresetForSandboxMock,
  parseCurrentPolicy: (raw: unknown) => String(raw),
  removePreset: removePresetMock,
  resolveAgentBaselinePolicy: resolveAgentBaselinePolicyMock,
}));

vi.mock("../../runner", () => ({
  ROOT: "/repo",
  run: vi.fn(() => ({ status: 0 })),
  shellQuote: (value: string) => `'${value}'`,
  validateName: vi.fn((value: string) => value),
}));

vi.mock("../../onboard/experimental/portable-agent-lifecycle", async (importOriginal) => ({
  ...(await importOriginal()),
  assertHermesPortableCommandUnavailable: assertHermesPortableCommandUnavailableMock,
}));

vi.mock("../../runtime-recovery", () => ({
  parseLiveSandboxNames: parseLiveSandboxNamesMock,
}));

vi.mock("../../onboard/initial-policy", () => ({
  prepareInitialSandboxCreatePolicy: prepareInitialSandboxCreatePolicyMock,
}));

vi.mock("../../shields", () => ({
  get isShieldsDown() {
    return shieldsMock.getIsShieldsDownExport();
  },
  repairMutableConfigPerms: shieldsMock.repairMutableConfigPermsMock,
  recoverCompletedAutoRestoreBeforeCommand:
    shieldsMock.recoverCompletedAutoRestoreBeforeCommandMock,
  shieldsUp: shieldsMock.shieldsUpMock,
}));

vi.mock("../../shields/timer-bound-lock", () => ({
  withTimerBoundShieldsMutationLock: lifecycleMock.withTimerBoundMock,
}));

vi.mock("../../shields/timer-control", () => ({
  isProcessAlive: vi.fn(() => true),
  readProcessStartIdentity: vi.fn(() => "snapshot-test-process-start"),
  readTimerMarker: lifecycleMock.readTimerMarkerMock,
}));

vi.mock("../../sandbox/create-stream", () => ({
  streamSandboxCreate: streamSandboxCreateMock,
}));

vi.mock("../../state/gateway", () => ({
  isGatewayHealthy: isGatewayHealthyMock,
  isSandboxReady: vi.fn((output: string, sandboxName: string) =>
    output.includes(`${sandboxName} Ready`),
  ),
}));

vi.mock("../../state/registry", () => ({
  getConfiguredMessagingChannelsFromEntry: vi.fn(() => []),
  getDisabledMessagingChannelsFromEntry: vi.fn(() => []),
  getSandbox: getSandboxMock,
  isRouteOnlySandboxReservation: (entry: SandboxRecord) =>
    entry.pendingRouteReservation === true && entry.createdAt === undefined,
  listSandboxes: () => ({
    sandboxes: ["alpha", "beta", "gamma"].map((name) => getSandboxMock(name)).filter(Boolean),
    defaultSandbox: "alpha",
  }),
  registerSandbox: registerSandboxMock,
  reserveSandboxInferenceRoute: reserveSandboxInferenceRouteMock,
  removeSandbox: removeSandboxMock,
  updateSandbox: updateSandboxMock,
  finalizePendingSandboxRegistration: finalizePendingSandboxRegistrationMock,
}));

vi.mock("../../state/sandbox", () => ({
  backupSandboxState: backupSandboxStateMock,
  captureSnapshotRestoreAuthority: captureSnapshotRestoreAuthorityMock,
  findBackup: findBackupMock,
  getLatestBackup: getLatestBackupMock,
  listBackups: listBackupsMock,
  restoreSandboxState: restoreSandboxStateMock,
}));

vi.mock("./destroy", async () => {
  const runtimeProviders = await vi.importActual<
    typeof import("../../onboard/runtime-provider/access")
  >("../../onboard/runtime-provider/access");
  return {
    cleanupShieldsDestroyArtifacts: lifecycleMock.cleanupShieldsDestroyArtifactsMock,
    removeSandboxRegistryEntry: vi.fn(() => true),
    removeSandboxRegistryEntryOutcome: removeSandboxRegistryEntryOutcomeMock,
    requireSandboxDestructiveCleanupAuthority: (sandboxName: string, sandbox: SandboxRecord) =>
      runtimeProviders.requireRuntimeProviderDestructiveCleanupAuthority(
        sandboxName,
        sandbox,
        runtimeProviders.CURRENT_RUNTIME_PROVIDER_BUNDLES,
      ),
  };
});

vi.mock("./restore-gateway-pairing", () => ({
  establishRestoredSandboxGatewayPairing: establishRestoredSandboxGatewayPairingMock,
  waitForRestoredSandboxGatewaySupervisor: waitForRestoredSandboxGatewaySupervisorMock,
}));

export function resetSnapshotRestoreMocks(): void {
  vi.clearAllMocks();
  assertHermesPortableCommandUnavailableMock.mockReset();
  captureSnapshotRestoreAuthorityMock.mockReturnValue({
    schemaVersion: 1,
    backupPath: "/tmp/backup-alpha",
    contentSha256: "a".repeat(64),
  });
  shieldsMock.setIsShieldsDownExport(shieldsMock.isShieldsDownMock);
  shieldsMock.isShieldsDownMock.mockReturnValue(true);
  shieldsMock.recoverCompletedAutoRestoreBeforeCommandMock.mockReturnValue(false);
  shieldsMock.shieldsUpMock.mockImplementation(() => lifecycleMock.events.push("harden"));
  lifecycleMock.events.length = 0;
  lifecycleMock.readTimerMarkerMock.mockReturnValue(null);
  captureOpenshellMock.mockImplementation((args) => defaultOpenshellResponses(args));
  readSandboxPolicyMock.mockReturnValue({
    ok: true,
    value: {
      document: "version: 1\nnetwork_policies: {}\n",
      appliedRevision: null,
    },
  });
  dockerInspectMock.mockReturnValue({ status: 0, stdout: "true\n" });
  establishRestoredSandboxGatewayPairingMock.mockReset();
  findBackupMock.mockReturnValue({ match: null });
  getAppliedPresetsMock.mockReturnValue([]);
  getLatestBackupMock.mockReturnValue(null);
  applyPresetMock.mockReturnValue(true);
  applyPresetContentMock.mockReturnValue(true);
  removePresetMock.mockReturnValue(true);
  getPresetContentGatewayStateMock.mockReturnValue("absent");
  loadPresetForSandboxMock.mockImplementation((_sandbox, preset) =>
    preset === "observability-otlp-local" ? builtinObservabilityPolicy : null,
  );
  getSandboxMock.mockReturnValue(null);
  isGatewayHealthyMock.mockReturnValue(true);
  listBackupsMock.mockReturnValue([]);
  loadAgentMock.mockImplementation((name: string) => ({
    name,
    policyAdditionsPath: name === "openclaw" ? null : `/repo/agents/${name}/policy-additions.yaml`,
  }));
  resolveAgentBaselinePolicyMock.mockImplementation(resolveTestAgentBaselinePolicy);
  prepareInitialSandboxCreatePolicyMock.mockImplementation((policyPath: string) => ({
    policyPath,
    appliedPresets: [],
  }));
  registerSandboxMock.mockReset();
  reserveSandboxInferenceRouteMock.mockReset().mockReturnValue(true);
  removeSandboxMock.mockReset();
  removeSandboxRegistryEntryOutcomeMock.mockReturnValue({ status: "complete", removed: true });
  updateSandboxMock.mockReset().mockReturnValue(true);
  finalizePendingSandboxRegistrationMock.mockReset().mockReturnValue(true);
  restoreSandboxStateMock.mockReturnValue({
    success: true,
    restoredDirs: [],
    restoredFiles: [],
    failedDirs: [],
    failedFiles: [],
  });
  streamSandboxCreateMock.mockImplementation(async () => ({
    status: 0,
    output: "",
    sawProgress: false,
    forcedReady: false,
  }));
  waitForRestoredSandboxGatewaySupervisorMock.mockReturnValue(true);
  parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
}

export function cleanupSnapshotRestoreMocks(): void {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
}
