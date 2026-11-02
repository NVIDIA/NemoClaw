// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, afterEach, expect, it, vi } from "vitest";
import { createHermesStateVolumeDockerHarness } from "../__test-helpers__/hermes-state-volume";
import { managedStartupStateRoots } from "../managed-startup/state-roots";
import { managedImageRuntimeIdentity } from "../managed-image/agents";
import { prepareManagedStateVolumes } from "./managed-state-volumes";
import { createManagedStateVolumeOnboardLifecycle } from "./onboard-orchestration";

const runtime = vi.hoisted(() => ({ version: "0.1.3" }));
vi.mock("../openshell-version", async (original) => ({
  ...(await original<typeof import("../openshell-version")>()),
  get SUPPORTED_OPENSHELL_FALLBACK_VERSION() {
    return runtime.version;
  },
}));

const roots = managedStartupStateRoots({
  agent: "openclaw",
  sandboxName: "alpha",
  agentIdentity: managedImageRuntimeIdentity("openclaw"),
});

afterEach(() => vi.unstubAllEnvs());

describe.each(["0.1.3", "0.1.5"])("OpenShell %s projection", (version) => {
  beforeEach(() => {
    runtime.version = version;
  });

  it.each([undefined, ""])("uses the default workspace when the environment is %j", (workspace) => {
    vi.stubEnv("OPENSHELL_WORKSPACE", workspace);
    const docker = createHermesStateVolumeDockerHarness();
    prepareManagedStateVolumes(
      { roots },
      { runContainerEngine: docker.runDocker, registerExitCleanup: () => () => undefined },
    );
    expect(docker.volume?.labels["openshell.ai/sandbox-attachable-workspace"]).toBe("default");
  });

  it("rejects an explicitly empty workspace before accessing volumes", () => {
    const docker = createHermesStateVolumeDockerHarness();
    expect(() =>
      prepareManagedStateVolumes(
        { roots },
        { workspace: "", runContainerEngine: docker.runDocker },
      ),
    ).toThrow("requires an exact OpenShell workspace");
    expect(docker.runDocker).not.toHaveBeenCalled();
  });

  it("creates workspace-approved volumes and retains incomplete creation for explicit cleanup", () => {
    const docker = createHermesStateVolumeDockerHarness();
    const scope = prepareManagedStateVolumes(
      { roots },
      {
        workspace: "qualification",
        runContainerEngine: docker.runDocker,
        registerExitCleanup: () => () => undefined,
      },
    );
    expect(docker.volume?.labels).toEqual({
      ...roots[0]!.ownershipLabels,
      "openshell.ai/sandbox-attachable": "true",
      "openshell.ai/sandbox-attachable-workspace": "qualification",
      "io.nvidia.nemoclaw.state-volume.creation-id": expect.any(String),
    });
    expect(scope?.reused).toEqual([false]);
    expect(scope?.cleanupIncompleteCreate()).toMatchObject([{ status: "retained" }]);
    expect(docker.volume).not.toBeNull();
    expect(docker.calls.filter(([command]) => command === "rm")).toEqual([]);
  });

  it("binds lifecycle volume approval to the selected workspace", () => {
    vi.stubEnv("OPENSHELL_WORKSPACE", "ambient");
    const docker = createHermesStateVolumeDockerHarness();
    const lifecycle = createManagedStateVolumeOnboardLifecycle(
      {
        roots,
        workspace: "selected",
        runtimeProvider: {
          identity: { id: "docker" },
          workload: { managedStateMountDriverId: "docker" },
          containerEngine: {
            supported: true,
            identities: [
              { operation: "sandbox-lifecycle", engineId: "docker", displayName: "Docker" },
            ],
          },
        } as never,
      },
      { runContainerEngine: docker.runDocker },
    );
    lifecycle.materializeSandboxCreatePlan({} as never, () => ({}) as never);
    expect(docker.volume?.labels["openshell.ai/sandbox-attachable-workspace"]).toBe("selected");
  });

  it.each<Record<string, string>>([
    {},
    {
      "openshell.ai/sandbox-attachable": "true",
      "openshell.ai/sandbox-attachable-workspace": "another-workspace",
    },
  ])("preserves retained state without matching workspace approval %j", (approval) => {
    const initial = {
      name: roots[0]!.resourceIdentity,
      labels: { ...roots[0]!.ownershipLabels, ...approval },
    };
    const docker = createHermesStateVolumeDockerHarness(initial);
    expect(() =>
      prepareManagedStateVolumes(
        { roots },
        {
          workspace: "qualification",
          runContainerEngine: docker.runDocker,
        },
      ),
    ).toThrow("Retained data was not changed");
    expect(docker.volume).toEqual(initial);
    expect(docker.calls.map(([command]) => command)).toEqual(["inspect", "inspect"]);
  });

  it("reuses approved retained state without removing it during rollback", () => {
    const initial = {
      name: roots[0]!.resourceIdentity,
      labels: {
        ...roots[0]!.ownershipLabels,
        "openshell.ai/sandbox-attachable": "true",
        "openshell.ai/sandbox-attachable-workspace": "qualification",
      },
    };
    const docker = createHermesStateVolumeDockerHarness(initial);
    const scope = prepareManagedStateVolumes(
      { roots },
      {
        workspace: "qualification",
        runContainerEngine: docker.runDocker,
      },
    );
    expect(scope?.reused).toEqual([true]);
    expect(scope?.cleanupIncompleteCreate()).toEqual([]);
    expect(docker.volume).toEqual(initial);
  });

  it("rejects a competing volume from another workspace without deleting it", () => {
    const initial = {
      name: roots[0]!.resourceIdentity,
      labels: {
        ...roots[0]!.ownershipLabels,
        "openshell.ai/sandbox-attachable": "true",
        "openshell.ai/sandbox-attachable-workspace": "another-workspace",
        "io.nvidia.nemoclaw.state-volume.creation-id": "competing-invocation",
      },
    };
    const docker = createHermesStateVolumeDockerHarness(initial);
    // Another invocation creates this volume between the first inspect and create.
    docker.runDocker.mockImplementationOnce((args) => {
      expect(args).toEqual(["inspect", "--format", "{{json .}}", initial.name]);
      return { status: 1, stderr: "no such volume" };
    });
    const registerExitCleanup = vi.fn(() => () => undefined);
    const prepare = () =>
      prepareManagedStateVolumes(
        { roots },
        { workspace: "qualification", runContainerEngine: docker.runDocker, registerExitCleanup },
      );
    expect(prepare).toThrow("Retained data was not changed");
    expect(docker.volume).toEqual(initial);
    expect(registerExitCleanup).not.toHaveBeenCalled();
    expect(docker.calls.filter(([command]) => command === "rm")).toEqual([]);
  });

  it("reuses an approved competing volume without arming rollback", () => {
    const initial = {
      name: roots[0]!.resourceIdentity,
      labels: {
        ...roots[0]!.ownershipLabels,
        "openshell.ai/sandbox-attachable": "true",
        "openshell.ai/sandbox-attachable-workspace": "qualification",
        "io.nvidia.nemoclaw.state-volume.creation-id": "competing-invocation",
      },
    };
    const docker = createHermesStateVolumeDockerHarness(initial);
    // Another invocation creates this volume between the first inspect and create.
    docker.runDocker.mockImplementationOnce((args) => {
      expect(args).toEqual(["inspect", "--format", "{{json .}}", initial.name]);
      return { status: 1, stderr: "no such volume" };
    });
    const registerExitCleanup = vi.fn(() => () => undefined);
    const prepare = () =>
      prepareManagedStateVolumes(
        { roots },
        { workspace: "qualification", runContainerEngine: docker.runDocker, registerExitCleanup },
      );
    const scope = prepare();
    expect(scope?.reused).toEqual([true]);
    expect(scope?.cleanupIncompleteCreate()).toEqual([]);
    expect(docker.volume).toEqual(initial);
    expect(registerExitCleanup).not.toHaveBeenCalled();
    expect(docker.calls.filter(([command]) => command === "rm")).toEqual([]);
  });

  it("preserves a replacement volume during rollback cleanup", () => {
    const docker = createHermesStateVolumeDockerHarness();
    let exitCleanup: () => void = () => undefined;
    const scope = prepareManagedStateVolumes(
      { roots },
      {
        workspace: "qualification",
        runContainerEngine: docker.runDocker,
        registerExitCleanup: (callback) => {
          exitCleanup = callback;
          return () => undefined;
        },
      },
    );
    expect(scope?.reused).toEqual([false]);
    docker.runDocker(["rm", roots[0]!.resourceIdentity]);
    const competitor = prepareManagedStateVolumes(
      { roots },
      {
        workspace: "qualification",
        runContainerEngine: docker.runDocker,
        registerExitCleanup: () => () => undefined,
      },
    );
    competitor!.commit();
    const replacement = structuredClone(docker.volume);
    const callsBeforeCleanup = docker.calls.length;
    expect(scope?.cleanupIncompleteCreate()).toMatchObject([{ status: "not-owned" }]);
    exitCleanup();
    expect(docker.volume).toEqual(replacement);
    expect(docker.calls.slice(callsBeforeCleanup).map(([command]) => command)).toEqual([
      "inspect",
      "inspect",
    ]);
  });

  it("preserves a replacement volume during exit cleanup", () => {
    const docker = createHermesStateVolumeDockerHarness();
    let exitCleanup: () => void = () => undefined;
    const scope = prepareManagedStateVolumes(
      { roots },
      {
        workspace: "qualification",
        runContainerEngine: docker.runDocker,
        registerExitCleanup: (callback) => {
          exitCleanup = callback;
          return () => undefined;
        },
      },
    );
    expect(scope?.reused).toEqual([false]);
    docker.runDocker(["rm", roots[0]!.resourceIdentity]);
    const competitor = prepareManagedStateVolumes(
      { roots },
      {
        workspace: "qualification",
        runContainerEngine: docker.runDocker,
        registerExitCleanup: () => () => undefined,
      },
    );
    competitor!.commit();
    const replacement = structuredClone(docker.volume);
    const callsBeforeCleanup = docker.calls.length;
    exitCleanup();
    expect(docker.volume).toEqual(replacement);
    expect(docker.calls.slice(callsBeforeCleanup).map(([command]) => command)).toEqual(["inspect"]);
  });

  it.each(["rollback", "exit"] as const)(
    "preserves replacement after the final %s cleanup inspection",
    (cleanupPath) => {
      const docker = createHermesStateVolumeDockerHarness();
      let exitCleanup = () => undefined as void;
      const scope = prepareManagedStateVolumes(
        { roots },
        {
          workspace: "qualification",
          runContainerEngine: docker.runDocker,
          registerExitCleanup: (callback) => {
            exitCleanup = callback;
            return () => undefined;
          },
        },
      )!;
      const originalRun = docker.runDocker.getMockImplementation()!;
      const replacementLabel = "io.nvidia.nemoclaw.state-volume.creation-id=competitor";
      docker.runDocker.mockImplementationOnce((args) => {
        expect(args).toEqual(["inspect", "--format", "{{json .}}", roots[0]!.resourceIdentity]);
        const staleObservation = originalRun(args);
        originalRun(["rm", roots[0]!.resourceIdentity]);
        originalRun(["create", "--label", replacementLabel, roots[0]!.resourceIdentity]);
        return staleObservation;
      });
      docker.runDocker.mockClear();
      const actions = { rollback: () => scope.cleanupIncompleteCreate(), exit: exitCleanup };
      actions[cleanupPath]();
      expect(docker.volume?.labels).toEqual({
        "io.nvidia.nemoclaw.state-volume.creation-id": "competitor",
      });
      expect(docker.runDocker.mock.calls.map(([args]) => args[0])).toEqual(["inspect"]);
    },
  );
});
