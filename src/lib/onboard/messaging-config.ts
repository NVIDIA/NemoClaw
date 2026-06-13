// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type MessagingChannelConfig,
  mergeMessagingChannelConfigs,
} from "../messaging-channel-config";
import { getMessagingChannelConfigFromPlan } from "../messaging/plan-validation";
import type { Session } from "../state/onboard-session";
import * as registry from "../state/registry";

// Read TELEGRAM_REQUIRE_MENTION (set either by the interactive mention prompt
// or by the user's shell) and map it to a boolean, or null when the env var
// is unset / invalid. Used at resume time to detect drift against the recorded
// session state. See #1737 and the CodeRabbit follow-up on #2417.
export function computeTelegramRequireMention(): boolean | null {
  const raw = process.env.TELEGRAM_REQUIRE_MENTION;
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

export function getStoredMessagingChannelConfig(
  sandboxName: string | null,
  session: Session | null,
): MessagingChannelConfig | null {
  const registryConfig = sandboxName
    ? getMessagingChannelConfigFromPlan(
        registry.getMessagingPlanFromEntry(registry.getSandbox(sandboxName)),
      )
    : null;
  const sessionMatchesSandbox =
    !session?.sandboxName || !sandboxName || session.sandboxName === sandboxName;
  const sessionConfig = sessionMatchesSandbox
    ? getMessagingChannelConfigFromPlan(session?.messagingPlan)
    : null;
  return mergeMessagingChannelConfigs(registryConfig, sessionConfig);
}

export function messagingChannelConfigsEqual(
  left: MessagingChannelConfig | null,
  right: MessagingChannelConfig | null,
): boolean {
  const leftKeys = Object.keys(left || {}).sort();
  const rightKeys = Object.keys(right || {}).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left?.[key] === right?.[key]);
}
