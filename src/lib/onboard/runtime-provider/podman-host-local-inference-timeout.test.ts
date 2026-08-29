// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createPodmanHostLocalInferenceTestHarness } from "../../../../test/helpers/podman-host-local-inference-test-harness";
import {
  createPodmanHostLocalInferenceOperation,
  PODMAN_INFERENCE_PROBE_MANAGED_LABEL,
} from "./podman-host-local-inference";

function operationAndRuntime(
  harness: ReturnType<typeof createPodmanHostLocalInferenceTestHarness>,
) {
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
  const runtime = operation.managedRuntime!;
  return { operation, runtime };
}

describe("Podman host-local inference timeout boundaries", () => {
  it("uses separate bounded timeouts for the readiness check and inference validation request (#9211)", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const { runtime } = operationAndRuntime(harness);

    runtime.startManaged(harness.input, harness.writer);

    const probeRuns = harness.events.filter(
      (event) =>
        event.startsWith("podman:run ") &&
        event.includes(`${PODMAN_INFERENCE_PROBE_MANAGED_LABEL}=true`),
    );
    const readyRun = probeRuns.find((event) => event.includes("/v1/health/ready"));
    const inferenceRun = probeRuns.find((event) => event.includes("/v1/chat/completions"));
    expect(readyRun).toContain("--retry-max-time 220");
    expect(readyRun).toContain("--max-time 20");
    expect(inferenceRun).toContain("--max-time 120");
    expect(inferenceRun).not.toContain("--retry-max-time");
    expect(harness.state.probeWaitTimeouts).toEqual([240_000, 150_000]);
  });

  it("removes an exact at-rest 20-second inference probe before recovery starts its replacement (#9211)", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const { operation, runtime } = operationAndRuntime(harness);
    harness.seedManaged("stopped", false, operation.bindingSha256);
    harness.state.retainLegacyInferenceProbe = true;
    harness.events.length = 0;

    const prepared = runtime.recoverManaged!(harness.input, harness.writer);

    const legacyRemoval = harness.events.indexOf(`podman:rm ${"c".repeat(64)}`);
    const replacementRun = harness.events.findIndex(
      (event) => event.startsWith("podman:run ") && event.includes("/v1/chat/completions"),
    );
    expect(legacyRemoval).toBeGreaterThanOrEqual(0);
    expect(replacementRun).toBeGreaterThan(legacyRemoval);
    expect(harness.events[replacementRun]).toContain("--max-time 120");
    expect(harness.probe()).toBeNull();
    expect(prepared.rollback()).toMatchObject({ status: "restored", priorState: "stopped" });
  });

  it("does not remove a running probe that has the legacy inference identity (#9211)", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const { operation, runtime } = operationAndRuntime(harness);
    harness.seedManaged("stopped", false, operation.bindingSha256);
    harness.state.retainLegacyInferenceProbe = true;
    harness.state.legacyInferenceProbeRunning = true;
    harness.events.length = 0;

    expect(() => runtime.recoverManaged?.(harness.input, harness.writer)).toThrow(
      "retained legacy probe is not in an exact at-rest state",
    );
    const retained = harness.probe();
    const legacyLookup = harness.events.findIndex((event) =>
      event.includes(`name=^${String(retained?.name)}$`),
    );
    expect(legacyLookup).toBeGreaterThanOrEqual(0);
    expect(
      harness.events
        .slice(legacyLookup + 1)
        .some((event) => event.startsWith("podman:rm ") && event.endsWith("c".repeat(64))),
    ).toBe(false);
    expect(retained).toMatchObject({ running: true, status: "running" });
  });
});
