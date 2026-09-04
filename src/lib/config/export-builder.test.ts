// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ObservedExportSource } from "./export-observation";
import { buildExportConfig } from "./export-builder";

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const policy = {
  version: 1,
  process: { run_as_user: "sandbox", run_as_group: "sandbox" },
  network_policies: {
    api: {
      name: "api",
      endpoints: [{ host: "api.example.com", port: 443 }],
      binaries: [{ path: "/usr/bin/openclaw" }],
    },
  },
  filesystem_policy: {
    include_workdir: false,
    read_only: ["/usr"],
    read_write: ["/sandbox"],
  },
};
const source: ObservedExportSource = {
  sandboxName: "alpha",
  registry: {
    name: "alpha",
    agent: "openclaw",
    openshellDriver: "docker",
    provider: "OpenAI API",
    model: "gpt-5",
    preferredInferenceApi: "openai-responses",
    endpointUrl: "https://api.openai.com/v1",
    credentialEnv: "OPENAI_API_KEY",
  },
  sandbox: {
    sandboxId: "018f47e2-9d93-7d15-9c41-3ecf70b2550f",
    fingerprint: "sha256:sandbox",
    lifecycleGeneration: "generation-1",
    identity: "live-sandbox-1",
  },
  gateway: {
    name: "nemoclaw",
    port: 8080,
    management: "nemoclaw",
    stateRootOwned: true,
    identity: "gateway-1",
  },
  workload: {
    schemaVersion: 1,
    kind: "managed-image",
    reference: `nvcr.io/nvidia/nemoclaw@${digest}`,
    platform: "linux/amd64",
    release: "1.0.0",
    sourceRevision: "abc",
    sourceCohort: "cohort",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile: "e30",
    startupProfileSha256: "sha256:profile",
    credentialProxyReplayRequired: false,
    shared: true,
  },
  inference: {
    topology: "hosted",
    provider: "OpenAI API",
    model: "gpt-5",
    api: "openai-responses",
    endpoint: "https://api.openai.com/v1",
    credentialEnv: "OPENAI_API_KEY",
    identity: "hosted-route-1",
  },
  policy,
  policyBasis: "verified-effective-state",
};

describe("export config builder", () => {
  it("maps verified source evidence into one validated aggregate (#10938)", () => {
    const result = buildExportConfig(source, "work-agents");

    expect(result).toMatchObject({
      apiVersion: "nemoclaw.nvidia.com/v1",
      kind: "NemoClawConfig",
      metadata: { name: "work-agents", uid: expect.any(String) },
      spec: {
        gateway: { management: "nemoclaw", name: "nemoclaw", port: 8080 },
        inferenceProviders: [
          {
            name: "hosted-openai-api",
            provider: "OpenAI API",
            api: "openai-responses",
            endpoint: "https://api.openai.com/v1",
            credential: { env: "OPENAI_API_KEY" },
          },
        ],
        sandboxes: [
          {
            name: "alpha",
            runtime: {
              provider: "docker",
              image: { ref: `nvcr.io/nvidia/nemoclaw@${digest}`, digest },
            },
            network: { policy: { explicit: policy } },
            agents: [
              {
                name: "primary",
                type: "openclaw",
                inference: {
                  routes: [
                    {
                      name: "primary",
                      providerRef: "hosted-openai-api",
                      overrides: { model: "gpt-5" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
    expect(result.metadata.uid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("creates fresh identity while keeping derived provider references deterministic (#10938)", () => {
    const first = buildExportConfig(source, "alpha");
    const second = buildExportConfig(source, "alpha");

    expect(second.metadata.uid).not.toBe(first.metadata.uid);
    expect(second.spec).toEqual(first.spec);
    expect(second.spec.inferenceProviders[0]?.name).toBe("hosted-openai-api");
    expect(second.spec.sandboxes[0]?.agents[0]?.inference.routes[0]?.providerRef).toBe(
      "hosted-openai-api",
    );
  });

  it("omits an absent hosted credential reference and validates the complete result (#10938)", () => {
    const credentialless = {
      ...source,
      registry: { ...source.registry, credentialEnv: null },
      inference: { ...source.inference, credentialEnv: null },
    };

    expect(buildExportConfig(credentialless, "alpha").spec.inferenceProviders[0]).toEqual({
      name: "hosted-openai-api",
      provider: "OpenAI API",
      api: "openai-responses",
      endpoint: "https://api.openai.com/v1",
    });
    expect(() => buildExportConfig(source, "Invalid Name")).toThrow("Invalid NemoClawConfig");
  });
});
