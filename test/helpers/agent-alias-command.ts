// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type CliRunResult, runCliScriptAsync } from "../cli/helpers";

export function runAgentAliasCommand(
  script: string,
  args: string,
  env: Record<string, string | undefined> = {},
): Promise<CliRunResult> {
  return runCliScriptAsync(script, args, {
    env: {
      // Let the launcher under test set its own identity markers.
      NEMOCLAW_AGENT: undefined,
      NEMOCLAW_INVOKED_AS: undefined,
      ...env,
    },
  });
}
