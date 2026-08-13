// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../cli/branding";
import { isPortableExperimentalProfile } from "./experimental/portable-profile";

export function onboardRecoveryCommand(portable = isPortableExperimentalProfile()): string {
  return portable
    ? `${CLI_NAME} onboard --experimental-profile portable`
    : `${CLI_NAME} onboard --resume`;
}

// Whether an onboard `--resume` recovery hint has already been emitted this run.
// Context-specific failure explainers (e.g. the sandbox build-context hints)
// print their own tailored `--resume` guidance and call
// `noteOnboardResumeHintShown()` so the incomplete-exit backstop in
// exit-step-failure.ts does not print a second, generic hint after them.
let resumeHintShown = false;

/**
 * Print the generic onboard recovery hint, once per process.
 *
 * Onboarding exits through dozens of scattered `process.exit(1)` paths; most
 * never mention how to resume, so users assume a failed run requires a full
 * reinstall (#6003). The incomplete-exit handler calls this as a catch-all when
 * a resumable step was in progress, covering every exit that does not already
 * print its own recovery guidance. The recovery command adapts to whether the
 * run selected the portable experimental profile (which forces `--fresh` and
 * rejects `--resume`) (#8873).
 */
export function printOnboardResumeHint(
  portable = isPortableExperimentalProfile(),
  log: (message: string) => void = (message) => console.error(message),
): void {
  if (resumeHintShown) return;
  resumeHintShown = true;
  log("");
  if (portable) {
    log("  Onboarding did not finish. Portable onboarding always starts fresh; rerun:");
    log(`    ${onboardRecoveryCommand(portable)}`);
  } else {
    log("  Onboarding did not finish. Resume from the step that failed with:");
    log(`    ${onboardRecoveryCommand(portable)}`);
    log("  Completed steps are skipped; pass --fresh instead to start over.");
  }
}

/**
 * Record that a context-specific hint was already printed this run so
 * the catch-all in {@link printOnboardResumeHint} stays silent.
 */
export function noteOnboardResumeHintShown(): void {
  resumeHintShown = true;
}

/** Reset the once-per-process latch. Test-only. */
export function resetOnboardResumeHintForTests(): void {
  resumeHintShown = false;
}
