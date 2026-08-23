// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadAgent } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";
import { buildLaunchReadinessRegistryProjection } from "./launch-readiness";

const SANDBOX: SandboxEntry = {
  name: "alpha",
  openshellDriver: "docker",
  openshellVersion: "0.0.99",
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  lifecycleGeneration: "generation-1",
  lifecycleLiveIdentityFingerprint: "b".repeat(64),
  agent: "openclaw",
  agentVersion: "1.0.0",
  nemoclawVersion: "2.0.0",
  imageTag: "example@sha256:immutable",
  policyPresetsFinalized: true,
  policies: ["managed_inference"],
  policyTier: "standard",
  provider: null,
  model: null,
  endpointUrl: null,
  credentialEnv: null,
  preferredInferenceApi: null,
  compatibleEndpointReasoning: null,
  compatibleEndpointReasoningEffort: null,
  nimContainer: null,
};
const DIGEST = "c".repeat(64);

describe("launch readiness runtime-provider projection", () => {
  it("accepts qualification-registered providers without a provider-name branch", () => {
    const projection = buildLaunchReadinessRegistryProjection(
      { ...SANDBOX, openshellDriver: "podman" },
      loadAgent("openclaw"),
    ) as { openshellDriver: string };

    expect(projection.openshellDriver).toBe("podman");
    expect(() =>
      buildLaunchReadinessRegistryProjection(
        { ...SANDBOX, openshellDriver: "unregistered-runtime" },
        loadAgent("openclaw"),
      ),
    ).toThrow();
  });

  it("rejects in-progress lifecycle and policy mutations", () => {
    const agent = loadAgent("openclaw");
    expect(() =>
      buildLaunchReadinessRegistryProjection(
        { ...SANDBOX, pendingRouteReservation: true, reservationSessionId: "session" },
        agent,
      ),
    ).toThrow();
    expect(() =>
      buildLaunchReadinessRegistryProjection(
        {
          ...SANDBOX,
          baselineExclusionTransition: {
            id: "transition",
            operation: "exclude",
            exclusion: {
              version: 1,
              agent: "openclaw",
              key: "phone_home",
              digest: DIGEST,
            },
            targetLiveDigest: null,
            startedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        agent,
      ),
    ).toThrow();
  });
});
