// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { hostLocalInferenceReceipt } from "../../../../test/helpers/host-local-inference-receipt";
import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import {
  type HostLocalInferenceOperation,
  type HostLocalInferenceRuntime,
  serializeHostLocalInferenceReceipt,
} from "../../onboard/runtime-provider/host-local-inference";
import type { SandboxEntry } from "../../state/registry/types";
import type { RebuildManifest, RestoreResult, SnapshotRestoreOptions } from "../../state/sandbox";
import { runSandboxSnapshot } from "./snapshot";

const harness = vi.hoisted(() => {
  let registryEntry: unknown = null;
  const events: string[] = [];
  return {
    events,
    getSandbox: vi.fn(() => registryEntry),
    setRegistryEntry: (entry: unknown) => {
      registryEntry = entry;
    },
    getLatestBackup: vi.fn(),
    captureSnapshotRestoreAuthority: vi.fn(),
    restoreSandboxState: vi.fn(),
    preserveForRebuild: vi.fn((receipt: unknown) => {
      events.push("reprove");
      return receipt;
    }),
  };
});

const managedRuntime: HostLocalInferenceRuntime = {
  providerId: "docker",
  authorityId: "docker:host-local",
  services: ["vllm"],
  translateContainerArgs: (args) => args,
  qualifyOllama: vi.fn(),
  startManaged: vi.fn(),
  inspectManaged: vi.fn((value) => ({ running: true, receipt: value })),
  stopManaged: vi.fn((value) => ({ running: false, receipt: value })),
  preserveForRebuild: harness.preserveForRebuild as HostLocalInferenceRuntime["preserveForRebuild"],
  prepareDestroy: vi.fn((value) => value),
  destroy: vi.fn((value) => ({ status: "removed" as const, receipt: value })),
};
const operation: HostLocalInferenceOperation = {
  providerId: "docker",
  engine: {
    operation: "host-local-inference",
    engineId: "memory",
    displayName: "In-memory",
    authorityId: "docker:host-local",
    capture: vi.fn(),
    captureHost: vi.fn(),
  },
  bindingSha256: "a".repeat(64),
  assertAuthority: vi.fn(),
  spawn: vi.fn() as HostLocalInferenceOperation["spawn"],
  createLlamaCppLifecycle: vi.fn() as HostLocalInferenceOperation["createLlamaCppLifecycle"],
  managedRuntime,
};
const provider = createInMemoryRuntimeProviderBundle({
  providerId: "docker",
  workloadProfile: {
    support: null,
    hostArchitectures: ["x64"],
    managedImageSelectionPolicy: "prefer-managed",
    legacyDockerfileBuilds: true,
  },
  hostLocalInference: { services: ["vllm"], createOperation: () => operation },
});

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(() => ({ status: 0, output: "alpha Ready\n" })),
  getOpenshellBinary: vi.fn(() => "openshell"),
  runOpenshell: vi.fn(() => ({ status: 0, output: "" })),
}));

vi.mock("../../policy", () => ({
  applyPreset: vi.fn(() => true),
  applyPresetContent: vi.fn(() => true),
  getAppliedPresets: vi.fn(() => []),
  getPresetContentGatewayState: vi.fn(() => "absent"),
  loadPresetForSandbox: vi.fn(() => null),
  removePreset: vi.fn(() => true),
}));

vi.mock("../../runtime-recovery", () => ({
  parseLiveSandboxNames: vi.fn(() => new Set(["alpha"])),
}));

vi.mock("../../shields", () => ({
  isShieldsDown: vi.fn(() => true),
  recoverCompletedAutoRestoreBeforeCommand: vi.fn(),
  repairMutableConfigPerms: vi.fn(() => ({ applied: true, verified: true, errors: [] })),
}));

vi.mock("../../shields/timer-bound-lock", () => ({
  withTimerBoundShieldsMutationLock: vi.fn(
    (_name: string, _operation: string, callback: () => unknown) => callback(),
  ),
}));

vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withSandboxMutationLock: vi.fn((_name: string, callback: () => Promise<unknown>) => callback()),
}));

vi.mock("../../state/registry", () => ({
  getBaselineExclusions: vi.fn(() => []),
  getCustomPolicies: vi.fn(() => []),
  getSandbox: harness.getSandbox,
  listSandboxes: vi.fn(() => ({
    sandboxes: [harness.getSandbox()].filter(Boolean),
    defaultSandbox: "alpha",
  })),
  updateSandbox: vi.fn(),
}));

vi.mock("../../state/sandbox", () => ({
  captureSnapshotRestoreAuthority: harness.captureSnapshotRestoreAuthority,
  findBackup: vi.fn(() => ({ match: null })),
  getLatestBackup: harness.getLatestBackup,
  listBackups: vi.fn(() => []),
  restoreSandboxState: harness.restoreSandboxState,
}));

vi.mock("./sandbox-gateway-routing", () => ({
  probeGatewayRunning: vi.fn(() => true),
  selectSandboxGatewayIfRegistered: vi.fn(() => true),
  usesGatewayMetadataProbe: vi.fn(() => false),
}));

vi.mock("./snapshot/dependencies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./snapshot/dependencies")>()),
  requireCurrentSnapshotRuntimeProvider: vi.fn(() => provider),
}));

function receiptAtPort(port: number): string {
  const receipt = hostLocalInferenceReceipt("docker");
  return serializeHostLocalInferenceReceipt({
    ...receipt,
    engineAuthority: { ...receipt.engineAuthority, engineId: "memory" },
    endpoint: { ...receipt.endpoint, port },
  });
}

function manifest(receipt: string): RebuildManifest {
  return {
    version: 1,
    sandboxName: "alpha",
    timestamp: "2026-08-02T00-00-00-000Z",
    agentType: "openclaw",
    agentVersion: null,
    expectedVersion: null,
    stateDirs: [],
    dir: "/sandbox",
    backupPath: "/tmp/backup-alpha",
    blueprintDigest: null,
    hostLocalInferenceReceipt: receipt,
  };
}

function sandbox(receipt: string): SandboxEntry {
  return {
    name: "alpha",
    agent: "openclaw",
    openshellDriver: "docker",
    provider: "vllm-local",
    model: "model-a",
    endpointUrl: "https://inference.local/v1",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "11111111-1111-4111-8111-111111111111",
    lifecycleLiveIdentityFingerprint: "f".repeat(64),
    hostLocalInferenceReceipt: receipt,
  };
}

function successfulRestore(
  _name: string,
  _path: string,
  options: SnapshotRestoreOptions = {},
): RestoreResult {
  harness.events.push("restore-start");
  options.validateBeforeMutation?.();
  harness.events.push("restore-complete");
  return {
    success: true,
    restoredDirs: [],
    failedDirs: [],
    restoredFiles: [],
    failedFiles: [],
  };
}

describe("snapshot command host-local inference authority", () => {
  beforeEach(() => {
    harness.events.length = 0;
  });

  it("re-proves authority before restore, at the mutation fence, and after success", async () => {
    const receipt = receiptAtPort(8000);
    harness.setRegistryEntry(sandbox(receipt));
    harness.getLatestBackup.mockReturnValue(manifest(receipt));
    harness.captureSnapshotRestoreAuthority.mockReturnValue({
      schemaVersion: 1,
      backupPath: "/tmp/backup-alpha",
      contentSha256: "e".repeat(64),
    });
    harness.restoreSandboxState.mockImplementation(successfulRestore);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(harness.preserveForRebuild).toHaveBeenCalledTimes(4);
    expect(harness.events).toEqual([
      "reprove",
      "reprove",
      "restore-start",
      "reprove",
      "restore-complete",
      "reprove",
    ]);
    expect(harness.restoreSandboxState).toHaveBeenCalledWith(
      "alpha",
      "/tmp/backup-alpha",
      expect.objectContaining({
        authority: expect.objectContaining({ contentSha256: "e".repeat(64) }),
        validateBeforeMutation: expect.any(Function),
      }),
    );
  });

  it("rejects mismatched target authority before filesystem restore", async () => {
    const snapshotReceipt = receiptAtPort(8000);
    harness.setRegistryEntry(sandbox(receiptAtPort(8001)));
    harness.getLatestBackup.mockReturnValue(manifest(snapshotReceipt));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runSandboxSnapshot("alpha", { kind: "restore" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(harness.restoreSandboxState).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "different host-local inference authority",
    );
  });
});
