// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type {
  ManagedBootstrapAdapter,
  ManagedBootstrapSequenceInput,
  ManagedBootstrapSequenceResult,
} from "../../onboard/managed-bootstrap/adapter";
import { MANAGED_STARTUP_HOLD_EXECUTABLE } from "../../onboard/managed-startup/hold";
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
  agent?: string | null;
  baselineExclusionTransition?: {
    id: string;
    operation: "exclude" | "restore";
    exclusion: {
      version: 1;
      agent: string;
      key: string;
      digest: string;
      acknowledgedAt?: string;
      appliedAgentVersion?: string | null;
    };
    startedAt: string;
    targetLiveDigest: string | null;
  };
  baselineExclusions?: Array<{
    version: 1;
    agent: string;
    key: string;
    digest: string;
    acknowledgedAt?: string;
    appliedAgentVersion?: string | null;
  }>;
  fromDockerfile?: string | null;
  gatewayName?: string | null;
  imageTag?: string | null;
  openshellDriver?: string | null;
  observabilityEnabled?: boolean;
  provider?: string | null;
  model?: string | null;
  dashboardPort?: number | null;
  hermesDashboardEnabled?: boolean;
  hermesDashboardPort?: number | null;
  hermesDashboardInternalPort?: number | null;
  hermesDashboardTui?: boolean;
};
export type DcodeProbeState = "active" | "idle" | "unverifiable" | "no-runtime";

export function dcodeProbeOutput(state: DcodeProbeState, extra = ""): string {
  return `${SANDBOX_EXEC_STARTED_MARKER}\nNEMOCLAW_DCODE_PROBE=${state}\n${extra}`;
}

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
  const result =
    responses[`${args[0] ?? ""} ${args[1] ?? ""}`] ??
    (args[0] === "sandbox" && args[1] === "get"
      ? {
          status: 0,
          output: `ID: sandbox-${args[2] ?? "fixture"}\n`,
        }
      : {
          status: 0,
          output: "",
        });
  return captureOpenshellStreams(args, result);
}

export function defaultOpenshellResponses(args: string[]): OpenshellCaptureResult {
  return openshellResponses(args, {
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
  const shieldsUpMock = vi.fn();
  let isShieldsDownExport: unknown = isShieldsDownMock;
  return {
    isShieldsDownMock,
    repairMutableConfigPermsMock,
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

const managedCloneCredentialMock = vi.hoisted(() => ({
  runDeviceCodeFlow: vi.fn(async (): Promise<never> => {
    throw new Error("production device-code OAuth is disabled in snapshot lifecycle tests");
  }),
  bindBrokerState: vi.fn(() => ({
    file: "/test-only/hermes-tool-gateway-state.json",
    brokerToken: "test-only-broker-token",
  })),
  stageBrokerState: vi.fn(() => ({
    activationToken: "nc_activate_test-only",
    brokerToken: "nc_broker_test-only",
  })),
  activateBrokerState: vi.fn(() => ({
    file: "/test-only/hermes-tool-gateway-state.json",
    brokerToken: "nc_broker_test-only",
  })),
  discardBrokerState: vi.fn(() => true),
  removeBrokerState: vi.fn(() => true),
  preflightBrokerState: vi.fn(),
}));

export const runDeviceCodeFlowMock = managedCloneCredentialMock.runDeviceCodeFlow;
export const bindHermesToolGatewayCloneProviderStateMock =
  managedCloneCredentialMock.bindBrokerState;
export const stageHermesToolGatewayCloneBindingMock = managedCloneCredentialMock.stageBrokerState;
export const activateHermesToolGatewayCloneBindingMock =
  managedCloneCredentialMock.activateBrokerState;
export const discardHermesToolGatewayCloneBindingMock =
  managedCloneCredentialMock.discardBrokerState;
export const removeHermesToolGatewayProviderStateMock =
  managedCloneCredentialMock.removeBrokerState;
export const preflightHermesToolGatewayCloneBindingMock =
  managedCloneCredentialMock.preflightBrokerState;

export const backupSandboxStateMock = vi.fn();
export const loadAgentMock = vi.fn((name: string) => ({
  name,
  policyAdditionsPath: name === "openclaw" ? null : `/repo/agents/${name}/policy-additions.yaml`,
}));
export const captureOpenshellMock = vi.fn<
  (args: string[], opts?: Record<string, unknown>) => OpenshellCaptureResult
>((args) => defaultOpenshellResponses(args));
export const dockerInspectMock = vi.fn(() => ({ status: 0, stdout: "true\n" }));
export const establishRestoredSandboxGatewayPairingMock = vi.fn();
export const findBackupMock = vi.fn();
export const getAppliedPresetsMock = vi.fn(() => [] as string[]);
export const getCustomPoliciesMock = vi.fn(
  () => [] as Array<{ name: string; content: string; sourcePath?: string }>,
);
export const getLatestBackupMock = vi.fn(() => null as Record<string, unknown> | null);
export const applyPresetMock = vi.fn((_sandbox: string, _preset: string) => true);
export const applyPresetContentMock = vi.fn(
  (_sandbox: string, _name: string, _content: string, _options?: unknown) => true,
);
export const removePresetMock = vi.fn((_sandbox: string, _preset: string) => true);
export const getPresetContentGatewayStateMock = vi.fn<
  (_sandbox: string, _content: string, _policyKey?: string) => "match" | "absent" | "drift" | null
>(() => "absent");
export const resolveAgentBaselinePolicyMock = vi.fn((agent: string) => ({
  agent,
  policyPath:
    agent === "openclaw"
      ? "/repo/nemoclaw-blueprint/policies/openclaw-sandbox.yaml"
      : `/repo/agents/${agent}/policy-additions.yaml`,
  content: "version: 1\nnetwork_policies: {}\n",
}));
export const builtinObservabilityPolicy =
  "network_policies:\n  observability-otlp-local:\n    endpoints:\n      - host: host.openshell.internal\n";
export const loadPresetForSandboxMock = vi.fn((_sandbox: string, preset: string) =>
  preset === "observability-otlp-local" ? builtinObservabilityPolicy : null,
);
export const getSandboxMock = vi.fn<(name?: string) => SandboxRecord | null>(() => null);
export const isGatewayHealthyMock = vi.fn(() => true);
export const listBackupsMock = vi.fn<() => Array<Record<string, unknown>>>(() => []);
export const parseLiveSandboxNamesMock = vi.fn(() => new Set(["alpha"]));
export const prepareInitialSandboxCreatePolicyMock = vi.fn(
  (
    policyPath: string,
  ): { policyPath: string; appliedPresets: string[]; cleanup?: () => boolean } => ({
    policyPath,
    appliedPresets: [],
  }),
);
export const registerSandboxMock = vi.fn();
export const updateSandboxMock = vi.fn();
export const restoreSandboxStateMock = vi.fn();
export const runOpenshellMock = vi.fn((args: string[], _opts?: Record<string, unknown>) => {
  args[0] === "sandbox" && args[1] === "delete" && lifecycleMock.events.push("delete");
  return { status: 0, output: "" };
});
export const streamSandboxCreateMock = vi.fn<SnapshotStreamSandboxCreateMock>(async () => ({
  status: 0,
  output: "",
  sawProgress: false,
  forcedReady: false,
}));
function managedStartupPatchFixture() {
  let cutover:
    | {
        rollback(): Promise<void>;
        commit(): Promise<void>;
      }
    | undefined;
  return {
    maybeApplyDuringCreate: vi.fn(),
    createFailureMessage: vi.fn(() => null),
    exitOnPatchError: vi.fn(async () => {}),
    attachManagedBootstrapCutover: vi.fn((value) => {
      cutover = value;
    }),
    rollbackManagedStartupAfterCreateFailure: vi.fn(async () => cutover?.rollback()),
    ensureApplied: vi.fn(async () => {}),
    waitForSupervisorReconnectIfNeeded: vi.fn(),
    commitAfterReady: vi.fn(async () => cutover?.commit()),
    selectedMode: vi.fn(() => null),
    printReadinessFailureIfEnabled: vi.fn(),
    verifyGpuOrExit: vi.fn(async (verifyDirectSandboxGpu: (sandboxName: string) => unknown) =>
      verifyDirectSandboxGpu("beta"),
    ),
  };
}
export const createDockerGpuSandboxCreatePatchMock = vi.fn((_options?: unknown) =>
  managedStartupPatchFixture(),
);
let managedBootstrapSequenceFailure: Error | null = null;
export const managedBootstrapFinalizeMock = vi.fn(
  async (
    input: Parameters<ManagedBootstrapAdapter["finalizeBootstrap"]>[0],
  ): Promise<Awaited<ReturnType<ManagedBootstrapAdapter["finalizeBootstrap"]>>> => ({
    schemaVersion: 1,
    sandbox: input.handle.sandbox,
    bootstrapIdentity: input.handle.bootstrapIdentity,
    outcome: input.outcome === "commit" ? "committed" : "rolled-back",
    restoredRuntimeId: input.outcome === "rollback" ? (input.snapshot?.runtimeId ?? null) : null,
    restoredSpecHash: input.outcome === "rollback" ? (input.snapshot?.specHash ?? null) : null,
    heldWorkloadRemoved: input.snapshot === null,
    alreadyRolledBack: false,
    finalizedAt: "2026-06-15T00:00:00.000Z",
  }),
);
export const createDockerManagedBootstrapAdapterMock = vi.fn(
  () =>
    ({
      finalizeBootstrap: managedBootstrapFinalizeMock,
    }) as unknown as ManagedBootstrapAdapter,
);

export async function simulateManagedBootstrapSequence(
  _adapter: ManagedBootstrapAdapter,
  input: ManagedBootstrapSequenceInput,
): Promise<ManagedBootstrapSequenceResult> {
  const bootstrapIdentity = input.create.bootstrapIdentity ?? "c".repeat(64);
  const executableIndex = input.create.plan.intendedWorkloadArgv.findIndex(
    (value, index) => index > 0 && !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(value),
  );
  if (executableIndex < 1) {
    throw new Error("snapshot fixture managed bootstrap intended workload is malformed");
  }
  const heldWorkloadArgv = [
    ...input.create.plan.intendedWorkloadArgv.slice(0, executableIndex),
    MANAGED_STARTUP_HOLD_EXECUTABLE,
    "--agent",
    input.request.agent,
    "--profile-fingerprint",
    input.request.profileFingerprint,
    "--bootstrap-identity",
    bootstrapIdentity,
  ];
  const createReceipt = await input.create.launch({
    heldWorkloadArgv,
    bootstrapIdentity,
  });
  if (managedBootstrapSequenceFailure) throw managedBootstrapSequenceFailure;
  const originalRuntimeId = "a".repeat(64);
  const replacementRuntimeId = "b".repeat(64);
  const runtimeImageContentId = `sha256:${"d".repeat(64)}`;
  const specHash = "e".repeat(64);
  const replacementSpecHash = "f".repeat(64);
  const handle = {
    schemaVersion: 1 as const,
    sandbox: createReceipt.sandbox,
    bootstrapIdentity,
    heldWorkloadArgv,
    intendedWorkloadArgv: input.create.plan.intendedWorkloadArgv,
    plan: input.create.plan,
    createReceipt,
  };
  const snapshot = {
    schemaVersion: 1 as const,
    sandbox: createReceipt.sandbox,
    runtimeId: originalRuntimeId,
    bootstrapIdentity,
    image: input.create.plan.image,
    runtimeImageContentId,
    specHash,
    specCanonicalJson: "{}",
    agentIdentity: input.create.plan.agentIdentity,
    supervisorArgv: input.create.plan.expectedSupervisorArgv,
    heldWorkloadArgv,
    metadata: input.create.plan.metadata,
  };
  const replacement = {
    schemaVersion: 1 as const,
    sandbox: createReceipt.sandbox,
    bootstrapIdentity,
    originalRuntimeId,
    replacementRuntimeId,
    image: input.create.plan.image,
    runtimeImageContentId,
    originalSpecHash: specHash,
    replacementSpecHash,
    profileFingerprint: input.request.profileFingerprint,
  };
  const completion = {
    schemaVersion: 1 as const,
    sandbox: createReceipt.sandbox,
    runtimeId: replacementRuntimeId,
    image: input.create.plan.image,
    runtimeImageContentId,
    originalSpecHash: specHash,
    replacementSpecHash,
    profileFingerprint: input.request.profileFingerprint,
    bootstrapIdentity,
    transactionPending: false,
    completedAt: "2026-06-15T00:00:00.000Z",
  };
  return { handle, snapshot, replacement, completion };
}

export const runManagedBootstrapSequenceMock = vi.fn(simulateManagedBootstrapSequence);

export function setManagedBootstrapSequenceFailure(error: Error | null): void {
  managedBootstrapSequenceFailure = error;
}
export const latestBackupFixture = {
  timestamp: "2026-06-15T00:00:00.000Z",
  backupPath: "/tmp/backup-alpha",
};

export { lifecycleMock, shieldsMock };

vi.mock("../../adapters/docker", () => ({
  dockerCapture: vi.fn(() => ""),
  dockerForceRm: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
  dockerInspect: dockerInspectMock,
  dockerRunDetached: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
}));

vi.mock("../../onboard/managed-bootstrap/adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../onboard/managed-bootstrap/adapter")>();
  return {
    ...actual,
    runManagedBootstrapSequence: runManagedBootstrapSequenceMock,
  };
});

vi.mock("../../onboard/managed-bootstrap/docker", () => ({
  createDockerManagedBootstrapAdapter: createDockerManagedBootstrapAdapterMock,
}));

vi.mock("../../onboard/docker-gpu-sandbox-create", () => ({
  createDockerGpuSandboxCreatePatch: createDockerGpuSandboxCreatePatchMock,
}));

vi.mock("../../agent/defs", () => ({
  loadAgent: loadAgentMock,
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: captureOpenshellMock,
  getOpenshellBinary: vi.fn(() => "openshell"),
  runOpenshell: runOpenshellMock,
}));

vi.mock("../../credentials/store", () => ({
  getCredential: vi.fn(),
  prompt: vi.fn(),
  saveCredential: vi.fn(),
}));

vi.mock("../../domain/sandbox/destroy", () => ({
  getSandboxDeleteOutcome: vi.fn(() => ({ alreadyGone: false, gatewayUnreachable: false })),
}));

vi.mock("../../inference/nim", () => ({
  stopNimContainer: vi.fn(),
  stopNimContainerByName: vi.fn(),
}));
vi.mock("../../oauth-device-code", () => ({
  runDeviceCodeFlow: managedCloneCredentialMock.runDeviceCodeFlow,
}));
vi.mock("../../hermes-tool-gateway-clone-broker", () => ({
  getHermesToolGatewayCloneBroker: () => ({
    HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV: "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN",
    getHermesInferenceProviderName: (sandboxName: string) => `${sandboxName}-hermes-inference`,
    getHermesToolGatewayProviderName: (sandboxName: string) => `${sandboxName}-hermes-tool-gateway`,
    preflightHermesToolGatewayCloneBinding: managedCloneCredentialMock.preflightBrokerState,
    stageHermesToolGatewayCloneBinding: managedCloneCredentialMock.stageBrokerState,
    activateHermesToolGatewayCloneBinding: managedCloneCredentialMock.activateBrokerState,
    discardHermesToolGatewayCloneBinding: managedCloneCredentialMock.discardBrokerState,
    bindHermesToolGatewayCloneProviderState: managedCloneCredentialMock.bindBrokerState,
    removeHermesToolGatewayProviderState: managedCloneCredentialMock.removeBrokerState,
  }),
}));

vi.mock("../../policy", () => ({
  applyPreset: applyPresetMock,
  applyPresetContent: applyPresetContentMock,
  getAppliedPresets: getAppliedPresetsMock,
  getPresetContentGatewayState: getPresetContentGatewayStateMock,
  loadPresetForSandbox: loadPresetForSandboxMock,
  removePreset: removePresetMock,
  resolveAgentBaselinePolicy: resolveAgentBaselinePolicyMock,
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

vi.mock("../../onboard/initial-policy", () => ({
  prepareInitialSandboxCreatePolicy: prepareInitialSandboxCreatePolicyMock,
}));

vi.mock("../../shields", () => ({
  get isShieldsDown() {
    return shieldsMock.getIsShieldsDownExport();
  },
  repairMutableConfigPerms: shieldsMock.repairMutableConfigPermsMock,
  shieldsUp: shieldsMock.shieldsUpMock,
}));

vi.mock("../../shields/timer-bound-lock", () => ({
  withTimerBoundShieldsMutationLock: lifecycleMock.withTimerBoundMock,
}));

vi.mock("../../shields/timer-control", () => ({
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
  getCustomPolicies: getCustomPoliciesMock,
  getDisabledMessagingChannelsFromEntry: vi.fn(() => []),
  getSandbox: getSandboxMock,
  listSandboxes: () => ({
    sandboxes: ["alpha", "beta", "gamma"].map((name) => getSandboxMock(name)).filter(Boolean),
    defaultSandbox: "alpha",
  }),
  registerSandbox: registerSandboxMock,
  removeSandbox: vi.fn(),
  updateSandbox: updateSandboxMock,
}));

vi.mock("../../state/sandbox", () => ({
  backupSandboxState: backupSandboxStateMock,
  findBackup: findBackupMock,
  getLatestBackup: getLatestBackupMock,
  listBackups: listBackupsMock,
  restoreSandboxState: restoreSandboxStateMock,
}));

vi.mock("./destroy", () => ({
  cleanupShieldsDestroyArtifacts: lifecycleMock.cleanupShieldsDestroyArtifactsMock,
  removeSandboxRegistryEntry: vi.fn(),
}));

vi.mock("./restore-gateway-pairing", () => ({
  establishRestoredSandboxGatewayPairing: establishRestoredSandboxGatewayPairingMock,
}));

export function resetSnapshotRestoreMocks(): void {
  vi.clearAllMocks();
  managedBootstrapSequenceFailure = null;
  runManagedBootstrapSequenceMock.mockImplementation(simulateManagedBootstrapSequence);
  shieldsMock.setIsShieldsDownExport(shieldsMock.isShieldsDownMock);
  shieldsMock.isShieldsDownMock.mockReturnValue(true);
  shieldsMock.shieldsUpMock.mockImplementation(() => lifecycleMock.events.push("harden"));
  lifecycleMock.events.length = 0;
  lifecycleMock.readTimerMarkerMock.mockReturnValue(null);
  captureOpenshellMock.mockImplementation((args) => defaultOpenshellResponses(args));
  dockerInspectMock.mockReturnValue({ status: 0, stdout: "true\n" });
  establishRestoredSandboxGatewayPairingMock.mockReset();
  findBackupMock.mockReturnValue({ match: null });
  getAppliedPresetsMock.mockReturnValue([]);
  getCustomPoliciesMock.mockReturnValue([]);
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
  managedCloneCredentialMock.runDeviceCodeFlow.mockReset();
  managedCloneCredentialMock.runDeviceCodeFlow.mockImplementation(async (): Promise<never> => {
    throw new Error("production device-code OAuth is disabled in snapshot lifecycle tests");
  });
  managedCloneCredentialMock.bindBrokerState.mockReset();
  managedCloneCredentialMock.bindBrokerState.mockReturnValue({
    file: "/test-only/hermes-tool-gateway-state.json",
    brokerToken: "test-only-broker-token",
  });
  managedCloneCredentialMock.removeBrokerState.mockReset();
  managedCloneCredentialMock.removeBrokerState.mockReturnValue(true);
  managedCloneCredentialMock.preflightBrokerState.mockReset();
  managedCloneCredentialMock.stageBrokerState.mockReset();
  managedCloneCredentialMock.stageBrokerState.mockReturnValue({
    activationToken: "nc_activate_test-only",
    brokerToken: "nc_broker_test-only",
  });
  managedCloneCredentialMock.activateBrokerState.mockReset();
  managedCloneCredentialMock.activateBrokerState.mockReturnValue({
    file: "/test-only/hermes-tool-gateway-state.json",
    brokerToken: "nc_broker_test-only",
  });
  managedCloneCredentialMock.discardBrokerState.mockReset();
  managedCloneCredentialMock.discardBrokerState.mockReturnValue(true);
  resolveAgentBaselinePolicyMock.mockImplementation((agent: string) => ({
    agent,
    policyPath:
      agent === "openclaw"
        ? "/repo/nemoclaw-blueprint/policies/openclaw-sandbox.yaml"
        : `/repo/agents/${agent}/policy-additions.yaml`,
    content: "version: 1\nnetwork_policies: {}\n",
  }));
  prepareInitialSandboxCreatePolicyMock.mockImplementation((policyPath: string) => ({
    policyPath,
    appliedPresets: [],
  }));
  registerSandboxMock.mockReset();
  updateSandboxMock.mockReset();
  restoreSandboxStateMock.mockReturnValue({
    success: true,
    restoredDirs: [],
    restoredFiles: [],
    failedDirs: [],
    failedFiles: [],
  });
  runOpenshellMock.mockImplementation((args) => {
    args[0] === "sandbox" && args[1] === "delete" && lifecycleMock.events.push("delete");
    return { status: 0, output: "" };
  });
  streamSandboxCreateMock.mockImplementation(async () => ({
    status: 0,
    output: "",
    sawProgress: false,
    forcedReady: false,
  }));
  createDockerGpuSandboxCreatePatchMock.mockReset();
  createDockerGpuSandboxCreatePatchMock.mockImplementation(() => managedStartupPatchFixture());
  parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
}

export function cleanupSnapshotRestoreMocks(): void {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
}
