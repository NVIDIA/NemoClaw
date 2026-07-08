// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Testing-only process-death checkpoint; inert unless the shared E2E gate is enabled. */
export function maybePauseForRebuildInterruption(phase: "prepared" | "delete_unjournaled"): void {
  if (process.env.NEMOCLAW_E2E_FAILURE_INJECTION !== "1") return;
  if (process.env.NEMOCLAW_E2E_FORCE_FAIL_AT_STEP !== `rebuild_${phase}`) return;
  process.stderr.write(
    `[e2e] Rebuild interruption point '${phase}' (pid ${String(process.pid)}).\n`,
  );
  process.kill(process.pid, "SIGSTOP");
}
