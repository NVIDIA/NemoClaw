// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";

import {
  CONTAINER_REACHABILITY_IMAGE,
  DEFAULT_OLLAMA_CONTEXT_WINDOW,
  DEFAULT_OLLAMA_MODEL,
  OPENCLAW_MIN_CONTEXT_WINDOW,
  getDefaultOllamaModel,
  getOllamaEndpointCandidates,
  getOllamaModelContextWindow,
  getOllamaModelMetadata,
  getOllamaOverrideEndpoint,
  getLocalProviderBaseUrl,
  getLocalProviderContainerReachabilityCheck,
  getLocalProviderHealthCheck,
  getOllamaModelOptions,
  getOllamaProbeCommand,
  getOllamaWarmupCommand,
  getWslHostCandidates,
  parseDefaultGateway,
  parseOllamaList,
  parseOllamaNumCtx,
  parseOllamaPsResponse,
  parseOllamaShowResponse,
  parseOllamaTagsResponse,
  parseResolvConfNameservers,
  resolveOllamaContainerRoute,
  resolveOllamaEndpoint,
  validateOllamaModel,
  validateOllamaOpenClawCompatibility,
  validateLocalProvider,
} from "../bin/lib/local-inference";

describe("local inference helpers", () => {
  it("returns the expected base URL for vllm-local", () => {
    expect(getLocalProviderBaseUrl("vllm-local")).toBe("http://host.openshell.internal:8000/v1");
  });

  it("returns the expected base URL for ollama-local", () => {
    expect(getLocalProviderBaseUrl("ollama-local")).toBe("http://host.openshell.internal:11434/v1");
  });

  it("uses an explicit Ollama base URL override when present", () => {
    const endpoint = getOllamaOverrideEndpoint({
      env: { NEMOCLAW_OLLAMA_BASE_URL: "http://172.18.112.1:11434" },
    });
    assert.equal(endpoint.hostUrl, "http://172.18.112.1:11434");
    assert.equal(endpoint.openaiBaseUrl, "http://172.18.112.1:11434/v1");
  });

  it("parses non-loopback nameservers from resolv.conf", () => {
    assert.deepEqual(
      parseResolvConfNameservers("nameserver 127.0.0.1\nnameserver 172.18.112.1\n"),
      ["172.18.112.1"],
    );
  });

  it("parses the default route gateway", () => {
    assert.equal(parseDefaultGateway("default via 172.18.112.1 dev eth0\n"), "172.18.112.1");
  });

  it("derives WSL host candidates from resolv.conf and the default route", () => {
    assert.deepEqual(
      getWslHostCandidates({
        platform: "linux",
        env: { WSL_DISTRO_NAME: "Ubuntu" },
        release: "6.6.87.2-microsoft-standard-WSL2",
        resolvConf: "nameserver 172.18.112.1\n",
        routeOutput: "default via 172.18.112.2 dev eth0\n",
      }),
      ["172.18.112.1", "172.18.112.2"],
    );
  });

  it("includes localhost and WSL candidates for Ollama endpoint discovery", () => {
    const candidates = getOllamaEndpointCandidates({
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      release: "6.6.87.2-microsoft-standard-WSL2",
      resolvConf: "nameserver 172.18.112.1\n",
      routeOutput: "default via 172.18.112.1 dev eth0\n",
    });

    assert.equal(candidates[0].hostUrl, "http://localhost:11434");
    assert.ok(candidates.some((candidate) => candidate.hostUrl === "http://172.18.112.1:11434"));
  });

  it("resolves a WSL-hosted Ollama endpoint when localhost is unavailable", () => {
    const result = resolveOllamaEndpoint(
      (command) => {
        if (command.includes("http://localhost:11434/api/tags")) return "";
        if (command.includes("http://172.18.112.1:11434/api/tags")) return '{"models":[]}';
        return "";
      },
      {
        platform: "linux",
        env: { WSL_DISTRO_NAME: "Ubuntu" },
        release: "6.6.87.2-microsoft-standard-WSL2",
        resolvConf: "nameserver 172.18.112.1\n",
        routeOutput: "default via 172.18.112.1 dev eth0\n",
      },
    );

    assert.equal(result.source, "wsl-host");
    assert.equal(result.hostUrl, "http://172.18.112.1:11434");
    assert.equal(result.openaiBaseUrl, "http://host.docker.internal:11434/v1");
    assert.equal(result.routeUrl, "http://host.docker.internal:11434");
  });

  it("resolves a reachable container route for WSL-hosted Ollama", () => {
    const endpoint = resolveOllamaEndpoint(
      (command) => {
        if (command.includes("http://localhost:11434/api/tags")) return "";
        if (command.includes("http://172.18.112.1:11434/api/tags")) return '{"models":[]}';
        return "";
      },
      {
        platform: "linux",
        env: { WSL_DISTRO_NAME: "Ubuntu" },
        release: "6.6.87.2-microsoft-standard-WSL2",
        resolvConf: "nameserver 172.18.112.1\n",
        routeOutput: "default via 172.18.112.1 dev eth0\n",
      },
    );

    const routed = resolveOllamaContainerRoute(endpoint, (command) => {
      if (command.includes("http://host.docker.internal:11434/api/tags")) return '{"models":[]}';
      return "";
    });

    assert.equal(routed.routeUrl, "http://host.docker.internal:11434");
    assert.equal(routed.openaiBaseUrl, "http://host.docker.internal:11434/v1");
  });

  it("returns the expected health check command for ollama-local", () => {
    expect(getLocalProviderHealthCheck("ollama-local")).toBe(
      "curl -sf --max-time 5 http://localhost:11434/api/tags 2>/dev/null",
    );
  });

  it("returns the expected container reachability command for ollama-local", () => {
    expect(getLocalProviderContainerReachabilityCheck("ollama-local")).toBe(
      `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:11434/api/tags 2>/dev/null`,
    );
  });

  it("builds a WSL-aware container reachability command for ollama-local", () => {
    const endpoint = { routeUrl: "http://172.18.112.1:11434" };
    assert.equal(
      getLocalProviderContainerReachabilityCheck("ollama-local", { endpoint }),
      `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://172.18.112.1:11434/api/tags 2>/dev/null`,
    );
  });

  it("validates a reachable local provider", () => {
    let callCount = 0;
    const result = validateLocalProvider(
      "ollama-local",
      () => {
        callCount += 1;
        return '{"models":[]}';
      },
      {
        platform: "linux",
        env: {},
        release: "6.6.87.2-generic",
      },
    );
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(2);
  });

  it("returns a clear error when ollama-local is unavailable", () => {
    const result = validateLocalProvider("ollama-local", () => "");
    assert.equal(result.ok, false);
    assert.match(result.message, /localhost:11434/);
    assert.match(result.message, /NEMOCLAW_OLLAMA_BASE_URL/);
  });

  it("returns a clear error when ollama-local is not reachable from containers", () => {
    let callCount = 0;
    const result = validateLocalProvider(
      "ollama-local",
      () => {
        callCount += 1;
        return callCount === 1 ? '{"models":[]}' : "";
      },
      {
        platform: "linux",
        env: {},
        release: "6.6.87.2-generic",
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/host\.openshell\.internal:11434/);
    expect(result.message).toMatch(/0\.0\.0\.0:11434/);
  });

  it("returns a WSL-specific container reachability error for ollama-local", () => {
    let callCount = 0;
    const endpoint = {
      source: "wsl-host",
      displayTarget: "Windows host 172.18.112.1:11434",
      routeUrl: "http://host.docker.internal:11434",
      routeCandidates: [
        "http://host.docker.internal:11434",
        "http://gateway.docker.internal:11434",
        "http://172.18.112.1:11434",
      ],
      tagsUrl: "http://172.18.112.1:11434/api/tags",
    };

    const result = validateLocalProvider(
      "ollama-local",
      () => {
        callCount += 1;
        return callCount === 1 ? '{"models":[]}' : "";
      },
      { endpoint },
    );

    assert.equal(result.ok, false);
    assert.match(result.message, /Docker Desktop hostnames/i);
    assert.match(result.message, /host\.docker\.internal:11434/);
  });

  it("returns a clear error when vllm-local is unavailable", () => {
    const result = validateLocalProvider("vllm-local", () => "");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/http:\/\/localhost:8000/);
  });

  it("parses model names from ollama list output", () => {
    expect(
      parseOllamaList(
        [
          "NAME                        ID              SIZE      MODIFIED",
          "nemotron-3-nano:30b         abc123          24 GB     2 hours ago",
          "qwen3:32b                   def456          20 GB     1 day ago",
        ].join("\n"),
      ),
    ).toEqual(["nemotron-3-nano:30b", "qwen3:32b"]);
  });

  it("returns parsed ollama model options when available", () => {
    expect(
      getOllamaModelOptions(
        () => "nemotron-3-nano:30b  abc  24 GB  now\nqwen3:32b  def  20 GB  now",
      ),
    ).toEqual(["nemotron-3-nano:30b", "qwen3:32b"]);
  });

  it("parses model names from the Ollama tags API", () => {
    assert.deepEqual(
      parseOllamaTagsResponse(
        JSON.stringify({ models: [{ name: "nemotron-3-nano:30b" }, { name: "qwen3:32b" }] }),
      ),
      ["nemotron-3-nano:30b", "qwen3:32b"],
    );
  });

  it("parses an active model context from the Ollama ps API", () => {
    assert.equal(
      parseOllamaPsResponse(
        JSON.stringify({ models: [{ name: "qwen3.5:35b-a3b", context_length: 8192 }] }),
        "qwen3.5:35b-a3b",
      ),
      8192,
    );
  });

  it("parses num_ctx from Ollama parameter output", () => {
    assert.equal(
      parseOllamaNumCtx("num_keep                       24\nnum_ctx                        8192\n"),
      8192,
    );
    assert.equal(parseOllamaNumCtx("PARAMETER num_ctx 16384\n"), 16384);
  });

  it("prefers configured num_ctx from Ollama show output", () => {
    const output = JSON.stringify({
      parameters: "num_ctx                        8192\n",
      modelfile: "FROM qwen3.5:35b-a3b\nPARAMETER num_ctx 4096\n",
      model_info: { "qwen3.context_length": 131072 },
    });
    assert.equal(parseOllamaShowResponse(output), 8192);
  });

  it("falls back to model_info context length from Ollama show output", () => {
    const output = JSON.stringify({ model_info: { "qwen3.context_length": 32768 } });
    assert.equal(parseOllamaShowResponse(output), 32768);
  });

  it("discovers Ollama model context from the running model list first", () => {
    const contextWindow = getOllamaModelContextWindow(
      (command) => {
        if (command.includes("/api/ps")) {
          return JSON.stringify({ models: [{ name: "qwen3.5:35b-a3b", context_length: 8192 }] });
        }
        if (command.includes("/api/show")) {
          return JSON.stringify({ parameters: "num_ctx                        4096\n" });
        }
        return "";
      },
      "qwen3.5:35b-a3b",
      {
        endpoint: { hostUrl: "http://172.18.112.1:11434" },
      },
    );

    assert.equal(contextWindow, 8192);
  });

  it("falls back to Ollama show when the model is not running", () => {
    const contextWindow = getOllamaModelContextWindow(
      (command) => {
        if (command.includes("/api/ps")) return JSON.stringify({ models: [] });
        if (command.includes("/api/show")) {
          return JSON.stringify({ parameters: "num_ctx                        16384\n" });
        }
        return "";
      },
      "qwen3.5:35b-a3b",
      {
        endpoint: { hostUrl: "http://172.18.112.1:11434" },
      },
    );

    assert.equal(contextWindow, 16384);
  });

  it("returns dynamic Ollama model metadata when a host context is available", () => {
    const metadata = getOllamaModelMetadata(
      (command) => {
        if (command.includes("/api/ps")) {
          return JSON.stringify({ models: [{ name: "qwen3.5:35b-a3b", context_length: 8192 }] });
        }
        return "";
      },
      "qwen3.5:35b-a3b",
      {
        endpoint: { hostUrl: "http://172.18.112.1:11434" },
      },
    );

    assert.deepEqual(metadata, { contextWindow: 8192, maxTokens: 4096 });
  });

  it("falls back to conservative Ollama metadata when host discovery fails", () => {
    assert.deepEqual(
      getOllamaModelMetadata(() => "", "qwen3.5:35b-a3b"),
      { contextWindow: DEFAULT_OLLAMA_CONTEXT_WINDOW, maxTokens: 4096 },
    );
  });

  it("rejects Ollama models below the OpenClaw minimum context window", () => {
    const result = validateOllamaOpenClawCompatibility("qwen3.5:9b", { contextWindow: 4096 });
    assert.equal(result.ok, false);
    assert.match(result.message, new RegExp(`${OPENCLAW_MIN_CONTEXT_WINDOW}`));
  });

  it("accepts Ollama models that meet the OpenClaw minimum context window", () => {
    assert.deepEqual(validateOllamaOpenClawCompatibility("qwen3.5:9b", { contextWindow: 16384 }), {
      ok: true,
    });
  });

  it("falls back to the Ollama tags API when the CLI is unavailable", () => {
    const endpoint = { tagsUrl: "http://172.18.112.1:11434/api/tags" };
    const calls = [];
    const models = getOllamaModelOptions(
      (command) => {
        calls.push(command);
        if (command.includes("ollama list")) return "";
        if (command.includes(endpoint.tagsUrl)) {
          return JSON.stringify({ models: [{ name: "qwen3:32b" }, { name: "gemma3:4b" }] });
        }
        return "";
      },
      { endpoint },
    );

    assert.deepEqual(models, ["qwen3:32b", "gemma3:4b"]);
    assert.ok(calls.some((command) => command.includes(endpoint.tagsUrl)));
  });

  it("falls back to the default ollama model when list output is empty", () => {
    assert.deepEqual(
      getOllamaModelOptions(() => ""),
      [DEFAULT_OLLAMA_MODEL],
    );
  });

  it("prefers the default ollama model when present", () => {
    expect(
      getDefaultOllamaModel(
        () => "qwen3:32b  abc  20 GB  now\nnemotron-3-nano:30b  def  24 GB  now",
      ),
    ).toBe(DEFAULT_OLLAMA_MODEL);
  });

  it("falls back to the first listed ollama model when the default is absent", () => {
    expect(
      getDefaultOllamaModel(() => "qwen3:32b  abc  20 GB  now\ngemma3:4b  def  3 GB  now"),
    ).toBe("qwen3:32b");
  });

  it("builds a background warmup command for ollama models", () => {
    const command = getOllamaWarmupCommand("nemotron-3-nano:30b");
    expect(command).toMatch(/^nohup curl -s http:\/\/localhost:11434\/api\/generate /);
    expect(command).toMatch(/"model":"nemotron-3-nano:30b"/);
    expect(command).toMatch(/"keep_alive":"15m"/);
  });

  it("builds a background warmup command for a discovered WSL endpoint", () => {
    const command = getOllamaWarmupCommand("nemotron-3-nano:30b", {
      endpoint: { generateUrl: "http://172.18.112.1:11434/api/generate" },
    });
    assert.match(command, /^nohup curl -s http:\/\/172\.18\.112\.1:11434\/api\/generate /);
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
    const result = validateOllamaModel("gabegoodhart/minimax-m2.1:latest", () =>
      JSON.stringify({ error: "model requires more system memory" }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/requires more system memory/);
  });

  it("passes ollama model validation when the probe returns a normal payload", () => {
    const result = validateOllamaModel("nemotron-3-nano:30b", () =>
      JSON.stringify({ model: "nemotron-3-nano:30b", response: "hello", done: true }),
    );
    expect(result).toEqual({ ok: true });
  });
});
