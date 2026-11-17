// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getReadyCheckOutputPatternsForAgent } from "../../sandbox/create-stream-ready-gate";

export const MANAGED_STARTUP_HOLD_EXECUTABLE = "/usr/local/bin/nemoclaw-managed-startup-hold";
export const MANAGED_STARTUP_EXECUTABLE = "/usr/local/bin/nemoclaw-start";

export function managedStartupCreateReadiness(input: {
  startupCommand: readonly string[];
  isTerminalAgent: boolean;
  env: NodeJS.ProcessEnv;
  deferPostCreateEffects: boolean;
}): { readyCheckOutputPatterns: readonly RegExp[]; waitForReadyTermination: boolean } {
  // The post-create transaction releases the hold, so create cannot wait for
  // a native startup banner while the hold is active.
  const held = input.startupCommand.includes(MANAGED_STARTUP_HOLD_EXECUTABLE);
  return {
    readyCheckOutputPatterns: getReadyCheckOutputPatternsForAgent({
      isTerminalAgent: input.isTerminalAgent,
      startupRunsDuringCreate: !held,
      env: input.env,
    }),
    waitForReadyTermination: held || input.deferPostCreateEffects,
  };
}
