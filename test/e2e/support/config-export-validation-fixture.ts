// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ConfigExportDocument } from "../fixtures/phases/config-export-validation.ts";

export const CONFIG_EXPORT_POLICY = {
  version: 1,
  network_policies: {
    inference: {
      name: "inference",
      endpoints: [{ host: "inference.example", port: 443 }],
      binaries: [{ path: "/usr/bin/openclaw" }],
    },
  },
};

export function configExportDocument(
  overrides: {
    model?: string;
    observability?: boolean;
    credentialReference?: string;
  } = {},
): ConfigExportDocument {
  return {
    apiVersion: "nemoclaw.nvidia.com/v1alpha1",
    kind: "NemoClawConfig",
    metadata: { name: "export", uid: "123e4567-e89b-42d3-a456-426614174000" },
    spec: {
      gateway: {
        management: "managed",
        endpoint: "http://127.0.0.1:8080",
        networkCIDR: "172.30.50.0/24",
      },
      inferenceProviders: [
        {
          name: "hosted-compatible-endpoint",
          provider: "openai",
          api: "openai-completions",
          endpoint: "https://inference.example/v1",
          credential: { env: overrides.credentialReference ?? "NVIDIA_INFERENCE_API_KEY" },
        },
      ],
      sandboxes: [
        {
          name: "sandbox",
          runtime: { provider: "docker" },
          network: { policy: { explicit: CONFIG_EXPORT_POLICY } },
          harness: {
            kind: "openclaw",
            ...(overrides.observability
              ? {
                  observability: {
                    otlp: {
                      enabled: true,
                      endpoint: "http://host.openshell.internal:4318",
                      serviceName: "openclaw",
                      sampleRate: 1,
                    },
                  },
                }
              : {}),
          },
          agents: [
            {
              name: "primary",
              inference: {
                routes: [
                  {
                    name: "primary",
                    providerRef: "hosted-compatible-endpoint",
                    overrides: { model: overrides.model ?? "nvidia/model" },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  } as unknown as ConfigExportDocument;
}
