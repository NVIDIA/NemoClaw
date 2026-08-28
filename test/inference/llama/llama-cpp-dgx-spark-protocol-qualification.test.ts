// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { loadLlamaCppImageConfig } from "../../../scripts/checks/export-llama-cpp-image-config.mts";
import {
  runLlamaCppDgxSparkProtocolQualification,
  validateMetricsResponse,
  validatePropertiesResponse,
  validateStreamingChatResponse,
  validateStructuredOutputResponse,
  validateToolCallResponse,
  validateToolResultContinuationResponse,
} from "../../../scripts/checks/llama-cpp-dgx-spark-protocol-qualification.mts";
import {
  LLAMA_CPP_DGX_SPARK_REQUIRED_METRIC_SERIES,
  parseLlamaCppDgxSparkExecutionPlan,
} from "../../../scripts/checks/llama-cpp-dgx-spark-qualification-contract.mts";

const AUTHORIZATION = `Bearer ${"a".repeat(64)}`;
const MODEL = "nvidia-nemotron-3-nano-30b-a3b";
const MODEL_FILE = "Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf";
const METRICS = LLAMA_CPP_DGX_SPARK_REQUIRED_METRIC_SERIES.map(
  (name, index) => `${name} ${String(index + 1)}`,
).join("\n");

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

function properties(contextSize = 262144): JsonObject {
  return {
    cors_proxy_enabled: false,
    default_generation_settings: { n_ctx: contextSize },
    endpoint_metrics: true,
    endpoint_props: false,
    endpoint_slots: false,
    is_sleeping: false,
    modalities: { audio: false, video: false, vision: false },
    model_alias: MODEL,
    model_path: `/models/${MODEL_FILE}`,
    total_slots: 1,
    ui: false,
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
    expect(validatePropertiesResponse(properties(), 262144, MODEL, MODEL_FILE)).toMatchObject({
      contextWindow: { contextSize: 262144, ok: true, slots: 1 },
      disabledState: { multimodal: false },
      properties: { metrics: true, model: MODEL, modelPath: MODEL_FILE },
    });
    expect(validateMetricsResponse(METRICS)).toMatchObject({ requiredSeries: 11 });
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
    expect(() => validatePropertiesResponse(properties(131072), 262144, MODEL, MODEL_FILE)).toThrow(
      "security and readiness",
    );
    expect(() => validateMetricsResponse("llamacpp:requests_processing nope")).toThrow(
      "invalid Prometheus sample",
    );
    expect(() =>
      validateMetricsResponse(METRICS.replace("llamacpp:requests_processing 7\n", "")),
    ).toThrow("required llama.cpp series");
    expect(() =>
      validatePropertiesResponse(
        { ...properties(), endpoint_slots: true },
        262144,
        MODEL,
        MODEL_FILE,
      ),
    ).toThrow("security and readiness");
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
    const requestBodySizes: number[] = [];
    let healthProbes = 0;
    let longRequest = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      switch (url) {
        case "http://127.0.0.1:18081/health":
          healthProbes += 1;
          return new Response("{}", { status: 200 });
        case "http://127.0.0.1:18081/v1/models":
          return jsonResponse({ data: [{ id: MODEL }], object: "list" });
        case "http://127.0.0.1:18081/props":
          return init?.method === "POST"
            ? jsonResponse({ error: {} }, 501)
            : jsonResponse(properties(plan.recipe.serve.contextSize));
        case "http://127.0.0.1:18081/metrics":
          return new Headers(init?.headers).get("authorization") === AUTHORIZATION
            ? new Response(METRICS, { headers: { "Content-Type": "text/plain" }, status: 200 })
            : jsonResponse({ error: {} }, 401);
        case "http://127.0.0.1:18081/":
        case "http://127.0.0.1:18081/models/load":
          return jsonResponse({ error: {} }, 404);
        case "http://127.0.0.1:18081/slots":
          return jsonResponse({ error: {} }, 501);
        case "http://127.0.0.1:18081/cors-proxy":
        case "http://127.0.0.1:18081/tools":
          return jsonResponse({ error: {} }, 403);
        default:
          expect(url).toBe("http://127.0.0.1:18081/v1/chat/completions");
      }
      const body = String(init?.body ?? "");
      const requestBodyBytes = new TextEncoder().encode(body).byteLength;
      requestBodySizes.push(requestBodyBytes);
      const authorization = new Headers(init?.headers).get("authorization");
      switch (true) {
        case authorization !== AUTHORIZATION:
          return jsonResponse({ error: {} }, 401);
        case body === "{":
          return jsonResponse({ error: {} }, 400);
        case requestBodyBytes === 50_000:
          return jsonResponse(
            {
              error: {
                code: "request_body_too_large",
                message: "Request body exceeds the declared limit.",
                type: "invalid_request_error",
              },
            },
            413,
          );
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
      disabledSurfaces: {
        corsProxyHttpStatus: 403,
        multimodal: false,
        routerHttpStatus: 404,
        slotsHttpStatus: 501,
        toolsHttpStatus: 403,
        uiHttpStatus: 404,
      },
      malformedRequest: { httpStatus: 400, ok: true },
      requestBodyLimit: {
        acceptedBytes: 32768,
        acceptedHttpStatus: 200,
        continuationHealthHttpStatus: 200,
        continuationHttpStatus: 200,
        errorCode: "request_body_too_large",
        errorType: "invalid_request_error",
        rejectedBytes: 50000,
        rejectedHttpStatus: 413,
      },
      metrics: { requiredSeries: 11, unauthenticatedHttpStatus: 401 },
      properties: { metrics: true, model: MODEL, modelPath: MODEL_FILE },
      clientTimeout: { limitMilliseconds: 10, recovered: true },
      streamingChat: { done: true, events: 3, model: MODEL },
      structuredOutput: { schemaMatched: true },
      toolCall: { argumentsValid: true, name: "get_current_weather" },
      toolResultContinuation: { model: MODEL },
      usage: { completionTokens: 2, promptTokens: 5, totalTokens: 7 },
    });
    expect(longRequest).toBe(2);
    expect(healthProbes).toBe(2);
    expect(
      requestBodySizes.filter(
        (size) => size >= plan.recipe.serve.limits.maxRequestBodyBytes,
      ),
    ).toEqual([32768, 50000]);
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
