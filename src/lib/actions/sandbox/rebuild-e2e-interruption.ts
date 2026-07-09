// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Testing-only process-death checkpoint; inert unless the shared E2E gate is enabled. */
export type RebuildInterruptionPhase =
  | "delete_unjournaled"
  | "prepared"
  | "replacement_created"
  | "replacement_unjournaled"
  | "required_verified"
  | "state_restored";

export function maybePauseForRebuildInterruption(phase: RebuildInterruptionPhase): void {
  if (process.env.VITEST !== "true") return;
  const fixtureRoot = process.env.NEMOCLAW_REBUILD_PROCESS_FIXTURE;
  if (!fixtureRoot || fixtureRoot !== process.env.HOME) return;
  if (process.env.NEMOCLAW_E2E_FAILURE_INJECTION !== "1") return;
  if (process.env.NEMOCLAW_E2E_FORCE_FAIL_AT_STEP !== `rebuild_${phase}`) return;
  process.stderr.write(
    `[e2e] Rebuild interruption point '${phase}' (pid ${String(process.pid)}).\n`,
  );
  process.kill(process.pid, "SIGSTOP");
}
