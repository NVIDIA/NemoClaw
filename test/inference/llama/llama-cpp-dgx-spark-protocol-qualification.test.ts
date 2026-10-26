// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
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
  AUTHORIZATION,
  MODEL,
  MODEL_FILE,
  METRICS,
  plan,
  completion,
  properties,
  createProtocolFixture,
} from "./llama-cpp-dgx-spark-protocol-qualification.test-support";
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

  it("records the complete native protocol inventory after cancellation and deadline recovery (#12664)", async () => {
    const fixture = createProtocolFixture();
    const { fetchImpl, requestedMaxTokens } = fixture;

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
        corsProxyHttpStatus: 404,
        multimodal: false,
        routerHttpStatus: 404,
        propertiesMutationHttpStatus: 404,
        slotsHttpStatus: 404,
        toolsHttpStatus: 404,
        uiHttpStatus: 404,
      },
      malformedRequest: { httpStatus: 400, ok: true },
      metrics: { requiredSeries: 11, unauthenticatedHttpStatus: 401 },
      properties: { metrics: true, model: MODEL, modelPath: MODEL_FILE },
      clientTimeout: { limitMilliseconds: 10, recovered: true },
      streamingChat: { done: true, events: 3, model: MODEL },
      structuredOutput: { schemaMatched: true },
      toolCall: { argumentsValid: true, name: "get_current_weather" },
      toolResultContinuation: { model: MODEL },
      usage: { completionTokens: 2, promptTokens: 5, totalTokens: 7 },
    });
    expect(fixture.longRequest).toBe(2);
    expect(fixture.healthProbes).toBe(2);
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

  it.each([
    {
      outcome: "continues" as const,
      message: "native generation remained active after cancellation",
      nativeActive: true,
    },
    {
      outcome: "metrics-fail" as const,
      message: "native work metrics returned an unexpected status",
      nativeActive: false,
    },
  ])(
    "rejects incomplete native cancellation evidence and aborts its stream [$outcome] (#12664)",
    async ({ outcome, message, nativeActive }) => {
      const fixture = createProtocolFixture(outcome);
      await expect(
        runLlamaCppDgxSparkProtocolQualification({
          authorization: AUTHORIZATION,
          baseUrl: "http://127.0.0.1:18081",
          fetchImpl: fixture.fetchImpl,
          plan,
        }),
      ).rejects.toThrow(message);
      expect(fixture.streamAborted).toBe(true);
      expect(fixture.nativeActive).toBe(nativeActive);
    },
  );
});
