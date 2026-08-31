// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import type { SandboxMessagingPlan } from "../../messaging";
import {
  ensureMessagingHostForwardIfConfigured,
  resolveMessagingHostForward,
} from "../../onboard/messaging-host-forward";
import {
  ensureSandboxPortForwardForPort,
  isSandboxPortForwardHealthy,
} from "./forward-recovery";

function getMessagingForwardHealth(
  sandboxName: string,
  port: number,
): true | false | "occupied" | null {
  const health = isSandboxPortForwardHealthy(sandboxName, port);
  if (health === "occupied") {
    console.warn(
      `! Messaging webhook forward on port ${port} is owned by another sandbox; leaving it unchanged.`,
    );
    console.warn(`  Free the port, then reconnect: ${CLI_NAME} ${sandboxName} connect`);
    return "occupied";
  }
  return health;
}

export function ensureMessagingHostForwardAfterRebuild(
  sandboxName: string,
  plan: SandboxMessagingPlan | null | undefined,
): boolean {
  const forward = resolveMessagingHostForward(plan);
  if (!forward) return true;
  const health = getMessagingForwardHealth(sandboxName, forward.port);
  if (health === true) return true;
  if (health === null) return false;
  if (health === "occupied") return false;
  return ensureMessagingHostForwardIfConfigured({
    sandboxName,
    plan,
    ensureForward: (name, port) => ensureSandboxPortForwardForPort(name, port),
    note: console.log,
  });
}
