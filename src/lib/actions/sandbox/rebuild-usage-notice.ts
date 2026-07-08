// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { prompt } from "../../credentials/store";
import { ensureUsageNoticeConsent, NOTICE_ACCEPT_ENV } from "../../onboard/usage-notice";

type EnsureConsent = typeof ensureUsageNoticeConsent;

export type RebuildUsageNoticeDeps = {
  ensureConsent?: EnsureConsent;
  env?: NodeJS.ProcessEnv;
  stdinIsTty?: boolean;
};

/**
 * Resolve the current notice before rebuild enters its destructive window.
 * Destructive `--yes` is deliberately not legal-notice consent: unattended
 * callers must have the current saved acceptance or set the dedicated env.
 */
export async function ensureRebuildUsageNoticeAccepted(
  deps: RebuildUsageNoticeDeps = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  const stdinIsTty = deps.stdinIsTty ?? process.stdin?.isTTY === true;
  return (deps.ensureConsent ?? ensureUsageNoticeConsent)({
    nonInteractive: env.NEMOCLAW_NON_INTERACTIVE === "1" || !stdinIsTty,
    acceptedByFlag: String(env[NOTICE_ACCEPT_ENV] || "") === "1",
    promptFn: prompt,
    writeLine: console.error,
  });
}
