// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface WebSearchConfig {
  fetchEnabled: true;
}

export const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";

export function encodeDockerJsonArg(value: unknown): string {
  return Buffer.from(JSON.stringify(value ?? {}), "utf8").toString("base64");
}

export function getBraveExposureWarningLines(): string[] {
  return [
    "Brave Search setup will store the Brave API key in OpenClaw config inside the sandbox.",
    "The OpenClaw agent can read that key and could exfiltrate or misuse it.",
    "We explored an OpenShell-hosted credential path first, but current OpenClaw Brave handling does not consume it end to end yet.",
    "This should be improved in the future.",
  ];
}

export function buildWebSearchDockerConfig(
  config: WebSearchConfig | null,
  braveApiKey: string | null,
): string {
  if (!config) return encodeDockerJsonArg({});

  const payload = {
    provider: "brave",
    fetchEnabled: true,
    apiKey: braveApiKey || "",
  };
  return encodeDockerJsonArg(payload);
}
