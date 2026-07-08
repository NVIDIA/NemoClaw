// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import { normalizeProviderPlaceholderForEnvKey } from "../../../src/lib/messaging/provider-placeholders.ts";
import { readToolDisclosureEnv } from "../../../src/lib/tool-disclosure.ts";

export type HermesWebSearchProvider = "tavily";

export type HermesBuildSettings = {
  model: string;
  baseUrl: string;
  providerKey: string;
  upstreamProvider: string;
  inferenceApi: string;
  /** Total context window (tokens); null lets Hermes auto-detect from /v1/models. */
  contextWindow: number | null;
  toolDisclosure: "progressive" | "direct";
  webSearchProvider: HermesWebSearchProvider | null;
  messagingCredentialPlaceholders: Array<{
    envKey: string;
    placeholder: string;
  }>;
  managedToolGateways: {
    brokerEnabled: boolean;
    presets: string[];
  };
};

export function readHermesBuildSettings(env: NodeJS.ProcessEnv): HermesBuildSettings {
  const model = readRequiredEnv(env, "NEMOCLAW_MODEL");
  const baseUrl = readRequiredEnv(env, "NEMOCLAW_INFERENCE_BASE_URL");

  return {
    model,
    baseUrl,
    providerKey: env.NEMOCLAW_PROVIDER_KEY || "custom",
    upstreamProvider: env.NEMOCLAW_UPSTREAM_PROVIDER || env.NEMOCLAW_PROVIDER_KEY || "custom",
    inferenceApi: env.NEMOCLAW_INFERENCE_API || "",
    contextWindow: readContextWindow(env),
    toolDisclosure: readToolDisclosureEnv(env),
    webSearchProvider: readWebSearchProvider(env),
    messagingCredentialPlaceholders: readMessagingCredentialPlaceholders(env),
    managedToolGateways: {
      brokerEnabled: env.NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER === "1",
      presets: readBase64Json<string[]>(env, "NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64", "W10="),
    },
  };
}

// Parse NEMOCLAW_CONTEXT_WINDOW as a positive integer of tokens. Empty, absent,
// or malformed values return null so the generated config omits context_length
// and Hermes keeps auto-detecting from the endpoint's /v1/models. See #6177.
function readContextWindow(env: NodeJS.ProcessEnv): number | null {
  const raw = (env.NEMOCLAW_CONTEXT_WINDOW || "").trim();
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function readWebSearchProvider(env: NodeJS.ProcessEnv): HermesWebSearchProvider | null {
  if (env.NEMOCLAW_WEB_SEARCH_ENABLED !== "1") return null;

  const provider = (env.NEMOCLAW_WEB_SEARCH_PROVIDER || "tavily").trim();
  if (provider === "tavily") return provider;
  throw new Error(
    `Hermes NEMOCLAW_WEB_SEARCH_PROVIDER must be "tavily", got ${JSON.stringify(provider)}`,
  );
}

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readBase64Json<T>(env: NodeJS.ProcessEnv, name: string, defaultValue: string): T {
  const encoded = env[name] || defaultValue;
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")) as T;
}

function readMessagingCredentialPlaceholders(
  env: NodeJS.ProcessEnv,
): Array<{ envKey: string; placeholder: string }> {
  const plan = readBase64Json<Record<string, unknown> | null>(
    env,
    "NEMOCLAW_MESSAGING_PLAN_B64",
    "bnVsbA==",
  );
  if (!isRecord(plan) || plan.agent !== "hermes") return [];
  if (planHasEnvLineRender(plan)) return [];

  const channels = Array.isArray(plan.channels) ? plan.channels : [];
  const disabledChannels = new Set(
    Array.isArray(plan.disabledChannels)
      ? plan.disabledChannels.filter((channel): channel is string => typeof channel === "string")
      : [],
  );
  const activeChannels = new Set(
    channels.flatMap((channel) => {
      if (!isRecord(channel)) return [];
      const channelId = typeof channel.channelId === "string" ? channel.channelId : "";
      return channelId &&
        channel.active === true &&
        channel.disabled !== true &&
        !disabledChannels.has(channelId)
        ? [channelId]
        : [];
    }),
  );
  const bindings = Array.isArray(plan.credentialBindings) ? plan.credentialBindings : [];
  const placeholders = new Map<string, string>();

  for (const binding of bindings) {
    if (!isRecord(binding)) continue;
    const channelId = typeof binding.channelId === "string" ? binding.channelId : "";
    const envKey = typeof binding.providerEnvKey === "string" ? binding.providerEnvKey : "";
    const placeholder = typeof binding.placeholder === "string" ? binding.placeholder : "";
    const normalizedPlaceholder = normalizeProviderPlaceholderForEnvKey(placeholder, envKey);
    if (
      !activeChannels.has(channelId) ||
      !isSafeEnvKey(envKey) ||
      !normalizedPlaceholder ||
      placeholders.has(envKey)
    ) {
      continue;
    }
    placeholders.set(envKey, normalizedPlaceholder);
  }

  return [...placeholders].map(([envKey, placeholder]) => ({ envKey, placeholder }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeEnvKey(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(value);
}

function planHasEnvLineRender(plan: Record<string, unknown> | null): boolean {
  const renderEntries = Array.isArray(plan?.agentRender) ? plan.agentRender : [];
  return renderEntries.some((entry) => isRecord(entry) && entry.kind === "env-lines");
}
