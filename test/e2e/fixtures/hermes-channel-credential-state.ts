// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const HERMES_REVISION_SCOPED_CREDENTIALS = {
  wechat: ["WEIXIN_TOKEN", "WECHAT_BOT_TOKEN"],
  teams: ["TEAMS_CLIENT_SECRET", "MSTEAMS_APP_PASSWORD"],
} as const;

export type HermesRevisionScopedCredentialChannel = keyof typeof HERMES_REVISION_SCOPED_CREDENTIALS;

export function hermesRevisionScopedCredentialLinePattern(
  channel: HermesRevisionScopedCredentialChannel,
): string {
  const [targetEnvKey, credentialEnvKey] = HERMES_REVISION_SCOPED_CREDENTIALS[channel];
  return `^${targetEnvKey}=openshell:resolve:env:v[0-9]+_${credentialEnvKey}$`;
}
