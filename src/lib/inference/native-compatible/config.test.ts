// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { nativeCompatibleEndpointIdentity } from "./endpoint";
import { getNativeCompatibleSandboxInferenceConfig } from "../config";
import { patchOpenClawInferenceConfig } from "../../actions/inference-set";
import type { ConfigObject } from "../../security/credential-filter";

describe("native compatible agent configuration", () => {
  it.each(["openai-completions", "openai-responses", "anthropic-messages"])(
    "uses the receipt endpoint for %s",
    (api) => {
      const identity = nativeCompatibleEndpointIdentity({
        addresses: ["93.184.216.34"],
        endpointUrl: "https://api.example.com/v1",
        api,
      });
      const receipt = {
        schemaVersion: 1 as const,
        profileId: identity.profileId,
        providerName: identity.providerName,
        providerId: "owned-provider",
        addresses: ["93.184.216.34"],
        endpointUrl: identity.endpoint,
        api: identity.api,
      };
      const provider =
        api === "anthropic-messages" ? "compatible-anthropic-endpoint" : "compatible-endpoint";
      const config = getNativeCompatibleSandboxInferenceConfig({
        provider,
        model: "model-a",
        endpointUrl: identity.endpoint,
        preferredInferenceApi: api,
        receipt,
      });
      const agentConfig: ConfigObject = {};
      patchOpenClawInferenceConfig(
        agentConfig,
        provider,
        "model-a",
        api,
        undefined,
        undefined,
        undefined,
        true,
        receipt,
      );
      expect(agentConfig).toMatchObject({
        models: {
          providers: {
            [config.providerKey]: {
              apiKey: "${NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY}",
            },
          },
        },
      });
      patchOpenClawInferenceConfig(agentConfig, "openai", "model-b");
      expect(JSON.stringify(agentConfig)).not.toContain("${NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY}");
      expect(agentConfig).toMatchObject({
        models: { providers: { inference: { apiKey: "unused" } } },
      });
      expect(config.inferenceBaseUrl).toBe(identity.endpoint);
      expect(config.inferenceApi).toBe(api);
      expect(config.inferenceCredentialEnv).toBe("NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY");
      expect(config.primaryModelRef).toContain("model-a");
      expect(JSON.stringify(config)).not.toContain("inference.local");
      expect(() =>
        getNativeCompatibleSandboxInferenceConfig({
          provider,
          model: "model-a",
          endpointUrl: "https://different.example.com/v1",
          preferredInferenceApi: api,
          receipt,
        }),
      ).toThrow("selected endpoint");
    },
  );
});
