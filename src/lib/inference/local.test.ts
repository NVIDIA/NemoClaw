// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

// Import from compiled dist/ for correct coverage attribution.
import {
  CONTAINER_REACHABILITY_IMAGE,
  DEFAULT_OLLAMA_MODEL,
  LARGE_OLLAMA_MIN_MEMORY_MB,
  LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV,
  OLLAMA_CONTAINER_PORT,
  QWEN3_6_OLLAMA_MODEL,
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
} from "../../../dist/lib/inference/local";

describe("local inference helpers", () => {
  const originalSandboxHostUrl = process.env[LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV];

  afterEach(() => {
    if (originalSandboxHostUrl === undefined) {
      delete process.env[LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV];
    } else {
      process.env[LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV] = originalSandboxHostUrl;
    }
  });

  it("returns the expected base URL for vllm-local", () => {
    expect(getLocalProviderBaseUrl("vllm-local")).toBe("http://host.openshell.internal:8000/v1");
  });

  it("returns the expected base URL for ollama-local (via auth proxy or direct)", () => {
    expect(getLocalProviderBaseUrl("ollama-local")).toBe(
      `http://host.openshell.internal:${OLLAMA_CONTAINER_PORT}/v1`,
    );
  });

  it("can target sandbox loopback for host-network Docker GPU sandboxes", () => {
    process.env[LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV] = "http://127.0.0.1";
    expect(getLocalProviderBaseUrl("ollama-local")).toBe(
      `http://127.0.0.1:${OLLAMA_CONTAINER_PORT}/v1`,
    );
    expect(getLocalProviderBaseUrl("vllm-local")).toBe("http://127.0.0.1:8000/v1");
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
    expect(getLocalProviderValidationBaseUrl("vllm-local")).toBe("http://127.0.0.1:8000/v1");
  });

  it("returns the expected health check command for ollama-local", () => {
    expect(getLocalProviderHealthEndpoint("ollama-local")).toBe("http://127.0.0.1:11434/api/tags");
    expect(getLocalProviderLabel("ollama-local")).toBe("Local Ollama");
    expect(getLocalProviderHealthCheck("ollama-local")).toEqual([
      "curl",
      "-sf",
      "http://127.0.0.1:11434/api/tags",
    ]);
  });

  it("returns the expected validation and health check commands for vllm-local", () => {
    expect(getLocalProviderValidationBaseUrl("ollama-local")).toBe("http://127.0.0.1:11434/v1");
    expect(getLocalProviderHealthEndpoint("vllm-local")).toBe("http://127.0.0.1:8000/v1/models");
    expect(getLocalProviderLabel("vllm-local")).toBe("Local vLLM");
    expect(getLocalProviderHealthCheck("vllm-local")).toEqual([
      "curl",
      "-sf",
      "http://127.0.0.1:8000/v1/models",
    ]);
    expect(getLocalProviderContainerReachabilityCheck("vllm-local")).toEqual([
      "docker",
      "run",
      "--rm",
      "--add-host",
      "host.openshell.internal:host-gateway",
      CONTAINER_REACHABILITY_IMAGE,
      "--connect-timeout",
      "5",
      "--max-time",
      "10",
      "-sf",
      "http://host.openshell.internal:8000/v1/models",
    ]);
  });

  it("returns the expected container reachability command for ollama-local (via auth proxy or direct)", () => {
    expect(getLocalProviderContainerReachabilityCheck("ollama-local")).toEqual([
      "docker",
      "run",
      "--rm",
      "--add-host",
      "host.openshell.internal:host-gateway",
      CONTAINER_REACHABILITY_IMAGE,
      "--connect-timeout",
      "5",
      "--max-time",
      "10",
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      `http://host.openshell.internal:${OLLAMA_CONTAINER_PORT}/api/tags`,
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

  it("rejects non-WSL Ollama when the backend and proxy ports collide", () => {
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        [
          "const platform = require('./dist/lib/platform.js');",
          "platform.isWsl = () => false;",
          "const localInference = require('./dist/lib/inference/local.js');",
          "const result = localInference.validateLocalProvider('ollama-local', () => '{\"models\":[]}');",
          "process.stdout.write(JSON.stringify(result));",
        ].join(""),
      ],
      {
        cwd: path.resolve(__dirname, "../../.."),
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_OLLAMA_PORT: "11435",
          NEMOCLAW_OLLAMA_PROXY_PORT: "11435",
        },
      },
    );

    const result = JSON.parse(output);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("NEMOCLAW_OLLAMA_PORT");
    expect(result.message).toContain("NEMOCLAW_OLLAMA_PROXY_PORT");
    expect(result.message).toContain("11435");
  });

  it("returns a clear error when ollama-local is unavailable", () => {
    const result = validateLocalProvider("ollama-local", () => "");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/http:\/\/127.0.0.1:11434/);
  });

  it("returns a clear error when ollama-local is not reachable from containers", () => {
    let callCount = 0;
    const mockCapture = () => {
      callCount += 1;
      // Call 1: host check succeeds
      if (callCount === 1) return '{"models":[]}';
      // Calls 2-4: container check fails (3 retries)
      // Calls 5-6: diagnostic commands fail
      return "";
    };
    const noopSleep = () => {};
    const result = validateLocalProvider("ollama-local", mockCapture, noopSleep);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(
      new RegExp(`host\\.openshell\\.internal:${OLLAMA_CONTAINER_PORT}`),
    );
    expect(result.message).toMatch(/Docker container reachability check failed/);
    expect(result.message).toMatch(/sandbox uses a different network path/);
    expect(result.message).not.toMatch(/Ensure the Ollama auth proxy is running/);
    expect(result.diagnostic).toMatch(/Docker command failed/);
  });

  it("succeeds after container check retry", () => {
    let callCount = 0;
    const mockCapture = () => {
      callCount += 1;
      // Call 1: host check succeeds
      if (callCount === 1) return '{"models":[]}';
      // Call 2: container attempt 1 fails
      if (callCount === 2) return "";
      // Call 3: container attempt 2 succeeds
      return '{"models":[]}';
    };
    const sleepCalls: number[] = [];
    const mockSleep = (s: number) => { sleepCalls.push(s); };
    const result = validateLocalProvider("ollama-local", mockCapture, mockSleep);
    expect(result).toEqual({ ok: true });
    expect(sleepCalls).toEqual([2]);
  });

  it("includes HTTP diagnostic when retries exhausted and diagnostic commands succeed", () => {
    let callCount = 0;
    const mockCapture = () => {
      callCount += 1;
      // Call 1: host check succeeds
      if (callCount === 1) return '{"models":[]}';
      // Calls 2-4: container check fails (3 retries)
      if (callCount <= 4) return "";
      // Call 5: diagnostic HTTP status
      if (callCount === 5) return "502";
      // Call 6: diagnostic /etc/hosts
      return "172.17.0.1\thost.openshell.internal";
    };
    const sleepCalls: number[] = [];
    const mockSleep = (s: number) => { sleepCalls.push(s); };
    const result = validateLocalProvider("ollama-local", mockCapture, mockSleep);
    expect(result.ok).toBe(false);
    expect(result.diagnostic).toMatch(/HTTP 502/);
    expect(result.diagnostic).toMatch(/host-gateway resolved to/);
    expect(sleepCalls).toEqual([2, 2]);
  });

  it("includes docker-failed diagnostic when diagnostic commands also fail", () => {
    let callCount = 0;
    const mockCapture = () => {
      callCount += 1;
      if (callCount === 1) return '{"models":[]}';
      return "";
    };
    const noopSleep = () => {};
    const result = validateLocalProvider("ollama-local", mockCapture, noopSleep);
    expect(result.ok).toBe(false);
    expect(result.diagnostic).toMatch(/Docker command failed/);
  });

  it("calls sleepFn between container check retries", () => {
    let callCount = 0;
    const mockCapture = () => {
      callCount += 1;
      if (callCount === 1) return '{"models":[]}';
      return "";
    };
    const sleepCalls: number[] = [];
    const mockSleep = (s: number) => { sleepCalls.push(s); };
    validateLocalProvider("ollama-local", mockCapture, mockSleep);
    expect(sleepCalls).toEqual([2, 2]);
  });

  it("does not retry when host check fails", () => {
    const sleepCalls: number[] = [];
    const mockSleep = (s: number) => { sleepCalls.push(s); };
    const result = validateLocalProvider("ollama-local", () => "", mockSleep);
    expect(result.ok).toBe(false);
    expect(sleepCalls).toEqual([]);
  });

  it("returns a clear error when vllm-local is unavailable", () => {
    const result = validateLocalProvider("vllm-local", () => "");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/http:\/\/127.0.0.1:8000/);
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
      loadOllamaProxyTokenImpl: () => null,
    });

    expect(result).toEqual({
      ok: true,
      providerLabel: "Local Ollama",
      endpoint: "http://127.0.0.1:11434/api/tags",
      detail: "Local Ollama is reachable on http://127.0.0.1:11434/api/tags.",
      probeLabel: "ollama backend",
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
      loadOllamaProxyTokenImpl: () => null,
    });

    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain("Local Ollama is selected for inference");
    expect(result?.detail).toContain("Start Ollama and retry");
    expect(result?.detail).toContain("http://127.0.0.1:11434/api/tags");
    expect(result?.probeLabel).toBe("ollama backend");
  });

  // #3265 — auth-proxy subprobe scenarios. Status was previously a single
  // probe to :11434 that ignored the auth proxy at :11435 entirely, so a
  // broken proxy hid behind a "healthy" backend.
  it("attaches a healthy auth-proxy subprobe when ollama backend is up", () => {
    const responses: Array<{ args: string[]; status: number }> = [];
    const result = probeLocalProviderHealth("ollama-local", {
      loadOllamaProxyTokenImpl: () => "test-token",
      runCurlProbeImpl: (argv: string[]) => {
        const isProxy = argv.some(
          (a) => typeof a === "string" && a.includes("11435"),
        );
        responses.push({ args: argv, status: 200 });
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: "{}",
          stderr: "",
          message: "HTTP 200",
        };
      },
    });
    const proxyCall = responses.find((r) =>
      r.args.some((a) => typeof a === "string" && a.includes("11435")),
    );
    expect(proxyCall?.args).toContain("Authorization: Bearer test-token");
    expect(result?.ok).toBe(true);
    expect(result?.subprobes).toHaveLength(1);
    expect(result?.subprobes?.[0]).toMatchObject({
      ok: true,
      probeLabel: "auth proxy",
      endpoint: "http://127.0.0.1:11435/api/tags",
    });
  });

  it("surfaces 401 on the auth-proxy subprobe even when backend is healthy", () => {
    const result = probeLocalProviderHealth("ollama-local", {
      loadOllamaProxyTokenImpl: () => "stale-token",
      runCurlProbeImpl: (argv: string[]) => {
        const isProxy = argv.some(
          (a) => typeof a === "string" && a.includes("11435"),
        );
        return {
          ok: !isProxy,
          httpStatus: isProxy ? 401 : 200,
          curlStatus: 0,
          body: "",
          stderr: "",
          message: isProxy ? "HTTP 401" : "HTTP 200",
        };
      },
    });
    expect(result?.ok).toBe(true);
    const proxy = result?.subprobes?.[0];
    expect(proxy?.ok).toBe(false);
    expect(proxy?.failureLabel).toBe("unauthorized");
    expect(proxy?.detail).toContain("401");
    expect(proxy?.detail).toContain("nemoclaw onboard");
  });

  it("surfaces an unreachable auth proxy (connection refused) even when backend is healthy", () => {
    const result = probeLocalProviderHealth("ollama-local", {
      loadOllamaProxyTokenImpl: () => "token",
      runCurlProbeImpl: (argv: string[]) => {
        const isProxy = argv.some(
          (a) => typeof a === "string" && a.includes("11435"),
        );
        return isProxy
          ? {
              ok: false,
              httpStatus: 0,
              curlStatus: 7,
              body: "",
              stderr: "Failed to connect",
              message: "curl failed (exit 7): Failed to connect",
            }
          : {
              ok: true,
              httpStatus: 200,
              curlStatus: 0,
              body: "{}",
              stderr: "",
              message: "HTTP 200",
            };
      },
    });
    expect(result?.ok).toBe(true);
    const proxy = result?.subprobes?.[0];
    expect(proxy?.ok).toBe(false);
    expect(proxy?.failureLabel).toBe("unreachable");
    expect(proxy?.detail).toContain("unreachable");
    expect(proxy?.detail).toContain("11435");
  });

  it("returns null when provider health probing is not supported", () => {
    expect(probeLocalProviderHealth("nvidia-prod")).toBeNull();
  });

  it("returns a clear error when vllm-local is not reachable from containers", () => {
    let callCount = 0;
    const mockCapture = () => {
      callCount += 1;
      // Call 1: host check succeeds
      if (callCount === 1) return '{"data":[]}';
      // Calls 2+: container check + diagnostics all fail
      return "";
    };
    const noopSleep = () => {};
    const result = validateLocalProvider("vllm-local", mockCapture, noopSleep);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/host\.openshell\.internal:8000/);
    expect(result.message).toMatch(/Docker container reachability check failed/);
    expect(result.message).toMatch(/sandbox uses a different network path/);
    expect(result.message).not.toMatch(/Ensure the server is reachable from containers/);
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
      getBootstrapOllamaModelOptions({
        type: "nvidia",
        totalMemoryMB: LARGE_OLLAMA_MIN_MEMORY_MB - 1,
      }),
    ).toEqual(["qwen2.5:7b"]);
    expect(
      getBootstrapOllamaModelOptions({
        type: "nvidia",
        totalMemoryMB: LARGE_OLLAMA_MIN_MEMORY_MB,
      }),
    ).toEqual(["qwen2.5:7b", DEFAULT_OLLAMA_MODEL, QWEN3_6_OLLAMA_MODEL]);
    expect(getDefaultOllamaModel({ type: "nvidia", totalMemoryMB: 16384 }, () => "")).toBe(
      "qwen2.5:7b",
    );
    expect(
      getDefaultOllamaModel(
        { type: "nvidia", totalMemoryMB: LARGE_OLLAMA_MIN_MEMORY_MB },
        () => "",
      ),
    ).toBe(QWEN3_6_OLLAMA_MODEL);
  });

  it("offers the large Ollama model on Apple Silicon with sufficient unified memory", () => {
    expect(
      getBootstrapOllamaModelOptions({
        type: "apple",
        totalMemoryMB: LARGE_OLLAMA_MIN_MEMORY_MB,
      }),
    ).toEqual(["qwen2.5:7b", DEFAULT_OLLAMA_MODEL, QWEN3_6_OLLAMA_MODEL]);
    expect(
      getDefaultOllamaModel(
        { type: "apple", totalMemoryMB: LARGE_OLLAMA_MIN_MEMORY_MB },
        () => "",
      ),
    ).toBe(QWEN3_6_OLLAMA_MODEL);
  });

  it("downgrades the default Ollama model when the GPU type is unrecognised (#3510)", () => {
    // Defensive guard: even with sufficient memory, an unknown/missing
    // `type` field must not promote a host to the 22 GB model.  The
    // failure mode this guards against is a partial-detection regression
    // where totalMemoryMB is set but the device type is "generic" or
    // unspecified.
    expect(
      getBootstrapOllamaModelOptions({ totalMemoryMB: LARGE_OLLAMA_MIN_MEMORY_MB }),
    ).toEqual(["qwen2.5:7b"]);
    expect(
      getDefaultOllamaModel({ totalMemoryMB: LARGE_OLLAMA_MIN_MEMORY_MB }, () => ""),
    ).toBe("qwen2.5:7b");
    expect(
      getBootstrapOllamaModelOptions({
        type: "generic",
        totalMemoryMB: LARGE_OLLAMA_MIN_MEMORY_MB * 4,
      }),
    ).toEqual(["qwen2.5:7b"]);
    expect(
      getDefaultOllamaModel(
        { type: "generic", totalMemoryMB: LARGE_OLLAMA_MIN_MEMORY_MB * 4 },
        () => "",
      ),
    ).toBe("qwen2.5:7b");
  });

  it("builds a background warmup command for ollama models", () => {
    const command = getOllamaWarmupCommand("nemotron-3-nano:30b");
    expect(command).toEqual(expect.arrayContaining(["bash", "-c"]));
    expect(command[2]).toMatch(/^nohup curl -s http:\/\/127.0.0.1:11434\/api\/generate /);
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
    expect(command).toContain("http://127.0.0.1:11434/api/generate");
    const payload = command[command.length - 1];
    expect(payload).toMatch(/"model":"nemotron-3-nano:30b"/);
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

  it("treats non-JSON probe output as success once the model responds", () => {
    expect(validateOllamaModel("nemotron-3-nano:30b", () => "ok")).toEqual({ ok: true });
  });
});
