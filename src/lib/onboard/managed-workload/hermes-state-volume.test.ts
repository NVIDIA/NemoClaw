// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createHermesStateVolumeDockerHarness as dockerHarness } from "../__test-helpers__/hermes-state-volume";
import {
  MANAGED_HERMES_STATE_ROOT,
  managedHermesStateVolumeName,
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

  it.each([
    ["agent", { ...context, agentName: "openclaw" }],
    ["provider", { ...context, runtimeProviderId: "kubernetes" }],
    ["workload", { ...context, workloadKind: "legacy-dockerfile" }],
  ])("does not provision outside the managed Docker Hermes %s boundary", (_boundary, input) => {
    const docker = dockerHarness();

    expect(
      prepareManagedHermesStateVolume(input, { runDocker: docker.runDocker as never }),
    ).toBeNull();
    expect(docker.calls).toEqual([]);
  });
});
