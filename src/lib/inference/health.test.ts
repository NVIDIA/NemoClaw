// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

// Import source directly so tests cannot pass against a stale build.
import { probeProviderHealth, probeRemoteProviderHealth } from "./health";

import { BUILD_ENDPOINT_URL } from "./provider-models";

afterEach(() => {
  vi.unstubAllEnvs();
});

function httpOk(body = '{"choices":[{"message":{"content":"OK"}}]}'): {
  ok: true;
  httpStatus: 200;
  curlStatus: 0;
  body: string;
  stderr: string;
  message: string;
} {
  return { ok: true, httpStatus: 200, curlStatus: 0, body, stderr: "", message: "HTTP 200" };
}

function curlArgValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function httpTimeout() {
  return {
    ok: false as const,
    httpStatus: 0,
    curlStatus: 28,
    body: "",
    stderr: "Operation timed out",
    message: "curl failed (exit 28): Operation timed out",
  };
}

function httpUnauthorized() {
  return {
    ok: false,
    httpStatus: 401,
    curlStatus: 0,
    body: '{"error":"unauthorized"}',
    stderr: "",
    message: "HTTP 401: unauthorized",
  };
}

function httpServerError() {
  return {
    ok: false,
    httpStatus: 500,
    curlStatus: 0,
    body: "",
    stderr: "",
    message: "HTTP 500",
  };
}

function connectionRefused() {
  return {
    ok: false,
    httpStatus: 0,
    curlStatus: 7,
    body: "",
    stderr: "Failed to connect",
    message: "curl failed (exit 7): Failed to connect",
  };
}

describe("inference health", () => {
  describe("probeRemoteProviderHealth — Bearer-auth chat-completions family", () => {
    it("invokes chat-completions for openai-api and never leaks the key into argv", () => {
      vi.stubEnv("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS", "90");
      let capturedArgv: string[] = [];
      let authConfigPath = "";
      let authConfigContent = "";
      const result = probeRemoteProviderHealth("openai-api", {
        model: "gpt-4o-mini",
        getCredentialImpl: (envName) => (envName === "OPENAI_API_KEY" ? "sk-test-secret" : null),
        runCurlProbeImpl: (argv) => {
          capturedArgv = argv;
          const configIndex = argv.indexOf("--config");
          authConfigPath = configIndex >= 0 ? argv[configIndex + 1] : "";
          authConfigContent = authConfigPath ? fs.readFileSync(authConfigPath, "utf8") : "";
          return httpOk('{"choices":[{"message":{"content":"OK"}}]}');
        },
      });

      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(true);
      expect(result?.providerLabel).toBe("OpenAI");
      expect(result?.endpoint).toBe("https://api.openai.com/v1/chat/completions");
      expect(capturedArgv.at(-1)).toBe("https://api.openai.com/v1/chat/completions");
      expect(curlArgValue(capturedArgv, "--connect-timeout")).toBe("3");
      expect(curlArgValue(capturedArgv, "--max-time")).toBe("5");

      const joined = capturedArgv.join(" ");
      expect(joined).not.toContain("sk-test-secret");
      expect(joined).not.toContain("Authorization: Bearer");
      expect(capturedArgv).toContain("--config");
      expect(authConfigContent).toContain("Authorization: Bearer sk-test-secret");
      expect(fs.existsSync(authConfigPath)).toBe(false);

      const payload = JSON.parse(capturedArgv[capturedArgv.indexOf("-d") + 1]);
      expect(payload).toEqual({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 8,
      });
    });

    it("skips the invocation probe for openai-api without a credential (never authoritative)", () => {
      let called = false;
      const result = probeRemoteProviderHealth("openai-api", {
        model: "gpt-4o-mini",
        getCredentialImpl: () => null,
        runCurlProbeImpl: () => {
          called = true;
          return httpOk();
        },
      });

      expect(called).toBe(false);
      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(false);
      expect(result?.detail).toContain("OPENAI_API_KEY");
    });

    it("invokes the Gemini OpenAI-compatible chat-completions shim, not the native v1/models surface", () => {
      let capturedArgv: string[] = [];
      const result = probeRemoteProviderHealth("gemini-api", {
        model: "gemini-2.5-flash",
        getCredentialImpl: (envName) => (envName === "GEMINI_API_KEY" ? "gm-test-secret" : null),
        runCurlProbeImpl: (argv) => {
          capturedArgv = argv;
          return httpOk();
        },
      });

      expect(result?.ok).toBe(true);
      expect(result?.endpoint).toBe(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      );
      expect(capturedArgv.at(-1)).toBe(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      );
      expect(capturedArgv.join(" ")).not.toContain("gm-test-secret");
    });

    it("skips the invocation probe for gemini-api without a credential", () => {
      const result = probeRemoteProviderHealth("gemini-api", {
        model: "gemini-2.5-flash",
        getCredentialImpl: () => null,
        runCurlProbeImpl: () => httpOk(),
      });

      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(false);
      expect(result?.detail).toContain("GEMINI_API_KEY");
    });

    it("probes non-Kimi NVIDIA models with a real chat-completions invocation (Stage A generalization)", () => {
      let capturedArgv: string[] = [];
      const result = probeRemoteProviderHealth("nvidia-prod", {
        model: "meta/llama-3.3-70b-instruct",
        getCredentialImpl: (envName) =>
          envName === "NVIDIA_INFERENCE_API_KEY" ? "nvapi-test" : null,
        runCurlProbeImpl: (argv) => {
          capturedArgv = argv;
          return httpOk();
        },
      });

      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(true);
      expect(result?.endpoint).toBe(`${BUILD_ENDPOINT_URL}/chat/completions`);
      expect(capturedArgv.at(-1)).toBe(`${BUILD_ENDPOINT_URL}/chat/completions`);
      const payload = JSON.parse(capturedArgv[capturedArgv.indexOf("-d") + 1]);
      expect(payload.model).toBe("meta/llama-3.3-70b-instruct");
    });

    it("always resolves NVIDIA credentials from NVIDIA_INFERENCE_API_KEY, not the route's default credential env", () => {
      let resolvedEnvNames: string[] = [];
      const result = probeRemoteProviderHealth("nvidia-nim", {
        model: "meta/llama-3.3-70b-instruct",
        getCredentialImpl: (envName) => {
          resolvedEnvNames.push(envName);
          return null;
        },
        runCurlProbeImpl: () => httpOk(),
      });

      expect(resolvedEnvNames).toEqual(["NVIDIA_INFERENCE_API_KEY"]);
      expect(resolvedEnvNames).not.toContain("OPENAI_API_KEY");
      expect(result?.probed).toBe(false);
    });

    it("still applies Kimi K2.6's model-specific payload treatment through the generalized helper", () => {
      let capturedArgv: string[] = [];
      let authConfigPath = "";
      const result = probeRemoteProviderHealth("nvidia-nim", {
        model: "moonshotai/kimi-k2.6",
        getCredentialImpl: (envName) =>
          envName === "NVIDIA_INFERENCE_API_KEY" ? "nvapi-test" : null,
        runCurlProbeImpl: (argv) => {
          capturedArgv = argv;
          const configIndex = argv.indexOf("--config");
          authConfigPath = configIndex >= 0 ? argv[configIndex + 1] : "";
          return httpOk('{"choices":[{"message":{"content":"OK"}}]}');
        },
      });

      expect(result?.ok).toBe(true);
      expect(result?.endpoint).toBe(`${BUILD_ENDPOINT_URL}/chat/completions`);
      // PR #5975: the bearer credential must route through the central
      // auth-config helper, never inline in argv.
      expect(capturedArgv.join(" ")).not.toContain("nvapi-test");
      expect(fs.existsSync(authConfigPath)).toBe(false);

      const payload = JSON.parse(capturedArgv[capturedArgv.indexOf("-d") + 1]);
      expect(payload).toEqual({
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 8,
        chat_template_kwargs: { thinking: false },
      });
      expect(curlArgValue(capturedArgv, "--connect-timeout")).toBe("3");
      expect(curlArgValue(capturedArgv, "--max-time")).toBe("5");
    });

    it("uses a lightweight DeepSeek V4 Pro status payload and validates its SSE shape", () => {
      let capturedArgv: string[] = [];
      const result = probeRemoteProviderHealth("nvidia-prod", {
        model: "deepseek-ai/deepseek-v4-pro",
        getCredentialImpl: () => "nvapi-test",
        runCurlProbeImpl: (argv) => {
          capturedArgv = argv;
          return httpOk('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n');
        },
      });

      expect(result?.ok).toBe(true);
      expect(curlArgValue(capturedArgv, "--connect-timeout")).toBe("3");
      expect(curlArgValue(capturedArgv, "--max-time")).toBe("5");
      const payload = JSON.parse(capturedArgv[capturedArgv.indexOf("-d") + 1]);
      expect(payload).toMatchObject({ max_tokens: 8, stream: true });
    });

    it.each([
      "deepseek-ai/deepseek-v4-pro",
      "qwen/qwen3.5-397b-a17b",
      "deepseek-ai/deepseek-v4-flash",
    ])("reports the short status timeout as unverified for slow model %s", (model) => {
      const result = probeRemoteProviderHealth("nvidia-prod", {
        model,
        getCredentialImpl: () => "nvapi-test",
        runCurlProbeImpl: () => httpTimeout(),
      });

      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(false);
      expect(result?.failureLabel).toBeUndefined();
      expect(result?.detail).toContain("model health was not verified");
    });

    it("reports a malformed HTTP 200 body as unhealthy", () => {
      const result = probeRemoteProviderHealth("openai-api", {
        model: "gpt-4o-mini",
        getCredentialImpl: () => "sk-test-secret",
        runCurlProbeImpl: () => httpOk("<html>upstream proxy</html>"),
      });

      expect(result?.ok).toBe(false);
      expect(result?.probed).toBe(true);
      expect(result?.failureLabel).toBe("unhealthy");
      expect(result?.detail).toContain("not a Chat Completions result");
    });

    it.each([
      ["numeric content", '{"choices":[{"message":{"content":123}}]}'],
      ["numeric refusal", '{"choices":[{"message":{"refusal":123}}]}'],
      [
        "malformed tool call",
        '{"choices":[{"message":{"tool_calls":[{"type":"function","function":{"name":"probe","arguments":7}}]}}]}',
      ],
      ["numeric streaming delta", 'data: {"choices":[{"delta":{"content":123}}]}\n'],
    ])("rejects a Chat Completions response with %s", (_description, body) => {
      const result = probeRemoteProviderHealth("openai-api", {
        model: "gpt-4o-mini",
        getCredentialImpl: () => "sk-test-secret",
        runCurlProbeImpl: () => httpOk(body),
      });

      expect(result?.ok).toBe(false);
      expect(result?.probed).toBe(true);
      expect(result?.failureLabel).toBe("unhealthy");
      expect(result?.detail).toContain("not a Chat Completions result");
    });

    it("reports a provider error envelope returned with HTTP 200 as unhealthy", () => {
      const result = probeRemoteProviderHealth("openai-api", {
        model: "gpt-4o-mini",
        getCredentialImpl: () => "sk-test-secret",
        runCurlProbeImpl: () => httpOk('{"error":{"message":"model unavailable"}}'),
      });

      expect(result?.ok).toBe(false);
      expect(result?.probed).toBe(true);
      expect(result?.failureLabel).toBe("unhealthy");
      expect(result?.detail).toContain("error envelope");
    });

    it.each([
      ["gemini-api", "gemini-2.5-flash", "{}"],
      ["nvidia-prod", "meta/llama-3.3-70b-instruct", '{"error":{"message":"model unavailable"}}'],
    ])("rejects malformed HTTP 200 responses from %s", (provider, model, body) => {
      const result = probeRemoteProviderHealth(provider, {
        model,
        getCredentialImpl: () => "test-secret",
        runCurlProbeImpl: () => httpOk(body),
      });

      expect(result?.ok).toBe(false);
      expect(result?.probed).toBe(true);
      expect(result?.failureLabel).toBe("unhealthy");
    });

    it("reports unauthorized (not healthy) on HTTP 401", () => {
      const result = probeRemoteProviderHealth("openai-api", {
        model: "gpt-4o-mini",
        getCredentialImpl: () => "sk-test-secret",
        runCurlProbeImpl: () => httpUnauthorized(),
      });

      expect(result?.ok).toBe(false);
      expect(result?.probed).toBe(true);
      expect(result?.failureLabel).toBe("unauthorized");
    });

    it("reports unhealthy on a non-auth HTTP failure", () => {
      const result = probeRemoteProviderHealth("openai-api", {
        model: "gpt-4o-mini",
        getCredentialImpl: () => "sk-test-secret",
        runCurlProbeImpl: () => httpServerError(),
      });

      expect(result?.ok).toBe(false);
      expect(result?.probed).toBe(true);
      expect(result?.failureLabel).toBe("unhealthy");
    });

    it("reports unreachable when the connection is refused", () => {
      const result = probeRemoteProviderHealth("openai-api", {
        model: "gpt-4o-mini",
        getCredentialImpl: () => "sk-test-secret",
        runCurlProbeImpl: () => connectionRefused(),
      });

      expect(result?.ok).toBe(false);
      expect(result?.probed).toBe(true);
      expect(result?.failureLabel).toBe("unreachable");
    });

    it("reports unhealthy (not probed) when credential lookup throws", () => {
      let called = false;
      const result = probeRemoteProviderHealth("openai-api", {
        model: "gpt-4o-mini",
        getCredentialImpl: () => {
          throw new Error("credential store unavailable");
        },
        runCurlProbeImpl: () => {
          called = true;
          return httpOk();
        },
      });

      expect(called).toBe(false);
      expect(result?.ok).toBe(false);
      expect(result?.probed).toBe(false);
      expect(result?.failureLabel).toBe("unhealthy");
      expect(result?.detail).toContain("credential store unavailable");
    });
  });

  describe("probeRemoteProviderHealth — Anthropic Messages", () => {
    it("invokes /v1/messages with x-api-key routed only through the config tmpfile", () => {
      let capturedArgv: string[] = [];
      let authConfigPath = "";
      let authConfigContent = "";
      const result = probeRemoteProviderHealth("anthropic-prod", {
        model: "claude-sonnet-4-6",
        getCredentialImpl: (envName) =>
          envName === "ANTHROPIC_API_KEY" ? "sk-ant-test-secret" : null,
        runCurlProbeImpl: (argv) => {
          capturedArgv = argv;
          const configIndex = argv.indexOf("--config");
          authConfigPath = configIndex >= 0 ? argv[configIndex + 1] : "";
          authConfigContent = authConfigPath ? fs.readFileSync(authConfigPath, "utf8") : "";
          return httpOk('{"content":[{"type":"text","text":"OK"}]}');
        },
      });

      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(true);
      expect(result?.providerLabel).toBe("Anthropic");
      expect(result?.endpoint).toBe("https://api.anthropic.com/v1/messages");
      expect(capturedArgv.at(-1)).toBe("https://api.anthropic.com/v1/messages");

      const joined = capturedArgv.join(" ");
      expect(joined).not.toContain("sk-ant-test-secret");
      expect(authConfigContent).toContain("x-api-key: sk-ant-test-secret");
      expect(fs.existsSync(authConfigPath)).toBe(false);

      // anthropic-version is not a secret and stays a plain inline header arg.
      expect(capturedArgv).toContain("anthropic-version: 2023-06-01");

      const payload = JSON.parse(capturedArgv[capturedArgv.indexOf("-d") + 1]);
      expect(payload).toEqual({
        model: "claude-sonnet-4-6",
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
      });
    });

    it("skips the invocation probe for anthropic-prod without a credential", () => {
      let called = false;
      const result = probeRemoteProviderHealth("anthropic-prod", {
        model: "claude-sonnet-4-6",
        getCredentialImpl: () => null,
        runCurlProbeImpl: () => {
          called = true;
          return httpOk();
        },
      });

      expect(called).toBe(false);
      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(false);
      expect(result?.detail).toContain("ANTHROPIC_API_KEY");
    });

    it("reports unauthorized on HTTP 403", () => {
      const result = probeRemoteProviderHealth("anthropic-prod", {
        model: "claude-sonnet-4-6",
        getCredentialImpl: () => "sk-ant-test-secret",
        runCurlProbeImpl: () => ({
          ok: false,
          httpStatus: 403,
          curlStatus: 0,
          body: "",
          stderr: "",
          message: "HTTP 403",
        }),
      });

      expect(result?.ok).toBe(false);
      expect(result?.failureLabel).toBe("unauthorized");
    });

    it("reports a non-Messages HTTP 200 response as unhealthy", () => {
      const result = probeRemoteProviderHealth("anthropic-prod", {
        model: "claude-sonnet-4-6",
        getCredentialImpl: () => "sk-ant-test-secret",
        runCurlProbeImpl: () => httpOk('{"message":"OK"}'),
      });

      expect(result?.ok).toBe(false);
      expect(result?.failureLabel).toBe("unhealthy");
      expect(result?.detail).toContain("not an Anthropic Messages result");
    });

    it("reports an Anthropic error envelope returned with HTTP 200 as unhealthy", () => {
      const result = probeRemoteProviderHealth("anthropic-prod", {
        model: "claude-sonnet-4-6",
        getCredentialImpl: () => "sk-ant-test-secret",
        runCurlProbeImpl: () => httpOk('{"type":"error","error":{"type":"overloaded_error"}}'),
      });

      expect(result?.ok).toBe(false);
      expect(result?.failureLabel).toBe("unhealthy");
      expect(result?.detail).toContain("error envelope");
    });

    it.each([
      ["an unknown block type", '{"content":[{"type":"bogus","text":"OK"}]}'],
      ["numeric text", '{"content":[{"type":"text","text":123}]}'],
      ["incomplete thinking", '{"content":[{"type":"thinking","thinking":"OK"}]}'],
    ])("rejects an Anthropic response with %s", (_description, body) => {
      const result = probeRemoteProviderHealth("anthropic-prod", {
        model: "claude-sonnet-4-6",
        getCredentialImpl: () => "sk-ant-test-secret",
        runCurlProbeImpl: () => httpOk(body),
      });

      expect(result?.ok).toBe(false);
      expect(result?.probed).toBe(true);
      expect(result?.failureLabel).toBe("unhealthy");
      expect(result?.detail).toContain("not an Anthropic Messages result");
    });

    it("reports the short status timeout as unverified", () => {
      const result = probeRemoteProviderHealth("anthropic-prod", {
        model: "claude-sonnet-4-6",
        getCredentialImpl: () => "sk-ant-test-secret",
        runCurlProbeImpl: () => httpTimeout(),
      });

      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(false);
      expect(result?.failureLabel).toBeUndefined();
      expect(result?.detail).toContain("model health was not verified");
    });
  });

  describe("probeRemoteProviderHealth — unrecognized and pass-through providers", () => {
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

    it("returns null for hermes-provider and openrouter, explicitly out of scope (#6846)", () => {
      expect(probeRemoteProviderHealth("hermes-provider")).toBeNull();
      expect(probeRemoteProviderHealth("openrouter")).toBeNull();
    });
  });

  describe("probeProviderHealth (unified)", () => {
    it("delegates to local probe for ollama-local", () => {
      const result = probeProviderHealth("ollama-local", {
        runCurlProbeImpl: () => ({
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: '{"models":[]}',
          stderr: "",
          message: "HTTP 200",
        }),
      });

      expect(result?.ok).toBe(true);
      expect(result?.probed).toBe(true);
      expect(result?.providerLabel).toBe("Local Ollama");
      expect(result?.endpoint).toBe("http://127.0.0.1:11434/api/tags");
    });

    it("passes the configured model through the unified local health probe", () => {
      const result = probeProviderHealth("ollama-local", {
        model: "configured-model",
        runCurlProbeImpl: () => ({
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: '{"models":[]}',
          stderr: "",
          message: "HTTP 200",
        }),
      });

      expect(result?.ok).toBe(false);
      expect(result?.failureLabel).toBe("unhealthy");
      expect(result?.detail).toContain("configured-model");
    });

    it("delegates to remote probe for openai-api", () => {
      const result = probeProviderHealth("openai-api", {
        model: "gpt-4o-mini",
        getCredentialImpl: () => "sk-test-secret",
        runCurlProbeImpl: () => httpUnauthorized(),
      });

      expect(result?.ok).toBe(false);
      expect(result?.probed).toBe(true);
      expect(result?.providerLabel).toBe("OpenAI");
      expect(result?.failureLabel).toBe("unauthorized");
    });

    it("uses model-aware chat-completions probing through the unified health entry point", () => {
      let capturedArgv: string[] = [];
      const result = probeProviderHealth("nvidia-nim", {
        model: "moonshotai/kimi-k2.6",
        getCredentialImpl: () => "nvapi-test",
        runCurlProbeImpl: (argv) => {
          capturedArgv = argv;
          return httpUnauthorized();
        },
      });

      expect(result?.ok).toBe(false);
      expect(result?.probed).toBe(true);
      expect(result?.failureLabel).toBe("unauthorized");
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
