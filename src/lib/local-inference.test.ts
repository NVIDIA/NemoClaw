// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

// Import from compiled dist/ for correct coverage attribution.
import {
  CONTAINER_REACHABILITY_IMAGE,
  DEFAULT_OLLAMA_MODEL,
  LARGE_OLLAMA_MIN_MEMORY_MB,
  detectWsl2HostIp,
  getDefaultOllamaModel,
  getBootstrapOllamaModelOptions,
  getLocalProviderBaseUrl,
  getLocalProviderContainerReachabilityCheck,
  getLocalProviderHealthCheck,
  getLocalProviderValidationBaseUrl,
  getOllamaModelOptions,
  getOllamaProbeCommand,
  getOllamaWarmupCommand,
  parseOllamaList,
  parseOllamaTags,
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

  it("uses an explicit host IP in the base URL when provided", () => {
    expect(getLocalProviderBaseUrl("ollama-local", "172.20.130.16")).toBe(
      "http://172.20.130.16:11434/v1",
    );
    expect(getLocalProviderBaseUrl("vllm-local", "172.20.130.16")).toBe(
      "http://172.20.130.16:8000/v1",
    );
    expect(getLocalProviderBaseUrl("unknown-provider", "172.20.130.16")).toBeNull();
  });

  it("returns null for unknown local provider URLs", () => {
    expect(getLocalProviderBaseUrl("unknown-provider")).toBeNull();
    expect(getLocalProviderValidationBaseUrl("unknown-provider")).toBeNull();
    expect(getLocalProviderHealthCheck("unknown-provider")).toBeNull();
    expect(getLocalProviderContainerReachabilityCheck("unknown-provider")).toBeNull();
  });

  it("returns the expected validation URL for vllm-local", () => {
    expect(getLocalProviderValidationBaseUrl("vllm-local")).toBe("http://localhost:8000/v1");
  });

  it("returns the expected health check command for ollama-local", () => {
    expect(getLocalProviderHealthCheck("ollama-local")).toBe(
      "curl -sf http://localhost:11434/api/tags 2>/dev/null",
    );
  });

  it("returns the expected validation and health check commands for vllm-local", () => {
    expect(getLocalProviderValidationBaseUrl("ollama-local")).toBe("http://localhost:11434/v1");
    expect(getLocalProviderHealthCheck("vllm-local")).toBe(
      "curl -sf http://localhost:8000/v1/models 2>/dev/null",
    );
    expect(getLocalProviderContainerReachabilityCheck("vllm-local")).toBe(
      `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -4 -sf http://host.openshell.internal:8000/v1/models 2>/dev/null`,
    );
  });

  it("returns the expected container reachability command for ollama-local", () => {
    expect(getLocalProviderContainerReachabilityCheck("ollama-local")).toBe(
      `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -4 -sf http://host.openshell.internal:11434/api/tags 2>/dev/null`,
    );
  });

  it("uses an explicit host IP when provided", () => {
    expect(getLocalProviderContainerReachabilityCheck("ollama-local", "172.20.130.16")).toBe(
      `docker run --rm --add-host host.openshell.internal:172.20.130.16 ${CONTAINER_REACHABILITY_IMAGE} -4 -sf http://host.openshell.internal:11434/api/tags 2>/dev/null`,
    );
    expect(getLocalProviderContainerReachabilityCheck("vllm-local", "172.20.130.16")).toBe(
      `docker run --rm --add-host host.openshell.internal:172.20.130.16 ${CONTAINER_REACHABILITY_IMAGE} -4 -sf http://host.openshell.internal:8000/v1/models 2>/dev/null`,
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
    expect(result.message).toMatch(/OLLAMA_HOST=0\.0\.0\.0:11434/);
  });

  it("returns a clear error when vllm-local is unavailable", () => {
    const result = validateLocalProvider("vllm-local", () => "");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/http:\/\/localhost:8000/);
  });

  it("returns a clear error when vllm-local is not reachable from containers", () => {
    let callCount = 0;
    const result = validateLocalProvider("vllm-local", () => {
      callCount += 1;
      return callCount === 1 ? '{"data":[]}' : "";
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/host\.openshell\.internal:8000/);
  });

  describe("detectWsl2HostIp", () => {
    it("prefers the `ip route get` outbound source address", () => {
      const ip = detectWsl2HostIp((cmd) => {
        if (cmd.includes("ip -4 -o route get")) {
          return "1.1.1.1 via 172.20.128.1 dev eth0 src 172.20.130.16 uid 1000\n";
        }
        if (cmd.includes("hostname -I")) return "192.168.1.50 172.17.0.1 ";
        return "";
      });
      expect(ip).toBe("172.20.130.16");
    });

    it("returns eth0 src and default gateway as separate candidates", async () => {
      const { detectWsl2HostIpCandidates } = await import(
        "../../dist/lib/local-inference"
      );
      const candidates = detectWsl2HostIpCandidates((cmd) => {
        if (cmd.includes("ip -4 -o route get 1.1.1.1")) {
          return "1.1.1.1 via 172.20.128.1 dev eth0 src 172.20.130.16 uid 1000";
        }
        if (cmd.includes("ip -4 -o route show default")) {
          return "default via 172.20.128.1 dev eth0 proto kernel\n";
        }
        return "";
      });
      expect(candidates).toEqual(["172.20.130.16", "172.20.128.1"]);
    });

    it("falls back to hostname -I when ip route is unavailable", () => {
      const ip = detectWsl2HostIp((cmd) => {
        if (cmd.includes("ip -4 -o route get")) return "";
        if (cmd.includes("hostname -I")) return "172.20.130.16 172.17.0.1";
        return "";
      });
      expect(ip).toBe("172.20.130.16");
    });

    it("skips docker bridge, loopback, and link-local addresses", () => {
      const ip = detectWsl2HostIp((cmd) => {
        if (cmd.includes("ip -4 -o route get")) return "";
        if (cmd.includes("hostname -I"))
          return "127.0.0.1 172.17.0.1 169.254.1.2 10.42.0.5 192.168.1.50";
        return "";
      });
      expect(ip).toBe("192.168.1.50");
    });

    it("returns null when no usable address is found", () => {
      expect(
        detectWsl2HostIp((cmd) => {
          if (cmd.includes("ip -4 -o route get")) return "";
          if (cmd.includes("hostname -I")) return "127.0.0.1 172.17.0.1";
          return "";
        }),
      ).toBeNull();
    });

    it("returns null when both probes fail", () => {
      expect(detectWsl2HostIp(() => "")).toBeNull();
    });

    it("ignores non-IPv4 tokens from hostname -I (IPv6 etc.)", () => {
      const ip = detectWsl2HostIp((cmd) => {
        if (cmd.includes("ip -4 -o route get")) return "";
        if (cmd.includes("hostname -I")) return "fe80::1234 192.168.1.50";
        return "";
      });
      expect(ip).toBe("192.168.1.50");
    });
  });

  it("detects WSL2 host IP and uses it for the container check", () => {
    const result = validateLocalProvider(
      "ollama-local",
      (cmd) => {
        if (cmd.includes("/api/tags") && !cmd.includes("docker run")) {
          return '{"models":[]}'; // localhost health check
        }
        if (cmd.includes("ip -4 -o route get")) {
          return "1.1.1.1 via 172.20.128.1 dev eth0 src 172.20.130.16 uid 1000";
        }
        if (cmd.includes("ip -4 -o route show default")) {
          return "default via 172.20.128.1 dev eth0 proto kernel";
        }
        if (cmd.includes("docker run") && cmd.includes("172.20.130.16")) {
          return '{"models":[]}'; // first candidate wins
        }
        return "";
      },
      { isWsl: true, isDockerDesktop: true },
    );
    expect(result).toEqual({ ok: true, resolvedHostIp: "172.20.130.16" });
  });

  it("falls back to default gateway when eth0 candidate is not reachable", () => {
    const result = validateLocalProvider(
      "ollama-local",
      (cmd) => {
        if (cmd.includes("/api/tags") && !cmd.includes("docker run")) {
          return '{"models":[]}';
        }
        if (cmd.includes("ip -4 -o route get")) {
          return "1.1.1.1 via 172.20.128.1 dev eth0 src 172.20.130.16 uid 1000";
        }
        if (cmd.includes("ip -4 -o route show default")) {
          return "default via 172.20.128.1 dev eth0 proto kernel";
        }
        // only the gateway candidate reaches Windows-hosted Ollama
        if (cmd.includes("docker run") && cmd.includes("172.20.128.1")) {
          return '{"models":[]}';
        }
        return "";
      },
      { isWsl: true, isDockerDesktop: true },
    );
    expect(result).toEqual({ ok: true, resolvedHostIp: "172.20.128.1" });
  });

  it("falls back to host-gateway when not on WSL2 + Docker Desktop", () => {
    let callCount = 0;
    const result = validateLocalProvider(
      "ollama-local",
      () => {
        callCount += 1;
        return '{"models":[]}';
      },
      { isWsl: false, isDockerDesktop: false },
    );
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(2); // no hostname -I call
  });

  it("treats unknown local providers as already valid", () => {
    expect(validateLocalProvider("custom-provider", () => "")).toEqual({ ok: true });
  });

  it("skips health check entirely for unknown providers", () => {
    let callCount = 0;
    const result = validateLocalProvider("custom-provider", () => {
      callCount += 1;
      return callCount <= 1 ? "ok" : "";
    });
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
    expect(
      getOllamaModelOptions(
        () => "nemotron-3-nano:30b  abc  24 GB  now\nqwen3:32b  def  20 GB  now",
      ),
    ).toEqual(["nemotron-3-nano:30b", "qwen3:32b"]);
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
    expect(
      getOllamaModelOptions(() => {
        call += 1;
        if (call === 1) {
          return JSON.stringify({ models: [{ name: "qwen2.5:7b" }] });
        }
        return "";
      }),
    ).toEqual(["qwen2.5:7b"]);
  });

  it("returns no installed ollama models when list output is empty", () => {
    expect(getOllamaModelOptions(() => "")).toEqual([]);
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

  it("falls back to bootstrap model options when no Ollama models are installed", () => {
    expect(getBootstrapOllamaModelOptions(null)).toEqual(["qwen2.5:7b"]);
    expect(
      getBootstrapOllamaModelOptions({ totalMemoryMB: LARGE_OLLAMA_MIN_MEMORY_MB - 1 }),
    ).toEqual(["qwen2.5:7b"]);
    expect(
      getBootstrapOllamaModelOptions({ totalMemoryMB: LARGE_OLLAMA_MIN_MEMORY_MB }),
    ).toEqual(["qwen2.5:7b", DEFAULT_OLLAMA_MODEL]);
    expect(getDefaultOllamaModel(() => "", { totalMemoryMB: 16384 })).toBe("qwen2.5:7b");
  });

  it("builds a background warmup command for ollama models", () => {
    const command = getOllamaWarmupCommand("nemotron-3-nano:30b");
    expect(command).toMatch(/^nohup curl -s http:\/\/localhost:11434\/api\/generate /);
    expect(command).toMatch(/"model":"nemotron-3-nano:30b"/);
    expect(command).toMatch(/"keep_alive":"15m"/);
  });

  it("supports custom probe and warmup tuning", () => {
    expect(getOllamaWarmupCommand("qwen2.5:7b", "30m")).toMatch(/"keep_alive":"30m"/);
    expect(getOllamaProbeCommand("qwen2.5:7b", 30, "5m")).toMatch(/--max-time 30/);
    expect(getOllamaProbeCommand("qwen2.5:7b", 30, "5m")).toMatch(/"keep_alive":"5m"/);
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

  it("treats non-JSON probe output as success once the model responds", () => {
    expect(validateOllamaModel("nemotron-3-nano:30b", () => "ok")).toEqual({ ok: true });
  });
});
