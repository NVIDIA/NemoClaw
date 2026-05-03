// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "vitest";

import {
  getOllamaModelOptions,
  setResolvedOllamaHost,
  resetOllamaHostCache,
  OLLAMA_HOST_DOCKER_INTERNAL,
  OLLAMA_LOCALHOST,
} from "../dist/lib/local-inference.js";

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

  it("returns [] when resolved host is non-loopback and /api/tags is empty (no CLI fallback)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const { capture, calls } = makeCapture([]);
    const models = getOllamaModelOptions(capture);
    expect(models).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].argv.join(" ")).toContain(`http://${OLLAMA_HOST_DOCKER_INTERNAL}:11434/api/tags`);
    expect(calls.some((c) => c.argv.includes("ollama") && c.argv.includes("list"))).toBe(false);
  });

  it("falls back to `ollama list` on loopback when /api/tags is empty", () => {
    setResolvedOllamaHost(OLLAMA_LOCALHOST);
    const { capture, calls } = makeCapture([
      {
        match: /ollama list/,
        output: "NAME           ID            SIZE    MODIFIED\nllama3.2:3b    abc123        2.0 GB  2 days ago\n",
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
        output: JSON.stringify({ models: [{ name: "qwen2.5:7b" }, { name: "gemma2:9b" }] }),
      },
    ]);
    const models = getOllamaModelOptions(capture);
    expect(models).toEqual(["qwen2.5:7b", "gemma2:9b"]);
    expect(calls.some((c) => c.argv.includes("list"))).toBe(false);
  });
});
