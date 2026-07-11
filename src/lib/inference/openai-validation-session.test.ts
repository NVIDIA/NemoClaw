// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import { describe, expect, it } from "vitest";
import { probeOpenAiLikeEndpointWithValidationSession } from "./openai-validation-session";
import {
  createOpenAiValidationTestDeps,
  useOpenAiValidationTestServers,
} from "./openai-validation-session.test-helpers";

const listen = useOpenAiValidationTestServers();

describe("OpenAI validation keepalive sequence", () => {
  it("uses the GPT-5 reply-budget field for native tool-call validation (#6642)", async () => {
    let observedBody = "";
    const server = http.createServer((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        observedBody += chunk;
      });
      request.on("end", () => {
        response.end('{"choices":[{"message":{"tool_calls":[{}]}}]}');
      });
    });
    const port = await listen(server);
    const harness = createOpenAiValidationTestDeps();

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "gpt-5.4",
      "test-key",
      { skipResponsesProbe: true, requireChatCompletionsToolCalling: true },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(JSON.parse(observedBody)).toMatchObject({
      max_completion_tokens: 256,
    });
    expect(JSON.parse(observedBody)).not.toHaveProperty("max_tokens");
    expect(JSON.parse(observedBody)).not.toHaveProperty("temperature");
    expect(harness.legacyProbe).not.toHaveBeenCalled();
  });

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
    const harness = createOpenAiValidationTestDeps();

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
    const harness = createOpenAiValidationTestDeps();

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

  it("returns Responses success when native streaming emits the required event", async () => {
    const paths: string[] = [];
    const server = http.createServer((request, response) => {
      paths.push(request.url ?? "");
      request.resume();
      response.end(
        paths.length === 1
          ? '{"output":[{"type":"message"}]}'
          : "event: response.output_text.delta\ndata: {}\n\n",
      );
    });
    const port = await listen(server);
    const harness = createOpenAiValidationTestDeps();

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "test-key",
      { probeStreaming: true },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-responses" });
    expect(paths).toEqual(["/v1/responses", "/v1/responses"]);
    expect(harness.legacyProbe).not.toHaveBeenCalled();
  });
});
