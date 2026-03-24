// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import {
  CONTAINER_REACHABILITY_IMAGE,
  DEFAULT_OLLAMA_MODEL,
  getDefaultOllamaModel,
  getLocalProviderBaseUrl,
  getLocalProviderContainerReachabilityCheck,
  getLocalProviderHealthCheck,
  getOllamaModelOptions,
  getOllamaProbeCommand,
  getOllamaWarmupCommand,
  parseOllamaList,
  parseOllamaTags,
  validateOllamaModel,
  validateLocalProvider,
} from "../bin/lib/local-inference";

describe("local inference helpers", () => {
  it("returns the expected base URL for vllm-local", () => {
    expect(getLocalProviderBaseUrl("vllm-local")).toBe("http://host.openshell.internal:8000/v1");
  });

  it("returns the expected base URL for ollama-local", () => {
    expect(getLocalProviderBaseUrl("ollama-local")).toBe("http://host.openshell.internal:11434/v1");
  });

  it("returns the expected health check command for ollama-local", () => {
    expect(getLocalProviderHealthCheck("ollama-local")).toBe("curl -sf http://localhost:11434/api/tags 2>/dev/null");
  });

  it("returns the expected container reachability command for ollama-local", () => {
    expect(getLocalProviderContainerReachabilityCheck("ollama-local")).toBe(
      `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:11434/api/tags 2>/dev/null`
    );
  });

  it("validates a reachable local provider", () => {
    let callCount = 0;
    const result = validateLocalProvider("ollama-local", () => {
      callCount += 1;
      return '{"models":[]}';
    });
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(2);
  });

  it("returns a clear error when ollama-local is unavailable", () => {
    const result = validateLocalProvider("ollama-local", () => "");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/http:\/\/localhost:11434/);
  });

  it("returns a clear error when ollama-local is not reachable from containers", () => {
    let callCount = 0;
    const result = validateLocalProvider("ollama-local", () => {
      callCount += 1;
      return callCount === 1 ? '{"models":[]}' : "";
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/host\.openshell\.internal:11434/);
    expect(result.message).toMatch(/0\.0\.0\.0:11434/);
  });

  it("returns a clear error when vllm-local is unavailable", () => {
    const result = validateLocalProvider("vllm-local", () => "");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/http:\/\/localhost:8000/);
  });

  it("parses model names from ollama list output", () => {
    expect(parseOllamaList(
      [
        "NAME                        ID              SIZE      MODIFIED",
        "nemotron-3-nano:30b         abc123          24 GB     2 hours ago",
        "qwen3:32b                   def456          20 GB     1 day ago",
      ].join("\n"),
    )).toEqual(["nemotron-3-nano:30b", "qwen3:32b"]);
  });

  it("returns parsed ollama model options when available", () => {
    expect(
      getOllamaModelOptions(() => "nemotron-3-nano:30b  abc  24 GB  now\nqwen3:32b  def  20 GB  now")
    ).toEqual(["nemotron-3-nano:30b", "qwen3:32b"]);
  });

  it("parses installed models from Ollama /api/tags output", () => {
    expect(
      parseOllamaTags(
        JSON.stringify({
          models: [
            { name: "nemotron-3-nano:30b" },
            { name: "qwen2.5:7b" },
          ],
        })
      )
    ).toEqual(["nemotron-3-nano:30b", "qwen2.5:7b"]);
  });

  it("prefers Ollama /api/tags over parsing the CLI list output", () => {
    let call = 0;
    expect(
      getOllamaModelOptions(() => {
        call += 1;
        if (call === 1) {
          return JSON.stringify({ models: [{ name: "qwen2.5:7b" }] });
        }
        return "";
      })
    ).toEqual(["qwen2.5:7b"]);
  });

  it("returns no installed ollama models when list output is empty", () => {
    expect(getOllamaModelOptions(() => "")).toEqual([]);
  });

  it("prefers the default ollama model when present", () => {
    expect(
      getDefaultOllamaModel(() => "qwen3:32b  abc  20 GB  now\nnemotron-3-nano:30b  def  24 GB  now")
    ).toBe(DEFAULT_OLLAMA_MODEL);
  });

  it("falls back to the first listed ollama model when the default is absent", () => {
    expect(
      getDefaultOllamaModel(() => "qwen3:32b  abc  20 GB  now\ngemma3:4b  def  3 GB  now")
    ).toBe("qwen3:32b");
  });

  it("builds a background warmup command for ollama models", () => {
    const command = getOllamaWarmupCommand("nemotron-3-nano:30b");
    expect(command).toMatch(/^nohup curl -s http:\/\/localhost:11434\/api\/generate /);
    expect(command).toMatch(/"model":"nemotron-3-nano:30b"/);
    expect(command).toMatch(/"keep_alive":"15m"/);
  });

  it("builds a foreground probe command for ollama models", () => {
    const command = getOllamaProbeCommand("nemotron-3-nano:30b");
    expect(command).toMatch(/^curl -sS --max-time 120 http:\/\/localhost:11434\/api\/generate /);
    expect(command).toMatch(/"model":"nemotron-3-nano:30b"/);
  });

  it("fails ollama model validation when the probe times out or returns nothing", () => {
    const result = validateOllamaModel("nemotron-3-nano:30b", () => "");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/did not answer the local probe in time/);
  });

  it("fails ollama model validation when Ollama returns an error payload", () => {
    const result = validateOllamaModel(
      "gabegoodhart/minimax-m2.1:latest",
      () => JSON.stringify({ error: "model requires more system memory" }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/requires more system memory/);
  });

  it("passes ollama model validation when the probe returns a normal payload", () => {
    const result = validateOllamaModel(
      "nemotron-3-nano:30b",
      () => JSON.stringify({ model: "nemotron-3-nano:30b", response: "hello", done: true }),
    );
    expect(result).toEqual({ ok: true });
  });
});
