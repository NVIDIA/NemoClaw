// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Generate Deep Agents Code config.toml from NemoClaw build-arg env vars.
//
// SECURITY: this file writes only non-secret provider/model metadata. Real
// provider credentials stay outside ~/.deepagents files.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Settings = {
  model: string;
  baseUrl: string;
  providerKey: string;
  upstreamProvider: string;
  upstreamEndpointUrl: string | null;
  inferenceApi: string;
};

type ManagedDeepAgentsProvider = "openai" | "openrouter";

type ManagedDeepAgentsConfig = {
  text: string;
  provider: ManagedDeepAgentsProvider;
  model: string;
  defaultModel: string;
};

const NEMOTRON_ULTRA_MODEL_IDS = new Set([
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nvidia/nemotron-3-ultra",
]);

const OPENROUTER_UPSTREAM_PROVIDERS = new Set(["openrouter", "openrouter-api"]);
const OPENROUTER_ENDPOINT_HOST = "openrouter.ai";
const OPENROUTER_ENDPOINT_PATH = "/api/v1";

function readSettings(env: NodeJS.ProcessEnv): Settings {
  const providerKey = normalizeCommentMetadata(
    env.NEMOCLAW_PROVIDER_KEY || "inference",
    "NEMOCLAW_PROVIDER_KEY",
  );
  return {
    model: readRequiredEnv(env, "NEMOCLAW_MODEL"),
    baseUrl: normalizeInferenceBaseUrl(
      env.NEMOCLAW_INFERENCE_BASE_URL || "https://inference.local/v1",
    ),
    providerKey,
    upstreamProvider: normalizeCommentMetadata(
      env.NEMOCLAW_UPSTREAM_PROVIDER || env.NEMOCLAW_PROVIDER_KEY || "inference",
      "NEMOCLAW_UPSTREAM_PROVIDER",
    ),
    upstreamEndpointUrl: normalizeOptionalEndpointUrl(
      env.NEMOCLAW_UPSTREAM_ENDPOINT_URL,
      "NEMOCLAW_UPSTREAM_ENDPOINT_URL",
    ),
    inferenceApi: normalizeCommentMetadata(
      env.NEMOCLAW_INFERENCE_API || "openai-completions",
      "NEMOCLAW_INFERENCE_API",
    ),
  };
}

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeCommentMetadata(value: string, name: string): string {
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`${name} must not contain control characters.`);
  }
  return value.trim();
}

function normalizeOptionalEndpointUrl(value: string | undefined, name: string): string | null {
  if (value === undefined || value.trim() === "") return null;
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`${name} must not contain control characters.`);
  }
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include credentials.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${name} must not include query strings or fragments.`);
  }
  return url.href;
}

function normalizeInferenceBaseUrl(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error("NEMOCLAW_INFERENCE_BASE_URL must not contain line breaks.");
  }
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("NEMOCLAW_INFERENCE_BASE_URL must be a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("NEMOCLAW_INFERENCE_BASE_URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("NEMOCLAW_INFERENCE_BASE_URL must not include credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("NEMOCLAW_INFERENCE_BASE_URL must not include query strings or fragments.");
  }

  return text;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function managedDeepAgentsProviderFor(settings: Settings): ManagedDeepAgentsProvider {
  if (OPENROUTER_UPSTREAM_PROVIDERS.has(settings.upstreamProvider)) return "openrouter";
  if (
    settings.upstreamProvider === "compatible-endpoint" &&
    isOpenRouterEndpointUrl(settings.upstreamEndpointUrl)
  ) {
    return "openrouter";
  }
  return "openai";
}

function isOpenRouterEndpointUrl(value: string | null): boolean {
  if (!value) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.hostname.toLowerCase() === OPENROUTER_ENDPOINT_HOST &&
    url.pathname.replace(/\/+$/, "") === OPENROUTER_ENDPOINT_PATH
  );
}

function modelNameForManagedProvider(model: string): string {
  const trimmed = model.trim();
  for (const prefix of ["openai:", "openrouter:"]) {
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return trimmed;
}

function openAiModelRequestParamLines(model: string): string[] {
  // Source boundary: NVIDIA's Ultra serving template owns the empty assistant
  // content behavior; this generator owns only the managed per-model request
  // parameters. Keep the exact invalid state, regression proof, and separate
  // removal conditions for this option and the dispatch guard in
  // dependency-review.md under "Managed Ultra compatibility workarounds."
  return NEMOTRON_ULTRA_MODEL_IDS.has(model)
    ? [
        "",
        `[models.providers.openai.params.${tomlString(model)}]`,
        "# Nemotron Ultra coding-agent requests need nonempty content when tool calls and reasoning are combined.",
        "extra_body = { chat_template_kwargs = { force_nonempty_content = true } }",
      ]
    : [];
}

function providerConfigLines(
  provider: ManagedDeepAgentsProvider,
  model: string,
  baseUrl: string,
): string[] {
  return [
    `[models.providers.${provider}]`,
    `models = ${tomlArray([model])}`,
    'api_key_env = "DEEPAGENTS_CODE_OPENAI_API_KEY"',
    `base_url = ${tomlString(baseUrl)}`,
    "enabled = true",
    ...(provider === "openai"
      ? [
          "",
          "[models.providers.openai.params]",
          "# NemoClaw-managed inference.local currently exposes Chat Completions.",
          "# Remove this override when that route supports OpenAI Responses API.",
          "use_responses_api = false",
          ...openAiModelRequestParamLines(model),
        ]
      : []),
  ];
}

function buildConfig(settings: Settings): ManagedDeepAgentsConfig {
  const provider = managedDeepAgentsProviderFor(settings);
  const model = modelNameForManagedProvider(settings.model);
  const defaultModel = `${provider}:${model}`;
  const text = [
    "# Generated by NemoClaw. This file contains no provider secrets.",
    `# NemoClaw provider route: ${settings.providerKey}; upstream provider: ${settings.upstreamProvider}; API: ${settings.inferenceApi}.`,
    "",
    "[models]",
    `default = ${tomlString(defaultModel)}`,
    "",
    ...providerConfigLines(provider, model, settings.baseUrl),
    "",
    "[update]",
    "check = false",
    "auto_update = false",
    "",
    "[warnings]",
    "# Tavily is optional in managed sandboxes; surface errors only when web search is invoked.",
    'suppress = ["tavily"]',
    "",
  ].join("\n");
  return { text, provider, model, defaultModel };
}

function main(): void {
  const settings = readSettings(process.env);
  const configDir = join(homedir(), ".deepagents");
  mkdirSync(join(configDir, ".state"), { recursive: true, mode: 0o770 });
  mkdirSync(join(configDir, "skills"), { recursive: true, mode: 0o770 });

  const configPath = join(configDir, "config.toml");
  const config = buildConfig(settings);
  writeFileSync(configPath, config.text);
  chmodSync(configPath, 0o600);

  console.log(
    `[config] Wrote ${configPath} (model=${config.defaultModel}, base_url=${settings.baseUrl})`,
  );
}

main();
