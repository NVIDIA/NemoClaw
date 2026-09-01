// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createHermesStateVolumeDockerHarness as dockerHarness } from "../__test-helpers__/hermes-state-volume";
import {
  MANAGED_HERMES_STATE_ROOT,
  managedHermesStateVolumeName,
  prepareManagedHermesStateVolume,
  removeManagedHermesStateVolume,
  removeRetainedManagedHermesStateVolume,
} from "./hermes-state-volume";

const context = {
  agentName: "hermes",
  runtimeProviderId: "docker",
  sandboxName: "alpha",
  workloadKind: "managed-image",
  createAttemptNonce: "a".repeat(62),
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

    expect(first?.mount.source).toBe(second?.mount.source);
    expect(registerExitCleanup).not.toHaveBeenCalled();
    expect(reused.calls.some((args) => args[0] === "create")).toBe(false);
    expect(second?.cleanupIncompleteCreate()).toEqual({ status: "not-applicable" });
    expect(reused.volume).not.toBeNull();
  });

  it("fails closed on fresh cross-attempt reuse and permits exact recovery authorization", () => {
    const created = dockerHarness();
    prepareManagedHermesStateVolume(context, {
      runDocker: created.runDocker as never,
      registerExitCleanup: () => () => undefined,
    })?.commit();
    const retry = dockerHarness(created.volume);
    const nextAttempt = { ...context, createAttemptNonce: "b".repeat(62) };

    expect(() =>
      prepareManagedHermesStateVolume(nextAttempt, { runDocker: retry.runDocker as never }),
    ).toThrow(/not authorized for create attempt/u);
    expect(
      prepareManagedHermesStateVolume(
        { ...nextAttempt, authorizedPriorCreateAttemptNonce: "a".repeat(62) },
        { runDocker: retry.runDocker as never },
      ),
    ).toMatchObject({
      recoveryDescriptor: null,
    });
  });

  it("refuses and leaves untouched a legacy four-label volume without create-attempt authority", () => {
    const name = managedHermesStateVolumeName(context.sandboxName);
    const legacy = dockerHarness({
      name,
      labels: {
        "io.nvidia.nemoclaw.hermes-state.managed": "true",
        "io.nvidia.nemoclaw.hermes-state.schema": "1",
        "io.nvidia.nemoclaw.hermes-state.sandbox": "alpha",
        "io.nvidia.nemoclaw.hermes-state.target": MANAGED_HERMES_STATE_ROOT,
      },
    });

    expect(() =>
      prepareManagedHermesStateVolume(context, { runDocker: legacy.runDocker as never }),
    ).toThrow(/not authorized for create attempt/u);
    expect(legacy.volume).not.toBeNull();
    expect(legacy.calls.filter((args) => args[0] === "rm")).toEqual([]);
  });

  it("removes a retained volume only with its exact name and create-attempt authority", () => {
    const name = managedHermesStateVolumeName(context.sandboxName);
    const created = dockerHarness();
    prepareManagedHermesStateVolume(context, {
      runDocker: created.runDocker as never,
      registerExitCleanup: () => () => undefined,
    })?.commit();
    const mismatched = dockerHarness(created.volume);

    expect(
      removeRetainedManagedHermesStateVolume(
        context.sandboxName,
        { name, createAttemptNonce: "b".repeat(62) },
        { runDocker: mismatched.runDocker as never },
      ),
    ).toMatchObject({ status: "not-owned", volumeName: name });
    expect(mismatched.volume).not.toBeNull();

    expect(
      removeRetainedManagedHermesStateVolume(
        context.sandboxName,
        { name, createAttemptNonce: context.createAttemptNonce },
        { runDocker: mismatched.runDocker as never },
      ),
    ).toEqual({ status: "removed" });
    expect(mismatched.volume).toBeNull();
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

    const name = managedHermesStateVolumeName(context.sandboxName);
    const mismatched = dockerHarness(owned.volume);
    expect(
      removeManagedHermesStateVolume(
        { ...context, createAttemptNonce: "b".repeat(62) },
        { runDocker: mismatched.runDocker as never },
      ),
    ).toMatchObject({ status: "not-owned", volumeName: name });
    expect(mismatched.volume).not.toBeNull();
    expect(mismatched.calls.filter((args) => args[0] === "rm")).toEqual([]);

    expect(
      removeManagedHermesStateVolume(context, { runDocker: mismatched.runDocker as never }),
    ).toEqual({ status: "removed" });
    expect(mismatched.volume).toBeNull();
  });

  it("leaves the volume untouched when ownership changes between deletion checks", () => {
    const name = managedHermesStateVolumeName(context.sandboxName);
    const labels = {
      "io.nvidia.nemoclaw.hermes-state.managed": "true",
      "io.nvidia.nemoclaw.hermes-state.schema": "1",
      "io.nvidia.nemoclaw.hermes-state.sandbox": "alpha",
      "io.nvidia.nemoclaw.hermes-state.target": MANAGED_HERMES_STATE_ROOT,
      "io.nvidia.nemoclaw.hermes-state.create-attempt": context.createAttemptNonce,
    };
    const runDocker = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ Name: name, Labels: labels }),
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ Name: name, Labels: { ...labels, "com.example.replaced": "true" } }),
        stderr: "",
      });

    expect(removeManagedHermesStateVolume(context, { runDocker })).toMatchObject({
      status: "not-owned",
      volumeName: name,
    });
    expect(runDocker).not.toHaveBeenCalledWith(["rm", name], expect.anything());
  });

  it("leaves a legacy successful registry volume untouched when nonce authority is absent", () => {
    const runDocker = vi.fn();

    expect(
      removeManagedHermesStateVolume(
        { ...context, createAttemptNonce: undefined },
        { runDocker: runDocker as never },
      ),
    ).toMatchObject({ status: "not-owned" });
    expect(runDocker).not.toHaveBeenCalled();
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
