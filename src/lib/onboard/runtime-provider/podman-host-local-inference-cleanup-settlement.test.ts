// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createPodmanHostLocalInferenceTestHarness } from "../../../../test/helpers/podman-host-local-inference-test-harness";
import type { HostLocalInferenceRuntime } from "./host-local-inference";
import { createPodmanHostLocalInferenceOperation } from "./podman-host-local-inference";

function operationRuntime(
  harness: ReturnType<typeof createPodmanHostLocalInferenceTestHarness>,
): HostLocalInferenceRuntime {
  const operation = createPodmanHostLocalInferenceOperation({
    engine: harness.engine,
    env: harness.env,
    acceleration: harness.operationAcceleration,
    probeCleanupTiming: harness.probeCleanupTiming,
    authorityStore: harness.authorityStore,
    routeAuthorityStore: harness.routeAuthorityStore,
    onFailureEvidence: harness.onFailureEvidence,
    redactSensitive: harness.redactSensitive,
  });
  return (
    operation.managedRuntime ??
    (() => {
      throw new Error("test operation lacks managed runtime");
    })()
  );
}

describe("Podman inference disposable-probe cleanup settlement", () => {
  it("retries a timed-out pre-remove inspection before removing the same exact probe", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeCleanupInspectTimeoutsRemaining = 1;

    const prepared = operationRuntime(harness).startManaged(harness.input, harness.writer);

    expect(prepared.receipt.service).toBe("nim");
    expect(harness.probe()).toBeNull();
    expect(
      harness.events.filter((event) => event === `podman:rm --force ${"c".repeat(64)}`),
    ).toHaveLength(2);
  });

  it("does not remove a probe that reached exact ID and name absence before cleanup", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeDisappearBeforeCleanupCount = 1;

    const prepared = operationRuntime(harness).startManaged(harness.input, harness.writer);

    expect(prepared.receipt.service).toBe("nim");
    expect(harness.probe()).toBeNull();
    expect(
      harness.events.filter((event) => event === `podman:rm --force ${"c".repeat(64)}`),
    ).toHaveLength(1);
  });

  it("settles delayed exact ID and name absence after one removal", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeRemovalIdObservationsRemaining = 1;
    harness.state.probeRemovalNameObservationsRemaining = 2;

    const prepared = operationRuntime(harness).startManaged(harness.input, harness.writer);

    const sleeps = harness.events
      .filter((event) => event.startsWith("probe-cleanup:sleep "))
      .map((event) => Number(event.slice("probe-cleanup:sleep ".length)));
    expect(prepared.receipt.service).toBe("nim");
    expect(harness.probe()).toBeNull();
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((delay) => delay === 1_000)).toBe(true);
    expect(sleeps.reduce((total, delay) => total + delay, 0)).toBeLessThanOrEqual(30_000);
    expect(
      harness.events.filter((event) => event === `podman:rm --force ${"c".repeat(64)}`),
    ).toHaveLength(2);
  });

  it("accepts a nonzero removal result only after delayed exact absence", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeRemoveLostAcknowledgement = true;
    harness.state.probeRemovalIdObservationsRemaining = 1;
    harness.state.probeRemovalNameObservationsRemaining = 1;

    const prepared = operationRuntime(harness).startManaged(harness.input, harness.writer);

    expect(prepared.receipt.service).toBe("nim");
    expect(harness.probe()).toBeNull();
    expect(
      harness.events.filter((event) => event === `podman:rm --force ${"c".repeat(64)}`),
    ).toHaveLength(2);
    expect(
      harness.failures.some(({ message }) => message.includes("probe removal returned exit 125")),
    ).toBe(true);
  });

  it("accepts a timed-out removal result only after delayed exact absence", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeRemoveTimeout = true;
    harness.state.probeRemovalIdObservationsRemaining = 1;
    harness.state.probeRemovalNameObservationsRemaining = 1;

    const prepared = operationRuntime(harness).startManaged(harness.input, harness.writer);

    expect(prepared.receipt.service).toBe("nim");
    expect(harness.probe()).toBeNull();
    expect(
      harness.events.filter((event) => event === `podman:rm --force ${"c".repeat(64)}`),
    ).toHaveLength(2);
    expect(
      harness.failures.some(({ message }) => message.includes("probe removal returned exit 1")),
    ).toBe(true);
  });

  it("stops after one removal when the exact probe remains through the deadline", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeRemoveLeavesContainer = true;

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "probe cleanup is indeterminate",
    );

    const sleeps = harness.events
      .filter((event) => event.startsWith("probe-cleanup:sleep "))
      .map((event) => Number(event.slice("probe-cleanup:sleep ".length)));
    expect(sleeps.reduce((total, delay) => total + delay, 0)).toBe(30_000);
    expect(
      harness.events.filter((event) => event === `podman:rm --force ${"c".repeat(64)}`),
    ).toHaveLength(1);
    expect(harness.probe()).not.toBeNull();
  });

  it("accepts exact absence and final currentness at the settlement deadline", () => {
    const clock = [0, 30_000, 30_000, 30_000, 30_000, 30_000];
    const harness = createPodmanHostLocalInferenceTestHarness({
      probeCleanupTiming: {
        now: () => clock.shift() ?? 30_000,
        sleep: () => undefined,
      },
    });

    const prepared = operationRuntime(harness).startManaged(harness.input, harness.writer);

    expect(prepared.receipt.service).toBe("nim");
    expect(harness.probe()).toBeNull();
    expect(
      harness.events.filter((event) => event === `podman:rm --force ${"c".repeat(64)}`),
    ).toHaveLength(2);
  });

  it("rejects absence first observed after the settlement deadline", () => {
    const clock = [0, 30_001];
    const harness = createPodmanHostLocalInferenceTestHarness({
      probeCleanupTiming: {
        now: () => clock.shift() ?? 30_001,
        sleep: () => undefined,
      },
    });

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "probe cleanup is indeterminate",
    );
    expect(harness.probe()).toBeNull();
    expect(harness.container()).toBeNull();
    expect(
      harness.events.filter((event) => event === `podman:rm --force ${"c".repeat(64)}`),
    ).toHaveLength(1);
  });

  it("rejects final authority currentness that completes after the settlement deadline", () => {
    const clock = [0, 30_000, 30_001];
    const harness = createPodmanHostLocalInferenceTestHarness({
      probeCleanupTiming: {
        now: () => clock.shift() ?? 30_001,
        sleep: () => undefined,
      },
    });

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "probe cleanup is indeterminate",
    );
    expect(harness.probe()).toBeNull();
    expect(harness.container()).toBeNull();
    expect(
      harness.events.filter((event) => event === `podman:rm --force ${"c".repeat(64)}`),
    ).toHaveLength(1);
  });

  it("rejects probe label drift after removal without a second mutation", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeRemovalIdObservationsRemaining = 1;
    harness.state.probeCleanupLabelDriftAfterRemoval = true;

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "probe cleanup is indeterminate",
    );

    expect(
      harness.events.filter((event) => event === `podman:rm --force ${"c".repeat(64)}`),
    ).toHaveLength(1);
    expect(harness.probe()).not.toBeNull();
    expect(harness.container()).toBeNull();
  });

  it("rejects probe spec drift after removal without a second mutation", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeRemovalIdObservationsRemaining = 1;
    harness.state.probeCleanupSpecDriftAfterRemoval = true;

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "probe cleanup is indeterminate",
    );

    expect(
      harness.events.filter((event) => event === `podman:rm --force ${"c".repeat(64)}`),
    ).toHaveLength(1);
    expect(harness.probe()).not.toBeNull();
    expect(harness.container()).toBeNull();
  });

  it("rejects a terminal existence-read failure without removal or settlement sleep", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeCleanupExistenceFailure = true;

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "probe cleanup lost exact identity",
    );
    expect(harness.events.some((event) => event === `podman:rm --force ${"c".repeat(64)}`)).toBe(
      false,
    );
    expect(harness.events.some((event) => event.startsWith("probe-cleanup:sleep "))).toBe(false);
    expect(harness.probe()).not.toBeNull();
  });

  it("rejects a terminal inspect-read failure without removal or settlement sleep", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeCleanupInspectFailure = true;

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "probe cleanup lost exact identity",
    );
    expect(harness.events.some((event) => event === `podman:rm --force ${"c".repeat(64)}`)).toBe(
      false,
    );
    expect(harness.events.some((event) => event.startsWith("probe-cleanup:sleep "))).toBe(false);
    expect(harness.probe()).not.toBeNull();
  });

  it("rejects a malformed inspection without removal or settlement sleep", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeCleanupMalformedInspection = true;

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "probe cleanup lost exact identity",
    );
    expect(harness.events.some((event) => event === `podman:rm --force ${"c".repeat(64)}`)).toBe(
      false,
    );
    expect(harness.events.some((event) => event.startsWith("probe-cleanup:sleep "))).toBe(false);
    expect(harness.probe()).not.toBeNull();
  });

  it("rejects an ambiguous name lookup without removal or settlement sleep", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeCleanupAmbiguousLookup = true;

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "probe cleanup lost exact identity",
    );
    expect(harness.events.some((event) => event === `podman:rm --force ${"c".repeat(64)}`)).toBe(
      false,
    );
    expect(harness.events.some((event) => event.startsWith("probe-cleanup:sleep "))).toBe(false);
    expect(harness.probe()).not.toBeNull();
  });

  it("rejects network-authority drift before probe removal", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeNetworkDriftBeforeRemoval = true;

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "Podman inference network identity or name changed after qualification.",
    );
    expect(harness.events.some((event) => event === `podman:rm --force ${"c".repeat(64)}`)).toBe(
      false,
    );
    expect(harness.probe()).not.toBeNull();
    expect(harness.container()).toBeNull();
  });

  it("restores the parent after network-authority drift during cleanup settlement", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeNetworkDriftAfterRemoval = true;

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "probe cleanup is indeterminate",
    );
    expect(harness.probe()).toBeNull();
    expect(harness.container()).toBeNull();
    expect(
      harness.events.filter((event) => event === `podman:rm --force ${"c".repeat(64)}`),
    ).toHaveLength(1);
  });

  it("reports restoration failure after engine drift during cleanup settlement", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeEngineDriftAfterRemoval = true;

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "Exact prior-runtime restoration also failed",
    );
    expect(harness.probe()).toBeNull();
    expect(harness.container()).not.toBeNull();
    expect(
      harness.events.filter((event) => event === `podman:rm --force ${"c".repeat(64)}`),
    ).toHaveLength(1);
  });

  it("reports restoration failure after engine drift before probe removal", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeEngineDriftBeforeRemoval = true;

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "Exact prior-runtime restoration also failed",
    );
    expect(harness.events.some((event) => event === `podman:rm --force ${"c".repeat(64)}`)).toBe(
      false,
    );
    expect(harness.probe()).not.toBeNull();
    expect(harness.container()).not.toBeNull();
  });

  it("rejects an invalid cleanup clock after the single removal", () => {
    const harness = createPodmanHostLocalInferenceTestHarness({
      probeCleanupTiming: { now: () => Number.NaN, sleep: () => undefined },
    });

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "probe cleanup is indeterminate",
    );
    expect(
      harness.events.filter((event) => event === `podman:rm --force ${"c".repeat(64)}`),
    ).toHaveLength(1);
    expect(harness.container()).toBeNull();
  });

  it("rejects a backward cleanup clock during settlement", () => {
    const clock = [1_000, 1_000, 999];
    const harness = createPodmanHostLocalInferenceTestHarness({
      probeCleanupTiming: {
        now: () => clock.shift() ?? 999,
        sleep: () => undefined,
      },
    });
    harness.state.probeRemoveLeavesContainer = true;

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "probe cleanup is indeterminate",
    );
    expect(
      harness.events.filter((event) => event === `podman:rm --force ${"c".repeat(64)}`),
    ).toHaveLength(1);
    expect(harness.probe()).not.toBeNull();
  });
});
