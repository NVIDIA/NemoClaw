// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getMessagingCredentialEnvKeysByChannel,
  getMessagingProviderSuffixesByChannel,
} from "../../channels";

// Map channelId to providerEnvKey values declared in built-in manifests.
// This is the primary key set for hash comparison so a missing credential for
// one of a channel's required credentials conservatively marks the comparison
// as unknown-token rather than silently returning null.
export const CHANNEL_CREDENTIAL_ENV_KEYS: Readonly<Record<string, readonly string[]>> =
  getMessagingCredentialEnvKeysByChannel();

export const PROVIDER_SUFFIXES: Readonly<Record<string, readonly string[]>> =
  getMessagingProviderSuffixesByChannel();
