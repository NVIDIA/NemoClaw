// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as urlUtilsModule from "../../../src/lib/core/url-utils.ts";
import * as onboardProbesModule from "../../../src/lib/inference/onboard-probes.ts";
import * as providerModelsModule from "../../../src/lib/inference/provider-models.ts";
import type { ModelCatalogFetchResult } from "../../../src/lib/onboard/types.ts";

function unwrapCommonJsModule<T extends object>(module: T): T {
  return (module as T & { default?: T }).default ?? module;
}

const { isLoopbackHostname } = unwrapCommonJsModule(urlUtilsModule);
const { probeOpenAiLikeEndpointOptimized } = unwrapCommonJsModule(onboardProbesModule);
const { fetchOpenAiLikeModels } = unwrapCommonJsModule(providerModelsModule);

const CHAT_MODEL_HINT = /(?:claude|deepseek|gemma|gpt|kimi|llama|mistral|nemotron|phi|qwen)/iu;
const NON_CHAT_MODEL_HINT =
  /(?:audio|clip|embed|guard|image|moderation|ocr|rerank|retrieval|reward|safety|speech|video)/iu;
const PREFERRED_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nvidia/nemotron-3-super-v3",
  "nvidia/nemotron-3-super-120b-a12b",
];
const MAX_CANDIDATES = 6;

type FetchModels = (endpoint: string, apiKey: string) => ModelCatalogFetchResult;
type ProbeModel = (
  endpoint: string,
  model: string,
  apiKey: string,
  options: { skipResponsesProbe: true },
) => Promise<{ ok: boolean }>;

interface AuthorizedChatModelOptions {
  apiKey?: string;
  currentModel?: string;
  endpoint?: string;
  fetchModels?: FetchModels;
  maxCandidates?: number;
  probeModel?: ProbeModel;
}

function fail(message: string): never {
  throw new Error(`authorized model selection failed: ${message}`);
}

function assertCredentialSafeEndpoint(endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    fail("the endpoint must be an absolute HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))
  ) {
    fail("the endpoint must use HTTPS unless it targets loopback");
  }
}

function orderedChatCandidates(ids: string[], currentModel: string): string[] {
  const preference = new Map(PREFERRED_MODELS.map((id, index) => [id, index]));
  return [...new Set(ids)]
    .filter(
      (id) => id !== currentModel && CHAT_MODEL_HINT.test(id) && !NON_CHAT_MODEL_HINT.test(id),
    )
    .sort((left, right) => {
      const leftRank = preference.get(left) ?? PREFERRED_MODELS.length;
      const rightRank = preference.get(right) ?? PREFERRED_MODELS.length;
      return leftRank - rightRank || left.localeCompare(right);
    });
}

export async function selectAuthorizedChatModel({
  apiKey,
  currentModel,
  endpoint,
  fetchModels = fetchOpenAiLikeModels,
  maxCandidates = MAX_CANDIDATES,
  probeModel = probeOpenAiLikeEndpointOptimized,
}: AuthorizedChatModelOptions): Promise<string> {
  if (!apiKey) fail("COMPATIBLE_API_KEY is required");
  if (!currentModel) fail("the current model is required");
  if (!endpoint) fail("the endpoint is required");
  assertCredentialSafeEndpoint(endpoint);
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > MAX_CANDIDATES) {
    fail(`maxCandidates must be an integer from 1 to ${MAX_CANDIDATES}`);
  }

  const catalog = fetchModels(endpoint, apiKey);
  if (!catalog.ok) fail(`authenticated model discovery failed: ${catalog.message}`);
  const candidates = orderedChatCandidates(catalog.ids, currentModel).slice(0, maxCandidates);
  if (candidates.length === 0) fail("the endpoint listed no alternate chat model");

  for (const model of candidates) {
    const result = await probeModel(endpoint, model, apiKey, { skipResponsesProbe: true });
    if (result.ok) return model;
    process.stderr.write(
      `Alternate model candidate ${model} failed validation; trying the next candidate.\n`,
    );
  }

  fail(`none of the first ${candidates.length} listed chat models passed validation`);
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const selected = await selectAuthorizedChatModel({
    apiKey: process.env.COMPATIBLE_API_KEY,
    currentModel: value("--current-model"),
    endpoint: value("--endpoint"),
  });
  process.stdout.write(`${selected}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
