// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, it, expect } from "vitest";

// Import from compiled dist/ for correct coverage attribution.
import {
  getRemoteProviderHealthEndpoint,
  probeRemoteProviderHealth,
  probeProviderHealth,
} from "../../../dist/lib/inference/health";

import { BUILD_ENDPOINT_URL } from "../../../dist/lib/inference/provider-models";

describe("inference health", () => {
  describe("getRemoteProviderHealthEndpoint", () => {
    it("returns NVIDIA endpoint for nvidia-prod", () => {
      expect(getRemoteProviderHealthEndpoint("nvidia-prod")).toBe(`${BUILD_ENDPOINT_URL}/models`);
    });

    it("returns NVIDIA endpoint for nvidia-nim", () => {
      expect(getRemoteProviderHealthEndpoint("nvidia-nim")).toBe(`${BUILD_ENDPOINT_URL}/models`);
    });

    it("returns OpenAI endpoint for openai-api", () => {
      expect(getRemoteProviderHealthEndpoint("openai-api")).toBe(
        "https://api.openai.com/v1/models",
      );
    });

    it("returns Anthropic endpoint for anthropic-prod", () => {
      expect(getRemoteProviderHealthEndpoint("anthropic-prod")).toBe(
        "https://api.anthropic.com/v1/models",
      );
    });

    it("returns Gemini endpoint for gemini-api", () => {
      expect(getRemoteProviderHealthEndpoint("gemini-api")).toBe(
        "https://generativelanguage.googleapis.com/v1/models",
      );
    });

    it("returns null for compatible-endpoint", () => {
      expect(getRemoteProviderHealthEndpoint("compatible-endpoint")).toBeNull();
    });

    it("returns null for compatible-anthropic-endpoint", () => {
      expect(getRemoteProviderHealthEndpoint("compatible-anthropic-endpoint")).toBeNull();
    });

    it("returns null for local providers", () => {
      expect(getRemoteProviderHealthEndpoint("ollama-local")).toBeNull();
      expect(getRemoteProviderHealthEndpoint("vllm-local")).toBeNull();
    });

    it("returns null for unknown providers", () => {
      expect(getRemoteProviderHealthEndpoint("unknown-provider")).toBeNull();
    });
  });

  describe("probeRemoteProviderHealth", () => {
    it("reports reachable when endpoint returns HTTP 200", () => {
      const result = probeRemoteProviderHealth("openai-api", {
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
        probed: true,
        providerLabel: "OpenAI",
        endpoint: "https://api.openai.com/v1/models",
        detail: "OpenAI endpoint is reachable at https://api.openai.com/v1/models.",
      });
    });

    it("reports reachable when endpoint returns HTTP 401 (auth required)", () => {
      const result = probeRemoteProviderHealth("nvidia-prod", {
        runCurlProbeImpl: () => ({
          ok: false,
          httpStatus: 401,
          curlStatus: 0,
          body: '{"error":"unauthorized"}',
          stderr: "",
          message: "HTTP 401: unauthorized",
        }),
      });

      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(true);
      expect(result?.detail).toContain("reachable");
    });

    it("reports reachable when endpoint returns HTTP 403 (forbidden)", () => {
      const result = probeRemoteProviderHealth("anthropic-prod", {
        runCurlProbeImpl: () => ({
          ok: false,
          httpStatus: 403,
          curlStatus: 0,
          body: "",
          stderr: "",
          message: "HTTP 403",
        }),
      });

      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(true);
    });

    it("reports unreachable when connection is refused", () => {
      const result = probeRemoteProviderHealth("openai-api", {
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
      expect(result?.probed).toBe(true);
      expect(result?.detail).toContain("unreachable");
      expect(result?.detail).toContain("Check your network connection");
    });

    it("reports unreachable on timeout", () => {
      const result = probeRemoteProviderHealth("gemini-api", {
        runCurlProbeImpl: () => ({
          ok: false,
          httpStatus: 0,
          curlStatus: 28,
          body: "",
          stderr: "Operation timed out",
          message: "curl failed (exit 28): Operation timed out",
        }),
      });

      expect(result?.ok).toBe(false);
      expect(result?.probed).toBe(true);
      expect(result?.endpoint).toBe("https://generativelanguage.googleapis.com/v1/models");
    });

    it("returns not-probed status for compatible-endpoint", () => {
      const result = probeRemoteProviderHealth("compatible-endpoint");

      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(false);
      expect(result?.detail).toContain("not known");
    });

    it("returns not-probed status for compatible-anthropic-endpoint", () => {
      const result = probeRemoteProviderHealth("compatible-anthropic-endpoint");

      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(false);
    });

    it("returns null for local providers", () => {
      expect(probeRemoteProviderHealth("ollama-local")).toBeNull();
      expect(probeRemoteProviderHealth("vllm-local")).toBeNull();
    });

    it("returns null for unknown providers", () => {
      expect(probeRemoteProviderHealth("unknown-provider")).toBeNull();
    });

    it("passes correct curl arguments to the probe", () => {
      let capturedArgv: string[] = [];
      probeRemoteProviderHealth("openai-api", {
        runCurlProbeImpl: (argv) => {
          capturedArgv = argv;
          return {
            ok: true,
            httpStatus: 200,
            curlStatus: 0,
            body: "",
            stderr: "",
            message: "",
          };
        },
      });

      expect(capturedArgv).toEqual([
        "-sS",
        "--connect-timeout",
        "3",
        "--max-time",
        "5",
        "https://api.openai.com/v1/models",
      ]);
    });

    it("uses Kimi chat completions for NVIDIA managed inference when a credential is available", () => {
      let capturedArgv: string[] = [];
      let authConfigPath = "";
      let authConfigContent = "";
      const result = probeRemoteProviderHealth("nvidia-prod", {
        model: "moonshotai/kimi-k2.6",
        getCredentialImpl: (envName) => (envName === "NVIDIA_API_KEY" ? "nvapi-test" : null),
        runCurlProbeImpl: (argv) => {
          capturedArgv = argv;
          const configIndex = argv.indexOf("--config");
          authConfigPath = configIndex >= 0 ? argv[configIndex + 1] : "";
          authConfigContent = authConfigPath ? fs.readFileSync(authConfigPath, "utf8") : "";
          return {
            ok: true,
            httpStatus: 200,
            curlStatus: 0,
            body: '{"choices":[{"message":{"content":"OK"}}]}',
            stderr: "",
            message: "HTTP 200",
          };
        },
      });

      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(true);
      expect(result?.endpoint).toBe(`${BUILD_ENDPOINT_URL}/chat/completions`);
      expect(capturedArgv.join(" ")).not.toContain("nvapi-test");
      expect(capturedArgv.join(" ")).not.toContain("Authorization: Bearer");
      expect(capturedArgv).toContain("--config");
      expect(authConfigContent).toContain("Authorization: Bearer nvapi-test");
      expect(fs.existsSync(authConfigPath)).toBe(false);
      expect(capturedArgv).toContain("--connect-timeout");
      expect(capturedArgv[capturedArgv.indexOf("--connect-timeout") + 1]).toBe("3");
      expect(capturedArgv).toContain("--max-time");
      expect(capturedArgv[capturedArgv.indexOf("--max-time") + 1]).toBe("5");
      expect(capturedArgv.at(-1)).toBe(`${BUILD_ENDPOINT_URL}/chat/completions`);

      const payload = JSON.parse(capturedArgv[capturedArgv.indexOf("-d") + 1]);
      expect(payload).toEqual({
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 8,
      });
    });

    it("does not fall back to provider-level NVIDIA /models for Kimi without a credential", () => {
      let called = false;
      const result = probeRemoteProviderHealth("nvidia-prod", {
        model: "moonshotai/kimi-k2.6",
        getCredentialImpl: () => null,
        runCurlProbeImpl: () => {
          called = true;
          return {
            ok: false,
            httpStatus: 0,
            curlStatus: 28,
            body: "",
            stderr: "Operation timed out",
            message: "curl failed (exit 28): Operation timed out",
          };
        },
      });

      expect(called).toBe(false);
      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(false);
      expect(result?.endpoint).toBe(`${BUILD_ENDPOINT_URL}/chat/completions`);
      expect(result?.detail).toContain("NVIDIA_API_KEY");
      expect(result?.detail).toContain("provider-level /models");
    });

    it("reports Kimi health as not probed when credential lookup fails", () => {
      let called = false;
      const result = probeRemoteProviderHealth("nvidia-prod", {
        model: "moonshotai/kimi-k2.6",
        getCredentialImpl: () => {
          throw new Error("credential store unavailable");
        },
        runCurlProbeImpl: () => {
          called = true;
          return {
            ok: false,
            httpStatus: 0,
            curlStatus: 28,
            body: "",
            stderr: "Operation timed out",
            message: "curl failed (exit 28): Operation timed out",
          };
        },
      });

      expect(called).toBe(false);
      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(false);
      expect(result?.detail).toContain("credential store unavailable");
    });
  });

  describe("probeProviderHealth (unified)", () => {
    it("delegates to local probe for ollama-local", () => {
      const result = probeProviderHealth("ollama-local", {
        runCurlProbeImpl: () => ({
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: "{}",
          stderr: "",
          message: "HTTP 200",
        }),
      });

      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(true);
      expect(result?.providerLabel).toBe("Local Ollama");
      expect(result?.endpoint).toBe("http://127.0.0.1:11434/api/tags");
    });

    it("delegates to remote probe for openai-api", () => {
      const result = probeProviderHealth("openai-api", {
        runCurlProbeImpl: () => ({
          ok: false,
          httpStatus: 401,
          curlStatus: 0,
          body: "",
          stderr: "",
          message: "HTTP 401",
        }),
      });

      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(true);
      expect(result?.providerLabel).toBe("OpenAI");
    });

    it("keeps non-Kimi NVIDIA models on the provider reachability probe", () => {
      let capturedArgv: string[] = [];
      const result = probeProviderHealth("nvidia-prod", {
        model: "minimaxai/minimax-m2.7",
        runCurlProbeImpl: (argv) => {
          capturedArgv = argv;
          return {
            ok: false,
            httpStatus: 401,
            curlStatus: 0,
            body: "",
            stderr: "",
            message: "HTTP 401",
          };
        },
      });

      expect(result?.ok).toBe(true);
      expect(result?.endpoint).toBe(`${BUILD_ENDPOINT_URL}/models`);
      expect(capturedArgv.at(-1)).toBe(`${BUILD_ENDPOINT_URL}/models`);
      expect(capturedArgv).not.toContain(`${BUILD_ENDPOINT_URL}/chat/completions`);
    });

    it("uses model-aware Kimi probing through the unified health entry point", () => {
      let capturedArgv: string[] = [];
      const result = probeProviderHealth("nvidia-nim", {
        model: "moonshotai/kimi-k2.6",
        getCredentialImpl: () => "nvapi-test",
        runCurlProbeImpl: (argv) => {
          capturedArgv = argv;
          return {
            ok: false,
            httpStatus: 401,
            curlStatus: 0,
            body: '{"error":"unauthorized"}',
            stderr: "",
            message: "HTTP 401: unauthorized",
          };
        },
      });

      expect(result?.ok).toBe(false);
      expect(result?.probed).toBe(true);
      expect(result?.failureLabel).toBe("unhealthy");
      expect(result?.endpoint).toBe(`${BUILD_ENDPOINT_URL}/chat/completions`);
      expect(capturedArgv.at(-1)).toBe(`${BUILD_ENDPOINT_URL}/chat/completions`);
    });

    it("returns not-probed for compatible-endpoint", () => {
      const result = probeProviderHealth("compatible-endpoint");

      expect(result?.probed).toBe(false);
    });

    it("returns null for unknown providers", () => {
      expect(probeProviderHealth("bogus-provider")).toBeNull();
    });
  });
});
