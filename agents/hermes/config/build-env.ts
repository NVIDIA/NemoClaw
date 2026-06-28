// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import { normalizeProviderPlaceholderForEnvKey } from "../../../src/lib/messaging/provider-placeholders.ts";

export type HermesBuildSettings = {
  model: string;
  baseUrl: string;
  providerKey: string;
  upstreamProvider: string;
  inferenceApi: string;
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
    messagingCredentialPlaceholders: readMessagingCredentialPlaceholders(env),
    managedToolGateways: {
      brokerEnabled: env.NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER === "1",
      presets: readBase64Json<string[]>(env, "NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64", "W10="),
    },
  };
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
