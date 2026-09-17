// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { validateV1Alpha1Export } from "./v1alpha1-export";

function document(): Record<string, unknown> {
  return {
    apiVersion: "nemoclaw.nvidia.com/v1alpha1",
    kind: "NemoClawConfig",
    metadata: { name: "alpha", uid: "018f47e2-9d93-7d15-9c41-3ecf70b2550f" },
    spec: {
      gateway: { management: "managed", endpoint: "http://127.0.0.1:8080" },
      inferenceProviders: [
        {
          name: "hosted-openai",
          provider: "openai",
          api: "openai-responses",
          endpoint: "https://api.openai.com/v1",
          credential: { env: "OPENAI_API_KEY" },
        },
      ],
      sandboxes: [
        {
          name: "alpha",
          runtime: { provider: "docker" },
          network: {
            policy: {
              explicit: {
                version: 1,
                process: { run_as_user: "1000", run_as_group: "1000" },
                filesystem_policy: {
                  include_workdir: false,
                  read_only: ["/usr", "/opt/fabric", "/opt/nemoclaw", "/app"],
                  read_write: ["/sandbox"],
                },
                network_policies: {
                  api: {
                    name: "api",
                    endpoints: [{ host: "api.openai.com", port: 443 }],
                    binaries: [{ path: "/usr/bin/openclaw" }],
                  },
                },
              },
            },
          },
          harness: { kind: "openclaw" },
          agents: [
            {
              name: "primary",
              inference: {
                routes: [
                  {
                    name: "primary",
                    providerRef: "hosted-openai",
                    overrides: { model: "gpt-5" },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  };
}

describe("v1alpha1 export validation", () => {
  it("accepts and freezes the directly consumable hosted subset (#11977)", () => {
    const input = document();
    const result = validateV1Alpha1Export(input);

    expect(result).toEqual(input);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.spec.sandboxes[0]!.network.policy.explicit)).toBe(true);
  });

  it.each([
    {
      label: "unknown output field",
      change: (value: MutableDocument) => {
        value.spec.sandboxes[0]!.image = { ref: "source-image" };
      },
    },
    {
      label: "mismatched provider driver",
      change: (value: MutableDocument) => {
        value.spec.inferenceProviders[0]!.provider = "anthropic";
      },
    },
    {
      label: "source process principal",
      change: (value: MutableDocument) => {
        value.spec.sandboxes[0]!.network.policy.explicit.process.run_as_user = "sandbox";
      },
    },
    {
      label: "missing Fabric runtime root",
      change: (value: MutableDocument) => {
        value.spec.sandboxes[0]!.network.policy.explicit.filesystem_policy.read_only = ["/usr"];
      },
    },
    {
      label: "unsafe inference endpoint",
      change: (value: MutableDocument) => {
        value.spec.inferenceProviders[0]!.endpoint = "https://user:secret@example.com/v1";
      },
    },
  ])("rejects $label before publication (#11977)", ({ change }) => {
    const input = document();
    change(input as unknown as MutableDocument);
    expect(() => validateV1Alpha1Export(input)).toThrow("Invalid v1alpha1 export");
  });
});

interface MutableDocument {
  spec: {
    inferenceProviders: Array<{ provider: string; endpoint: string }>;
    sandboxes: Array<{
      image?: { ref: string };
      network: {
        policy: {
          explicit: {
            process: { run_as_user: string };
            filesystem_policy: { read_only: string[] };
          };
        };
      };
    }>;
  };
}
