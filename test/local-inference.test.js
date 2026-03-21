// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
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
  validateOllamaModel,
  validateLocalProvider,
} = require("../bin/lib/local-inference");

describe("local inference helpers", () => {
  it("returns the expected base URL for vllm-local", () => {
    assert.equal(
      getLocalProviderBaseUrl("vllm-local"),
      "http://host.openshell.internal:8000/v1",
    );
  });

  it("returns the expected base URL for ollama-local", () => {
    assert.equal(
      getLocalProviderBaseUrl("ollama-local"),
      "http://host.openshell.internal:11434/v1",
    );
  });

  it("returns the expected health check command for ollama-local", () => {
    assert.equal(
      getLocalProviderHealthCheck("ollama-local"),
      "curl -sf http://localhost:11434/api/tags 2>/dev/null",
    );
  });

  it("returns the expected container reachability command for ollama-local", () => {
    assert.equal(
      getLocalProviderContainerReachabilityCheck("ollama-local"),
      `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:11434/api/tags 2>/dev/null`,
    );
  });

  it("validates a reachable local provider", () => {
    let callCount = 0;
    const result = validateLocalProvider("ollama-local", () => {
      callCount += 1;
      return '{"models":[]}';
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(callCount, 2);
  });

  it("returns a clear error when ollama-local is unavailable", () => {
    const result = validateLocalProvider("ollama-local", () => "");
    assert.equal(result.ok, false);
    assert.match(result.message, /http:\/\/localhost:11434/);
  });

  it("returns a clear error when ollama-local is not reachable from containers", () => {
    let callCount = 0;
    const result = validateLocalProvider("ollama-local", () => {
      callCount += 1;
      return callCount === 1 ? '{"models":[]}' : "";
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /host\.openshell\.internal:11434/);
    assert.match(result.message, /0\.0\.0\.0:11434/);
  });

  it("returns a clear error when vllm-local is unavailable", () => {
    const result = validateLocalProvider("vllm-local", () => "");
    assert.equal(result.ok, false);
    assert.match(result.message, /http:\/\/localhost:8000/);
  });

  it("parses model names from ollama list output", () => {
    assert.deepEqual(
      parseOllamaList(
        [
          "NAME                        ID              SIZE      MODIFIED",
          "nemotron-3-nano:30b         abc123          24 GB     2 hours ago",
          "qwen3:32b                   def456          20 GB     1 day ago",
        ].join("\n"),
      ),
      ["nemotron-3-nano:30b", "qwen3:32b"],
    );
  });

  it("returns parsed ollama model options when available", () => {
    assert.deepEqual(
      getOllamaModelOptions(() => "nemotron-3-nano:30b  abc  24 GB  now\nqwen3:32b  def  20 GB  now"),
      ["nemotron-3-nano:30b", "qwen3:32b"],
    );
  });

  it("falls back to the default ollama model when list output is empty", () => {
    assert.deepEqual(getOllamaModelOptions(() => ""), [DEFAULT_OLLAMA_MODEL]);
  });

  it("prefers the default ollama model when present", () => {
    assert.equal(
      getDefaultOllamaModel(() => "qwen3:32b  abc  20 GB  now\nnemotron-3-nano:30b  def  24 GB  now"),
      DEFAULT_OLLAMA_MODEL,
    );
  });

  it("falls back to the first listed ollama model when the default is absent", () => {
    assert.equal(
      getDefaultOllamaModel(() => "qwen3:32b  abc  20 GB  now\ngemma3:4b  def  3 GB  now"),
      "qwen3:32b",
    );
  });

  it("builds a background warmup command for ollama models", () => {
    const command = getOllamaWarmupCommand("nemotron-3-nano:30b");
    assert.match(command, /^nohup curl -s http:\/\/localhost:11434\/api\/generate /);
    assert.match(command, /"model":"nemotron-3-nano:30b"/);
    assert.match(command, /"keep_alive":"15m"/);
  });

  it("builds a foreground probe command for ollama models", () => {
    const command = getOllamaProbeCommand("nemotron-3-nano:30b");
    assert.match(command, /^curl -sS --max-time 120 http:\/\/localhost:11434\/api\/generate /);
    assert.match(command, /"model":"nemotron-3-nano:30b"/);
  });

  it("fails ollama model validation when the probe times out or returns nothing", () => {
    const result = validateOllamaModel("nemotron-3-nano:30b", () => "");
    assert.equal(result.ok, false);
    assert.match(result.message, /did not answer the local probe in time/);
  });

  it("fails ollama model validation when Ollama returns an error payload", () => {
    const result = validateOllamaModel(
      "gabegoodhart/minimax-m2.1:latest",
      () => JSON.stringify({ error: "model requires more system memory" }),
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /requires more system memory/);
  });

  it("passes ollama model validation when the probe returns a normal payload", () => {
    const result = validateOllamaModel(
      "nemotron-3-nano:30b",
      () => JSON.stringify({ model: "nemotron-3-nano:30b", response: "hello", done: true }),
    );
    assert.deepEqual(result, { ok: true });
  });
});
