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

const probeId = "c".repeat(64);
const inspectEvent = `podman:container inspect ${probeId}`;

describe("Podman host-local inference post-create probe inspection", () => {
  it("settles two transport timeouts using the same full probe ID", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probePostCreateInspectTimeoutsRemaining = 2;

    const prepared = operationRuntime(harness).startManaged(harness.input, harness.writer);

    const waitIndex = harness.events.indexOf(`podman:wait ${probeId}`);
    expect(waitIndex).toBeGreaterThan(0);
    expect(
      harness.events.slice(0, waitIndex).filter((event) => event === inspectEvent),
    ).toHaveLength(3);
    expect(prepared.receipt.service).toBe("nim");
    expect(harness.probe()).toBeNull();
  });

  it("fails closed after the bounded settlement window without acting on the probe", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probePostCreateInspectTimeoutsRemaining = 3;
    harness.state.probeForbiddenActions = ["wait", "logs", "rm"];

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "probe identity is indeterminate after create",
    );

    expect(harness.events.filter((event) => event === inspectEvent)).toHaveLength(3);
    expect(harness.probe()).toMatchObject({ id: probeId });
    expect(harness.written).toHaveLength(0);
  });

  it("does not retry a non-timeout failure", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probePostCreateInspectFailuresRemaining = 1;
    harness.state.probeForbiddenActions = ["wait", "logs", "rm"];

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "probe identity is indeterminate after create",
    );

    expect(harness.events.filter((event) => event === inspectEvent)).toHaveLength(1);
    expect(harness.probe()).toMatchObject({ id: probeId });
    expect(harness.written).toHaveLength(0);
  });

  it("does not retry an inspect result with a mismatched container ID", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probePostCreateInspectTimeoutsRemaining = 2;
    harness.state.probeInspectRuntimeIdMismatchAt = 3;
    harness.state.probeForbiddenActions = ["wait", "logs", "rm"];

    expect(() => operationRuntime(harness).startManaged(harness.input, harness.writer)).toThrow(
      "probe identity is indeterminate after create",
    );

    expect(harness.events.filter((event) => event === inspectEvent)).toHaveLength(3);
    expect(harness.probe()).toMatchObject({ id: probeId });
    expect(harness.written).toHaveLength(0);
  });
});
