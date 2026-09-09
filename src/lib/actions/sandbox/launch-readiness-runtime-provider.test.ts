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
  provider: null,
  model: null,
  endpointUrl: null,
  credentialEnv: null,
  preferredInferenceApi: null,
  compatibleEndpointReasoning: null,
  compatibleEndpointReasoningEffort: null,
  nimContainer: null,
};

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
  });

  it("invalidates launch readiness when denied-tool intent changes (#11115)", () => {
    const bridge = {
      server: "github",
      agent: "openclaw",
      adapter: "mcporter",
      url: "https://mcp.example.test/mcp",
      env: ["GITHUB_TOKEN"],
      allowedIps: ["8.8.8.8"],
      providerName: "alpha-mcp-github",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-github",
      addedAt: "2026-09-05T00:00:00.000Z",
    };
    const project = (denyTools?: string[], pendingDenyTools?: string[]) =>
      buildLaunchReadinessRegistryProjection(
        {
          ...SANDBOX,
          mcp: {
            bridges: {
              github: {
                ...bridge,
                ...(denyTools ? { denyTools } : {}),
                ...(pendingDenyTools ? { pendingDenyTools } : {}),
              },
            },
          },
        },
        loadAgent("openclaw"),
      ) as { mcpSha256: string };

    expect(project().mcpSha256).not.toBe(project(["delete_*"]).mcpSha256);
    expect(project(["delete_*"]).mcpSha256).not.toBe(
      project(["delete_*", "submit_*"]).mcpSha256,
    );
    expect(project(["delete_*"], ["replacement_*"]).mcpSha256).not.toBe(
      project(["delete_*"]).mcpSha256,
    );
  });
});
