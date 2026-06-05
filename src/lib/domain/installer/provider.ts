// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const INSTALLER_PROVIDER_VALUES = [
  "build",
  "openai",
  "anthropic",
  "anthropicCompatible",
  "gemini",
  "ollama",
  "custom",
  "nim-local",
  "vllm",
  "routed",
] as const;

export type InstallerProvider = (typeof INSTALLER_PROVIDER_VALUES)[number];

export const INSTALLER_PROVIDER_ALIASES: Readonly<Record<string, InstallerProvider>> = {
  anthropiccompatible: "anthropicCompatible",
  cloud: "build",
  nim: "nim-local",
};

const PROVIDERS_BY_LOWERCASE = new Map<string, InstallerProvider>(
  INSTALLER_PROVIDER_VALUES.map((provider) => [provider.toLowerCase(), provider]),
);

export function normalizeInstallerProvider(value: string | null | undefined): InstallerProvider | null {
  const provider = (value ?? "").trim();
  if (!provider) return null;
  const key = provider.toLowerCase();
  return INSTALLER_PROVIDER_ALIASES[key] ?? PROVIDERS_BY_LOWERCASE.get(key) ?? null;
}

export function installerProviderHelpValues(): string {
  return INSTALLER_PROVIDER_VALUES.join(", ");
}

export function installerProviderUsageLines(): readonly string[] {
  const aliases = Object.entries(INSTALLER_PROVIDER_ALIASES)
    .map(([alias, provider]) => `${alias} -> ${provider}`)
    .join(", ");
  return [
    INSTALLER_PROVIDER_VALUES.slice(0, 4).join(" | "),
    INSTALLER_PROVIDER_VALUES.slice(4).join(" | "),
    `aliases: ${aliases}`,
  ];
}
