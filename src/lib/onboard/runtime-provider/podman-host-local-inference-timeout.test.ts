// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createPodmanHostLocalInferenceTestHarness } from "../../../../test/helpers/podman-host-local-inference-test-harness";
import {
  createPodmanHostLocalInferenceOperation,
  PODMAN_INFERENCE_PROBE_MANAGED_LABEL,
} from "./podman-host-local-inference";

describe("Podman host-local inference timeout boundaries", () => {
  it("uses separate bounded timeouts for the readiness check and inference validation request (#9211)", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const operation = createPodmanHostLocalInferenceOperation({
      engine: harness.engine,
      env: harness.env,
      acceleration: harness.operationAcceleration,
      authorityStore: harness.authorityStore,
      routeAuthorityStore: harness.routeAuthorityStore,
      onFailureEvidence: harness.onFailureEvidence,
      redactSensitive: harness.redactSensitive,
    });
    const runtime =
      operation.managedRuntime ??
      (() => {
        throw new Error("test operation lacks managed runtime");
      })();

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
});
