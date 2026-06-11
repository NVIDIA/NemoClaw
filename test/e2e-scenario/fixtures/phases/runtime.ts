// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import { assertExitZero } from "../clients/command.ts";
import type {
  ProviderClient,
  ProviderJsonRequestOptions,
  SandboxClient,
  TrustedProviderEndpoint,
} from "../clients/index.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../shell-probe.ts";
import type { NemoClawInstance } from "./onboarding.ts";

export type InferenceRoute = "inference-local" | "inference.local";

export interface InferenceRuntimeProbeResult {
  readonly endpoint: string;
  readonly result: ShellProbeResult;
}

export interface InferenceRuntimeRequestOptions {
  readonly artifactName?: string;
  readonly curlMaxTimeSeconds?: number;
  readonly headers?: readonly string[];
  readonly redactionValues?: readonly string[];
  readonly timeoutMs?: number;
}

export interface InferenceRuntimeChatOptions extends InferenceRuntimeRequestOptions {
  readonly maxTokens?: number;
  readonly model?: string;
  readonly prompt?: string;
}

export interface InferenceRuntimeStatusOptions extends InferenceRuntimeRequestOptions {
  readonly allowedStatusCodes?: readonly number[];
  readonly path?: string;
  readonly route?: InferenceRoute;
}

export interface InferenceRuntimeRouteOptions extends InferenceRuntimeRequestOptions {
  readonly path?: string;
  readonly route?: InferenceRoute;
}

export interface ProviderRuntimeRequestOptions extends InferenceRuntimeRequestOptions {
  readonly apiKey?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CURL_MAX_TIME_SECONDS = 20;
const DEFAULT_CHAT_MODEL = "default";
const DEFAULT_CHAT_PROMPT = "Say ok";
const DEFAULT_CHAT_MAX_TOKENS = 8;
const MODELS_PATH = "/v1/models";
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const SENSITIVE_HEADER_NAME = /(authorization|api[-_]?key|token|secret|credential|password)/i;

function inferenceHost(route: InferenceRoute = "inference-local"): string {
  switch (route) {
    case "inference-local":
    case "inference.local":
      return "inference.local";
    default: {
      const _exhaustive: never = route;
      throw new Error(`Unsupported inference route '${_exhaustive}'.`);
    }
  }
}

function normalizePath(path: string): string {
  if (!path.trim()) {
    throw new Error("inference endpoint path is required");
  }
  return path.startsWith("/") ? path : `/${path}`;
}

export function inferenceRouteUrl(
  route: InferenceRoute = "inference-local",
  path = MODELS_PATH,
): string {
  return `https://${inferenceHost(route)}${normalizePath(path)}`;
}

function curlMaxTime(options: InferenceRuntimeRequestOptions): string {
  const seconds = options.curlMaxTimeSeconds ?? DEFAULT_CURL_MAX_TIME_SECONDS;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("inference request curlMaxTimeSeconds must be a finite positive number");
  }
  return String(seconds);
}

function shellOptions(
  options: InferenceRuntimeRequestOptions,
  artifactName: string,
): ShellProbeRunOptions {
  return {
    artifactName: options.artifactName ?? artifactName,
    env: buildAvailabilityProbeEnv(),
    redactionValues: uniqueRedactionValues([
      ...(options.redactionValues ?? []),
      ...sensitiveHeaderRedactionValues(options.headers),
    ]),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function headerArgs(headers: readonly string[] = []): string[] {
  return headers.flatMap((header) => ["-H", validatedCurlHeader(header)]);
}

function validatedCurlHeader(header: string): string {
  if (/[\r\n]/.test(header)) {
    throw new Error("inference request header must not contain CR or LF");
  }
  if (header.trimStart().startsWith("@")) {
    throw new Error("inference request header must not use curl @file syntax");
  }
  return header;
}

function sensitiveHeaderRedactionValues(headers: readonly string[] = []): string[] {
  const values = new Set<string>();
  for (const header of headers) {
    const separator = header.indexOf(":");
    if (separator === -1) continue;
    const name = header.slice(0, separator).trim();
    const value = header.slice(separator + 1).trim();
    if (!value || !SENSITIVE_HEADER_NAME.test(name)) continue;
    values.add(header);
    values.add(value);
    values.add(value.replace(/^Bearer\s+/i, "").trim());
  }
  return [...values].filter(Boolean);
}

function uniqueRedactionValues(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function parseHttpStatus(result: ShellProbeResult, label: string): number {
  assertExitZero(result, label);
  const status = Number(result.stdout.trim());
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`${label} returned invalid HTTP status '${result.stdout.trim() || "empty"}'`);
  }
  return status;
}

function openAiChatPayload(options: InferenceRuntimeChatOptions): string {
  const model = options.model ?? DEFAULT_CHAT_MODEL;
  const prompt = options.prompt ?? DEFAULT_CHAT_PROMPT;
  if (!model.trim()) {
    throw new Error("inference chat model is required");
  }
  if (!prompt.trim()) {
    throw new Error("inference chat prompt is required");
  }
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: options.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS,
  });
}

function parseJsonBody(body: string, label: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} response was not JSON`);
  }
}

function hasChoiceContent(choice: unknown): boolean {
  if (!choice || typeof choice !== "object") return false;
  const message = (choice as { message?: unknown }).message;
  if (message && typeof message === "object") {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string" && content.length > 0) return true;
  }
  const text = (choice as { text?: unknown }).text;
  return typeof text === "string" && text.length > 0;
}

function assertChatCompletionShape(json: unknown, label: string): void {
  if (!json || typeof json !== "object") {
    throw new Error(`${label} response was not an object`);
  }
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0 || !choices.some(hasChoiceContent)) {
    throw new Error(`${label} response missing choices/content`);
  }
}

function hasModelIdentifier(entry: unknown): boolean {
  if (typeof entry === "string") return entry.trim().length > 0;
  if (!entry || typeof entry !== "object") return false;
  for (const key of ["id", "model", "name"]) {
    const value = (entry as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) return true;
  }
  return false;
}

function assertModelListShape(json: unknown, label: string): void {
  if (!json || typeof json !== "object") {
    throw new Error(`${label} response was not an object`);
  }
  const body = json as { data?: unknown; models?: unknown };
  const candidates = [body.data, body.models].filter(Array.isArray);
  if (!candidates.some((items) => items.some(hasModelIdentifier))) {
    throw new Error(`${label} response missing model data`);
  }
}

function providerRequestOptions(
  options: ProviderRuntimeRequestOptions,
  body?: string,
): ProviderJsonRequestOptions {
  const headers = [...(options.headers ?? [])];
  const redactionValues = uniqueRedactionValues([
    ...(options.redactionValues ?? []),
    ...sensitiveHeaderRedactionValues(headers),
  ]);
  if (body !== undefined) {
    headers.unshift("Content-Type: application/json");
  }
  if (options.apiKey) {
    headers.push(`Authorization: Bearer ${options.apiKey}`);
    redactionValues.push(options.apiKey);
  }
  return {
    artifactName: options.artifactName,
    body,
    curlMaxTimeSeconds: options.curlMaxTimeSeconds ?? DEFAULT_CURL_MAX_TIME_SECONDS,
    headers,
    redactionValues,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export class RuntimePhaseFixture {
  constructor(
    private readonly sandbox: SandboxClient,
    private readonly provider: ProviderClient,
  ) {}

  async expectInferenceLocalModels(
    instance: NemoClawInstance,
    options: InferenceRuntimeRouteOptions = {},
  ): Promise<InferenceRuntimeProbeResult> {
    const endpoint = inferenceRouteUrl(options.route, options.path ?? MODELS_PATH);
    const result = await this.sandbox.exec(
      instance.sandboxName,
      [
        "curl",
        "-fsS",
        "--max-time",
        curlMaxTime(options),
        ...headerArgs(options.headers),
        endpoint,
      ],
      shellOptions(options, "runtime-inference-local-models"),
    );
    assertExitZero(result, "inference.local models probe");
    assertModelListShape(
      parseJsonBody(result.stdout, "inference.local models"),
      "inference.local models",
    );
    return { endpoint, result };
  }

  async expectInferenceLocalChatCompletion(
    instance: NemoClawInstance,
    options: InferenceRuntimeChatOptions & { readonly route?: InferenceRoute } = {},
  ): Promise<InferenceRuntimeProbeResult> {
    const endpoint = inferenceRouteUrl(options.route, CHAT_COMPLETIONS_PATH);
    const payload = openAiChatPayload(options);
    const result = await this.sandbox.exec(
      instance.sandboxName,
      [
        "curl",
        "-fsS",
        "--max-time",
        curlMaxTime(options),
        "-H",
        "Content-Type: application/json",
        ...headerArgs(options.headers),
        "--data-raw",
        payload,
        endpoint,
      ],
      shellOptions(options, "runtime-inference-local-chat-completion"),
    );
    assertExitZero(result, "inference.local chat completion probe");
    assertChatCompletionShape(
      parseJsonBody(result.stdout, "inference.local chat completion"),
      "inference.local chat completion",
    );
    return { endpoint, result };
  }

  async expectInferenceLocalStatus(
    instance: NemoClawInstance,
    options: InferenceRuntimeStatusOptions = {},
  ): Promise<InferenceRuntimeProbeResult> {
    const allowedStatusCodes = options.allowedStatusCodes ?? [200];
    const endpoint = inferenceRouteUrl(options.route, options.path ?? MODELS_PATH);
    const result = await this.sandbox.exec(
      instance.sandboxName,
      [
        "curl",
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        curlMaxTime(options),
        ...headerArgs(options.headers),
        endpoint,
      ],
      shellOptions(options, "runtime-inference-local-status"),
    );
    const status = parseHttpStatus(result, "inference.local status probe");
    if (!allowedStatusCodes.includes(status)) {
      throw new Error(
        `inference.local status probe returned HTTP ${status}; expected one of ${allowedStatusCodes.join(", ")}`,
      );
    }
    return { endpoint, result };
  }

  async expectProviderModels(
    endpoint: TrustedProviderEndpoint,
    options: ProviderRuntimeRequestOptions = {},
  ): Promise<InferenceRuntimeProbeResult> {
    const response = await this.provider.requestJson(endpoint, providerRequestOptions(options));
    assertModelListShape(response.json, "provider models");
    return { endpoint: endpoint.logLabel, result: response.result };
  }

  async expectProviderChatCompletion(
    endpoint: TrustedProviderEndpoint,
    options: ProviderRuntimeRequestOptions & InferenceRuntimeChatOptions = {},
  ): Promise<InferenceRuntimeProbeResult> {
    const response = await this.provider.requestJson(
      endpoint,
      providerRequestOptions(options, openAiChatPayload(options)),
    );
    assertChatCompletionShape(response.json, "provider chat completion");
    return { endpoint: endpoint.logLabel, result: response.result };
  }
}
