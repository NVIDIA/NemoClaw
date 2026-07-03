// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { maybeEmitPolicyDenialHint, type PolicyDenialHintDeps } from "./exec-policy-hint";

export type ExecPolicyDenialHintIntegrationDeps = PolicyDenialHintDeps & {
  now?: () => number;
};

type ExecPolicyDenialHintCompletion = {
  commandCode: number;
  invocationError?: string;
};

/**
 * Capture the denial cutoff before dispatch, then return the post-exec emitter.
 * Keeping this orchestration outside exec.ts prevents observability concerns
 * from growing the command-dispatch module.
 */
export function prepareExecPolicyDenialHint(
  cliName: string,
  sandboxName: string,
  deps: ExecPolicyDenialHintIntegrationDeps = {},
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
