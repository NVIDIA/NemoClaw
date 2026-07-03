// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { listAgents } from "../agent/defs";
import { runOnboardCommand } from "../onboard/command";
import type { OnboardFlags } from "../onboard/command-support";

async function runOnboard(options?: unknown): Promise<void> {
  // Keep the monolithic legacy onboarding graph lazy so command metadata/help
  // imports do not execute it. Resolve it only when the user invokes onboard.
  const { onboard } = (await import("../onboard")) as unknown as {
    onboard: (onboardOptions?: unknown) => Promise<void>;
  };
  await onboard(options);
}

function buildOnboardCommandDeps(flags: OnboardFlags) {
  return {
    flags,
    env: process.env,
    runOnboard,
    listAgents,
    log: console.log,
    error: console.error,
    exit: (code: number) => process.exit(code),
  };
}

export async function runOnboardAction(flags: OnboardFlags): Promise<void> {
  await runOnboardCommand(buildOnboardCommandDeps(flags));
}
