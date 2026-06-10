// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistry } from "../hooks";
import type {
  ChannelManifest,
  ChannelManifestRegistry,
  MessagingAgentId,
  MessagingChannelId,
} from "../manifest";

export interface SandboxMessagingPlanValidationOptions {
  readonly registry?: ChannelManifestRegistry;
  readonly hooks?: MessagingHookRegistry;
  readonly sandboxName?: string;
  readonly agent?: MessagingAgentId;
  readonly supportedChannelIds?: readonly MessagingChannelId[];
}

export type PlanManifestMap = ReadonlyMap<MessagingChannelId, ChannelManifest>;
