// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { NemoClawConfig, NemoClawInferenceProviderConfig } from "./model";
import { validateNemoClawConfig } from "./schema";
import type { ObservedExportSource } from "./export-observation";

function providerLocalName(provider: string): string {
  const normalized = provider
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "");
  return `hosted-${normalized || "provider"}`.slice(0, 63).replace(/[^a-z0-9]+$/gu, "");
}

function inferenceProvider(
  source: ObservedExportSource,
  name: string,
): NemoClawInferenceProviderConfig {
  const provider = {
    name,
    provider: source.inference.provider,
    api: source.inference.api,
    endpoint: source.inference.endpoint,
  };
  return source.inference.credentialEnv === null
    ? provider
    : { ...provider, credential: { env: source.inference.credentialEnv } };
}

/** Build and validate an unbound aggregate document from one verified export observation. */
export function buildExportConfig(
  source: ObservedExportSource,
  documentName: string,
): NemoClawConfig {
  const providerName = providerLocalName(source.inference.provider);
  if (source.workload.kind !== "managed-image") {
    throw new Error("Verified export source must contain a managed image workload.");
  }
  const imageDigest = source.workload.reference.slice(source.workload.reference.indexOf("@") + 1);
  return validateNemoClawConfig({
    apiVersion: "nemoclaw.nvidia.com/v1",
    kind: "NemoClawConfig",
    metadata: { name: documentName, uid: randomUUID() },
    spec: {
      gateway: {
        management: "nemoclaw",
        name: source.gateway.name,
        port: source.gateway.port,
      },
      inferenceProviders: [inferenceProvider(source, providerName)],
      sandboxes: [
        {
          name: source.sandboxName,
          runtime: {
            provider: source.registry.openshellDriver,
            image: { ref: source.workload.reference, digest: imageDigest },
          },
          network: { policy: { explicit: source.policy } },
          agents: [
            {
              name: "primary",
              type: "openclaw",
              inference: {
                routes: [
                  {
                    name: "primary",
                    providerRef: providerName,
                    overrides: { model: source.inference.model },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  });
}
