// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../messaging";
import {
  ensureMessagingHostForwardIfConfigured,
  resolveMessagingHostForward,
} from "../../onboard/messaging-host-forward";
import {
  ensureSandboxPortForwardForPort,
  isSandboxPortForwardHealthy,
} from "./forward-recovery";

export function ensureMessagingHostForwardAfterRebuild(
  sandboxName: string,
  plan: SandboxMessagingPlan | null | undefined,
): boolean {
  const forward = resolveMessagingHostForward(plan);
  if (!forward) return true;
  const health = isSandboxPortForwardHealthy(sandboxName, forward.port);
  if (health === true) return true;
  return ensureMessagingHostForwardIfConfigured({
    sandboxName,
    plan,
    ensureForward: (name, port) => ensureSandboxPortForwardForPort(name, port),
    note: console.log,
  });
}
