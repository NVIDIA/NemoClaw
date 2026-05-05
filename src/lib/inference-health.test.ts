// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

// Import from compiled dist/ for correct coverage attribution.
import {
  getRemoteProviderHealthEndpoint,
  probeRemoteProviderHealth,
  probeProviderHealth,
} from "../../dist/lib/inference-health";

import { BUILD_ENDPOINT_URL } from "../../dist/lib/provider-models";

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

    it("returns not-probed for compatible-endpoint", () => {
      const result = probeProviderHealth("compatible-endpoint");

      expect(result?.probed).toBe(false);
    });

    it("returns null for unknown providers", () => {
      expect(probeProviderHealth("bogus-provider")).toBeNull();
    });
  });
});
