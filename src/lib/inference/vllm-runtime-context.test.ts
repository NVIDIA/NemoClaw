// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { applyVllmRuntimeContextWindow } from "../../../dist/lib/inference/vllm-runtime-context";

function applyContextWindow(
  modelsResponse: unknown,
  modelId = "model-a",
  env: NodeJS.ProcessEnv = {},
): { env: NodeJS.ProcessEnv; messages: string[] } {
  const messages: string[] = [];
  applyVllmRuntimeContextWindow(modelsResponse, modelId, {
    env,
    logger: {
      log: (message: string) => messages.push(message),
      warn: (message: string) => messages.push(message),
    },
  });
  return { env, messages };
}

describe("vLLM runtime context helpers", () => {
  it("applies valid vLLM /v1/models max_model_len values", () => {
    expect(
      applyContextWindow({ data: [{ id: "model-a", max_model_len: 65_536 }] }).env
        .NEMOCLAW_CONTEXT_WINDOW,
    ).toBe("65536");
    expect(
      applyContextWindow({ data: [{ id: "model-a", max_model_len: "262144" }] }).env
        .NEMOCLAW_CONTEXT_WINDOW,
    ).toBe("262144");
  });

  it("treats omitted max_model_len values as compatibility no-ops", () => {
    for (const value of [undefined, null, "   "]) {
      const { env, messages } = applyContextWindow({
        data: [{ id: "model-a", max_model_len: value }],
      });
      expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
      expect(messages).toEqual([]);
    }
  });

  it("warns and ignores malformed or non-positive max_model_len values", () => {
    for (const value of ["bogus", "1.5", 1.5, 0, -1]) {
      const { env, messages } = applyContextWindow({
        data: [{ id: "model-a", max_model_len: value }],
      });
      expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
      expect(messages.at(-1)).toContain("non-positive or malformed max_model_len");
    }
  });

  it("warns and ignores implausibly large max_model_len values", () => {
    const { env, messages } = applyContextWindow({
      data: [{ id: "model-a", max_model_len: 10_000_000 }],
    });
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
    expect(messages.at(-1)).toContain("above NemoClaw's auto-detect ceiling");
  });

  it("matches max_model_len by model id, then falls back to the first entry", () => {
    const response = {
      data: [
        { id: "model-a", max_model_len: 32_768 },
        { id: "model-b", max_model_len: 65_536 },
      ],
    };

    expect(applyContextWindow(response, "model-b").env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
    expect(applyContextWindow(response, "missing").env.NEMOCLAW_CONTEXT_WINDOW).toBe("32768");
    expect(applyContextWindow(response, "").env.NEMOCLAW_CONTEXT_WINDOW).toBe("32768");
  });

  it("applies detected max_model_len only when no explicit override is set", () => {
    const response = { data: [{ id: "model-a", max_model_len: 65_536 }] };

    const { env, messages } = applyContextWindow(response);
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
    expect(messages.at(-1)).toContain("Using vLLM max_model_len");

    const explicit = applyContextWindow(response, "model-a", {
      NEMOCLAW_CONTEXT_WINDOW: "131072",
    });
    expect(explicit.env.NEMOCLAW_CONTEXT_WINDOW).toBe("131072");
    expect(explicit.messages.at(-1)).toContain("Keeping configured context window");
  });
});
