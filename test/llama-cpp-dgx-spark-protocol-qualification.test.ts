// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { loadLlamaCppImageConfig } from "../scripts/checks/export-llama-cpp-image-config.mts";
import {
  runLlamaCppDgxSparkProtocolQualification,
  validatePropertiesResponse,
  validateStreamingChatResponse,
  validateStructuredOutputResponse,
  validateToolCallResponse,
  validateToolResultContinuationResponse,
} from "../scripts/checks/llama-cpp-dgx-spark-protocol-qualification.mts";
import { parseLlamaCppDgxSparkExecutionPlan } from "../scripts/checks/llama-cpp-dgx-spark-qualification-contract.mts";

const AUTHORIZATION = `Bearer ${"a".repeat(64)}`;
const MODEL = "nvidia-nemotron-3-nano-30b-a3b";

const config = loadLlamaCppImageConfig();
const compiledPlan = parseLlamaCppDgxSparkExecutionPlan(
  JSON.parse(config.publication_qualification_plan) as unknown,
  config.publication_qualification_plan_sha256,
);
const plan = {
  ...compiledPlan,
  qualification: {
    ...compiledPlan.qualification,
    probeBounds: {
      ...compiledPlan.qualification.probeBounds,
      clientTimeoutMilliseconds: 10,
    },
  },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function completion(content = "ready", usage = true): JsonObject {
  return {
    choices: [{ message: { content, role: "assistant" } }],
    model: MODEL,
    object: "chat.completion",
    ...(usage ? { usage: { completion_tokens: 2, prompt_tokens: 5, total_tokens: 7 } } : {}),
  };
}

type JsonObject = Record<string, unknown>;

function hangingStream(signal: AbortSignal | null | undefined): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"started":true}\n\n'));
      signal?.addEventListener(
        "abort",
        () => controller.error(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
    status: 200,
  });
}

describe("llama.cpp DGX Spark protocol qualification", () => {
  it("accepts SSE keepalives and exact streaming, tool, and context evidence (#8144)", () => {
    const stream = [
      ": keepalive",
      `data: ${JSON.stringify({
        choices: [
          {
            delta: { content: "ready", role: "assistant" },
            finish_reason: null,
          },
        ],
        model: MODEL,
        object: "chat.completion.chunk",
      })}`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        model: MODEL,
        object: "chat.completion.chunk",
      })}`,
      `data: ${JSON.stringify({
        choices: [],
        model: MODEL,
        object: "chat.completion.chunk",
        usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
      })}`,
      "data: [DONE]",
      "",
    ].join("\n");
    expect(validateStreamingChatResponse(stream, MODEL, 8)).toMatchObject({
      done: true,
      events: 3,
      usage: { completionTokens: 1, promptTokens: 2, totalTokens: 3 },
    });
    expect(() =>
      validateStructuredOutputResponse(completion('{"status":"ready"}', false), MODEL),
    ).not.toThrow();
    expect(
      validateToolCallResponse(
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    function: {
                      arguments: '{"location":"Seattle"}',
                      name: "get_current_weather",
                    },
                    id: "call_1",
                    type: "function",
                  },
                ],
              },
            },
          ],
          model: MODEL,
          object: "chat.completion",
        },
        MODEL,
      ),
    ).toMatchObject({ arguments: { location: "Seattle" }, id: "call_1" });
    expect(() =>
      validateToolResultContinuationResponse(
        completion('{"conditions":"clear","temperature_c":21}', false),
        MODEL,
      ),
    ).not.toThrow();
    expect(
      validatePropertiesResponse(
        { default_generation_settings: { n_ctx: 262144 }, total_slots: 1 },
        262144,
      ),
    ).toEqual({
      contextSize: 262144,
      ok: true,
      slots: 1,
    });
  });

  it("rejects malformed or unbounded protocol evidence without exposing response content (#8144)", () => {
    expect(() =>
      validateStreamingChatResponse(
        [
          `data: ${JSON.stringify({ choices: [], model: MODEL, object: "chat.completion.chunk" })}`,
          `data: ${JSON.stringify({ choices: [], model: MODEL, object: "chat.completion.chunk" })}`,
          "data: [DONE]",
        ].join("\n"),
        MODEL,
        1,
      ),
    ).toThrow("event bound");
    expect(() =>
      validateStructuredOutputResponse(completion('{"status":"wrong"}', false), MODEL),
    ).toThrow("JSON schema");
    expect(() =>
      validatePropertiesResponse(
        { default_generation_settings: { n_ctx: 131072 }, total_slots: 1 },
        262144,
      ),
    ).toThrow("context window");
    expect(() =>
      validateToolCallResponse(
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    function: {
                      arguments: '{"location":"Seattle","shell":"id"}',
                      name: "get_current_weather",
                    },
                    id: "call_1",
                    type: "function",
                  },
                ],
              },
            },
          ],
          model: MODEL,
          object: "chat.completion",
        },
        MODEL,
      ),
    ).toThrow("declared schema");
    expect(() =>
      validateToolResultContinuationResponse(
        completion('{"conditions":"rain","temperature_c":21}', false),
        MODEL,
      ),
    ).toThrow("supplied result");
  });

  it("stops reading an oversized probe response at the declarative byte bound (#8144)", async () => {
    const boundedPlan = {
      ...plan,
      qualification: {
        ...plan.qualification,
        probeBounds: { ...plan.qualification.probeBounds, maxResponseBytes: 64 * 1024 },
      },
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
        controller.enqueue(new TextEncoder().encode("sensitive-response-body"));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(
      async () => new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      runLlamaCppDgxSparkProtocolQualification({
        authorization: AUTHORIZATION,
        baseUrl: "http://127.0.0.1:18081",
        fetchImpl,
        plan: boundedPlan,
      }),
    ).rejects.toThrow("declarative byte bound");
  });

  it("drives every YAML-selected probe with declarative bounds and returns sanitized evidence (#8144)", async () => {
    const requestedMaxTokens: number[] = [];
    let longRequest = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      switch (url) {
        case "http://127.0.0.1:18081/health":
          return new Response("{}", { status: 200 });
        case "http://127.0.0.1:18081/v1/models":
          return jsonResponse({ data: [{ id: MODEL }], object: "list" });
        case "http://127.0.0.1:18081/props":
          return jsonResponse({
            default_generation_settings: {
              n_ctx: plan.recipe.serve.contextSize,
            },
            total_slots: 1,
          });
        default:
          expect(url).toBe("http://127.0.0.1:18081/v1/chat/completions");
      }
      const body = String(init?.body ?? "");
      const authorization = new Headers(init?.headers).get("authorization");
      switch (true) {
        case authorization !== AUTHORIZATION:
          return jsonResponse({ error: {} }, 401);
        case body === "{":
          return jsonResponse({ error: {} }, 400);
      }

      const request = JSON.parse(body) as JsonObject;
      const maxTokens = Number(request.max_tokens);
      requestedMaxTokens.push(maxTokens);
      switch (true) {
        case maxTokens === plan.qualification.probeBounds.cancellationMaxTokens:
          longRequest += 1;
          return hangingStream(init?.signal);
        case request.stream_options !== undefined:
          return new Response(
            [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: { content: "ready", role: "assistant" },
                    finish_reason: null,
                  },
                ],
                model: MODEL,
                object: "chat.completion.chunk",
              })}`,
              `data: ${JSON.stringify({
                choices: [{ delta: {}, finish_reason: "stop" }],
                model: MODEL,
                object: "chat.completion.chunk",
              })}`,
              `data: ${JSON.stringify({
                choices: [],
                model: MODEL,
                object: "chat.completion.chunk",
                usage: {
                  completion_tokens: 1,
                  prompt_tokens: 2,
                  total_tokens: 3,
                },
              })}`,
              "data: [DONE]",
              "",
            ].join("\n"),
            { headers: { "Content-Type": "text/event-stream" }, status: 200 },
          );
        case request.tool_choice === "none":
          return jsonResponse(completion('{"conditions":"clear","temperature_c":21}', false));
        case request.response_format !== undefined:
          return jsonResponse(completion('{"status":"ready"}', false));
        case request.tool_choice === "required":
          return jsonResponse({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"location":"Seattle"}',
                        name: "get_current_weather",
                      },
                      id: "call_1",
                      type: "function",
                    },
                  ],
                },
              },
            ],
            model: MODEL,
            object: "chat.completion",
          });
        default:
          return jsonResponse(completion());
      }
    }) as unknown as typeof fetch;

    const evidence = await runLlamaCppDgxSparkProtocolQualification({
      authorization: AUTHORIZATION,
      baseUrl: "http://127.0.0.1:18081",
      fetchImpl,
      plan,
    });

    expect(evidence).toMatchObject({
      authentication: { httpStatus: 401, ok: true },
      cancellation: { aborted: true, ok: true, recovered: true },
      contextWindow: { contextSize: plan.recipe.serve.contextSize, slots: 1 },
      malformedRequest: { httpStatus: 400, ok: true },
      clientTimeout: { limitMilliseconds: 10, recovered: true },
      streamingChat: { done: true, events: 3, model: MODEL },
      structuredOutput: { schemaMatched: true },
      toolCall: { argumentsValid: true, name: "get_current_weather" },
      toolResultContinuation: { model: MODEL },
      usage: { completionTokens: 2, promptTokens: 5, totalTokens: 7 },
    });
    expect(longRequest).toBe(2);
    expect(requestedMaxTokens).toEqual(
      expect.arrayContaining([
        plan.qualification.probeBounds.maxTokens.synchronousChat,
        plan.qualification.probeBounds.maxTokens.streamingChat,
        plan.qualification.probeBounds.maxTokens.structuredOutput,
        plan.qualification.probeBounds.maxTokens.toolCall,
        plan.qualification.probeBounds.maxTokens.toolResultContinuation,
        plan.qualification.probeBounds.cancellationMaxTokens,
      ]),
    );
    const serializedEvidence = JSON.stringify(evidence);
    expect(serializedEvidence).not.toContain(AUTHORIZATION.slice("Bearer ".length));
    expect(serializedEvidence).not.toContain("Seattle");
    expect(serializedEvidence).not.toContain("conditions");
    expect(serializedEvidence).not.toContain("temperature_c");
  });
});
