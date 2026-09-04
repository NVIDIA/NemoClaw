// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  NemoClawConfig,
  NemoClawConfigDocumentName,
  NemoClawConfigDocumentUid,
  NemoClawInferenceProviderConfig,
  ValidatedNemoClawConfig,
} from "./model";
import { validateNemoClawConfig } from "./schema";
import type { VerifiedExportSource } from "./export-observation";

function providerLocalName(provider: string): string {
  const normalized = provider
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "");
  return `hosted-${normalized || "provider"}`.slice(0, 63).replace(/[^a-z0-9]+$/gu, "");
}

function inferenceProvider(
  source: VerifiedExportSource,
  name: string,
): NemoClawInferenceProviderConfig {
  const provider = {
    name,
    provider: source.inference.provider,
    api: source.inference.api,
    endpoint: source.inference.endpoint,
  };
  return source.inference.credentialEnv === undefined
    ? provider
    : { ...provider, credential: { env: source.inference.credentialEnv } };
}

export interface ExportConfigBuildIdentity {
  readonly documentName: NemoClawConfigDocumentName;
  readonly documentUid: NemoClawConfigDocumentUid;
}

/** Build and validate an unbound aggregate document from one verified export observation. */
export function buildExportConfig(
  source: VerifiedExportSource,
  identity: ExportConfigBuildIdentity,
): ValidatedNemoClawConfig {
  const providerName = providerLocalName(source.inference.provider);
  const candidate = {
    apiVersion: "nemoclaw.nvidia.com/v1",
    kind: "NemoClawConfig",
    metadata: { name: identity.documentName, uid: identity.documentUid },
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
            provider: source.runtime.provider,
            image: { ref: source.runtime.imageRef },
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
  } satisfies NemoClawConfig;
  return validateNemoClawConfig(candidate);
}
