// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import { MessagingSetupApplier } from "../messaging/applier";
import type { SandboxMessagingPlan } from "../messaging/manifest";

type DisabledChannelsSession = Pick<onboardSession.Session, "messagingPlan" | "sandboxName">;

export type DisabledChannelsDeps = {
  loadSession: () => DisabledChannelsSession | null;
  readMessagingPlanFromEnv?: () => SandboxMessagingPlan | null;
  getRegistryDisabledChannels: (sandboxName: string) => string[];
};

export function resolveDisabledChannels(
  sandboxName: string,
  deps?: DisabledChannelsDeps,
): string[] {
  const envPlan = deps?.readMessagingPlanFromEnv
    ? deps.readMessagingPlanFromEnv()
    : MessagingSetupApplier.readPlanFromEnv();
  if (envPlan?.sandboxName === sandboxName) return [...envPlan.disabledChannels];

  // `rebuild` destroys the registry entry before `onboard --resume` reaches
  // createSandbox, so the session plan carries paused channels across that
  // destroy/recreate window.
  const session = (deps?.loadSession ?? onboardSession.loadSession)();
  if (session?.messagingPlan?.sandboxName === sandboxName) {
    return [...session.messagingPlan.disabledChannels];
  }
  return (deps?.getRegistryDisabledChannels ?? registry.getDisabledChannels)(sandboxName);
}
