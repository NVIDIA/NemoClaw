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
