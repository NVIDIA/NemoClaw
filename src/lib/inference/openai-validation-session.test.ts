// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CurlProbeResult } from "../adapters/http/probe";
import {
  type OpenAiValidationSessionDeps,
  probeOpenAiLikeEndpointWithValidationSession,
} from "./openai-validation-session";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  expect(address).toBeTruthy();
  expect(typeof address).toBe("object");
  return (address as import("node:net").AddressInfo).port;
}

const legacySuccess = (): CurlProbeResult => ({
  ok: true,
  httpStatus: 200,
  curlStatus: 0,
  body: "",
  stderr: "",
  message: "legacy",
});

function deps(
  legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(legacySuccess),
): OpenAiValidationSessionDeps {
  return {
    legacyProbe,
    hasResponsesToolCall: (body: string) => body.includes('"type":"function_call"'),
    hasChatCompletionsToolCall: (body: string) => body.includes('"tool_calls"'),
    hasChatCompletionsToolCallLeak: () => false,
    getChatPayload: (model: string) => ({ model, messages: [] }),
    getResponsesTimeoutMs: () => 1_000,
    getChatTimeoutMs: () => 1_000,
    sessionOptions: {
      env: {},
      lookup: vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]),
      allowPrivateAddressesForTesting: true,
    },
  };
}

describe("OpenAI validation keepalive sequence", () => {
  it("uses one connection for Responses semantic fallback and Chat success", async () => {
    let connections = 0;
    const paths: string[] = [];
    const server = http.createServer((request, response) => {
      paths.push(request.url ?? "");
      request.resume();
      response.setHeader("content-type", "application/json");
      response.end(
        request.url?.endsWith("/responses")
          ? '{"output":[{"type":"message"}]}'
          : '{"choices":[{"message":{"content":"OK"}}]}',
      );
    });
    server.on("connection", () => {
      connections += 1;
    });
    const port = await listen(server);
    const harness = deps();

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "test-key",
      { requireResponsesToolCalling: true },
      harness,
    );

    expect(result).toMatchObject({
      ok: true,
      api: "openai-completions",
      label: "Chat Completions API",
    });
    expect(harness.legacyProbe).not.toHaveBeenCalled();
    expect(harness.sessionOptions!.lookup).toHaveBeenCalledTimes(1);
    expect(connections).toBe(1);
    expect(paths).toEqual(["/v1/responses", "/v1/chat/completions"]);
  });

  it("reuses the connection across non-streaming, streaming, and Chat fallback", async () => {
    let connections = 0;
    let responsesCalls = 0;
    const paths: string[] = [];
    const server = http.createServer((request, response) => {
      paths.push(request.url ?? "");
      request.resume();
      const isResponses = request.url?.endsWith("/responses") === true;
      responsesCalls += Number(isResponses);
      response.end(
        isResponses
          ? responsesCalls === 1
            ? '{"output":[{"type":"function_call"}]}'
            : "event: response.completed\ndata: {}\n\n"
          : '{"choices":[{"message":{"content":"OK"}}]}',
      );
    });
    server.on("connection", () => {
      connections += 1;
    });
    const port = await listen(server);
    const harness = deps();

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "test-key",
      { requireResponsesToolCalling: true, probeStreaming: true },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(harness.legacyProbe).not.toHaveBeenCalled();
    expect(connections).toBe(1);
    expect(paths).toEqual(["/v1/responses", "/v1/responses", "/v1/chat/completions"]);
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
    const harness = deps(legacyProbe);

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
    const harness = deps(legacyProbe);

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
    const harness = deps(legacyProbe);
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
    const harness = deps(legacyProbe);

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
    const harness = deps(legacyProbe);
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

  it("keeps DeepSeek V4 Pro on its specialized legacy streaming probe", async () => {
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: true,
      api: "openai-completions",
    }));
    const harness = deps(legacyProbe);

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

  it("keeps query-parameter authentication out of request headers", async () => {
    let observedUrl = "";
    let observedAuthorization: string | undefined;
    const server = http.createServer((request, response) => {
      observedUrl = request.url ?? "";
      observedAuthorization = request.headers.authorization;
      request.resume();
      response.end('{"choices":[{"message":{"content":"OK"}}]}');
    });
    const port = await listen(server);
    const harness = deps();

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "query-secret",
      { authMode: "query-param", skipResponsesProbe: true },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(observedAuthorization).toBeUndefined();
    expect(new URL(observedUrl, "http://provider.example.test").searchParams.get("key")).toBe(
      "query-secret",
    );
  });
});
