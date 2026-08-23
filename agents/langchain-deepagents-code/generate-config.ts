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

import {
  type ManagedDcodeProvider,
  normalizeManagedDcodeEndpointUrl,
  resolveManagedDcodeIdentity,
} from "../../src/lib/inference/managed-dcode/identity.ts";

type ReasoningEffort = "low" | "medium" | "high";

type Settings = {
  model: string;
  baseUrl: string;
  providerKey: string;
  upstreamProvider: string;
  upstreamEndpointUrl: string | null;
  inferenceApi: string;
  reasoningEffort: ReasoningEffort | null;
};

type ManagedDeepAgentsConfig = {
  text: string;
  provider: ManagedDcodeProvider;
  model: string;
  defaultModel: string;
};

const NEMOTRON_ULTRA_MODEL_IDS = new Set([
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nvidia/nemotron-3-ultra",
]);

function readSettings(env: NodeJS.ProcessEnv): Settings {
  const providerKey = normalizeCommentMetadata(
    env.NEMOCLAW_INFERENCE_PROVIDER_ID || env.NEMOCLAW_PROVIDER_KEY || "inference",
    "NEMOCLAW_INFERENCE_PROVIDER_ID",
  );
  return {
    model: readRequiredEnv(env, "NEMOCLAW_MODEL"),
    baseUrl: normalizeInferenceBaseUrl(
      env.NEMOCLAW_INFERENCE_BASE_URL || "https://inference.local/v1",
    ),
    providerKey,
    upstreamProvider: normalizeCommentMetadata(
      env.NEMOCLAW_UPSTREAM_PROVIDER ||
        env.NEMOCLAW_INFERENCE_PROVIDER_ID ||
        env.NEMOCLAW_PROVIDER_KEY ||
        "inference",
      "NEMOCLAW_UPSTREAM_PROVIDER",
    ),
    upstreamEndpointUrl: normalizeManagedDcodeEndpointUrl(
      env.NEMOCLAW_UPSTREAM_ENDPOINT_URL,
      "NEMOCLAW_UPSTREAM_ENDPOINT_URL",
    ),
    inferenceApi: normalizeCommentMetadata(
      env.NEMOCLAW_INFERENCE_API || "openai-completions",
      "NEMOCLAW_INFERENCE_API",
    ),
    reasoningEffort: normalizeReasoningEffort(env.NEMOCLAW_REASONING_EFFORT),
  };
}

function normalizeReasoningEffort(value: string | undefined): ReasoningEffort | null {
  if (value === undefined || value.trim() === "") return null;
  const text = value.trim();
  if (text !== "low" && text !== "medium" && text !== "high") {
    throw new Error("NEMOCLAW_REASONING_EFFORT must be low, medium, or high.");
  }
  return text;
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

function openAiModelRequestParamLines(
  model: string,
  reasoningEffort: ReasoningEffort | null,
): string[] {
  // Source boundary: NVIDIA's Ultra serving template owns the empty assistant
  // content behavior; this generator owns only the managed per-model request
  // parameters. Keep the exact invalid state, regression proof, and separate
  // removal conditions for this option and the dispatch guard in
  // dependency-review.md under "Managed Ultra compatibility workarounds."
  const isUltra = NEMOTRON_ULTRA_MODEL_IDS.has(model);
  const extraBodyEntries = [
    ...(isUltra ? ["chat_template_kwargs = { force_nonempty_content = true }"] : []),
    ...(reasoningEffort ? [`reasoning_effort = ${tomlString(reasoningEffort)}`] : []),
  ];
  if (extraBodyEntries.length === 0) return [];
  return [
    "",
    `[models.providers.openai.params.${tomlString(model)}]`,
    ...(isUltra
      ? [
          "# Nemotron Ultra coding-agent requests need nonempty content when tool calls and reasoning are combined.",
        ]
      : []),
    `extra_body = { ${extraBodyEntries.join(", ")} }`,
  ];
}

function providerConfigLines(
  provider: ManagedDcodeProvider,
  model: string,
  baseUrl: string,
  reasoningEffort: ReasoningEffort | null,
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
          ...openAiModelRequestParamLines(model, reasoningEffort),
        ]
      : []),
  ];
}

function buildConfig(settings: Settings): ManagedDeepAgentsConfig {
  const { provider, model, defaultModel } = resolveManagedDcodeIdentity(
    settings.upstreamProvider,
    settings.model,
    settings.upstreamEndpointUrl,
  );
  const text = [
    "# Generated by NemoClaw. This file contains no provider secrets.",
    `# NemoClaw provider route: ${settings.providerKey}; upstream provider: ${settings.upstreamProvider}; API: ${settings.inferenceApi}.`,
    "",
    "[models]",
    `default = ${tomlString(defaultModel)}`,
    "",
    ...providerConfigLines(provider, model, settings.baseUrl, settings.reasoningEffort),
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
