// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingHostForwardPlan, SandboxMessagingPlan } from "./manifest";

export function getActiveMessagingHostForward(
  plan: SandboxMessagingPlan | null | undefined,
): SandboxMessagingHostForwardPlan | null {
  if (!plan) return null;
  const disabled = new Set(plan.disabledChannels);
  for (const channel of plan.channels) {
    if (!channel.active || channel.disabled || disabled.has(channel.channelId)) continue;
    if (channel.hostForward) return channel.hostForward;
  }
  return null;
}
