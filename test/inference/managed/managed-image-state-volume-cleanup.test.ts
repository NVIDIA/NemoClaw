// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { cleanupProtectedManagedStateVolumes } from "../../../scripts/checks/run-managed-image-openshell-e2e";
import { createHermesStateVolumeDockerHarness } from "../../../src/lib/onboard/__test-helpers__/hermes-state-volume";
import { managedStartupStateRoots } from "../../../src/lib/onboard/managed-startup/state-roots";
import { managedImageRuntimeIdentity } from "../../../src/lib/onboard/managed-image/agents";
import {
  prepareManagedStateVolumes,
  removeManagedStateVolumes,
} from "../../../src/lib/onboard/managed-workload/managed-state-volumes";
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
      prepared: true,
      runtimeProvider: createDockerRuntimeProviderBundle(),
    }),
  ).toEqual([]);
  expect(remove).toHaveBeenCalledOnce();
  expect(docker.volume).toBeNull();
});
