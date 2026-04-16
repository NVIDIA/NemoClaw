// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

// Import from compiled dist/ for correct coverage attribution.
import {
  CONTAINER_REACHABILITY_IMAGE,
  DEFAULT_OLLAMA_MODEL,
  LARGE_OLLAMA_MIN_MEMORY_MB,
  getDefaultOllamaModel,
  getBootstrapOllamaModelOptions,
  getLocalProviderBaseUrl,
  getLocalProviderContainerReachabilityCheck,
  getLocalProviderHealthCheck,
  getLocalProviderHealthEndpoint,
  getLocalProviderLabel,
  getLocalProviderValidationBaseUrl,
  getOllamaModelOptions,
  getOllamaProbeCommand,
  getOllamaWarmupCommand,
  parseOllamaList,
  parseOllamaTags,
  probeLocalProviderHealth,
  validateOllamaModel,
  validateLocalProvider,
} from "../../dist/lib/local-inference";

describe("local inference helpers", () => {
  it("returns the expected base URL for vllm-local", () => {
    expect(getLocalProviderBaseUrl("vllm-local")).toBe("http://host.openshell.internal:8000/v1");
  });

  it("returns the expected base URL for ollama-local", () => {
    expect(getLocalProviderBaseUrl("ollama-local")).toBe(
      "http://host.openshell.internal:11434/v1",
    );
  });

  it("returns null for unknown local provider URLs", () => {
    expect(getLocalProviderBaseUrl("unknown-provider")).toBeNull();
    expect(getLocalProviderValidationBaseUrl("unknown-provider")).toBeNull();
    expect(getLocalProviderHealthEndpoint("unknown-provider")).toBeNull();
    expect(getLocalProviderHealthCheck("unknown-provider")).toBeNull();
    expect(getLocalProviderLabel("unknown-provider")).toBeNull();
    expect(getLocalProviderContainerReachabilityCheck("unknown-provider")).toBeNull();
  });

  it("returns the expected validation URL for vllm-local", () => {
    expect(getLocalProviderValidationBaseUrl("vllm-local")).toBe("http://localhost:8000/v1");
  });

  it("returns the expected health check command for ollama-local", () => {
    expect(getLocalProviderHealthEndpoint("ollama-local")).toBe(
      "http://localhost:11434/api/tags",
    );
    expect(getLocalProviderLabel("ollama-local")).toBe("Local Ollama");
    expect(getLocalProviderHealthCheck("ollama-local")).toEqual(
      ["curl", "-sf", "http://localhost:11434/api/tags"],
    );
  });

  it("returns the expected validation and health check commands for vllm-local", () => {
    expect(getLocalProviderValidationBaseUrl("ollama-local")).toBe("http://localhost:11434/v1");
    expect(getLocalProviderHealthEndpoint("vllm-local")).toBe("http://localhost:8000/v1/models");
    expect(getLocalProviderLabel("vllm-local")).toBe("Local vLLM");
    expect(getLocalProviderHealthCheck("vllm-local")).toEqual(
      ["curl", "-sf", "http://localhost:8000/v1/models"],
    );
    expect(getLocalProviderContainerReachabilityCheck("vllm-local")).toEqual([
      "docker", "run", "--rm",
      "--add-host", "host.openshell.internal:host-gateway",
      CONTAINER_REACHABILITY_IMAGE,
      "-sf", "http://host.openshell.internal:8000/v1/models",
    ]);
  });

  it("returns the expected container reachability command for ollama-local", () => {
    expect(getLocalProviderContainerReachabilityCheck("ollama-local")).toEqual([
      "docker", "run", "--rm",
      "--add-host", "host.openshell.internal:host-gateway",
      CONTAINER_REACHABILITY_IMAGE,
      "-sf", "http://host.openshell.internal:11434/api/tags",
    ]);
  });

  it("validates a reachable local provider", () => {
    let callCount = 0;
    const mockCapture = () => {
      callCount += 1;
      return '{"models":[]}';
    };
    const result = validateLocalProvider("ollama-local", mockCapture);
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
    const mockCapture = () => {
      callCount += 1;
      return callCount === 1 ? '{"models":[]}' : "";
    };
    const result = validateLocalProvider("ollama-local", mockCapture);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/host\.openshell\.internal:11434/);
    expect(result.message).toMatch(/0\.0\.0\.0:11434/);
  });

  it("returns a clear error when vllm-local is unavailable", () => {
    const result = validateLocalProvider("vllm-local", () => "");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/http:\/\/localhost:8000/);
  });

  it("probes local provider health successfully", () => {
    const result = probeLocalProviderHealth("ollama-local", {
      runCurlProbeImpl: () => ({
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: "{}",
        stderr: "",
        message: "HTTP 200",
      }),
    });

    expect(result).toEqual({
      ok: true,
      providerLabel: "Local Ollama",
      endpoint: "http://localhost:11434/api/tags",
      detail: "Local Ollama is reachable on http://localhost:11434/api/tags.",
    });
  });

  it("reports a clear local provider outage when the host probe cannot connect", () => {
    const result = probeLocalProviderHealth("ollama-local", {
      runCurlProbeImpl: () => ({
        ok: false,
        httpStatus: 0,
        curlStatus: 7,
        body: "",
        stderr: "Failed to connect",
        message: "curl failed (exit 7): Failed to connect",
      }),
    });

    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain("Local Ollama is selected for inference");
    expect(result?.detail).toContain("Start Ollama and retry");
    expect(result?.detail).toContain("http://localhost:11434/api/tags");
  });

  it("returns null when provider health probing is not supported", () => {
    expect(probeLocalProviderHealth("nvidia-prod")).toBeNull();
  });

  it("returns a clear error when vllm-local is not reachable from containers", () => {
    let callCount = 0;
    const mockCapture = () => {
      callCount += 1;
      return callCount === 1 ? '{"data":[]}' : "";
    };
    const result = validateLocalProvider("vllm-local", mockCapture);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/host\.openshell\.internal:8000/);
  });

  it("treats unknown local providers as already valid", () => {
    expect(validateLocalProvider("custom-provider", () => "")).toEqual({ ok: true });
  });

  it("skips health check entirely for unknown providers", () => {
    let callCount = 0;
    const mockCapture = () => {
      callCount += 1;
      return callCount <= 1 ? "ok" : "";
    };
    const result = validateLocalProvider("custom-provider", mockCapture);
    // custom-provider has no health check command, so it returns ok immediately
    expect(result).toEqual({ ok: true });
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

  it("ignores headers and blank lines in ollama list output", () => {
    expect(parseOllamaList("NAME ID SIZE MODIFIED\n\n")).toEqual([]);
  });

  it("returns parsed ollama model options when available", () => {
    const mockCapture = () => "nemotron-3-nano:30b  abc  24 GB  now\nqwen3:32b  def  20 GB  now";
    expect(getOllamaModelOptions(mockCapture)).toEqual(["nemotron-3-nano:30b", "qwen3:32b"]);
  });

  it("parses installed models from Ollama /api/tags output", () => {
    expect(
      parseOllamaTags(
        JSON.stringify({
          models: [{ name: "nemotron-3-nano:30b" }, { name: "qwen2.5:7b" }],
        }),
      ),
    ).toEqual(["nemotron-3-nano:30b", "qwen2.5:7b"]);
  });

  it("returns no tags for malformed Ollama API output", () => {
    expect(parseOllamaTags("{not-json")).toEqual([]);
    expect(parseOllamaTags(JSON.stringify({ models: null }))).toEqual([]);
    expect(parseOllamaTags(JSON.stringify({ models: [{}, { name: "qwen2.5:7b" }] }))).toEqual([
      "qwen2.5:7b",
    ]);
  });

  it("prefers Ollama /api/tags over parsing the CLI list output", () => {
    let call = 0;
    const mockCapture = () => {
      call += 1;
      if (call === 1) {
        return JSON.stringify({ models: [{ name: "qwen2.5:7b" }] });
      }
      return "";
    };
    expect(getOllamaModelOptions(mockCapture)).toEqual(["qwen2.5:7b"]);
  });

  it("returns no installed ollama models when list output is empty", () => {
    expect(getOllamaModelOptions(() => "")).toEqual([]);
  });

  it("prefers the default ollama model when present", () => {
    const mockCapture = () => "qwen3:32b  abc  20 GB  now\nnemotron-3-nano:30b  def  24 GB  now";
    expect(getDefaultOllamaModel(null, mockCapture)).toBe(DEFAULT_OLLAMA_MODEL);
  });

  it("falls back to the first listed ollama model when the default is absent", () => {
    const mockCapture = () => "qwen3:32b  abc  20 GB  now\ngemma3:4b  def  3 GB  now";
    expect(getDefaultOllamaModel(null, mockCapture)).toBe("qwen3:32b");
  });

  it("falls back to bootstrap model options when no Ollama models are installed", () => {
    expect(getBootstrapOllamaModelOptions(null)).toEqual(["qwen2.5:7b"]);
    expect(
      getBootstrapOllamaModelOptions({ totalMemoryMB: LARGE_OLLAMA_MIN_MEMORY_MB - 1 }),
    ).toEqual(["qwen2.5:7b"]);
    expect(
      getBootstrapOllamaModelOptions({ totalMemoryMB: LARGE_OLLAMA_MIN_MEMORY_MB }),
    ).toEqual(["qwen2.5:7b", DEFAULT_OLLAMA_MODEL]);
    expect(getDefaultOllamaModel({ totalMemoryMB: 16384 }, () => "")).toBe("qwen2.5:7b");
  });

  it("builds a background warmup command for ollama models", () => {
    const command = getOllamaWarmupCommand("nemotron-3-nano:30b");
    expect(command).toEqual(expect.arrayContaining(["bash", "-c"]));
    expect(command[2]).toMatch(/^nohup curl -s http:\/\/localhost:11434\/api\/generate /);
    expect(command[2]).toMatch(/"model":"nemotron-3-nano:30b"/);
    expect(command[2]).toMatch(/"keep_alive":"15m"/);
  });

  it("supports custom probe and warmup tuning", () => {
    const warmup = getOllamaWarmupCommand("qwen2.5:7b", "30m");
    expect(warmup[2]).toMatch(/"keep_alive":"30m"/);
    const probe1 = getOllamaProbeCommand("qwen2.5:7b", 30, "5m");
    expect(probe1).toContain("--max-time");
    expect(probe1).toContain("30");
    const payload1 = probe1[probe1.length - 1];
    expect(payload1).toMatch(/"keep_alive":"5m"/);
  });

  it("builds a foreground probe command as an argv array", () => {
    const command = getOllamaProbeCommand("nemotron-3-nano:30b");
    expect(command[0]).toBe("curl");
    expect(command).toContain("-sS");
    expect(command).toContain("--max-time");
    expect(command).toContain("120");
    expect(command).toContain("http://localhost:11434/api/generate");
    const payload = command[command.length - 1];
    expect(payload).toMatch(/"model":"nemotron-3-nano:30b"/);
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

  it("treats non-JSON probe output as success once the model responds", () => {
    expect(validateOllamaModel("nemotron-3-nano:30b", () => "ok")).toEqual({ ok: true });
  });
});
