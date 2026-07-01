// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ConfigObject } from "../security/credential-filter";
import { runInferenceSet } from "./inference-set";
import { baseSession, createDeps } from "./inference-set.test-support";

describe("runInferenceSet context window", () => {
  const ollamaConfig = (): ConfigObject => ({
    agents: { defaults: { model: { primary: "inference/llama3.2:3b" } } },
    models: {
      providers: {
        inference: {
          api: "openai-completions",
          models: [{ id: "llama3.2:3b", name: "inference/llama3.2:3b", contextWindow: 131072 }],
        },
      },
    },
  });

  function inferenceModels(config: ConfigObject): Array<Record<string, unknown>> {
    const models = config.models as { providers: { inference: { models: unknown } } };
    return models.providers.inference.models as Array<Record<string, unknown>>;
  }

  it("writes the recomputed context window into the in-sandbox config", async () => {
    const config = ollamaConfig();
    const deps = createDeps({ config, session: baseSession(), contextWindow: 16384 });

    await runInferenceSet({ provider: "ollama-local", model: "qwen2.5:7b", noVerify: true }, deps);

    expect(deps.calls.resolveContextWindowForModel).toHaveBeenCalledWith(
      "ollama-local",
      "qwen2.5:7b",
    );
    expect(inferenceModels(config)[0].contextWindow).toBe(16384);
    const logged = deps.calls.log.mock.calls.map((a) => String(a[0])).join("\n");
    expect(logged).toMatch(/Context window for 'qwen2\.5:7b': 16384 tokens/);
  });

  it("keeps the existing window and warns when it cannot be determined", async () => {
    const config = ollamaConfig();
    const deps = createDeps({ config, session: baseSession(), contextWindow: null });

    await runInferenceSet({ provider: "ollama-local", model: "qwen2.5:7b", noVerify: true }, deps);

    expect(inferenceModels(config)[0].contextWindow).toBe(131072);
    const logged = deps.calls.log.mock.calls.map((a) => String(a[0])).join("\n");
    expect(logged).toMatch(/could not determine the context window/i);
    expect(logged).toMatch(/rebuild/);
  });
});
