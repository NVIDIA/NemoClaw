// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { probeOpenAiLikeEndpointWithValidationSession } from "./openai-validation-session";
import { getChatCompletionsProbePayload } from "./openai-probe-models";
import {
  createOpenAiValidationTestDeps,
  useOpenAiValidationTestServers,
} from "./openai-validation-session.test-helpers";

const listen = useOpenAiValidationTestServers();

describe("OpenAI validation keepalive sequence", () => {
  it("sends the NVIDIA Endpoints Nemotron request shape through native validation (#10880)", async () => {
    let observedBody = "";
    const server = http.createServer((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        observedBody += chunk;
      });
      request.on("end", () => {
        response.end('{"choices":[{"message":{"content":"OK"}}]}');
      });
    });
    const port = await listen(server);
    const harness = {
      ...createOpenAiValidationTestDeps(),
      getChatPayload: getChatCompletionsProbePayload,
    };

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "nvidia/nemotron-3-super-120b-a12b",
      "test-key",
      { skipResponsesProbe: true, useNvidiaEndpointProbePayload: true },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(JSON.parse(observedBody)).toEqual({
      model: "nvidia/nemotron-3-super-120b-a12b",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 16,
      temperature: 1,
      top_p: 0.95,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(JSON.parse(observedBody)).not.toHaveProperty("thinking");
    expect(harness.legacyProbe).not.toHaveBeenCalled();
  });

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

  it("retries the validation session after an HTTP 200 response omits a structured tool call (#8714)", async () => {
    const observedBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        observedBodies.push(JSON.parse(body));
        response.setHeader("content-type", "application/json");
        response.end(
          observedBodies.length === 1
            ? '{"choices":[{"finish_reason":"stop","message":{"content":"OK"}}]}'
            : '{"choices":[{"finish_reason":"tool_calls","message":{"tool_calls":[{"type":"function","function":{"name":"emit_ok","arguments":{}}}]}}]}',
        );
      });
    });
    const port = await listen(server);
    const harness = createOpenAiValidationTestDeps();
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "nemotron-3-nano:30b",
      "test-key",
      {
        skipResponsesProbe: true,
        requireChatCompletionsToolCalling: true,
        retryChatCompletionsToolReadiness: true,
      },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(observedBodies).toHaveLength(2);
    expect(harness.legacyProbe).not.toHaveBeenCalled();
  });

  it("stops the validation session after four HTTP 200 responses omit structured tool calls (#8714)", async () => {
    const observedBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        observedBodies.push(JSON.parse(body));
        response.setHeader("content-type", "application/json");
        response.end('{"choices":[{"finish_reason":"stop","message":{"content":"OK"}}]}');
      });
    });
    const port = await listen(server);
    const harness = createOpenAiValidationTestDeps();
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "nemotron-3-nano:30b",
      "test-key",
      {
        skipResponsesProbe: true,
        requireChatCompletionsToolCalling: true,
        retryChatCompletionsToolReadiness: true,
      },
      harness,
    );

    expect(result).toMatchObject({
      ok: false,
      failures: [
        expect.objectContaining({
          diagnosticCodes: ["openai-chat-missing-structured-tool-call"],
        }),
      ],
    });
    expect(observedBodies).toHaveLength(4);
    expect(harness.legacyProbe).not.toHaveBeenCalled();
  });

  it("uses one larger-token retry when a readiness response contains only reasoning (#8714)", async () => {
    const observedBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        observedBodies.push(JSON.parse(body));
        response.setHeader("content-type", "application/json");
        const replies = [
          '{"choices":[{"finish_reason":"stop","message":{"content":"OK"}}]}',
          '{"choices":[{"finish_reason":"length","message":{"content":"","reasoning_content":"Planning the tool call."}}]}',
          '{"choices":[{"finish_reason":"tool_calls","message":{"tool_calls":[{"type":"function","function":{"name":"emit_ok","arguments":{}}}]}}]}',
        ];
        response.end(replies[observedBodies.length - 1]);
      });
    });
    const port = await listen(server);
    const harness = createOpenAiValidationTestDeps();
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "nemotron-3-nano:30b",
      "test-key",
      {
        skipResponsesProbe: true,
        requireChatCompletionsToolCalling: true,
        retryChatCompletionsToolReadiness: true,
      },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(observedBodies.map((body) => body.max_tokens)).toEqual([256, 256, 1024]);
    expect(harness.legacyProbe).not.toHaveBeenCalled();
  });

  it("retries reasoning-only tool-call truncation on the native connection", async () => {
    const observedBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        observedBodies.push(JSON.parse(body));
        response.setHeader("content-type", "application/json");
        response.end(
          observedBodies.length === 1
            ? '{"choices":[{"finish_reason":"length","message":{"content":"","reasoning_content":"Planning the tool call."}}]}'
            : '{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"type":"function","function":{"name":"sessions_send","arguments":"{\\"message\\":\\"hello\\"}"}}]}}]}',
        );
      });
    });
    const port = await listen(server);
    const harness = createOpenAiValidationTestDeps();

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "qwen3-vl:4b",
      "test-key",
      { skipResponsesProbe: true, requireChatCompletionsToolCalling: true },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(observedBodies).toHaveLength(2);
    expect(observedBodies[0]).toMatchObject({ max_tokens: 256, tool_choice: "required" });
    expect(observedBodies[1]).toMatchObject({ max_tokens: 1024, tool_choice: "required" });
    expect(harness.legacyProbe).not.toHaveBeenCalled();
  });

  it("gives the delayed 4096-token native retry the doubled deadline (#8714)", async () => {
    const observedBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        observedBodies.push(parsed);
        response.setHeader("content-type", "application/json");
        const reply =
          (parsed.max_tokens as number) < 4096
            ? '{"choices":[{"finish_reason":"length","message":{"content":"","reasoning_content":"Planning the tool call."}}]}'
            : '{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"type":"function","function":{"name":"sessions_send","arguments":"{\\"message\\":\\"hello\\"}"}}]}}]}';
        setTimeout(() => response.end(reply), (parsed.max_tokens as number) === 4096 ? 1_200 : 0);
      });
    });
    const port = await listen(server);
    const harness = createOpenAiValidationTestDeps();

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "nemotron-3-nano:30b",
      "test-key",
      { skipResponsesProbe: true, requireChatCompletionsToolCalling: true },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(observedBodies.map((body) => body.max_tokens)).toEqual([256, 1024, 4096]);
    expect(harness.legacyProbe).not.toHaveBeenCalled();
  });

  it("fails after the full retry ladder without replaying the legacy probe (#8714)", async () => {
    const observedBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        observedBodies.push(JSON.parse(body));
        response.setHeader("content-type", "application/json");
        response.end(
          '{"choices":[{"finish_reason":"length","message":{"content":"","reasoning_content":"Planning the tool call."}}]}',
        );
      });
    });
    const port = await listen(server);
    const harness = createOpenAiValidationTestDeps();

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "qwen3-vl:4b",
      "test-key",
      { skipResponsesProbe: true, requireChatCompletionsToolCalling: true },
      harness,
    );

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("did not return a tool call"),
      failures: [
        expect.objectContaining({
          diagnosticCodes: [
            "openai-chat-missing-structured-tool-call",
            "openai-chat-reasoning-budget-exhausted",
          ],
        }),
      ],
    });
    expect(observedBodies.map((body) => body.max_tokens)).toEqual([256, 1024, 4096]);
    expect(harness.legacyProbe).not.toHaveBeenCalled();
  });

  it("does not retry a transient HTTP failure after the larger-budget retry", async () => {
    let requestCount = 0;
    const observedBodies: Array<Record<string, unknown>> = [];
    const replies = [
      {
        statusCode: 200,
        body: '{"choices":[{"finish_reason":"length","message":{"content":"","reasoning_content":"Planning the tool call."}}]}',
      },
      {
        statusCode: 503,
        body: '{"error":{"message":"temporarily unavailable"}}',
      },
    ];
    const unexpectedThirdReply = {
      statusCode: 200,
      body: '{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"type":"function","function":{"name":"sessions_send","arguments":"{\\"message\\":\\"hello\\"}"}}]}}]}',
    };
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        observedBodies.push(JSON.parse(body));
        const reply = replies[requestCount] ?? unexpectedThirdReply;
        requestCount += 1;
        response.setHeader("content-type", "application/json");
        response.statusCode = reply.statusCode;
        response.end(reply.body);
      });
    });
    const port = await listen(server);
    const harness = createOpenAiValidationTestDeps();
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");

    try {
      const result = await probeOpenAiLikeEndpointWithValidationSession(
        `http://provider.example.test:${port}/v1`,
        "qwen3-vl:4b",
        "test-key",
        { skipResponsesProbe: true, requireChatCompletionsToolCalling: true },
        harness,
      );

      expect(result).toMatchObject({
        ok: false,
        message: expect.stringContaining("HTTP 503"),
      });
      expect(requestCount).toBe(2);
      expect(observedBodies.map((body) => body.max_tokens)).toEqual([256, 1024]);
      expect(harness.legacyProbe).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not use the legacy probe after an unexpected post-retry failure", async () => {
    const observedBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        observedBodies.push(JSON.parse(body));
        response.setHeader("content-type", "application/json");
        response.end(
          observedBodies.length === 1
            ? '{"choices":[{"finish_reason":"length","message":{"content":"","reasoning_content":"Planning the tool call."}}]}'
            : '{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{}]}}]}',
        );
      });
    });
    const port = await listen(server);
    const harness = createOpenAiValidationTestDeps();
    harness.hasChatCompletionsToolCall = () => {
      throw new Error("unexpected parser failure");
    };

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "qwen3-vl:4b",
      "test-key",
      { skipResponsesProbe: true, requireChatCompletionsToolCalling: true },
      harness,
    );

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("failed after the reasoning retry"),
    });
    expect(observedBodies).toHaveLength(2);
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

  it("falls back after native streaming stalls without capping the initial request (#7792)", async () => {
    const paths: string[] = [];
    let initialResponse: http.ServerResponse | undefined;
    let resolveInitialStarted!: () => void;
    let resolveStreamingStarted!: () => void;
    const initialStarted = new Promise<void>((resolve) => {
      resolveInitialStarted = resolve;
    });
    const streamingStarted = new Promise<void>((resolve) => {
      resolveStreamingStarted = resolve;
    });
    const responsePlan = [
      (response: http.ServerResponse) => {
        initialResponse = response;
        resolveInitialStarted();
      },
      (response: http.ServerResponse) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("event: response.created\ndata: {}\n\n");
        resolveStreamingStarted();
      },
      (response: http.ServerResponse) => {
        response.end('{"choices":[{"message":{"content":"OK"}}]}');
      },
    ];
    const server = http.createServer((request, response) => {
      const path = request.url ?? "";
      paths.push(path);
      request.resume();
      responsePlan[paths.length - 1](response);
    });
    const port = await listen(server);
    const harness = createOpenAiValidationTestDeps();
    harness.getResponsesTimeoutMs = () => 20_000;
    vi.useFakeTimers();

    try {
      const resultPromise = probeOpenAiLikeEndpointWithValidationSession(
        `http://provider.example.test:${port}/v1`,
        "test-model",
        "test-key",
        { probeStreaming: true },
        harness,
      );

      await initialStarted;
      await vi.advanceTimersByTimeAsync(5_001);
      expect(initialResponse).toBeDefined();
      initialResponse!.end('{"output":[{"type":"message"}]}');
      await streamingStarted;
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(resultPromise).resolves.toMatchObject({
        ok: true,
        api: "openai-completions",
      });
      expect(paths).toEqual(["/v1/responses", "/v1/responses", "/v1/chat/completions"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
