// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  CONTAINER_REACHABILITY_IMAGE,
  DEFAULT_OLLAMA_MODEL,
  OLLAMA_VRAM_TIERS,
  getDefaultOllamaModel,
  getHostUrl,
  getLocalProviderBaseUrl,
  getLocalProviderContainerReachabilityCheck,
  getLocalProviderHealthCheck,
  getOllamaModelOptions,
  getOllamaProbeCommand,
  getOllamaWarmupCommand,
  getRecommendedOllamaModel,
  getWsl2HostIp,
  isOllamaBoundToAllInterfaces,
  parseOllamaList,
  validateOllamaModel,
  validateLocalProvider,
} = require("../bin/lib/local-inference");

const { isWsl } = require("../bin/lib/platform");

// The host URL varies by platform: WSL2 uses eth0 IP, others use host.openshell.internal
const hostUrl = getHostUrl();

describe("local inference helpers", () => {
  it("returns the expected base URL for vllm-local", () => {
    assert.equal(
      getLocalProviderBaseUrl("vllm-local"),
      `${hostUrl}:8000/v1`,
    );
  });

  it("returns the expected base URL for ollama-local", () => {
    assert.equal(
      getLocalProviderBaseUrl("ollama-local"),
      `${hostUrl}:11434/v1`,
    );
  });

  it("returns the expected base URL for lmstudio-local", () => {
    assert.equal(
      getLocalProviderBaseUrl("lmstudio-local"),
      `${hostUrl}:1234/v1`,
    );
  });

  it("returns the expected health check command for ollama-local", () => {
    assert.equal(
      getLocalProviderHealthCheck("ollama-local"),
      "curl -sf http://localhost:11434/api/tags 2>/dev/null",
    );
  });

  it("returns the expected health check command for lmstudio-local", () => {
    assert.equal(
      getLocalProviderHealthCheck("lmstudio-local"),
      "curl -sf http://localhost:1234/v1/models 2>/dev/null",
    );
  });

  it("returns the expected container reachability command for ollama-local", () => {
    const cmd = getLocalProviderContainerReachabilityCheck("ollama-local");
    assert.match(cmd, /docker run --rm/);
    assert.match(cmd, /:11434\/api\/tags/);
    assert.match(cmd, new RegExp(CONTAINER_REACHABILITY_IMAGE));
    if (isWsl()) {
      assert.match(cmd, /--add-host host\.docker\.internal:host-gateway/);
      assert.match(cmd, /host\.docker\.internal:11434/);
    } else {
      assert.match(cmd, /--add-host host\.openshell\.internal:host-gateway/);
    }
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
    assert.match(result.message, /containers cannot reach it/);
    assert.match(result.message, /0\.0\.0\.0:11434/);
  });

  it("returns a clear error when lmstudio-local is unavailable", () => {
    const result = validateLocalProvider("lmstudio-local", () => "");
    assert.equal(result.ok, false);
    assert.match(result.message, /http:\/\/localhost:1234/);
  });

  it("returns a clear error when lmstudio-local is not reachable from containers", () => {
    let callCount = 0;
    const result = validateLocalProvider("lmstudio-local", () => {
      callCount += 1;
      return callCount === 1 ? '{"data":[]}' : "";
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /containers cannot reach it/);
    assert.match(result.message, /0\.0\.0\.0:1234/);
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

describe("WSL2 networking", () => {
  it("getHostUrl returns a URL string", () => {
    const url = getHostUrl();
    assert.match(url, /^http:\/\//);
  });

  it("getWsl2HostIp returns an IP on WSL2 or empty string otherwise", () => {
    const ip = getWsl2HostIp();
    if (isWsl()) {
      assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
    } else {
      assert.equal(ip, "");
    }
  });
});

describe("Ollama binding check", () => {
  it("returns true when ss output shows 0.0.0.0 binding", () => {
    const result = isOllamaBoundToAllInterfaces(
      () => "LISTEN  0  4096  0.0.0.0:11434  *:*\nok",
    );
    assert.equal(result, true);
  });

  it("returns false when ss output does not match", () => {
    const result = isOllamaBoundToAllInterfaces(() => "");
    assert.ok(!result);
  });

  it("returns true when ss output shows wildcard binding", () => {
    const result = isOllamaBoundToAllInterfaces(
      () => "LISTEN  0  4096  *:11434  *:*\nok",
    );
    assert.equal(result, true);
  });
});

describe("VRAM-aware model recommendation", () => {
  it("recommends nemotron-3-nano:30b for 24+ GB VRAM", () => {
    const rec = getRecommendedOllamaModel(24564); // RTX 4090 reports 24564 MB
    assert.equal(rec.model, "nemotron-3-nano:30b");
  });

  it("recommends gemma3:12b for 12-24 GB VRAM", () => {
    const rec = getRecommendedOllamaModel(12000);
    assert.equal(rec.model, "gemma3:12b");
  });

  it("recommends gemma3:4b for 8-12 GB VRAM", () => {
    const rec = getRecommendedOllamaModel(8000);
    assert.equal(rec.model, "gemma3:4b");
  });

  it("recommends ministral-3:3b for < 8 GB VRAM", () => {
    const rec = getRecommendedOllamaModel(4096);
    assert.equal(rec.model, "ministral-3:3b");
  });

  it("returns fallback tier for 0 VRAM", () => {
    const rec = getRecommendedOllamaModel(0);
    assert.equal(rec.model, "ministral-3:3b");
  });

  it("OLLAMA_VRAM_TIERS is sorted descending by minMB", () => {
    for (let i = 1; i < OLLAMA_VRAM_TIERS.length; i++) {
      assert.ok(
        OLLAMA_VRAM_TIERS[i - 1].minMB > OLLAMA_VRAM_TIERS[i].minMB,
        `Tier ${i - 1} (${OLLAMA_VRAM_TIERS[i - 1].minMB}) should be > tier ${i} (${OLLAMA_VRAM_TIERS[i].minMB})`,
      );
    }
  });
});
