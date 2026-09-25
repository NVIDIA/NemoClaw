// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import { resolveTestAgentBaselinePolicy } from "../../../../test/support/snapshot-policy-test-fixture";
import type { StreamSandboxCreateCommand } from "../../adapters/openshell/sandbox-lifecycle-cli";
import type { OpenShellSandboxPolicyReader } from "../../adapters/openshell/sandbox-policy";
import type { MutableConfigRepairResult } from "../../sandbox/mutable-config-perms";
import type {
  SandboxEntry,
  SandboxHostLocalInferenceProvenance,
  SandboxWorkloadReceipt,
} from "../../state/registry/types";
import type { SnapshotRestoreOptions } from "../../state/sandbox";
import { dcodeProbeOutput } from "./dcode-probe-test-fixture";
import { SANDBOX_EXEC_STARTED_MARKER } from "../../adapters/sandbox/sandbox-exec-output";

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
  /** Legacy test input consumed only by the source-inspection mock. */
  mcp?: { bridges?: Record<string, import("./mcp-bridge-contracts").McpSourceEntry> };
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
  const selectorIndex = args.indexOf("--selector");
  if (command === "sandbox list" && selectorIndex >= 0) {
    const selector = args[selectorIndex + 1] ?? "";
    const separatorIndex = selector.indexOf("=");
    return {
      status: 0,
      output: JSON.stringify([
        {
          id: "beta-live-id",
          name: "beta",
          labels: { [selector.slice(0, separatorIndex)]: selector.slice(separatorIndex + 1) },
          resource_version: 1,
          created_at: "2026-09-22T00:00:00.000Z",
          phase: "Ready",
          current_policy_version: 1,
        },
      ]),
    };
  }
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

const mutableConfigMock = vi.hoisted(() => {
  const repairMutableConfigPermsMock = vi.fn<() => MutableConfigRepairResult>(() => ({
    applied: true,
    verified: true,
    errors: [],
  }));
  return { repairMutableConfigPermsMock };
});

const lifecycleMock = vi.hoisted(() => {
  const events: string[] = [];
  return { events };
});

export const backupSandboxStateMock = vi.fn();
export const assertHermesPortableCommandUnavailableMock = vi.fn();
export const captureSnapshotRestoreAuthorityMock = vi.fn((_backupPath?: string) => ({
  schemaVersion: 1 as const,
  backupPath: "/tmp/backup-alpha",
  contentSha256: "a".repeat(64),
}));
export const validateSnapshotRestoreMutationMock = vi.fn(
  async (backupPath: string, options: SnapshotRestoreOptions): Promise<string | null> => {
    if (options.authority) {
      const current = captureSnapshotRestoreAuthorityMock(backupPath);
      if (
        !current ||
        current.backupPath !== options.authority.backupPath ||
        current.contentSha256 !== options.authority.contentSha256
      ) {
        return "Selected snapshot content changed before filesystem mutation";
      }
    }
    try {
      await options.validateBeforeMutation?.();
      return null;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return `Runtime authority changed before filesystem mutation: ${detail}`;
    }
  },
);
export const loadAgentMock = vi.fn((name: string) => ({
  name,
  policyAdditionsPath: name === "openclaw" ? null : `/repo/agents/${name}/policy-additions.yaml`,
}));
export const captureOpenshellMock = vi.fn<
  (args: string[], opts?: Record<string, unknown>) => OpenshellCaptureResult
>((args) => defaultOpenshellResponses(args));
export const readSandboxPolicyMock = vi.fn<OpenShellSandboxPolicyReader["readSandboxPolicy"]>(
  async () => ({
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
export const finalizeSandboxRouteReservationMock = vi.fn();
export const finalizePendingSandboxRegistrationMock = vi.fn();
export const finalizePendingSandboxRegistrationIfCurrentMock = vi.fn();
export const restoreSandboxStateMock = vi.fn();
export const restoreDeepAgentsNativeMcpConfigMock = vi.fn();
export const getMcpProviderInspectionRuntimeSelectionMock = vi.fn(() => ({
  gatewayName: "nemoclaw-8091",
  workspace: "default",
}));
export const removeSandboxRegistryEntryOutcomeMock = vi.fn<
  (
    name: string,
  ) =>
    | { status: "complete"; removed: true }
    | { status: "blocked"; reason: "authority-unproven"; removed: false }
>(() => ({ status: "complete", removed: true }));
export const runOpenshellMock = vi.fn((args: string[]) => {
  switch (`${String(args[0])}:${String(args[1])}`) {
    case "sandbox:delete":
      lifecycleMock.events.push("delete");
      parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
      return { status: 0, output: "", stdout: "", stderr: "" };
    case "sandbox:get":
      return {
        status: 1,
        output: "Error: sandbox beta not found",
        stdout: "",
        stderr: "Error: sandbox beta not found",
      };
    default:
      return { status: 0, output: "", stdout: "", stderr: "" };
  }
});
export const streamSandboxCreateMock = vi.fn<StreamSandboxCreateCommand>(async () => ({
  status: 0,
  output: "",
  sawProgress: false,
  forcedReady: false,
}));
export const allocateSnapshotCloneForwardPortsMock = vi.fn(
  async (input: { source: SandboxRecord }) => ({
    dashboardPort:
      typeof input.source.dashboardPort === "number" ? input.source.dashboardPort : null,
    hermesApiPort: input.source.agent === "hermes" ? 8_642 : null,
  }),
);
export const latestBackupFixture = {
  timestamp: "2026-06-15T00:00:00.000Z",
  backupPath: "/tmp/backup-alpha",
};

export { lifecycleMock, mutableConfigMock };

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
  captureResolvedOpenshell: (args: string[]) =>
    args[0] === "gateway" && args[1] === "select"
      ? runOpenshellMock(args)
      : captureOpenshellMock(args),
  getOpenshellBinary: vi.fn(() => "openshell"),
  runOpenshell: runOpenshellMock,
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

vi.mock("../../sandbox/mutable-config-perms", () => ({
  repairMutableConfigPerms: mutableConfigMock.repairMutableConfigPermsMock,
}));

vi.mock("../../sandbox/create-stream", () => ({
  streamSandboxCreate: streamSandboxCreateMock,
}));

vi.mock("../../adapters/openshell/gateway-reuse-cli", () => ({
  createCliOpenShellGatewayReuseObserver: () => ({
    observeGatewayReuse: async () => {
      const healthy = isGatewayHealthyMock();
      return {
        gatewayReuseState: healthy ? "healthy" : "missing",
        healthy,
        namedMetadata: true,
        shouldSelect: false,
        endpoints: [],
        endpointBinding: healthy ? "match" : "unknown",
      };
    },
  }),
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
  finalizeSandboxRouteReservation: finalizeSandboxRouteReservationMock,
  finalizePendingSandboxRegistration: finalizePendingSandboxRegistrationMock,
  finalizePendingSandboxRegistrationIfCurrent: finalizePendingSandboxRegistrationIfCurrentMock,
}));

vi.mock("../../state/sandbox", () => ({
  backupSandboxState: backupSandboxStateMock,
  captureSnapshotRestoreAuthority: captureSnapshotRestoreAuthorityMock,
  findBackup: findBackupMock,
  getLatestBackup: getLatestBackupMock,
  listBackups: listBackupsMock,
  restoreSandboxState: restoreSandboxStateMock,
  validateSnapshotRestoreMutation: validateSnapshotRestoreMutationMock,
}));

vi.mock("./destroy", async () => {
  const runtimeProviders = await vi.importActual<
    typeof import("../../onboard/runtime-provider/access")
  >("../../onboard/runtime-provider/access");
  return {
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

vi.mock("./snapshot/forward-port-allocation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./snapshot/forward-port-allocation")>()),
  allocateSnapshotCloneForwardPorts: allocateSnapshotCloneForwardPortsMock,
}));

vi.mock("./mcp-bridge-adapter-deepagents-registration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-adapter-deepagents-registration")>()),
  restoreDeepAgentsNativeMcpConfig: restoreDeepAgentsNativeMcpConfigMock,
}));

vi.mock("./mcp-bridge-provider-inspection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-provider-inspection")>()),
  getMcpProviderInspectionRuntimeSelection: getMcpProviderInspectionRuntimeSelectionMock,
}));

vi.mock("./mcp-bridge-source", () => ({
  inspectAgentMcpSources: (sandbox: SandboxRecord) => ({
    native: sandbox.mcp?.bridges ?? {},
    legacy: {},
  }),
}));

export function resetSnapshotRestoreMocks(): void {
  vi.clearAllMocks();
  assertHermesPortableCommandUnavailableMock.mockReset();
  captureSnapshotRestoreAuthorityMock.mockReturnValue({
    schemaVersion: 1,
    backupPath: "/tmp/backup-alpha",
    contentSha256: "a".repeat(64),
  });
  mutableConfigMock.repairMutableConfigPermsMock.mockReturnValue({
    applied: true,
    verified: true,
    errors: [],
  });
  lifecycleMock.events.length = 0;
  captureOpenshellMock.mockImplementation((args) => defaultOpenshellResponses(args));
  readSandboxPolicyMock.mockResolvedValue({
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
  finalizeSandboxRouteReservationMock.mockReset().mockReturnValue(true);
  finalizePendingSandboxRegistrationMock.mockReset().mockReturnValue(true);
  finalizePendingSandboxRegistrationIfCurrentMock.mockReset().mockReturnValue(true);
  restoreSandboxStateMock.mockReturnValue({
    success: true,
    restoredDirs: [],
    restoredFiles: [],
    failedDirs: [],
    failedFiles: [],
  });
  restoreDeepAgentsNativeMcpConfigMock.mockReset();
  getMcpProviderInspectionRuntimeSelectionMock.mockClear();
  streamSandboxCreateMock.mockImplementation(async () => ({
    status: 0,
    output: "",
    sawProgress: false,
    forcedReady: false,
  }));
  allocateSnapshotCloneForwardPortsMock.mockImplementation(async (input) => ({
    dashboardPort:
      typeof input.source.dashboardPort === "number" ? input.source.dashboardPort : null,
    hermesApiPort: input.source.agent === "hermes" ? 8_642 : null,
  }));
  waitForRestoredSandboxGatewaySupervisorMock.mockReturnValue(true);
  parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
}

export function cleanupSnapshotRestoreMocks(): void {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
}
