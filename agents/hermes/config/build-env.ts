// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

export type HermesBuildSettings = {
  model: string;
  baseUrl: string;
  providerKey: string;
  upstreamProvider: string;
  inferenceApi: string;
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
