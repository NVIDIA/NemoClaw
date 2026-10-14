// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, vi } from "vitest";

import { loadLlamaCppImageConfig } from "../../../scripts/checks/export-llama-cpp-image-config.mts";
import {
  LLAMA_CPP_DGX_SPARK_REQUIRED_METRIC_SERIES,
  parseLlamaCppDgxSparkExecutionPlan,
} from "../../../scripts/checks/llama-cpp-dgx-spark-qualification-contract.mts";

export const AUTHORIZATION = `Bearer ${"a".repeat(64)}`;
export const MODEL = "nvidia-nemotron-3-nano-30b-a3b";
export const MODEL_FILE = "Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf";
export const METRICS = LLAMA_CPP_DGX_SPARK_REQUIRED_METRIC_SERIES.map(
  (name, index) => `${name} ${String(index + 1)}`,
).join("\n");

const config = loadLlamaCppImageConfig();
const compiledPlan = parseLlamaCppDgxSparkExecutionPlan(
  JSON.parse(config.publication_qualification_plan) as unknown,
  config.publication_qualification_plan_sha256,
);
export const plan = {
  ...compiledPlan,
  qualification: {
    ...compiledPlan.qualification,
    probeBounds: {
      ...compiledPlan.qualification.probeBounds,
      clientTimeoutMilliseconds: 10,
    },
  },
};

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

export function completion(content = "ready", usage = true): JsonObject {
  return {
    choices: [{ message: { content, role: "assistant" } }],
    model: MODEL,
    object: "chat.completion",
    ...(usage ? { usage: { completion_tokens: 2, prompt_tokens: 5, total_tokens: 7 } } : {}),
  };
}

export function properties(contextSize = 262144): JsonObject {
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

function hangingStream(
  signal: AbortSignal | null | undefined,
  onAbort: () => void = () => undefined,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"started":true}\n\n'));
      signal?.addEventListener(
        "abort",
        () => {
          onAbort();
          controller.error(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
    status: 200,
  });
}

export function createProtocolFixture(outcome: "stops" | "continues" | "metrics-fail" = "stops") {
  const requestedMaxTokens: number[] = [];
  let healthProbes = 0;
  let longRequest = 0;
  let nativeActive = false;
  let streamAborted = false;
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
          ? jsonResponse({ error: {} }, 404)
          : jsonResponse(properties(plan.recipe.serve.contextSize));
      case "http://127.0.0.1:18081/metrics":
        if (nativeActive && outcome === "metrics-fail") return new Response("", { status: 503 });
        return new Headers(init?.headers).get("authorization") === AUTHORIZATION
          ? new Response(
              METRICS.replace(
                /^llamacpp:requests_processing .+$/mu,
                `llamacpp:requests_processing ${nativeActive ? 1 : 0}`,
              ).replace(/^llamacpp:requests_deferred .+$/mu, "llamacpp:requests_deferred 0"),
              { headers: { "Content-Type": "text/plain" }, status: 200 },
            )
          : jsonResponse({ error: {} }, 401);
      case "http://127.0.0.1:18081/":
      case "http://127.0.0.1:18081/models/load":
      case "http://127.0.0.1:18081/slots":
      case "http://127.0.0.1:18081/cors-proxy":
      case "http://127.0.0.1:18081/tools":
        return jsonResponse({ error: {} }, 404);
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
      case Buffer.byteLength(body) > 1_048_576:
        return jsonResponse(
          {
            error: {
              code: "request_body_too_large",
              type: "invalid_request_error",
              message: "Request body exceeds the declared limit.",
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
        nativeActive = true;
        return hangingStream(init?.signal, () => {
          streamAborted = true;
          if (outcome !== "continues") nativeActive = false;
        });
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

  return {
    fetchImpl,
    requestedMaxTokens,
    get longRequest() {
      return longRequest;
    },
    get healthProbes() {
      return healthProbes;
    },
    get streamAborted() {
      return streamAborted;
    },
    get nativeActive() {
      return nativeActive;
    },
  };
}
