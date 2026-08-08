// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  LLAMA_CPP_DGX_SPARK_PROTOCOL_PROBES,
  type LlamaCppDgxSparkExecutionPlan,
  type LlamaCppDgxSparkQualificationReceipt,
} from "./llama-cpp-dgx-spark-qualification-contract.mts";

type ProtocolProbe = (typeof LLAMA_CPP_DGX_SPARK_PROTOCOL_PROBES)[number];

type JsonRecord = Record<string, unknown>;
type ProtocolEvidence = LlamaCppDgxSparkQualificationReceipt["probes"];
type FetchImplementation = typeof fetch;

type ToolCall = {
  readonly arguments: JsonRecord;
  readonly id: string;
  readonly name: "get_current_weather";
  readonly raw: JsonRecord;
};

const weatherTool = {
  type: "function",
  function: {
    name: "get_current_weather",
    description: "Return the current weather for one location.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        location: { type: "string" },
      },
      required: ["location"],
    },
  },
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertLoopbackBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("protocol qualification base URL is invalid");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !/^[1-9][0-9]{0,4}$/u.test(parsed.port)
  ) {
    throw new Error("protocol qualification must target an explicit loopback port");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function assertAuthorization(value: string): string {
  if (!/^Bearer [0-9a-f]{64}$/u.test(value)) {
    throw new Error("protocol qualification authorization is invalid");
  }
  return value;
}

function contentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("protocol probe returned an invalid content length");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("protocol probe returned an invalid content length");
  }
  return parsed;
}

async function readBoundedBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = contentLength(response);
  if (declaredLength !== undefined && declaredLength > maximumBytes) {
    throw new Error("protocol probe response exceeded its declarative byte bound");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new Error("protocol probe response exceeded its declarative byte bound");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJson(
  response: Response,
  expectedStatus: number,
  maximumBytes: number,
  label: string,
): Promise<unknown> {
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned an unexpected HTTP status`);
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error(`${label} did not return JSON`);
  }
  const bytes = await readBoundedBytes(response, maximumBytes);
  try {
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function expectStatus(
  response: Response,
  expectedStatus: number,
  maximumBytes: number,
  label: string,
): Promise<void> {
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned an unexpected HTTP status`);
  }
  await readBoundedBytes(response, maximumBytes);
}

function requestSignal(timeoutMilliseconds: number): AbortSignal {
  return AbortSignal.timeout(timeoutMilliseconds);
}

function jsonRequest(
  authorization: string,
  body: unknown,
  timeoutMilliseconds: number,
  signal = requestSignal(timeoutMilliseconds),
): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal,
  };
}

function usageFrom(value: unknown): ProtocolEvidence["usage"] {
  if (!isRecord(value)) throw new Error("chat usage was not returned");
  const promptTokens = value.prompt_tokens;
  const completionTokens = value.completion_tokens;
  const totalTokens = value.total_tokens;
  if (
    !Number.isSafeInteger(promptTokens) ||
    Number(promptTokens) < 1 ||
    !Number.isSafeInteger(completionTokens) ||
    Number(completionTokens) < 1 ||
    !Number.isSafeInteger(totalTokens) ||
    Number(totalTokens) !== Number(promptTokens) + Number(completionTokens)
  ) {
    throw new Error("chat usage did not satisfy the token accounting contract");
  }
  return {
    completionTokens: Number(completionTokens),
    ok: true,
    promptTokens: Number(promptTokens),
    totalTokens: Number(totalTokens),
  };
}

export function validateModelsResponse(value: unknown, expectedModel: string): void {
  if (
    !isRecord(value) ||
    value.object !== "list" ||
    !Array.isArray(value.data) ||
    value.data.length !== 1 ||
    !isRecord(value.data[0]) ||
    value.data[0].id !== expectedModel
  ) {
    throw new Error("models probe did not return the exact served model identity");
  }
}

export function validateChatCompletionResponse(value: unknown, expectedModel: string): void {
  if (
    !isRecord(value) ||
    value.object !== "chat.completion" ||
    value.model !== expectedModel ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1 ||
    !isRecord(value.choices[0]) ||
    !isRecord(value.choices[0].message) ||
    value.choices[0].message.role !== "assistant" ||
    typeof value.choices[0].message.content !== "string" ||
    value.choices[0].message.content.length < 1 ||
    value.choices[0].message.content.length > 4096
  ) {
    throw new Error("authenticated chat completion probe failed its response contract");
  }
}

export function validatePropertiesResponse(
  value: unknown,
  expectedContextSize: number,
): ProtocolEvidence["contextWindow"] {
  if (
    !isRecord(value) ||
    value.total_slots !== 1 ||
    !isRecord(value.default_generation_settings) ||
    value.default_generation_settings.n_ctx !== expectedContextSize
  ) {
    throw new Error("properties probe did not prove the declarative context window");
  }
  return { contextSize: expectedContextSize, ok: true, slots: 1 };
}

export function validateStructuredOutputResponse(value: unknown, expectedModel: string): void {
  validateChatCompletionResponse(value, expectedModel);
  const choice = (value as JsonRecord).choices as JsonRecord[];
  const message = choice[0]?.message as JsonRecord;
  let content: unknown;
  try {
    content = JSON.parse(String(message.content)) as unknown;
  } catch {
    throw new Error("structured-output probe did not return valid JSON");
  }
  if (!isRecord(content) || content.status !== "ready" || Object.keys(content).length !== 1) {
    throw new Error("structured-output probe did not satisfy its JSON schema");
  }
}

export function validateToolResultContinuationResponse(
  value: unknown,
  expectedModel: string,
): void {
  validateChatCompletionResponse(value, expectedModel);
  const choice = (value as JsonRecord).choices as JsonRecord[];
  const message = choice[0]?.message as JsonRecord;
  let content: unknown;
  try {
    content = JSON.parse(String(message.content)) as unknown;
  } catch {
    throw new Error("tool-result continuation did not return valid JSON");
  }
  if (
    !isRecord(content) ||
    content.conditions !== "clear" ||
    content.temperature_c !== 21 ||
    Object.keys(content).length !== 2
  ) {
    throw new Error("tool-result continuation did not consume the supplied result");
  }
}

export function validateToolCallResponse(value: unknown, expectedModel: string): ToolCall {
  if (
    !isRecord(value) ||
    value.object !== "chat.completion" ||
    value.model !== expectedModel ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1 ||
    !isRecord(value.choices[0]) ||
    value.choices[0].finish_reason !== "tool_calls" ||
    !isRecord(value.choices[0].message) ||
    value.choices[0].message.role !== "assistant" ||
    !Array.isArray(value.choices[0].message.tool_calls) ||
    value.choices[0].message.tool_calls.length !== 1 ||
    !isRecord(value.choices[0].message.tool_calls[0])
  ) {
    throw new Error("tool-call probe did not return one structured tool call");
  }
  const raw = value.choices[0].message.tool_calls[0];
  if (
    raw.type !== "function" ||
    typeof raw.id !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,256}$/u.test(raw.id) ||
    !isRecord(raw.function) ||
    raw.function.name !== "get_current_weather"
  ) {
    throw new Error("tool-call probe returned an invalid function identity");
  }
  let args: unknown = raw.function.arguments;
  if (typeof args === "string") {
    if (args.length < 2 || args.length > 4096) {
      throw new Error("tool-call probe returned invalid arguments");
    }
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      throw new Error("tool-call probe returned invalid arguments");
    }
  }
  if (
    !isRecord(args) ||
    Object.keys(args).length !== 1 ||
    typeof args.location !== "string" ||
    args.location.length < 1 ||
    args.location.length > 256
  ) {
    throw new Error("tool-call probe returned arguments outside the declared schema");
  }
  return { arguments: args, id: raw.id, name: "get_current_weather", raw };
}

export function validateStreamingChatResponse(
  source: string,
  expectedModel: ProtocolEvidence["streamingChat"]["model"],
  maximumEvents: number,
): Pick<ProtocolEvidence["streamingChat"], "done" | "events" | "model" | "ok"> & {
  usage: ProtocolEvidence["usage"];
} {
  let content = "";
  let done = false;
  let events = 0;
  let sawFinish = false;
  let usage: ProtocolEvidence["usage"] | undefined;
  for (const line of source.split(/\r?\n/u)) {
    if (line === "") continue;
    if (line.startsWith(":")) continue;
    if (!line.startsWith("data: ")) {
      throw new Error("streaming chat returned a non-SSE event");
    }
    const data = line.slice("data: ".length);
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    events += 1;
    if (events > maximumEvents) {
      throw new Error("streaming chat exceeded its declarative event bound");
    }
    let value: unknown;
    try {
      value = JSON.parse(data) as unknown;
    } catch {
      throw new Error("streaming chat returned invalid event JSON");
    }
    if (
      !isRecord(value) ||
      value.object !== "chat.completion.chunk" ||
      value.model !== expectedModel ||
      !Array.isArray(value.choices)
    ) {
      throw new Error("streaming chat event failed its response contract");
    }
    if (value.usage !== undefined && value.usage !== null) usage = usageFrom(value.usage);
    for (const choice of value.choices) {
      if (!isRecord(choice) || !isRecord(choice.delta)) {
        throw new Error("streaming chat choice failed its response contract");
      }
      if (choice.finish_reason === "stop" || choice.finish_reason === "length") sawFinish = true;
      if (choice.delta.content !== undefined && choice.delta.content !== null) {
        if (typeof choice.delta.content !== "string") {
          throw new Error("streaming chat content was invalid");
        }
        content += choice.delta.content;
      }
    }
  }
  if (!done || !sawFinish || content.length < 1 || content.length > 4096 || !usage) {
    throw new Error("streaming chat did not complete with content, usage, and a terminal event");
  }
  return { done: true, events, model: expectedModel, ok: true, usage };
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && (value.name === "AbortError" || value.name === "TimeoutError");
}

async function recoveryCompletion(
  fetchImpl: FetchImplementation,
  url: string,
  authorization: string,
  model: string,
  maxTokens: number,
  timeoutMilliseconds: number,
  maximumBytes: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    let response: Response;
    try {
      response = await fetchImpl(
        url,
        jsonRequest(
          authorization,
          {
            max_tokens: maxTokens,
            messages: [{ content: "Reply with one token.", role: "user" }],
            model,
            temperature: 0,
          },
          timeoutMilliseconds,
        ),
      );
    } catch (error) {
      if (!isAbortError(error) && !(error instanceof TypeError)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      continue;
    }
    if (response.status === 200) {
      validateChatCompletionResponse(
        await readJson(response, 200, maximumBytes, "recovery completion"),
        model,
      );
      return;
    }
    if (response.status !== 429 && response.status !== 503) {
      throw new Error("serving slot recovery returned an unexpected HTTP status");
    }
    await readBoundedBytes(response, maximumBytes);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("cancelled protocol request did not release the serving slot");
}

function assertExecutedProbeInventory(
  plannedProbes: readonly ProtocolProbe[],
  executedProbes: ReadonlySet<ProtocolProbe>,
): void {
  const plannedProbeSet = new Set(plannedProbes);
  if (
    plannedProbeSet.size !== plannedProbes.length ||
    executedProbes.size !== plannedProbeSet.size ||
    plannedProbes.some((probe) => !executedProbes.has(probe))
  ) {
    throw new Error("protocol qualification did not execute every declarative probe");
  }
}

async function cancellationProbe(
  fetchImpl: FetchImplementation,
  url: string,
  authorization: string,
  plan: LlamaCppDgxSparkExecutionPlan,
  timeoutMilliseconds: number,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    const response = await fetchImpl(
      url,
      jsonRequest(
        authorization,
        {
          max_tokens: plan.qualification.probeBounds.cancellationMaxTokens,
          messages: [{ content: "Count upward without stopping.", role: "user" }],
          model: plan.recipe.model.servedName,
          stream: true,
          temperature: 0,
        },
        timeoutMilliseconds,
        controller.signal,
      ),
    );
    if (response.status !== 200 || !response.body) {
      throw new Error("cancellation probe did not start a streaming response");
    }
    const reader = response.body.getReader();
    const first = await reader.read();
    if (first.done || !first.value || first.value.byteLength < 1) {
      throw new Error("cancellation probe ended before cancellation");
    }
    controller.abort();
    try {
      await reader.read();
    } catch (error) {
      if (!isAbortError(error)) throw error;
    }
    if (!controller.signal.aborted) throw new Error("cancellation probe was not aborted");
  } finally {
    clearTimeout(timer);
  }
  await recoveryCompletion(
    fetchImpl,
    url,
    authorization,
    plan.recipe.model.servedName,
    plan.qualification.probeBounds.maxTokens.synchronousChat,
    timeoutMilliseconds,
    plan.qualification.probeBounds.maxResponseBytes,
  );
}

async function clientTimeoutProbe(
  fetchImpl: FetchImplementation,
  url: string,
  authorization: string,
  plan: LlamaCppDgxSparkExecutionPlan,
  timeoutMilliseconds: number,
): Promise<void> {
  let aborted = false;
  try {
    const response = await fetchImpl(
      url,
      jsonRequest(
        authorization,
        {
          max_tokens: plan.qualification.probeBounds.cancellationMaxTokens,
          messages: [{ content: "Count upward without stopping.", role: "user" }],
          model: plan.recipe.model.servedName,
          stream: true,
          temperature: 0,
        },
        plan.qualification.probeBounds.clientTimeoutMilliseconds,
      ),
    );
    await readBoundedBytes(response, plan.qualification.probeBounds.maxResponseBytes);
  } catch (error) {
    if (!isAbortError(error)) throw error;
    aborted = true;
  }
  if (!aborted) throw new Error("client-timeout probe completed outside its deadline contract");
  await recoveryCompletion(
    fetchImpl,
    url,
    authorization,
    plan.recipe.model.servedName,
    plan.qualification.probeBounds.maxTokens.synchronousChat,
    timeoutMilliseconds,
    plan.qualification.probeBounds.maxResponseBytes,
  );
}

export async function runLlamaCppDgxSparkProtocolQualification(options: {
  readonly authorization: string;
  readonly baseUrl: string;
  readonly fetchImpl?: FetchImplementation;
  readonly plan: LlamaCppDgxSparkExecutionPlan;
}): Promise<ProtocolEvidence> {
  const baseUrl = assertLoopbackBaseUrl(options.baseUrl);
  const authorization = assertAuthorization(options.authorization);
  const fetchImpl = options.fetchImpl ?? fetch;
  const { plan } = options;
  const model = plan.recipe.model.servedName;
  const bounds = plan.qualification.probeBounds;
  const timeoutMilliseconds = plan.recipe.serve.limits.requestTimeoutSeconds * 1000;
  const chatUrl = `${baseUrl}/v1/chat/completions`;
  const executedProbes = new Set<ProtocolProbe>();

  const healthResponse = await fetchImpl(`${baseUrl}/health`, {
    headers: { Authorization: authorization },
    signal: requestSignal(timeoutMilliseconds),
  });
  await expectStatus(healthResponse, 200, bounds.maxResponseBytes, "health probe");
  executedProbes.add("health");

  const modelsResponse = await fetchImpl(`${baseUrl}/v1/models`, {
    headers: { Authorization: authorization },
    signal: requestSignal(timeoutMilliseconds),
  });
  validateModelsResponse(
    await readJson(modelsResponse, 200, bounds.maxResponseBytes, "models probe"),
    model,
  );
  executedProbes.add("models");

  const propertiesResponse = await fetchImpl(`${baseUrl}/props`, {
    headers: { Authorization: authorization },
    signal: requestSignal(timeoutMilliseconds),
  });
  const contextWindow = validatePropertiesResponse(
    await readJson(propertiesResponse, 200, bounds.maxResponseBytes, "properties probe"),
    plan.recipe.serve.contextSize,
  );
  executedProbes.add("context-window");

  const authenticationResponse = await fetchImpl(
    chatUrl,
    jsonRequest(
      `${authorization.slice(0, -1)}${authorization.endsWith("0") ? "1" : "0"}`,
      {
        max_tokens: 1,
        messages: [{ content: "This request must be rejected.", role: "user" }],
        model,
      },
      timeoutMilliseconds,
    ),
  );
  await expectStatus(authenticationResponse, 401, bounds.maxResponseBytes, "authentication probe");
  executedProbes.add("authentication");

  const malformedResponse = await fetchImpl(chatUrl, {
    body: "{",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: requestSignal(timeoutMilliseconds),
  });
  await expectStatus(malformedResponse, 400, bounds.maxResponseBytes, "malformed-request probe");
  executedProbes.add("malformed-request");

  const synchronousResponse = await fetchImpl(
    chatUrl,
    jsonRequest(
      authorization,
      {
        max_tokens: bounds.maxTokens.synchronousChat,
        messages: [{ content: "Return one short readiness token.", role: "user" }],
        model,
        temperature: 0,
      },
      timeoutMilliseconds,
    ),
  );
  const synchronousValue = await readJson(
    synchronousResponse,
    200,
    bounds.maxResponseBytes,
    "synchronous chat probe",
  );
  validateChatCompletionResponse(synchronousValue, model);
  executedProbes.add("synchronous-chat");
  const usage = usageFrom(isRecord(synchronousValue) ? synchronousValue.usage : undefined);
  executedProbes.add("usage");

  const streamingResponse = await fetchImpl(
    chatUrl,
    jsonRequest(
      authorization,
      {
        max_tokens: bounds.maxTokens.streamingChat,
        messages: [{ content: "Reply with exactly: ready", role: "user" }],
        model,
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0,
      },
      timeoutMilliseconds,
    ),
  );
  if (
    streamingResponse.status !== 200 ||
    !streamingResponse.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
  ) {
    throw new Error("streaming chat did not return an SSE response");
  }
  const streamingSource = new TextDecoder("utf8", { fatal: true }).decode(
    await readBoundedBytes(streamingResponse, bounds.maxResponseBytes),
  );
  const streaming = validateStreamingChatResponse(streamingSource, model, bounds.maxStreamEvents);
  executedProbes.add("streaming-chat");

  const structuredResponse = await fetchImpl(
    chatUrl,
    jsonRequest(
      authorization,
      {
        max_tokens: bounds.maxTokens.structuredOutput,
        messages: [
          {
            content: "Report the requested qualification status.",
            role: "user",
          },
        ],
        model,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "qualification_status",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { status: { const: "ready", type: "string" } },
              required: ["status"],
            },
          },
        },
        temperature: 0,
      },
      timeoutMilliseconds,
    ),
  );
  const structuredValue = await readJson(
    structuredResponse,
    200,
    bounds.maxResponseBytes,
    "structured-output probe",
  );
  validateStructuredOutputResponse(structuredValue, model);
  executedProbes.add("structured-output");

  const toolMessages = [
    {
      content: "Use the available tool to get the weather in Seattle.",
      role: "user",
    },
  ];
  const toolResponse = await fetchImpl(
    chatUrl,
    jsonRequest(
      authorization,
      {
        max_tokens: bounds.maxTokens.toolCall,
        messages: toolMessages,
        model,
        parallel_tool_calls: false,
        temperature: 0,
        tool_choice: "required",
        tools: [weatherTool],
      },
      timeoutMilliseconds,
    ),
  );
  const toolValue = await readJson(toolResponse, 200, bounds.maxResponseBytes, "tool-call probe");
  const toolCall = validateToolCallResponse(toolValue, model);
  executedProbes.add("tool-call");

  const continuationResponse = await fetchImpl(
    chatUrl,
    jsonRequest(
      authorization,
      {
        max_tokens: bounds.maxTokens.toolResultContinuation,
        messages: [
          ...toolMessages,
          { content: null, role: "assistant", tool_calls: [toolCall.raw] },
          {
            content: JSON.stringify({ conditions: "clear", temperature_c: 21 }),
            role: "tool",
            tool_call_id: toolCall.id,
          },
        ],
        model,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "weather_result",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                conditions: { const: "clear", type: "string" },
                temperature_c: { const: 21, type: "number" },
              },
              required: ["conditions", "temperature_c"],
            },
          },
        },
        temperature: 0,
        tool_choice: "none",
        tools: [weatherTool],
      },
      timeoutMilliseconds,
    ),
  );
  const continuationValue = await readJson(
    continuationResponse,
    200,
    bounds.maxResponseBytes,
    "tool-result continuation probe",
  );
  validateToolResultContinuationResponse(continuationValue, model);
  executedProbes.add("tool-result-continuation");

  await cancellationProbe(fetchImpl, chatUrl, authorization, plan, timeoutMilliseconds);
  executedProbes.add("cancellation");
  await clientTimeoutProbe(fetchImpl, chatUrl, authorization, plan, timeoutMilliseconds);
  executedProbes.add("client-timeout");
  assertExecutedProbeInventory(plan.qualification.probes, executedProbes);

  return {
    authentication: { httpStatus: 401, ok: true },
    cancellation: { aborted: true, ok: true, recovered: true },
    contextWindow,
    health: { httpStatus: 200, ok: true },
    malformedRequest: { httpStatus: 400, ok: true },
    models: { httpStatus: 200, model, ok: true },
    clientTimeout: {
      aborted: true,
      limitMilliseconds: bounds.clientTimeoutMilliseconds,
      ok: true,
      recovered: true,
    },
    streamingChat: {
      done: streaming.done,
      events: streaming.events,
      httpStatus: 200,
      model,
      ok: true,
    },
    structuredOutput: { httpStatus: 200, model, ok: true, schemaMatched: true },
    synchronousChat: { httpStatus: 200, model, ok: true },
    toolCall: {
      argumentsValid: true,
      httpStatus: 200,
      name: "get_current_weather",
      ok: true,
    },
    toolResultContinuation: { httpStatus: 200, model, ok: true },
    usage,
  };
}
