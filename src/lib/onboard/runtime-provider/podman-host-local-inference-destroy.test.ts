// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createPodmanHostLocalInferenceTestHarness } from "../../../../test/helpers/podman-host-local-inference-test-harness";
import { createPodmanHostLocalInferenceOperation } from "./podman-host-local-inference";

describe("Podman host-local inference destroy", () => {
  it("retains externally owned Ollama without issuing a Podman remove", () => {
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
    const runtime = operation.managedRuntime!;
    expect(runtime, "test operation lacks managed runtime").toBeDefined();
    const prepared = runtime.qualifyOllama(
      {
        acceleration: "nvidia-gpu",
        networkName: harness.input.networkName,
        networkId: harness.input.networkId,
        networkGatewayIp: harness.input.networkGatewayIp,
        hostPort: 11434,
        probeImageRef: harness.input.probeImageRef,
        model: "nemotron:latest",
        requireToolCalling: true,
      },
      harness.writer,
    );
    prepared.validateBeforeCommit();
    const receipt = prepared.commit();
    harness.state.probeFailure = "ready";
    harness.events.length = 0;

    expect(runtime.prepareDestroy(receipt)).toEqual(receipt);
    expect(runtime.destroy(receipt)).toEqual({
      status: "retained",
      reason: "host-process",
      receipt,
    });
    expect(harness.events.some((event) => event.startsWith("podman:rm "))).toBe(false);
  });
});
