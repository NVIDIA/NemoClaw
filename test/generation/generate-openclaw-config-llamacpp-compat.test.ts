// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildConfig } from "../../scripts/generate-openclaw-config.mts";
import { baseOpenClawGenerationEnv } from "../helpers/openclaw-env-fixture";

function buildLlamaCppConfig(upstreamProvider: string, compat: Record<string, unknown> = {}): any {
  return buildConfig({
    ...baseOpenClawGenerationEnv(),
    NEMOCLAW_MODEL: "nemotron-3-nano-30b-a3b",
    NEMOCLAW_PROVIDER_KEY: "inference",
    NEMOCLAW_UPSTREAM_PROVIDER: upstreamProvider,
    NEMOCLAW_PRIMARY_MODEL_REF: "inference/nemotron-3-nano-30b-a3b",
    NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
    NEMOCLAW_INFERENCE_API: "openai-completions",
    NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from(JSON.stringify(compat)).toString("base64"),
  });
}

describe("managed llama.cpp OpenClaw compatibility", () => {
  it("selects OpenClaw's llama.cpp tool-schema profile for the managed inference route", () => {
    const config = buildLlamaCppConfig("llama-cpp-local", { supportsTools: true });
    const model = config.models.providers.inference.models[0];

    expect(model.compat).toEqual({
      supportsTools: true,
      toolSchemaProfile: "llamacpp",
    });
  });

  it("does not select the llama.cpp profile for another upstream provider", () => {
    const config = buildLlamaCppConfig("vllm-local");
    const model = config.models.providers.inference.models[0];

    expect(model.compat?.toolSchemaProfile).toBeUndefined();
  });
});

describe("native local OpenClaw generation", () => {
  it("writes a scoped local credential reference for an attached endpoint", () => {
    const config = buildConfig({
      ...baseOpenClawGenerationEnv(),
      NEMOCLAW_MODEL: "local-model",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_UPSTREAM_PROVIDER: "ollama-local",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/local-model",
      NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11435/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
    });
    expect(config.models.providers.inference).toMatchObject({
      baseUrl: "http://host.openshell.internal:11435/v1",
      apiKey: "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    });
  });

  it("keeps a shared local selection on inference.local", () => {
    const config = buildLlamaCppConfig("vllm-local");
    expect(config.models.providers.inference).toMatchObject({
      baseUrl: "https://inference.local/v1",
      apiKey: "unused",
    });
  });
});
