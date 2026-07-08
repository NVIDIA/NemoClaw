// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { R, YW } from "../../cli/terminal-style";
import { redact } from "../../security/redact";
import { executeSandboxCommand } from "./process-recovery";
import { buildRefreshMutableOpenClawConfigHashCommand } from "./rebuild-config-hash-command";

export { buildRefreshMutableOpenClawConfigHashCommand };

export function refreshMutableOpenClawConfigHashAfterPostRestoreWrites(
  sandboxName: string,
  log: (msg: string) => void,
): boolean {
  const result = executeSandboxCommand(sandboxName, buildRefreshMutableOpenClawConfigHashCommand());
  if (result && result.status === 0) {
    log("Mutable OpenClaw config hash refreshed after post-restore config writes");
    return true;
  }

  const detail = result
    ? [result.stderr, result.stdout].filter(Boolean).join("; ") || `exit ${result.status}`
    : "could not obtain sandbox SSH config";
  console.error(`  ${YW}⚠${R} Mutable OpenClaw config hash was not refreshed: ${redact(detail)}`);
  return false;
}
