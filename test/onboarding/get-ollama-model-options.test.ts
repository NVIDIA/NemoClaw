// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getOllamaModelOptions,
  OLLAMA_HOST_DOCKER_INTERNAL,
  OLLAMA_LOCALHOST,
  resetOllamaHostCache,
  setResolvedOllamaHost,
} from "../../src/lib/inference/local.js";

type CapturedCall = { argv: readonly string[] };

function makeCapture(responses: ReadonlyArray<{ match: RegExp; output: string }>) {
  const calls: CapturedCall[] = [];
  const capture = ((cmd: string | readonly string[]) => {
    const argv = Array.isArray(cmd) ? (cmd as readonly string[]) : [cmd as string];
    calls.push({ argv });
    const joined = argv.join(" ");
    const hit = responses.find((r) => r.match.test(joined));
    return hit ? hit.output : "";
  }) as Parameters<typeof getOllamaModelOptions>[0];
  return { capture, calls };
}

describe("getOllamaModelOptions host-pinned fallback", () => {
  beforeEach(() => {
    resetOllamaHostCache();
  });

  it("returns no models when the Windows host reports an empty inventory", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const { capture, calls } = makeCapture([
      {
        match: /\/api\/tags/,
        output: JSON.stringify({ models: [] }),
      },
    ]);
    const models = getOllamaModelOptions(capture);
    expect(models).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].argv.join(" ")).toContain(
      `http://${OLLAMA_HOST_DOCKER_INTERNAL}:11434/api/tags`,
    );
    expect(calls.some((c) => c.argv.includes("ollama") && c.argv.includes("list"))).toBe(false);
  });

  it("falls back to `ollama list` on loopback when /api/tags is empty", () => {
    setResolvedOllamaHost(OLLAMA_LOCALHOST);
    const { capture, calls } = makeCapture([
      {
        match: /\/api\/tags/,
        output: JSON.stringify({ models: [] }),
      },
      {
        match: /ollama list/,
        output:
          "NAME           ID            SIZE    MODIFIED\nllama3.2:3b    abc123        2.0 GB  2 days ago\n",
      },
    ]);
    const models = getOllamaModelOptions(capture);
    expect(models).toEqual(["llama3.2:3b"]);
    expect(calls.some((c) => c.argv.includes("list"))).toBe(true);
  });

  it("returns parsed tags when /api/tags responds with models", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const { capture, calls } = makeCapture([
      {
        match: /\/api\/tags/,
        output: JSON.stringify({ models: [{ name: "qwen3.5:9b" }, { name: "gemma2:9b" }] }),
      },
    ]);
    const models = getOllamaModelOptions(capture);
    expect(models).toEqual(["qwen3.5:9b", "gemma2:9b"]);
    expect(calls.some((c) => c.argv.includes("list"))).toBe(false);
  });

  it("retries an invalid Windows-host inventory before returning installed models (#10259)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const outputs = [
      "",
      "<html>proxy response</html>",
      JSON.stringify({ models: [{ name: "qwen3.5:9b" }] }),
    ];
    const capture = vi.fn(() => outputs.shift() ?? "");
    const sleeps: number[] = [];

    const models = getOllamaModelOptions(capture, (milliseconds) => sleeps.push(milliseconds));

    expect(models).toEqual(["qwen3.5:9b"]);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1_000]);
  });

  it("rejects an invalid Windows-host inventory after bounded retries (#10259)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = vi.fn(() => "");
    const sleeps: number[] = [];

    expect(() =>
      getOllamaModelOptions(capture, (milliseconds) => sleeps.push(milliseconds)),
    ).toThrow(/Could not read Ollama models from host\.docker\.internal:11434 after 3 attempts/);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1_000]);
  });
});
