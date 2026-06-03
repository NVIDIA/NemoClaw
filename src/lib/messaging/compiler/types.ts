// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingAgentId,
  MessagingChannelId,
  MessagingCompilerWorkflow,
} from "../manifest";

/** Credential availability lookup by env key, channel.input id, or credential id. */
export type MessagingCompilerCredentialAvailability = Readonly<Record<string, boolean>>;

/** Compiler inputs; values here must not contain raw secret material. */
export interface ManifestCompilerContext {
  readonly sandboxName: string;
  readonly agent: MessagingAgentId;
  readonly workflow: MessagingCompilerWorkflow;
  readonly isInteractive: boolean;
  readonly configuredChannels: readonly MessagingChannelId[];
  readonly disabledChannels?: readonly MessagingChannelId[];
  readonly supportedChannelIds?: readonly MessagingChannelId[];
  readonly credentialAvailability?: MessagingCompilerCredentialAvailability;
}
