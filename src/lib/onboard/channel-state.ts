// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import { readMessagingPlanFromEnv } from "./messaging-channel-setup";
import { getDisabledChannelsFromPlan } from "./messaging-plan-session";

type DisabledChannelsSession = Pick<onboardSession.Session, "messagingPlan" | "sandboxName">;

export type DisabledChannelsDeps = {
  loadSession: () => DisabledChannelsSession | null;
  readMessagingPlanFromEnv?: () => onboardSession.Session["messagingPlan"];
  getRegistryDisabledChannels: (sandboxName: string) => string[];
};

export function resolveDisabledChannels(
  sandboxName: string,
  deps?: DisabledChannelsDeps,
): string[] {
  const envPlan = (deps?.readMessagingPlanFromEnv ?? readMessagingPlanFromEnv)();
  if (envPlan?.sandboxName === sandboxName) {
    return getDisabledChannelsFromPlan(envPlan) ?? [];
  }
  const session = (deps?.loadSession ?? onboardSession.loadSession)();
  if (session?.sandboxName === sandboxName && session.messagingPlan) {
    return getDisabledChannelsFromPlan(session.messagingPlan) ?? [];
  }
  return (deps?.getRegistryDisabledChannels ?? registry.getDisabledChannels)(sandboxName);
}
