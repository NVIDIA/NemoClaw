// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function isSyntheticDiscordToken(token: string | undefined): boolean {
  return /^(?:test-fake-discord-[a-z0-9-]+|dc-[ab]-rotation-e2e)$/.test(token ?? "");
}

/** Install the synthetic enrollment transport in installer and CLI children only. */
export function withDiscordEnrollmentFixture(
  env: NodeJS.ProcessEnv,
  token = env.DISCORD_BOT_TOKEN,
): NodeJS.ProcessEnv {
  if (!isSyntheticDiscordToken(token)) return env;
  const preload = new URL("./discord-enrollment-preload.mts", import.meta.url).href;
  return {
    ...env,
    NEMOCLAW_E2E_DISCORD_TOKEN: token,
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${preload}`.trim(),
  };
}
