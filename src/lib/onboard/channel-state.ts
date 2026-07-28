// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as onboardSession from "../state/onboard-session";
import {
  getRegistrySandboxMessagingAuthority,
  readMessagingPlanFromEnv,
} from "./messaging-channel-setup";
import {
  type RegistryMessagingAuthority,
  resolveMessagingPlanAuthority,
} from "./messaging-plan-authority";
import { getDisabledChannelsFromPlan } from "./messaging-plan-session";

type DisabledChannelsSession = Pick<onboardSession.Session, "messagingPlan" | "sandboxName">;

export type DisabledChannelsDeps = {
  loadSession: () => DisabledChannelsSession | null;
  readMessagingPlanFromEnv?: () => onboardSession.Session["messagingPlan"];
  getRegistryMessagingAuthority(sandboxName: string): RegistryMessagingAuthority;
};

export function resolveDisabledChannels(
  sandboxName: string,
  deps?: DisabledChannelsDeps,
): string[] {
  const session = (deps?.loadSession ?? onboardSession.loadSession)();
  const result = resolveMessagingPlanAuthority({
    sandboxName,
    registry: (deps?.getRegistryMessagingAuthority ?? getRegistrySandboxMessagingAuthority)(
      sandboxName,
    ),
    stagedPlan: (deps?.readMessagingPlanFromEnv ?? readMessagingPlanFromEnv)(),
    sessionPlan: session?.sandboxName === sandboxName ? session.messagingPlan : null,
  });
  return getDisabledChannelsFromPlan(result.plan);
}
