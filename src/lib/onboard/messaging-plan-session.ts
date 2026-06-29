// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../messaging/manifest";
import { getConfiguredChannelIdsFromPlan } from "../messaging/plan-validation";

export {
  getActiveChannelIdsFromPlan as getActiveChannelsFromPlan,
  getDisabledChannelIdsFromPlan as getDisabledChannelsFromPlan,
  getMessagingChannelConfigFromPlan,
  parseSandboxMessagingPlan,
} from "../messaging/plan-validation";

/** Derive configured channel IDs from a plan. */
export function getChannelsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  const channels = getConfiguredChannelIdsFromPlan(plan);
  return channels.length > 0 ? channels : null;
}
