// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const CONFIG_COMPAT_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  TELEGRAM_ALLOWED_IDS: ["TELEGRAM_AUTHORIZED_CHAT_IDS", "TELEGRAM_CHAT_ID"],
  DISCORD_SERVER_ID: ["DISCORD_SERVER_IDS"],
  DISCORD_USER_ID: ["DISCORD_ALLOWED_IDS"],
  MSTEAMS_APP_ID: ["TEAMS_CLIENT_ID"],
  MSTEAMS_TENANT_ID: ["TEAMS_TENANT_ID"],
  TEAMS_ALLOWED_USERS: ["MSTEAMS_ALLOWED_USERS"],
  MSTEAMS_PORT: ["TEAMS_PORT"],
};

const CONFIG_COMPAT_ENV_KEY_REMOVAL_POLICY = {
  enforcement: "manual",
  reviewCadence: "release",
  releaseWindow: "one-full-release-after-sources-clear",
  sourceBoundaries: [
    "test/e2e/live/messaging-providers-helpers.ts",
    "test/e2e/live/hermes-discord.test.ts",
    "test/e2e/live/channels-stop-start-helpers.ts",
    ".github/workflows/e2e.yaml",
    "docs/manage-sandboxes/messaging-channels.mdx",
    "docs/reference/troubleshooting.mdx",
    "NVIDIA internal QA automation that exports legacy messaging env names",
  ],
  removalCondition:
    "Remove manually after every source boundary stops exporting these legacy names for at least one full release.",
} as const;

export interface MessagingConfigCompatEnvKeyRemovalPolicy {
  readonly enforcement: string;
  readonly reviewCadence: string;
  readonly releaseWindow: string;
  readonly sourceBoundaries: readonly string[];
  readonly removalCondition: string;
  readonly canonicalKeys: readonly string[];
}

export function selectMessagingConfigCompatEnvKeys(
  configKeys: Iterable<string>,
): Readonly<Record<string, readonly string[]>> {
  const configKeySet = new Set(configKeys);
  return Object.fromEntries(
    Object.entries(CONFIG_COMPAT_ENV_KEYS).filter(([canonical]) => configKeySet.has(canonical)),
  );
}

export function createMessagingConfigCompatEnvKeyRemovalPolicy(
  compatEnvKeys: Readonly<Record<string, readonly string[]>>,
): MessagingConfigCompatEnvKeyRemovalPolicy {
  return {
    ...CONFIG_COMPAT_ENV_KEY_REMOVAL_POLICY,
    canonicalKeys: Object.keys(compatEnvKeys),
  };
}
