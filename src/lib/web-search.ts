// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface WebSearchConfig {
  fetchEnabled: boolean;
}

export const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";

export function encodeDockerJsonArg(value: unknown): string {
  return Buffer.from(JSON.stringify(value ?? {}), "utf8").toString("base64");
}

export function buildWebSearchDockerConfig(
  config: WebSearchConfig | null,
): string {
  if (!config || config.fetchEnabled !== true) return encodeDockerJsonArg({});

  const payload = {
    provider: "brave",
    fetchEnabled: Boolean(config.fetchEnabled),
    // Use the OpenShell proxy placeholder instead of the raw API key to ensure
    // credentials are never baked into Docker images or raw sandbox configuration.
    apiKey: `openshell:resolve:env:${BRAVE_API_KEY_ENV}`,
  };
  return encodeDockerJsonArg(payload);
}
