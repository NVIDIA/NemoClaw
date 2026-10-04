// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCredential, normalizeCredentialValue } from "../credentials/store";
import { getChannelTokenKeys, type ChannelDef } from "../sandbox/channels";

export function getMessagingToken(envKey: string | undefined): string | null {
  if (!envKey) return null;
  return normalizeCredentialValue(process.env[envKey]) || getCredential(envKey) || null;
}

function getTokenFormat(channel: ChannelDef, envKey: string | undefined): RegExp | undefined {
  if (!envKey) return undefined;
  if ("envKey" in channel && envKey === channel.envKey) return channel.tokenFormat;
  if ("appTokenEnvKey" in channel && envKey === channel.appTokenEnvKey) {
    return channel.appTokenFormat;
  }
  return undefined;
}

export function isMessagingTokenFormatValid(
  channel: ChannelDef,
  envKey: string | undefined,
  token: string | null,
): boolean {
  if (!token || !envKey || !getChannelTokenKeys(channel).includes(envKey)) return false;
  const format = getTokenFormat(channel, envKey);
  return !format || format.test(token);
}

export function getValidatedMessagingToken(
  channel: ChannelDef,
  envKey: string | undefined,
): string | null {
  const token = getMessagingToken(envKey);
  return isMessagingTokenFormatValid(channel, envKey, token) ? token : null;
}

export function getValidatedMessagingTokenByEnvKey(
  channels: readonly ChannelDef[],
  envKey: string,
): string | null {
  const channel = channels.find((ch) => getChannelTokenKeys(ch).includes(envKey));
  return channel ? getValidatedMessagingToken(channel, envKey) : null;
}
