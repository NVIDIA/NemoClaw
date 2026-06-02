// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelDef } from "../../sandbox/channels";
import {
  formatSlackValidationFailure,
  validateSlackCredentials,
} from "../../onboard/slack-validation";

export type SlackChannelCredentialValidationResult =
  | { ok: true; message?: string }
  | { ok: false; message: string };

function isAcquiredTokenFormatValid(channel: ChannelDef, envKey: string, token: string): boolean {
  if (envKey === channel.envKey) return !channel.tokenFormat || channel.tokenFormat.test(token);
  if (envKey === channel.appTokenEnvKey) {
    return !channel.appTokenFormat || channel.appTokenFormat.test(token);
  }
  return false;
}

export function validateSlackChannelCredentials(
  channel: ChannelDef,
  acquired: Record<string, string>,
): SlackChannelCredentialValidationResult {
  if (!channel.envKey || !channel.appTokenEnvKey) {
    return { ok: false, message: "Slack channel definition is missing required token keys." };
  }

  const botToken = acquired[channel.envKey];
  const appToken = acquired[channel.appTokenEnvKey];
  if (!botToken || !appToken) {
    return { ok: false, message: "Slack requires both SLACK_BOT_TOKEN and SLACK_APP_TOKEN." };
  }

  for (const [envKey, token] of Object.entries(acquired)) {
    if (!isAcquiredTokenFormatValid(channel, envKey, token)) {
      const hint =
        envKey === channel.appTokenEnvKey
          ? channel.appTokenFormatHint || "Check the token and try again."
          : channel.tokenFormatHint || "Check the token and try again.";
      return { ok: false, message: `Invalid ${envKey} format. ${hint}` };
    }
  }

  const validation = validateSlackCredentials({ botToken, appToken });
  if (validation.ok) {
    return validation.skipped && validation.message
      ? { ok: true, message: validation.message }
      : { ok: true };
  }

  return {
    ok: false,
    message: `Slack credential validation failed. ${formatSlackValidationFailure(validation)}`,
  };
}
