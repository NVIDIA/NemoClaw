// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { VerifiedExportSource } from "./export-observation";
import { buildExportConfig } from "./export-builder";
import { parseNemoClawConfigDocumentName, parseNemoClawConfigDocumentUid } from "./model";

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const firstUid = parseNemoClawConfigDocumentUid("018f47e2-9d93-7d15-9c41-3ecf70b2550f");
const secondUid = parseNemoClawConfigDocumentUid("018f47e2-9d93-7d15-9c41-3ecf70b25510");
const alphaDocumentName = parseNemoClawConfigDocumentName("alpha");
const workAgentsDocumentName = parseNemoClawConfigDocumentName("work-agents");
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
const source = {
  sandboxName: "alpha",
  runtime: {
    provider: "docker",
    imageRef: `nvcr.io/nvidia/nemoclaw@${digest}`,
  },
  gateway: { name: "nemoclaw", port: 8080 },
  inference: {
    provider: "openai-api",
    model: "gpt-5",
    api: "openai-responses",
    endpoint: "https://api.openai.com/v1",
    credentialEnv: "OPENAI_API_KEY",
  },
  policy,
} as unknown as VerifiedExportSource;

describe("export config builder", () => {
  it("maps a verified source into one validated aggregate (#10938)", () => {
    const result = buildExportConfig(source, {
      documentName: workAgentsDocumentName,
      documentUid: firstUid,
    });

    expect(result).toMatchObject({
      apiVersion: "nemoclaw.nvidia.com/v1",
      kind: "NemoClawConfig",
      metadata: { name: "work-agents", uid: firstUid },
      spec: {
        gateway: { management: "nemoclaw", name: "nemoclaw", port: 8080 },
        inferenceProviders: [
          {
            name: "hosted-openai-api",
            provider: "openai-api",
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
              image: { ref: `nvcr.io/nvidia/nemoclaw@${digest}` },
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
  });

  it("uses the supplied identity and keeps derived references deterministic (#10938)", () => {
    const first = buildExportConfig(source, {
      documentName: alphaDocumentName,
      documentUid: firstUid,
    });
    const second = buildExportConfig(source, {
      documentName: alphaDocumentName,
      documentUid: secondUid,
    });

    expect(second.metadata.uid).toBe(secondUid);
    expect(second.metadata.uid).not.toBe(first.metadata.uid);
    expect(second.spec).toEqual(first.spec);
    expect(second.spec.inferenceProviders[0]?.name).toBe("hosted-openai-api");
    expect(second.spec.sandboxes[0]?.agents[0]?.inference.routes[0]?.providerRef).toBe(
      "hosted-openai-api",
    );
  });

  it("omits an absent hosted credential reference and validates the result (#10938)", () => {
    const credentialless: VerifiedExportSource = {
      ...source,
      inference: { ...source.inference, credentialEnv: undefined },
    };

    expect(
      buildExportConfig(credentialless, {
        documentName: alphaDocumentName,
        documentUid: firstUid,
      }).spec.inferenceProviders[0],
    ).toEqual({
      name: "hosted-openai-api",
      provider: "openai-api",
      api: "openai-responses",
      endpoint: "https://api.openai.com/v1",
    });
  });
});
