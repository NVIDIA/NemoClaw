// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildConfig } from "../../scripts/generate-openclaw-config.mts";
import { baseOpenClawGenerationEnv } from "../helpers/openclaw-env-fixture";

describe("OpenClaw native local inference config", () => {
  it.each(["ollama-local", "vllm-local", "llama-cpp-local"])(
    "writes the selected native endpoint and opaque credential for %s (#12558)",
    (provider) => {
      const environment = {
        ...baseOpenClawGenerationEnv(),
        NEMOCLAW_UPSTREAM_PROVIDER: provider,
        NEMOCLAW_PROVIDER_KEY: "inference",
        NEMOCLAW_MODEL: "local-model",
        NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
        NEMOCLAW_INFERENCE_API: "openai-completions",
        OPENAI_API_KEY: "ambient-secret-must-not-escape",
      };
      const config = buildConfig(environment);
      expect(config.models.providers.inference).toMatchObject({
        baseUrl: "http://host.openshell.internal:11434/v1",
        apiKey: "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
        api: "openai-completions",
        models: [expect.objectContaining({ id: "local-model" })],
      });
      expect(JSON.stringify(config)).not.toContain("ambient-secret-must-not-escape");
    },
  );
});
