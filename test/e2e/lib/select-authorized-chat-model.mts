// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const CHAT_MODEL_HINT = /(?:claude|deepseek|gemma|gpt|kimi|llama|mistral|nemotron|phi|qwen)/iu;
const NON_CHAT_MODEL_HINT =
  /(?:audio|clip|embed|guard|image|moderation|ocr|rerank|retrieval|reward|safety|speech|video)/iu;
const PREFERRED_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nvidia/nemotron-3-super-v3",
  "nvidia/nemotron-3-super-120b-a12b",
];
const MAX_CANDIDATES = 6;
const MAX_TRANSIENT_ATTEMPTS = 3;
const TRANSIENT_STATUS = new Set([408, 409, 425, 429]);

function fail(message: string): never {
  throw new Error(`authorized model selection failed: ${message}`);
}

function modelIds(body: unknown): string[] {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) {
    fail("the authenticated models response has no data array");
  }
  const ids = data
    .map((entry: unknown) =>
      entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined,
    )
    .filter((id: unknown): id is string => typeof id === "string");
  return [...new Set(ids)];
}

function orderedChatCandidates(ids: string[], currentModel: string): string[] {
  const candidates = ids.filter(
    (id) => id !== currentModel && CHAT_MODEL_HINT.test(id) && !NON_CHAT_MODEL_HINT.test(id),
  );
  const preference = new Map(PREFERRED_MODELS.map((id, index) => [id, index]));
  return candidates.sort((left, right) => {
    const leftRank = preference.get(left) ?? PREFERRED_MODELS.length;
    const rightRank = preference.get(right) ?? PREFERRED_MODELS.length;
    return leftRank - rightRank || left.localeCompare(right);
  });
}

async function parseJson(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    fail(`${label} did not return JSON`);
  }
}

async function probePayload(model: string): Promise<Record<string, unknown>> {
  const { getChatCompletionsProbePayload } = await import(
    "../../../src/lib/inference/openai-probe-models"
  );
  return getChatCompletionsProbePayload(model);
}

interface AuthorizedChatModelOptions {
  apiKey?: string;
  currentModel?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  maxCandidates?: number;
}

export async function selectAuthorizedChatModel({
  apiKey,
  currentModel,
  endpoint,
  fetchImpl = fetch,
  maxCandidates = MAX_CANDIDATES,
}: AuthorizedChatModelOptions): Promise<string> {
  if (!apiKey) fail("COMPATIBLE_API_KEY is required");
  if (!currentModel) fail("the current model is required");
  if (!endpoint) fail("the endpoint is required");
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > MAX_CANDIDATES) {
    fail(`maxCandidates must be an integer from 1 to ${MAX_CANDIDATES}`);
  }

  let baseUrl;
  try {
    baseUrl = new URL(endpoint);
  } catch {
    fail("the endpoint is not a valid URL");
  }
  if (!["http:", "https:"].includes(baseUrl.protocol)) {
    fail("the endpoint must use HTTP or HTTPS");
  }
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/u, "")}/`;
  baseUrl.search = "";
  baseUrl.hash = "";

  const headers = { Authorization: `Bearer ${apiKey}` };
  const modelsResponse = await fetchImpl(new URL("models", baseUrl), {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!modelsResponse.ok) {
    fail(`authenticated model discovery returned HTTP ${modelsResponse.status}`);
  }
  const candidates = orderedChatCandidates(
    modelIds(await parseJson(modelsResponse, "authenticated model discovery")),
    currentModel,
  ).slice(0, maxCandidates);
  if (candidates.length === 0) fail("the endpoint listed no alternate chat model");

  for (const model of candidates) {
    for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(new URL("chat/completions", baseUrl), {
          body: JSON.stringify(await probePayload(model)),
          headers: { ...headers, "Content-Type": "application/json" },
          method: "POST",
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        if (attempt < MAX_TRANSIENT_ATTEMPTS) continue;
        fail(
          `alternate model validation did not complete after ${MAX_TRANSIENT_ATTEMPTS} attempts`,
        );
      }
      await response.arrayBuffer();
      if (response.ok) return model;
      if (response.status === 401) fail("the inference credential was rejected during validation");
      const transient = TRANSIENT_STATUS.has(response.status) || response.status >= 500;
      if (transient && attempt < MAX_TRANSIENT_ATTEMPTS) continue;
      if (transient) {
        fail(
          `alternate model validation remained unavailable after ${MAX_TRANSIENT_ATTEMPTS} attempts`,
        );
      }
      process.stderr.write(
        `Alternate model candidate was unavailable (HTTP ${response.status}); trying the next listed model.\n`,
      );
      break;
    }
  }

  fail(
    `none of the first ${candidates.length} listed chat models passed a bounded validation request`,
  );
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
