// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
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
  const result = responses[`${args[0] ?? ""} ${args[1] ?? ""}`] ?? {
    status: 0,
    output: "",
  };
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

export const backupSandboxStateMock = vi.fn();
export const captureOpenshellMock = vi.fn<
  (args: string[], opts?: Record<string, unknown>) => OpenshellCaptureResult
>((args) => defaultOpenshellResponses(args));
export const dockerInspectMock = vi.fn(() => ({ status: 0, stdout: "true\n" }));
export const findBackupMock = vi.fn();
export const getAppliedPresetsMock = vi.fn(() => [] as string[]);
export const getCustomPoliciesMock = vi.fn(
  () => [] as Array<{ name: string; content: string; sourcePath?: string }>,
);
export const getLatestBackupMock = vi.fn(() => null as Record<string, unknown> | null);
export const getOpenShellSandboxDescriptorMock = vi.fn(
  async (_gatewayName: string, sandboxName: string) => ({
    id: `${sandboxName}-id`,
    name: sandboxName,
    image: `nemoclaw-${sandboxName}:live`,
  }),
);
export const applyPresetMock = vi.fn((_sandbox: string, _preset: string) => true);
export const applyPresetContentMock = vi.fn(
  (_sandbox: string, _name: string, _content: string, _options?: unknown) => true,
);
export const removePresetMock = vi.fn((_sandbox: string, _preset: string) => true);
export const getPresetContentGatewayStateMock = vi.fn<
  (_sandbox: string, _content: string, _policyKey?: string) => "match" | "absent" | "drift" | null
>(() => "absent");
export const builtinObservabilityPolicy =
  "network_policies:\n  observability-otlp-local:\n    endpoints:\n      - host: host.openshell.internal\n";
export const loadPresetForSandboxMock = vi.fn((_sandbox: string, preset: string) =>
  preset === "observability-otlp-local" ? builtinObservabilityPolicy : null,
);
export const getSandboxMock = vi.fn<(name?: string) => SandboxRecord | null>(() => null);
export const isGatewayHealthyMock = vi.fn(() => true);
export const listBackupsMock = vi.fn<() => Array<Record<string, unknown>>>(() => []);
export const parseLiveSandboxNamesMock = vi.fn(() => new Set(["alpha"]));
export const registerSandboxMock = vi.fn();
export const updateSandboxMock = vi.fn();
export const restoreSandboxStateMock = vi.fn();
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
  dockerInspect: dockerInspectMock,
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: captureOpenshellMock,
  getOpenshellBinary: vi.fn(() => "openshell"),
  runOpenshell: runOpenshellMock,
}));

vi.mock("../../adapters/openshell/sandbox-control-routing", () => ({
  getOpenShellSandboxDescriptor: getOpenShellSandboxDescriptorMock,
}));

vi.mock("../../credentials/store", () => ({
  prompt: vi.fn(),
}));

vi.mock("../../domain/sandbox/destroy", () => ({
  getSandboxDeleteOutcome: vi.fn(() => ({ alreadyGone: false, gatewayUnreachable: false })),
}));

vi.mock("../../inference/nim", () => ({
  stopNimContainer: vi.fn(),
  stopNimContainerByName: vi.fn(),
}));

vi.mock("../../policy", () => ({
  applyPreset: applyPresetMock,
  applyPresetContent: applyPresetContentMock,
  getAppliedPresets: getAppliedPresetsMock,
  getPresetContentGatewayState: getPresetContentGatewayStateMock,
  loadPresetForSandbox: loadPresetForSandboxMock,
  removePreset: removePresetMock,
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

vi.mock("../../shields", () => ({
  get isShieldsDown() {
    return shieldsMock.getIsShieldsDownExport();
  },
  repairMutableConfigPerms: shieldsMock.repairMutableConfigPermsMock,
  shieldsUp: shieldsMock.shieldsUpMock,
}));

vi.mock("../../shields/timer-bound-lock", () => ({
  withTimerBoundShieldsMutationLock: lifecycleMock.withTimerBoundMock,
  withTimerBoundShieldsMutationLockAsync: lifecycleMock.withTimerBoundMock,
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
  getCustomPolicies: getCustomPoliciesMock,
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

export function resetSnapshotRestoreMocks(): void {
  vi.clearAllMocks();
  shieldsMock.setIsShieldsDownExport(shieldsMock.isShieldsDownMock);
  shieldsMock.isShieldsDownMock.mockReturnValue(true);
  shieldsMock.shieldsUpMock.mockImplementation(() => lifecycleMock.events.push("harden"));
  lifecycleMock.events.length = 0;
  lifecycleMock.readTimerMarkerMock.mockReturnValue(null);
  captureOpenshellMock.mockImplementation((args) => defaultOpenshellResponses(args));
  dockerInspectMock.mockReturnValue({ status: 0, stdout: "true\n" });
  findBackupMock.mockReturnValue({ match: null });
  getAppliedPresetsMock.mockReturnValue([]);
  getCustomPoliciesMock.mockReturnValue([]);
  getLatestBackupMock.mockReturnValue(null);
  getOpenShellSandboxDescriptorMock.mockImplementation(async (_gatewayName, sandboxName) => ({
    id: `${sandboxName}-id`,
    name: sandboxName,
    image: `nemoclaw-${sandboxName}:live`,
  }));
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
  registerSandboxMock.mockReset();
  updateSandboxMock.mockReset();
  restoreSandboxStateMock.mockReturnValue({
    success: true,
    restoredDirs: [],
    restoredFiles: [],
    failedDirs: [],
    failedFiles: [],
  });
  parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
}

export function cleanupSnapshotRestoreMocks(): void {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
}
