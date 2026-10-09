// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { PodmanBoundContainerEngine, PodmanContainerEngine } from "../../adapters/podman";
import { createHermesStateVolumeDockerHarness as dockerHarness } from "../__test-helpers__/hermes-state-volume";
import {
  createDockerRuntimeProviderBundle,
  createKubernetesRuntimeProviderBundle,
} from "../runtime-provider/docker";
import { createPodmanRuntimeProviderBundle } from "../runtime-provider/podman";
import {
  MANAGED_HERMES_STATE_ROOT,
  MANAGED_OPENCLAW_STATE_ROOT,
  managedStartupStateRoots,
} from "../managed-startup/state-roots";
import { managedImageRuntimeIdentity } from "../managed-image/agents";
import { prepareManagedStateVolumes } from "./managed-state-volumes";
import {
  managedHermesStateVolumeName,
  removeManagedAgentStateVolumes,
  prepareManagedHermesStateVolume,
  removeManagedHermesStateVolume,
} from "./hermes-state-volume";

const context = {
  agentName: "hermes",
  runtimeProviderId: "docker",
  sandboxName: "alpha",
  workloadKind: "managed-image",
} as const;

describe("managed Hermes state volume", () => {
  it("creates and mounts one labeled writable volume for managed Docker Hermes", () => {
    const docker = dockerHarness();
    let exitCleanup: (() => void) | null = null;
    const unregister = vi.fn();

    const scope = prepareManagedHermesStateVolume(context, {
      runDocker: docker.runDocker as never,
      registerExitCleanup: (cleanup) => {
        exitCleanup = cleanup;
        return unregister;
      },
    });

    expect(scope).toMatchObject({
      reused: false,
      volumeName: "nemoclaw-hermes-state-v1-alpha",
      mount: {
        type: "volume",
        source: "nemoclaw-hermes-state-v1-alpha",
        target: MANAGED_HERMES_STATE_ROOT,
        read_only: false,
      },
    });
    expect(docker.volume?.labels).toMatchObject({
      "io.nvidia.nemoclaw.hermes-state.managed": "true",
      "io.nvidia.nemoclaw.hermes-state.schema": "1",
      "io.nvidia.nemoclaw.hermes-state.sandbox": "alpha",
      "io.nvidia.nemoclaw.hermes-state.target": "/sandbox/.hermes",
    });

    exitCleanup!();
    expect(docker.volume).toBeNull();
    expect(unregister).not.toHaveBeenCalled();
  });

  it("uses the registered native provider for the same managed Hermes volume contract", () => {
    const runtime = dockerHarness();
    const scope = prepareManagedHermesStateVolume(
      { ...context, runtimeProviderId: "podman" },
      {
        runDocker: runtime.runDocker as never,
        registerExitCleanup: () => () => undefined,
      },
    );

    expect(scope?.mount).toMatchObject({
      source: "nemoclaw-hermes-state-v1-alpha",
      target: MANAGED_HERMES_STATE_ROOT,
    });
  });

  it("dispatches native volume lifecycle through the selected provider operation", () => {
    const runtime = dockerHarness();
    const workloadCleanupCapture = vi.fn((args: readonly string[]) => {
      expect(args[0]).toBe("volume");
      const result = runtime.runDocker(args.slice(1)) as {
        status: number | null;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        error?: Error;
      };
      return {
        status: result.status ?? 1,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
        ...(result.error ? { error: result.error } : {}),
      };
    });
    const engine = (
      operation: PodmanContainerEngine["operation"],
      capture: PodmanContainerEngine["capture"] = vi.fn(() => ({
        status: 0,
        stdout: "",
        stderr: "",
      })),
    ): PodmanBoundContainerEngine => ({
      operation,
      engineId: "podman",
      displayName: "Podman",
      authorityId: `podman:${operation}`,
      endpointAuthorityId: "podman:test-endpoint",
      capture,
      captureHost: capture,
      assertAuthority: vi.fn(),
    });
    const provider = createPodmanRuntimeProviderBundle({
      engines: {
        hostDoctor: engine("host-doctor"),
        sandboxLifecycle: engine("sandbox-lifecycle"),
        workloadCleanup: engine("workload-cleanup", workloadCleanupCapture),
      },
    });

    const scope = prepareManagedHermesStateVolume(
      { ...context, runtimeProviderId: "podman" },
      {
        runtimeProviders: { podman: provider },
        registerExitCleanup: () => () => undefined,
      },
    );

    expect(scope?.mount.source).toBe("nemoclaw-hermes-state-v1-alpha");
    expect(workloadCleanupCapture).toHaveBeenCalled();
    expect(workloadCleanupCapture.mock.calls.every(([args]) => args[0] === "volume")).toBe(true);
  });

  it("commits a newly created volume after registration so exit cleanup preserves it", () => {
    const docker = dockerHarness();
    let exitCleanup: (() => void) | null = null;
    const unregister = vi.fn();
    const scope = prepareManagedHermesStateVolume(context, {
      runDocker: docker.runDocker as never,
      registerExitCleanup: (cleanup) => {
        exitCleanup = cleanup;
        return unregister;
      },
    });

    scope!.commit();
    exitCleanup!();

    expect(docker.volume).not.toBeNull();
    expect(unregister).toHaveBeenCalledOnce();
    expect(docker.calls.filter((args) => args[0] === "rm")).toEqual([]);
  });

  it("reuses the exact owned volume across rebuild without arming failure cleanup", () => {
    const created = dockerHarness();
    const first = prepareManagedHermesStateVolume(context, {
      runDocker: created.runDocker as never,
      registerExitCleanup: () => () => undefined,
    });
    const reused = dockerHarness(created.volume);
    const registerExitCleanup = vi.fn();

    const second = prepareManagedHermesStateVolume(context, {
      runDocker: reused.runDocker as never,
      registerExitCleanup,
    });

    expect(first?.volumeName).toBe(second?.volumeName);
    expect(second?.reused).toBe(true);
    expect(registerExitCleanup).not.toHaveBeenCalled();
    expect(reused.calls.some((args) => args[0] === "create")).toBe(false);
    expect(second?.cleanupIncompleteCreate()).toEqual({ status: "not-applicable" });
    expect(reused.volume).not.toBeNull();
  });

  it("refuses a same-name volume without exact NemoClaw ownership labels", () => {
    const name = managedHermesStateVolumeName(context.sandboxName);
    const docker = dockerHarness({ name, labels: { "com.example.owner": "foreign" } });

    expect(() =>
      prepareManagedHermesStateVolume(context, { runDocker: docker.runDocker as never }),
    ).toThrow(/exact NemoClaw ownership labels do not match/u);
    expect(docker.volume).not.toBeNull();
    expect(docker.calls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("removes only an exactly owned volume during sandbox destroy", () => {
    const owned = dockerHarness();
    const scope = prepareManagedHermesStateVolume(context, {
      runDocker: owned.runDocker as never,
      registerExitCleanup: () => () => undefined,
    });
    scope!.commit();

    expect(
      removeManagedHermesStateVolume(context, { runDocker: owned.runDocker as never }),
    ).toEqual({ status: "removed" });
    expect(owned.volume).toBeNull();

    const name = managedHermesStateVolumeName(context.sandboxName);
    const foreign = dockerHarness({ name, labels: { "com.example.owner": "foreign" } });
    expect(
      removeManagedHermesStateVolume(context, { runDocker: foreign.runDocker as never }),
    ).toMatchObject({ status: "not-owned", volumeName: name });
    expect(foreign.volume).not.toBeNull();
  });

  it("projects and retires the declared OpenClaw state root through the generic volume path", () => {
    const docker = dockerHarness();
    const roots = managedStartupStateRoots({
      agent: "openclaw",
      sandboxName: "alpha",
      agentIdentity: managedImageRuntimeIdentity("openclaw"),
    });
    const scope = prepareManagedStateVolumes(
      { roots },
      {
        runContainerEngine: docker.runDocker as never,
        registerExitCleanup: () => () => undefined,
      },
    );

    expect(scope?.mounts).toEqual([
      {
        type: "volume",
        source: "nemoclaw-openclaw-state-v1-alpha",
        target: MANAGED_OPENCLAW_STATE_ROOT,
        read_only: false,
      },
    ]);
    scope!.commit();
    expect(
      removeManagedAgentStateVolumes(
        { ...context, agentName: "openclaw" },
        { runDocker: docker.runDocker as never },
      ),
    ).toEqual([{ status: "removed" }]);
    expect(docker.volume).toBeNull();
  });

  it.each([
    ["agent", { ...context, agentName: "openclaw" }],
    ["provider", { ...context, runtimeProviderId: "kubernetes" }],
    ["workload", { ...context, workloadKind: "legacy-dockerfile" }],
  ])(
    "does not provision outside the managed container-engine Hermes %s boundary",
    (_boundary, input) => {
      const docker = dockerHarness();

      expect(
        prepareManagedHermesStateVolume(input, {
          runDocker: docker.runDocker as never,
          runtimeProviders: {
            docker: createDockerRuntimeProviderBundle(),
            kubernetes: createKubernetesRuntimeProviderBundle(),
          },
        }),
      ).toBeNull();
      expect(docker.calls).toEqual([]);
    },
  );
});
