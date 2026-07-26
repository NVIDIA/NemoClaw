// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { OLLAMA_PORT } from "../core/ports";
import {
  applyOllamaRuntimeContextWindow,
  getOllamaContextWindowFloorForAgent,
  MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW,
  MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
  parseOllamaRuntimeContextLength,
  probeOllamaRuntimeModelStatus,
  resetOllamaRuntimeContextWindowAutoState,
  resolveOllamaRuntimeContextWindow,
} from "./ollama-runtime-context";

const getOllamaHost = () => "127.0.0.1";

type OllamaRuntimeContextFailure = Extract<
  ReturnType<typeof applyOllamaRuntimeContextWindow>,
  { ok: false }
>;

function expectOllamaRuntimeContextFailure(
  result: ReturnType<typeof applyOllamaRuntimeContextWindow>,
): OllamaRuntimeContextFailure {
  expect(result.ok).toBe(false);
  return result as OllamaRuntimeContextFailure;
}

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

    const status = probeOllamaRuntimeModelStatus("qwen3.6:35b", getOllamaHost, () =>
      JSON.stringify({ models: [{ name: "qwen3.6:35b", processor: "100% GPU" }] }),
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

    const status = probeOllamaRuntimeModelStatus("qwen3.6:35b", getOllamaHost, () =>
      JSON.stringify({ models: [{ name: "qwen3.6:35b", context_length: "bogus" }] }),
    );

    expect(status.loaded).toBe(true);
    expect(status.contextLength).toBeUndefined();
    expect(status.contextLengthWarning).toContain("non-positive or malformed context_length");
  });

  it("warns and ignores implausibly large Ollama /api/ps context lengths", () => {
    const parsed = parseOllamaRuntimeContextLength(10_000_000);
    expect(parsed.contextLength).toBeUndefined();
    expect(parsed.warning).toContain("above NemoClaw's auto-detect ceiling");

    const status = probeOllamaRuntimeModelStatus("qwen3.6:35b", getOllamaHost, () =>
      JSON.stringify({ models: [{ name: "qwen3.6:35b", context_length: 10_000_000 }] }),
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

    expect(resolveOllamaRuntimeContextWindow("qwen3.6:35b", null, getOllamaHost, capture)).toBe(
      262144,
    );
    expect(
      resolveOllamaRuntimeContextWindow("qwen3.6:35b", "131072", getOllamaHost, capture),
    ).toBeNull();
    expect(
      resolveOllamaRuntimeContextWindow("qwen3.6:35b", "bogus", getOllamaHost, capture),
    ).toBeNull();
    expect(resolveOllamaRuntimeContextWindow("qwen3.6:35b", "   ", getOllamaHost, capture)).toBe(
      262144,
    );
    expect(
      resolveOllamaRuntimeContextWindow("other:model", null, getOllamaHost, capture),
    ).toBeNull();
  });

  it("raises the auto-adopted context window to the agent floor when the daemon reports below it", () => {
    const env: NodeJS.ProcessEnv = {};
    const messages: string[] = [];
    const options = {
      env,
      logger: {
        log: (message: string) => messages.push(message),
        warn: (message: string) => messages.push(message),
      },
      runCaptureImpl: () =>
        JSON.stringify({
          models: [{ name: "llama3.2:3b", context_length: 4096, processor: "100% GPU" }],
        }),
    };

    applyOllamaRuntimeContextWindow("llama3.2:3b", getOllamaHost, options);
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe(String(MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW));
    expect(messages.some((m) => m.includes("Raising Ollama runtime context window"))).toBe(true);
  });

  it("keeps the OpenClaw Ollama floor at 16384 and requires 64000 for Hermes", () => {
    expect(getOllamaContextWindowFloorForAgent(null)).toBe(MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW);
    expect(getOllamaContextWindowFloorForAgent("openclaw")).toBe(
      MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW,
    );
    expect(getOllamaContextWindowFloorForAgent("hermes")).toBe(MIN_HERMES_OLLAMA_CONTEXT_WINDOW);

    const env: NodeJS.ProcessEnv = {};
    const messages: string[] = [];
    const result = applyOllamaRuntimeContextWindow("llama3.2:1b", getOllamaHost, {
      env,
      contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
      logger: {
        log: (message: string) => messages.push(message),
        warn: (message: string) => messages.push(message),
      },
      runCaptureImpl: () =>
        JSON.stringify({
          models: [{ name: "llama3.2:1b", context_length: 16_384, processor: "100% GPU" }],
        }),
    });

    const failure = expectOllamaRuntimeContextFailure(result);
    expect(failure.message).toContain("context_length=16384");
    expect(failure.message).toContain("'llama3.2:1b'");
    expect(failure.message).toContain("required 64000-token window");
    expect(failure.message).toContain("OLLAMA_CONTEXT_LENGTH=64000");
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
    expect(messages.some((m) => m.includes("Raising Ollama runtime context window"))).toBe(false);
  });

  it("does not let an explicit prompt budget hide a below-floor Hermes daemon", () => {
    const env: NodeJS.ProcessEnv = { NEMOCLAW_CONTEXT_WINDOW: "64000" };
    const result = applyOllamaRuntimeContextWindow("llama3.2:1b", getOllamaHost, {
      env,
      contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
      logger: { log: () => {}, warn: () => {} },
      runCaptureImpl: () =>
        JSON.stringify({
          models: [{ name: "llama3.2:1b", context_length: 16_384 }],
        }),
    });

    const failure = expectOllamaRuntimeContextFailure(result);
    expect(failure.message).toContain("context_length=16384");
    expect(failure.message).toContain("OLLAMA_CONTEXT_LENGTH=64000");
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("64000");
  });

  it.each([
    ["no runtime response", ""],
    ["an unloaded model", JSON.stringify({ models: [] })],
    [
      "a missing context length",
      JSON.stringify({ models: [{ name: "llama3.2:1b", processor: "100% GPU" }] }),
    ],
    [
      "a malformed context length",
      JSON.stringify({ models: [{ name: "llama3.2:1b", context_length: "bogus" }] }),
    ],
  ])("fails closed for Hermes with %s", (_caseName, output) => {
    const env: NodeJS.ProcessEnv = {};
    const result = applyOllamaRuntimeContextWindow("llama3.2:1b", getOllamaHost, {
      env,
      contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
      logger: { log: () => {}, warn: () => {} },
      runCaptureImpl: () => output,
    });

    const failure = expectOllamaRuntimeContextFailure(result);
    expect(failure.message).toContain("did not report a valid runtime context_length");
    expect(failure.message).toContain("OLLAMA_CONTEXT_LENGTH=64000");
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
  });

  it("fails closed against Windows-host Ollama when runtime context is missing (#6760)", () => {
    const env: NodeJS.ProcessEnv = {};
    let probeCommand: readonly string[] = [];
    const result = applyOllamaRuntimeContextWindow("llama3.2:1b", () => "host.docker.internal", {
      env,
      contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
      logger: { log: () => {}, warn: () => {} },
      runCaptureImpl: (command) => {
        probeCommand = command;
        return JSON.stringify({ models: [{ name: "llama3.2:1b" }] });
      },
    });

    expect(probeCommand).toContain(`http://host.docker.internal:${OLLAMA_PORT}/api/ps`);
    const failure = expectOllamaRuntimeContextFailure(result);
    expect(failure.message).toContain("did not report a valid runtime context_length");
    expect(failure.message).toContain("OLLAMA_CONTEXT_LENGTH=64000");
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
  });

  it.each([64_000, 131_072])("accepts a Hermes daemon reporting context_length=%i", (context) => {
    const env: NodeJS.ProcessEnv = {};
    const result = applyOllamaRuntimeContextWindow("llama3.2:1b", getOllamaHost, {
      env,
      contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
      logger: { log: () => {}, warn: () => {} },
      runCaptureImpl: () =>
        JSON.stringify({ models: [{ name: "llama3.2:1b", context_length: context }] }),
    });

    expect(result).toEqual({ ok: true });
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe(String(context));
  });

  it("requires the daemon to satisfy an explicit Hermes context above the agent floor", () => {
    const env: NodeJS.ProcessEnv = { NEMOCLAW_CONTEXT_WINDOW: "131072" };
    const result = applyOllamaRuntimeContextWindow("llama3.2:1b", getOllamaHost, {
      env,
      contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
      logger: { log: () => {}, warn: () => {} },
      runCaptureImpl: () =>
        JSON.stringify({ models: [{ name: "llama3.2:1b", context_length: 64_000 }] }),
    });

    const failure = expectOllamaRuntimeContextFailure(result);
    expect(failure.message).toContain("required 131072-token window");
    expect(failure.message).toContain("OLLAMA_CONTEXT_LENGTH=131072");
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("131072");
  });

  it("clears only stale auto-detected state when strict Hermes validation fails", () => {
    const env: NodeJS.ProcessEnv = {};
    const logger = { log: () => {}, warn: () => {} };

    expect(
      applyOllamaRuntimeContextWindow("llama3.2:1b", getOllamaHost, {
        env,
        logger,
        runCaptureImpl: () =>
          JSON.stringify({ models: [{ name: "llama3.2:1b", context_length: 32_768 }] }),
      }),
    ).toEqual({ ok: true });
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("32768");

    const result = applyOllamaRuntimeContextWindow("llama3.2:1b", getOllamaHost, {
      env,
      contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
      logger,
      runCaptureImpl: () => JSON.stringify({ models: [] }),
    });

    expect(result.ok).toBe(false);
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
  });

  it("preserves a daemon-reported context window above the agent floor", () => {
    const env: NodeJS.ProcessEnv = {};
    const messages: string[] = [];
    const options = {
      env,
      logger: {
        log: (message: string) => messages.push(message),
        warn: (message: string) => messages.push(message),
      },
      runCaptureImpl: () =>
        JSON.stringify({
          models: [{ name: "qwen3.5:9b", context_length: 32_768, processor: "100% GPU" }],
        }),
    };

    applyOllamaRuntimeContextWindow("qwen3.5:9b", getOllamaHost, options);
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("32768");
    expect(messages.some((m) => m.includes("Raising Ollama runtime context window"))).toBe(false);
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
