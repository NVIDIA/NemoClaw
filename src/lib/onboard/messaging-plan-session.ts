// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../messaging/manifest";
import {
  getActiveChannelIdsFromPlan,
  getConfiguredChannelIdsFromPlan,
  getDisabledChannelIdsFromPlan,
  getMessagingChannelConfigFromPlan,
  parseSandboxMessagingPlan,
} from "../messaging/plan-validation";

export { getMessagingChannelConfigFromPlan, parseSandboxMessagingPlan };

/** Derive configured channel IDs from a plan. */
export function getChannelsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  const channels = getConfiguredChannelIdsFromPlan(plan);
  return channels.length > 0 ? channels : null;
}

/** Derive active channels from a plan, excluding stopped/disabled channels. */
export function getActiveChannelsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  const channels = getActiveChannelIdsFromPlan(plan);
  return channels.length > 0 ? channels : null;
}

/** Derive disabled channel IDs from a plan. */
export function getDisabledChannelsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  const channels = getDisabledChannelIdsFromPlan(plan);
  return channels.length > 0 ? channels : null;
}
