// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertEndpointResolvesPublic } from "./endpoint-ssrf-preflight";
import {
  type OpenAiValidationSessionDeps,
  probeOpenAiLikeEndpointWithValidationSession,
} from "./openai-validation-session";
import {
  createOpenAiValidationTestDeps,
  useOpenAiValidationTestServers,
} from "./openai-validation-session.test-helpers";

const listen = useOpenAiValidationTestServers();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenAI validation curl fallback", () => {
  it("recovers natively after transient HTTP failures", async () => {
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");
    const responsePlan = [
      [503, '{"error":{"message":"retry"}}'],
      [429, '{"error":{"message":"retry"}}'],
      [200, '{"choices":[{"message":{"content":"OK"}}]}'],
    ] as const;
    let requests = 0;
    const server = http.createServer((request, response) => {
      request.resume();
      const [statusCode, body] = responsePlan[requests] ?? responsePlan.at(-1)!;
      requests += 1;
      response.statusCode = statusCode;
      response.end(body);
    });
    const port = await listen(server);
    const harness = createOpenAiValidationTestDeps();

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "test-key",
      { skipResponsesProbe: true },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(requests).toBe(3);
    expect(harness.legacyProbe).not.toHaveBeenCalled();
  });

  it("falls back once after transient HTTP retries are exhausted", async () => {
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");
    let requests = 0;
    const server = http.createServer((request, response) => {
      request.resume();
      requests += 1;
      response.statusCode = 503;
      response.end('{"error":{"message":"still unavailable"}}');
    });
    const port = await listen(server);
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: false,
      message: "curl retry diagnostic",
    }));
    const harness = createOpenAiValidationTestDeps(legacyProbe);

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "test-key",
      { skipResponsesProbe: true },
      harness,
    );

    expect(result).toEqual({ ok: false, message: "curl retry diagnostic" });
    expect(requests).toBe(4);
    expect(legacyProbe).toHaveBeenCalledTimes(1);
  });

  it("replays through curl after a terminal native failure", async () => {
    const server = http.createServer((request, response) => {
      request.resume();
      response.statusCode = 401;
      response.end('{"error":{"message":"invalid key"}}');
    });
    const port = await listen(server);
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: false,
      message: "curl diagnostic",
    }));
    const harness = createOpenAiValidationTestDeps(legacyProbe);

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "bad-key",
      { skipResponsesProbe: true },
      harness,
    );

    expect(result).toEqual({ ok: false, message: "curl diagnostic" });
    expect(legacyProbe).toHaveBeenCalledTimes(1);
  });

  it("replays through curl once after a native connection reset", async () => {
    const server = http.createServer((request) => {
      request.socket.destroy();
    });
    const port = await listen(server);
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: false,
      message: "curl connection diagnostic",
    }));
    const harness = createOpenAiValidationTestDeps(legacyProbe);

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "test-key",
      { skipResponsesProbe: true },
      harness,
    );

    expect(result).toEqual({ ok: false, message: "curl connection diagnostic" });
    expect(legacyProbe).toHaveBeenCalledTimes(1);
  });

  it("replays through curl when DNS pre-resolution exceeds its deadline", async () => {
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: false,
      message: "curl DNS diagnostic",
    }));
    const lookup = vi.fn(() => new Promise<Array<{ address: string; family: number }>>(() => {}));
    const harness = createOpenAiValidationTestDeps(legacyProbe);
    harness.sessionOptions = { env: {}, lookup, dnsTimeoutMs: 10 };

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      "https://provider.example.test/v1",
      "test-model",
      "test-key",
      {},
      harness,
    );

    expect(result).toEqual({ ok: false, message: "curl DNS diagnostic" });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(legacyProbe).toHaveBeenCalledTimes(1);
  });

  it("replays through curl after a connection reset during Responses streaming", async () => {
    const handleRequest = vi
      .fn()
      .mockImplementationOnce((_request, response) => {
        response.end('{"output":[{"type":"message"}]}');
      })
      .mockImplementationOnce((request) => {
        request.socket.destroy();
      });
    const server = http.createServer((request, response) => {
      request.resume();
      handleRequest(request, response);
    });
    const port = await listen(server);
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: false,
      message: "curl streaming diagnostic",
    }));
    const harness = createOpenAiValidationTestDeps(legacyProbe);

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "test-key",
      { probeStreaming: true },
      harness,
    );

    expect(result).toEqual({ ok: false, message: "curl streaming diagnostic" });
    expect(handleRequest).toHaveBeenCalledTimes(2);
    expect(legacyProbe).toHaveBeenCalledTimes(1);
  });

  it("uses curl without DNS pre-resolution when a proxy is configured", async () => {
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: true,
      api: "openai-completions",
    }));
    const lookup = vi.fn();
    const harness = createOpenAiValidationTestDeps(legacyProbe);
    harness.sessionOptions = {
      env: { HTTPS_PROXY: "http://proxy.example.test:8080" },
      lookup,
    };

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      "https://provider.example.test/v1",
      "test-model",
      "test-key",
      {},
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(legacyProbe).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "CURL_CA_BUNDLE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ])("uses curl without DNS pre-resolution when %s is configured", async (envName) => {
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: true,
      api: "openai-completions",
    }));
    const lookup = vi.fn();
    const harness = createOpenAiValidationTestDeps(legacyProbe);
    harness.sessionOptions = { env: { [envName]: "/tmp/provider-tls-config" }, lookup };

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      "https://provider.example.test/v1",
      "test-model",
      "test-key",
      {},
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(legacyProbe).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps preflight-pinned endpoints on curl without native DNS", async () => {
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: true,
      api: "openai-completions",
    }));
    const harness = createOpenAiValidationTestDeps(legacyProbe);

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      "https://provider.example.test/v1",
      "test-model",
      "test-key",
      { pinnedAddresses: ["203.0.113.10"] },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(legacyProbe).toHaveBeenCalledTimes(1);
    expect(harness.sessionOptions!.lookup).not.toHaveBeenCalled();
  });

  it("keeps trusted private IP literals on curl without native DNS", async () => {
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: true,
      api: "openai-completions",
    }));
    const harness = createOpenAiValidationTestDeps(legacyProbe);
    const preflight = await assertEndpointResolvesPublic("http://10.0.0.8/v1", async () => [], {
      trustedPrivateHosts: ["10.0.0.8"],
    });

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      "http://10.0.0.8/v1",
      "test-model",
      "test-key",
      {
        pinnedAddresses: preflight.addresses,
        trustedPrivateCapability: preflight.trustedPrivateCapability,
      },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(legacyProbe).toHaveBeenCalledTimes(1);
    expect(legacyProbe).toHaveBeenCalledWith(
      "http://10.0.0.8/v1",
      "test-model",
      "test-key",
      expect.objectContaining({
        pinnedAddresses: [],
        trustedPrivateCapability: preflight.trustedPrivateCapability,
      }),
    );
    expect(harness.sessionOptions!.lookup).not.toHaveBeenCalled();
  });

  it("keeps DeepSeek V4 Pro on its specialized legacy streaming probe", async () => {
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: true,
      api: "openai-completions",
    }));
    const harness = createOpenAiValidationTestDeps(legacyProbe);

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      "https://provider.example.test/v1",
      "deepseek-ai/deepseek-v4-pro",
      "test-key",
      {},
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(legacyProbe).toHaveBeenCalledTimes(1);
    expect(harness.sessionOptions!.lookup).not.toHaveBeenCalled();
  });
});
