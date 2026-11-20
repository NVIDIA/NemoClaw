// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../../../src/lib/onboard/managed-startup/profile.ts";
import type { V1ParseSummary } from "../../support/v1-parse-consumer.ts";
import { V1_IMAGE_REF_PLACEHOLDER } from "../../../src/lib/domain/config/export-document.ts";
import type { ConfigExportDocument } from "../fixtures/phases/config-export-validation.ts";
import type { NemoClawInstance } from "../fixtures/phases/onboarding.ts";
import type { NemoClawInstanceManifest } from "../registry/types.ts";

export const IMAGE_REF = `nvcr.io/nvidia/nemoclaw@sha256:${"a".repeat(64)}`;
export const POLICY = {
  version: 1,
  network_policies: {
    inference: {
      name: "inference",
      endpoints: [{ host: "inference.example", port: 443 }],
      binaries: [{ path: "/usr/bin/openclaw" }],
    },
  },
};
export const PINNED_CONSUMER_EVIDENCE: V1ParseSummary = {
  revision: "d1d0c87e535f9c757f47dde6ee157e9859dd91fd",
  sandboxes: {
    sandbox: {
      harnessKind: "nvidia.fabric.openclaw",
      imageRef: V1_IMAGE_REF_PLACEHOLDER,
      integrationRefs: [],
    },
  },
  integrations: {},
};

export function manifest(
  features?: Record<string, unknown>,
  credentialRefs = ["NVIDIA_INFERENCE_API_KEY"],
  agent: "openclaw" | "hermes" = "openclaw",
): NemoClawInstanceManifest {
  return {
    apiVersion: "nemoclaw.io/v1",
    kind: "NemoClawInstance",
    metadata: { name: agent },
    spec: {
      setup: { install: {}, runtime: {}, platform: {} },
      onboarding: {
        agent,
        provider: "nvidia",
        modelRoute: "inference-local",
        policyTier: "personal",
        messaging: [],
        ...(features ? { features } : {}),
      },
      state: { credentialRefs },
    },
  };
}

export function document(
  overrides: {
    model?: string;
    credentialReference?: string;
    gatewayEndpoint?: string;
    agent?: "openclaw" | "hermes";
    searchProvider?: "brave" | "tavily";
  } = {},
): ConfigExportDocument {
  const gatewayEndpoint = overrides.gatewayEndpoint ?? "http://127.0.0.1:8080";
  return {
    apiVersion: "nemoclaw.nvidia.com/v1alpha1",
    kind: "NemoClawConfig",
    metadata: {
      name: "export",
      uid: "123e4567-e89b-42d3-a456-426614174000",
    },
    spec: {
      gateway: {
        management: "managed",
        runtime: { provider: "docker" },
        endpoint: gatewayEndpoint,
      },
      inferenceProviders: {
        "hosted-compatible-endpoint": {
          provider: "openai",
          api: "openai-completions",
          endpoint: "https://inference.example/v1",
          credential: { env: overrides.credentialReference ?? "NVIDIA_INFERENCE_API_KEY" },
        },
      },
      ...(overrides.searchProvider
        ? {
            integrations: {
              [`${overrides.searchProvider}-search`]: {
                kind: "webSearch",
                provider: overrides.searchProvider,
                credential: { env: `${overrides.searchProvider.toUpperCase()}_API_KEY` },
              },
            },
          }
        : {}),
      sandboxes: {
        sandbox: {
          image: { ref: V1_IMAGE_REF_PLACEHOLDER },
          network: { policy: { explicit: POLICY } },
          harness: { kind: `nvidia.fabric.${overrides.agent ?? "openclaw"}` },
          agent: {
            name: "primary",
            ...(overrides.agent === "hermes" ? { auth: { method: "api-key" } } : {}),
            ...(overrides.searchProvider
              ? { integrationRefs: [`${overrides.searchProvider}-search`] }
              : {}),
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
        },
      },
    },
  } as unknown as ConfigExportDocument;
}

export function instance(expectedFailure = false): NemoClawInstance {
  return {
    onboarding: "cloud-openclaw",
    sandboxName: "sandbox",
    agent: "openclaw",
    provider: "nvidia",
    providerEnv: "cloud",
    gatewayUrl: "http://127.0.0.1:18789",
    result: {} as NemoClawInstance["result"],
    ...(expectedFailure
      ? {
          expectedFailure: {
            phase: "onboarding" as const,
            errorClass: "policy-presets-required" as const,
          },
        }
      : {}),
  };
}

export function sourceProfile(agent: "openclaw" | "hermes", provider?: "brave" | "tavily"): string {
  const profile = managedStartupE2eProfile(agent);
  Object.assign(profile.agentConfig, {
    webSearch: {
      enabled: Boolean(provider),
      provider: provider ?? (agent === "hermes" ? "tavily" : "brave"),
    },
  });
  return encodeManagedStartupProfile(profile);
}

export function searchConsumerEvidence(
  agent: "openclaw" | "hermes",
  search: {
    provider: "brave" | "tavily";
    credentialReference: string;
    integrationRefs?: readonly string[];
  },
): V1ParseSummary {
  const integration = `${search.provider}-search`;
  return {
    ...PINNED_CONSUMER_EVIDENCE,
    sandboxes: {
      sandbox: {
        harnessKind: `nvidia.fabric.${agent}`,
        imageRef: V1_IMAGE_REF_PLACEHOLDER,
        integrationRefs: [...(search.integrationRefs ?? [integration])],
      },
    },
    integrations: {
      [integration]: { provider: search.provider, credentialReference: search.credentialReference },
    },
  };
}

export const SECRET = "fixture-secret-value";
export const ENCODED_SECRET = Buffer.from(SECRET, "utf8").toString("base64");
export const DIAGNOSTIC_SECRET_REPRESENTATIONS = [
  { name: "literal", value: SECRET },
  { name: "wrapped-literal", value: `${SECRET.slice(0, 7)}\n# ${SECRET.slice(7)}` },
  {
    name: "escaped-literal",
    value: `\\u${SECRET.charCodeAt(0).toString(16).padStart(4, "0")}${SECRET.slice(1)}`,
  },
  { name: "base64", value: ENCODED_SECRET },
  {
    name: "wrapped-base64",
    value: `${ENCODED_SECRET.slice(0, 12)}\n# ${ENCODED_SECRET.slice(12)}`,
  },
  {
    name: "escaped-base64",
    value: `\\u${ENCODED_SECRET.charCodeAt(0).toString(16).padStart(4, "0")}${ENCODED_SECRET.slice(1)}`,
  },
] as const;
export const INTERNAL_TRANSPORT = "openshell:resolve:env:KEY";
export const ENCODED_INTERNAL_TRANSPORT = Buffer.from(INTERNAL_TRANSPORT, "utf8").toString(
  "base64",
);
export const INTERNAL_TRANSPORT_REPRESENTATIONS = [
  {
    name: "escaped",
    value: [...INTERNAL_TRANSPORT]
      .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  },
  { name: "base64", value: ENCODED_INTERNAL_TRANSPORT },
  {
    name: "base64url",
    value: Buffer.from("openshell:resolve:env:ÿ", "utf8")
      .toString("base64")
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_"),
  },
  {
    name: "wrapped-base64",
    value: `${ENCODED_INTERNAL_TRANSPORT.slice(0, 16)}\n# ${ENCODED_INTERNAL_TRANSPORT.slice(16)}`,
  },
] as const;
