// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const HERMES_STABLE_CREDENTIALS = {
  wechat: ["WEIXIN_TOKEN", "WECHAT_BOT_TOKEN"],
  teams: ["TEAMS_CLIENT_SECRET", "MSTEAMS_APP_PASSWORD"],
} as const;

export type HermesStableCredentialChannel = keyof typeof HERMES_STABLE_CREDENTIALS;

export function hermesStableCredentialLinePattern(
  channel: HermesStableCredentialChannel,
): string {
  const [targetEnvKey, credentialEnvKey] = HERMES_STABLE_CREDENTIALS[channel];
  return `^${targetEnvKey}=openshell:resolve:env:s[a-f0-9]{64}_${credentialEnvKey}$`;
}
