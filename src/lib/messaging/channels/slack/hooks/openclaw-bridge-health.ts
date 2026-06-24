// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createOpenClawBridgeHealthHookRegistration,
  type OpenClawBridgeHealthHookOptions,
} from "../../openclaw-bridge-health";

export type { OpenClawBridgeHealthHookOptions } from "../../openclaw-bridge-health";

export const SLACK_OPENCLAW_BRIDGE_HEALTH_HOOK_HANDLER_ID = "slack.openclawBridgeHealth";

export function createSlackOpenClawBridgeHealthHookRegistration(
  options: OpenClawBridgeHealthHookOptions = {},
) {
  return createOpenClawBridgeHealthHookRegistration(
    {
      channelId: "slack",
      handlerId: SLACK_OPENCLAW_BRIDGE_HEALTH_HOOK_HANDLER_ID,
    },
    options,
  );
}
