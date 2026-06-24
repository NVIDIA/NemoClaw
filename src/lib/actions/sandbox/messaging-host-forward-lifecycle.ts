// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  captureOpenshell,
  getOpenshellBinary,
  runOpenshell,
} from "../../adapters/openshell/runtime";
import { CLI_NAME } from "../../cli/branding";
import { sleepSeconds } from "../../core/wait";
import type { SandboxMessagingPlan } from "../../messaging";
import { ensureAgentFixedForward } from "../../onboard/agent-fixed-forward";
import {
  ensureMessagingHostForwardIfConfigured,
  resolveMessagingHostForward,
} from "../../onboard/messaging-host-forward";
import { parseForwardList } from "../../state/sandbox-session";
import { classifyForwardHealthWithReachability, isLocalForwardReachable } from "./forward-health";

function captureOpenShellOutput(args: string[], opts: Record<string, unknown> = {}): string | null {
  const result = captureOpenshell(args, opts as Parameters<typeof captureOpenshell>[1]);
  return result.status === 0 ? result.output : null;
}

function getMessagingForwardHealth(sandboxName: string, port: number): true | false | "occupied" {
  const output = captureOpenShellOutput(["forward", "list"], { ignoreError: true });
  if (output === null) return false;
  const entries = parseForwardList(output);
  const health = classifyForwardHealthWithReachability(entries, sandboxName, String(port), () =>
    isLocalForwardReachable(port),
  );
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
  if (health === "occupied") return false;
  return ensureMessagingHostForwardIfConfigured({
    sandboxName,
    plan,
    ensureForward: (name, port, label) =>
      ensureAgentFixedForward(
        {
          runOpenshell: (args, opts = {}) =>
            runOpenshell(args, opts as Parameters<typeof runOpenshell>[1]),
          runCaptureOpenshell: captureOpenShellOutput,
          openshellArgv: (args) => [getOpenshellBinary(), ...args],
          cliName: () => CLI_NAME,
          sleep: sleepSeconds,
        },
        name,
        port,
        label,
      ),
    note: console.log,
  });
}
