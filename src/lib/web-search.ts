// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface WebSearchConfig {
  fetchEnabled: boolean;
}

export const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";

export function encodeDockerJsonArg(value: unknown): string {
  return Buffer.from(JSON.stringify(value ?? {}), "utf8").toString("base64");
}

export function getBraveExposureWarningLines(): string[] {
  return [
    "NemoClaw will store the Brave API key in the sandbox agent config.",
    "The sandboxed agent will be able to read that key.",
  ];
}

export function buildWebSearchDockerConfig(
  config: WebSearchConfig | null,
  braveApiKey: string | null,
): string {
  if (!config || config.fetchEnabled !== true) return encodeDockerJsonArg({});

  const payload = {
    provider: "brave",
    fetchEnabled: Boolean(config.fetchEnabled),
    apiKey: braveApiKey || "",
  };
  return encodeDockerJsonArg(payload);
}
