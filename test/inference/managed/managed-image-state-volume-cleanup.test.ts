// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";
import { cleanupProtectedManagedStateVolumes } from "../../../scripts/checks/run-managed-image-openshell-e2e";
import { createHermesStateVolumeDockerHarness } from "../../../src/lib/onboard/__test-helpers__/hermes-state-volume";
import { managedStartupStateRoots } from "../../../src/lib/onboard/managed-startup/state-roots";
import { managedImageRuntimeIdentity } from "../../../src/lib/onboard/managed-image/agents";
import {
  prepareManagedStateVolumes,
  removeManagedStateVolumes,
} from "../../../src/lib/onboard/managed-workload/managed-state-volumes";
import { createManagedStateVolumeCleanupFixture } from "../../support/managed-state-volume-cleanup";
import { createDockerRuntimeProviderBundle } from "../../../src/lib/onboard/runtime-provider/docker";

it("explicitly tears down fixture volumes retained by incomplete bootstrap rollback", () => {
  const docker = createHermesStateVolumeDockerHarness();
  const roots = managedStartupStateRoots({
    agent: "openclaw",
    sandboxName: "fixture",
    agentIdentity: managedImageRuntimeIdentity("openclaw"),
  });
  const scope = prepareManagedStateVolumes(
    { roots },
    {
      runContainerEngine: docker.runDocker,
      registerExitCleanup: () => () => undefined,
    },
  )!;
  expect(scope.cleanupIncompleteCreate()).toMatchObject([{ status: "retained" }]);
  expect(docker.volume).not.toBeNull();
  const remove = vi.fn((input: Parameters<typeof removeManagedStateVolumes>[0]) =>
    removeManagedStateVolumes(input, { runContainerEngine: docker.runDocker }),
  );
  const onboard = { managedWorkloadOnboard: { removeManagedStateVolumes: remove } } as never;
  expect(
    cleanupProtectedManagedStateVolumes({
      onboard,
      roots,
      preparationAttempted: true,
      runtimeProvider: createDockerRuntimeProviderBundle(),
    }),
  ).toEqual([]);
  expect(remove).toHaveBeenCalledOnce();
  expect(docker.volume).toBeNull();
});

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  remove: vi.fn(),
  roots: vi.fn(),
  startGateway: vi.fn(),
  command: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: mocks.command,
}));
vi.mock("../../../src/lib/onboard/host-gateway-process", () => ({
  stopHostGatewayProcesses: () => ({ failed: [], ownershipFailures: [] }),
}));
vi.mock("../../../src/lib/onboard/initial-policy", () => ({
  prepareInitialSandboxCreatePolicy: () => ({ policyPath: "/fixture/policy.yaml" }),
}));
vi.mock("../../../src/lib/onboard.ts", () => ({
  default: {
    openshellArgv: (args: string[]) => ["openshell", ...args],
    runOpenshell: vi.fn(),
    runCaptureOpenshell: vi.fn(),
    sleepSeconds: vi.fn(),
    startGatewayForRecovery: mocks.startGateway,
    createForwardPortObserver: vi.fn(),
    managedWorkloadOnboard: {
      completeProviderManagedStartup: vi.fn(),
      managedStartupStateRoots: mocks.roots,
      managedStartupWorkspaceRoot: vi.fn(),
      prepareManagedStateVolumes: mocks.prepare,
      removeManagedStateVolumes: mocks.remove,
    },
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function fixture(failure: Parameters<typeof createManagedStateVolumeCleanupFixture>[0]) {
  const setup = createManagedStateVolumeCleanupFixture(failure);
  mocks.roots.mockReturnValue(setup.roots);
  mocks.prepare.mockImplementation(setup.prepare);
  mocks.remove.mockImplementation(setup.remove);
  mocks.startGateway.mockImplementation(setup.startGateway);
  mocks.command.mockImplementation(setup.command);
  return setup;
}

it.each(["second root", "verification"] as const)(
  "removes its partial fixture volume after %s fails",
  async (failure) => {
    const setup = fixture(failure);
    try {
      await expect(setup.run()).rejects.toThrow(/injected/);
      expect(mocks.prepare).toHaveBeenCalledOnce();
      expect(mocks.remove).toHaveBeenCalledOnce();
      expect(setup.docker.volume).toBeNull();
      expect(setup.docker.calls.filter(([operation]) => operation === "rm")).toEqual([
        ["rm", setup.roots[0]!.resourceIdentity],
      ]);
      expect(setup.remainingState()).toEqual([]);
    } finally {
      setup.dispose();
    }
  },
);

it("does not attempt volume removal after a failure before preparation", async () => {
  const setup = fixture("before preparation");
  try {
    await expect(setup.run()).rejects.toThrow("injected early failure");
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(setup.docker.volume).toBeNull();
    expect(setup.docker.calls).toEqual([]);
    expect(setup.remainingState()).toEqual([]);
  } finally {
    setup.dispose();
  }
});

it("preserves an older same-name volume with ordinary NemoClaw ownership labels", async () => {
  const setup = fixture("foreign ownership");
  try {
    await expect(setup.run()).rejects.toThrow(/cleanup not-owned/);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(setup.docker.volume).toEqual({
      name: setup.roots[0]!.resourceIdentity,
      labels: { ...setup.roots[0]!.ownershipLabels },
    });
    expect(setup.docker.calls.filter(([operation]) => operation === "rm")).toEqual([]);
    expect(setup.remainingState()).toEqual([]);
  } finally {
    setup.dispose();
  }
});
