// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import {
  applyOllamaRuntimeContextWindow,
  parseOllamaRuntimeContextLength,
  probeOllamaRuntimeModelStatus,
  resetOllamaRuntimeContextWindowAutoState,
  resolveOllamaRuntimeContextWindow,
} from "../../../dist/lib/inference/ollama-runtime-context";

const getOllamaHost = () => "127.0.0.1";

describe("Ollama runtime context helpers", () => {
  afterEach(() => {
    resetOllamaRuntimeContextWindowAutoState();
  });

  it("parses valid Ollama /api/ps context lengths", () => {
    expect(parseOllamaRuntimeContextLength(262144)).toEqual({ contextLength: 262144 });
    expect(parseOllamaRuntimeContextLength("262144")).toEqual({ contextLength: 262144 });
  });

  it("treats omitted Ollama /api/ps context lengths as compatibility no-ops", () => {
    expect(parseOllamaRuntimeContextLength(undefined)).toEqual({});
    expect(parseOllamaRuntimeContextLength(null)).toEqual({});
    expect(parseOllamaRuntimeContextLength("   ")).toEqual({});

    const status = probeOllamaRuntimeModelStatus(
      "qwen3.6:35b",
      getOllamaHost,
      () => JSON.stringify({ models: [{ name: "qwen3.6:35b", processor: "100% GPU" }] }),
    );

    expect(status.loaded).toBe(true);
    expect(status.contextLength).toBeUndefined();
    expect(status.contextLengthWarning).toBeUndefined();
    expect(
      resolveOllamaRuntimeContextWindow("qwen3.6:35b", null, getOllamaHost, () =>
        JSON.stringify({ models: [{ name: "qwen3.6:35b" }] }),
      ),
    ).toBeNull();
  });

  it("warns and ignores malformed or non-positive Ollama /api/ps context lengths", () => {
    for (const value of ["bogus", "1.5", 0, -1]) {
      const parsed = parseOllamaRuntimeContextLength(value);
      expect(parsed.contextLength).toBeUndefined();
      expect(parsed.warning).toContain("non-positive or malformed context_length");
    }

    const status = probeOllamaRuntimeModelStatus(
      "qwen3.6:35b",
      getOllamaHost,
      () => JSON.stringify({ models: [{ name: "qwen3.6:35b", context_length: "bogus" }] }),
    );

    expect(status.loaded).toBe(true);
    expect(status.contextLength).toBeUndefined();
    expect(status.contextLengthWarning).toContain("non-positive or malformed context_length");
  });

  it("warns and ignores implausibly large Ollama /api/ps context lengths", () => {
    const parsed = parseOllamaRuntimeContextLength(10_000_000);
    expect(parsed.contextLength).toBeUndefined();
    expect(parsed.warning).toContain("above NemoClaw's auto-detect ceiling");

    const status = probeOllamaRuntimeModelStatus(
      "qwen3.6:35b",
      getOllamaHost,
      () => JSON.stringify({ models: [{ name: "qwen3.6:35b", context_length: 10_000_000 }] }),
    );

    expect(status.loaded).toBe(true);
    expect(status.contextLength).toBeUndefined();
    expect(status.contextLengthWarning).toContain("above NemoClaw's auto-detect ceiling");
    expect(
      resolveOllamaRuntimeContextWindow("qwen3.6:35b", null, getOllamaHost, () =>
        JSON.stringify({ models: [{ name: "qwen3.6:35b", context_length: 10_000_000 }] }),
      ),
    ).toBeNull();
  });

  it("resolves runtime context length only when no explicit override is set", () => {
    const capture = () =>
      JSON.stringify({
        models: [{ name: "qwen3.6:35b", context_length: "262144", processor: "100% GPU" }],
      });

    expect(
      resolveOllamaRuntimeContextWindow("qwen3.6:35b", null, getOllamaHost, capture),
    ).toBe(262144);
    expect(
      resolveOllamaRuntimeContextWindow("qwen3.6:35b", "131072", getOllamaHost, capture),
    ).toBeNull();
    expect(
      resolveOllamaRuntimeContextWindow("qwen3.6:35b", "bogus", getOllamaHost, capture),
    ).toBeNull();
    expect(
      resolveOllamaRuntimeContextWindow("qwen3.6:35b", "   ", getOllamaHost, capture),
    ).toBe(262144);
    expect(
      resolveOllamaRuntimeContextWindow("other:model", null, getOllamaHost, capture),
    ).toBeNull();
  });

  it("applies and clears only auto-detected context window state", () => {
    const env: NodeJS.ProcessEnv = {};
    const messages: string[] = [];
    let models: Array<{ name: string; context_length?: number }> = [];
    const options = {
      env,
      logger: {
        log: (message: string) => messages.push(message),
        warn: (message: string) => messages.push(message),
      },
      runCaptureImpl: () => JSON.stringify({ models }),
    };

    models = [{ name: "qwen3.6:35b", context_length: 262144 }];
    applyOllamaRuntimeContextWindow("qwen3.6:35b", getOllamaHost, options);
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("262144");

    models = [{ name: "qwen2.5:7b", context_length: 32768 }];
    applyOllamaRuntimeContextWindow("qwen2.5:7b", getOllamaHost, options);
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("32768");

    models = [];
    applyOllamaRuntimeContextWindow("qwen2.5:7b", getOllamaHost, options);
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();

    resetOllamaRuntimeContextWindowAutoState();
    env.NEMOCLAW_CONTEXT_WINDOW = "262144";
    models = [{ name: "qwen2.5:7b", context_length: 32768 }];
    applyOllamaRuntimeContextWindow("qwen2.5:7b", getOllamaHost, options);
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("262144");
    expect(messages.at(-1)).toContain("Keeping configured context window");
  });
});
