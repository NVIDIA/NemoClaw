// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { maybeEmitPolicyDenialHint, type PolicyDenialHintDeps } from "./exec-policy-hint";

export type ExecPolicyHintDeps = PolicyDenialHintDeps & {
  now?: () => number;
};

type ExecPolicyDenialHintCompletion = {
  commandCode: number;
  invocationError?: string;
};

/**
 * Capture the denial cutoff before dispatch, then return the post-exec emitter.
 * This is the boundary for post-exec observability so timing and diagnostic
 * dependencies do not accumulate in the command-dispatch module.
 */
export function preparePolicyHint(
  cliName: string,
  sandboxName: string,
  deps: ExecPolicyHintDeps = {},
): (completion: ExecPolicyDenialHintCompletion) => Promise<void> {
  const { now = Date.now, ...hintDeps } = deps;
  const commandStartedAtMs = now();
  return async (completion) => {
    await maybeEmitPolicyDenialHint(
      cliName,
      sandboxName,
      completion.commandCode,
      Boolean(completion.invocationError),
      commandStartedAtMs,
      hintDeps,
    );
  };
}
