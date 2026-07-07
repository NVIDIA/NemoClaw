// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../cli/branding";

// Whether an onboard `--resume` recovery hint has already been emitted this run.
// Context-specific failure explainers (e.g. the sandbox build-context hints)
// print their own tailored `--resume` guidance and call
// `noteOnboardResumeHintShown()` so the incomplete-exit backstop in
// exit-step-failure.ts does not print a second, generic hint after them.
let resumeHintShown = false;

/**
 * Print the generic onboard `--resume` recovery hint, once per process.
 *
 * Onboarding exits through dozens of scattered `process.exit(1)` paths; most
 * never mention `--resume`, so users assume a failed run requires a full
 * reinstall (#6003). The incomplete-exit handler calls this as a catch-all when
 * a resumable step was in progress, covering every exit that does not already
 * print its own recovery guidance.
 */
export function printOnboardResumeHint(
  log: (message: string) => void = (message) => console.error(message),
): void {
  if (resumeHintShown) return;
  resumeHintShown = true;
  log("");
  log("  Onboarding did not finish. Resume from the step that failed with:");
  log(`    ${CLI_NAME} onboard --resume`);
  log("  Completed steps are skipped; pass --fresh instead to start over.");
}

/**
 * Record that a context-specific `--resume` hint was already printed this run so
 * the catch-all in {@link printOnboardResumeHint} stays silent.
 */
export function noteOnboardResumeHintShown(): void {
  resumeHintShown = true;
}

/** Reset the once-per-process latch. Test-only. */
export function resetOnboardResumeHintForTests(): void {
  resumeHintShown = false;
}
