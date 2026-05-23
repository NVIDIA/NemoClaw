// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";

type DisabledChannelsSession = Pick<onboardSession.Session, "disabledChannels">;

export type DisabledChannelsDeps = {
  loadSession: () => DisabledChannelsSession | null;
  getRegistryDisabledChannels: (sandboxName: string) => string[];
};

export function resolveDisabledChannels(
  sandboxName: string,
  deps?: DisabledChannelsDeps,
): string[] {
  // `rebuild` destroys the registry entry before `onboard --resume` reaches
  // createSandbox, so the session mirror is authoritative when present.
  const sessionDisabledChannels = (deps?.loadSession ?? onboardSession.loadSession)()
    ?.disabledChannels;
  if (Array.isArray(sessionDisabledChannels)) {
    return sessionDisabledChannels;
  }
  return (deps?.getRegistryDisabledChannels ?? registry.getDisabledChannels)(sandboxName);
}
