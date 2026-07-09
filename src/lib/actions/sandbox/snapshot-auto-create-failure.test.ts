// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { SnapshotStreamSandboxCreateMock } from "./snapshot-create-stream-test-types";

const captureOpenshellMock = vi.fn(() => ({ status: 0, output: "alpha Ready\n" }));
const getSandboxMock = vi.fn((name?: string) =>
  name === "alpha"
    ? {
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw",
        imageTag: "nemoclaw-alpha:test",
        openshellDriver: "docker",
        provider: "nvidia-nim",
        model: "nvidia/model-a",
      }
    : null,
);
const registerSandboxMock = vi.fn();
const restoreSandboxStateMock = vi.fn();
const streamSandboxCreateMock = vi.fn<SnapshotStreamSandboxCreateMock>(async () => ({
  status: 7,
  output: "create failed before registry write",
  sawProgress: false,
  forcedReady: false,
}));

vi.mock("../../adapters/docker", () => ({ dockerCapture: vi.fn(() => "") }));
vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: captureOpenshellMock,
  getOpenshellBinary: vi.fn(() => "openshell"),
  runOpenshell: vi.fn(() => ({ status: 0, output: "" })),
}));
vi.mock("../../credentials/store", () => ({ prompt: vi.fn() }));
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
vi.mock("../../messaging/channels", () => ({ listMessagingProviderSuffixes: vi.fn(() => []) }));
vi.mock("../../policy", () => ({
  applyPreset: vi.fn(() => true),
  applyPresetContent: vi.fn(() => true),
  getAppliedPresets: vi.fn(() => []),
  getCustomPolicies: vi.fn(() => []),
  getPresetContentGatewayState: vi.fn(() => "absent"),
  loadPresetForSandbox: vi.fn(() => null),
  removePreset: vi.fn(() => true),
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
  repairMutableConfigPerms: vi.fn(() => ({ applied: true, verified: true, errors: [] })),
  shieldsUp: vi.fn(),
}));
vi.mock("../../shields/timer-bound-lock", () => ({
  withTimerBoundShieldsMutationLock: vi.fn((_sandbox, _command, fn) => fn()),
}));
vi.mock("../../shields/timer-control", () => ({ readTimerMarker: vi.fn(() => null) }));
vi.mock("../../state/gateway", () => ({
  isGatewayHealthy: vi.fn(() => true),
  isSandboxReady: vi.fn((output: string, sandboxName: string) =>
    output.includes(`${sandboxName} Ready`),
  ),
}));
vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withSandboxMutationLock: vi.fn((_sandbox, fn) => fn()),
}));
vi.mock("../../state/registry", () => ({
  getSandbox: getSandboxMock,
  listSandboxes: vi.fn(() => ({ sandboxes: [getSandboxMock("alpha")], defaultSandbox: "alpha" })),
  registerSandbox: registerSandboxMock,
  removeSandbox: vi.fn(),
  updateSandbox: vi.fn(),
}));
vi.mock("../../state/sandbox", () => ({
  backupSandboxState: vi.fn(),
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
  removeSandboxRegistryEntry: vi.fn(),
}));
vi.mock("./sandbox-gateway-routing", () => ({
  probeGatewayRunning: vi.fn(() => true),
  selectSandboxGatewayIfRegistered: vi.fn(() => true),
  usesGatewayMetadataProbe: vi.fn(
    (driver?: string | null) => driver === "docker" || driver === "vm",
  ),
}));

describe("snapshot restore auto-create failures", () => {
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
});
