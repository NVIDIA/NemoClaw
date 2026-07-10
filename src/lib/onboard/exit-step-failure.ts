// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../state/onboard-session";
import { printOnboardResumeHint } from "./resume-hint";

export interface ExitStepFailureSessionDeps {
  loadSession(): Pick<Session, "lastStepStarted"> | null;
  finalizeIncompleteOnboardStep(stepName: string, message?: string | null): Session | null;
}

export interface OnboardExitFailureProcessLike {
  once(event: "exit", listener: (code: number) => void): unknown;
  on?(event: OnboardInterruptSignal, listener: () => void): unknown;
  removeListener?(event: OnboardInterruptSignal, listener: () => void): unknown;
  kill?(pid: number, signal: OnboardInterruptSignal): unknown;
  pid?: number;
}

type OnboardInterruptSignal = "SIGINT" | "SIGTERM";

export function markLastStartedStepFailed(
  deps: ExitStepFailureSessionDeps,
  message: string,
): Session | null {
  // Repairs the invalid state where onboard/rebuild exits nonzero after a step
  // starts but before normal completion handlers can run. Routes through the
  // single terminal-failure owner (finalizeIncompleteOnboardStep), which
  // validates the failed transition and is idempotent against an already
  // terminal machine, rather than the legacy step-mutation escape hatch.
  // Covered by exit-step-failure, rebuild-flow, and onboard-exit-handler tests.
  const failedStep = deps.loadSession()?.lastStepStarted;
  if (!failedStep) return null;
  return deps.finalizeIncompleteOnboardStep(failedStep, message);
}

export function registerIncompleteOnboardExitFailureHandler(
  deps: ExitStepFailureSessionDeps,
  isComplete: () => boolean,
  message: string,
  processLike: OnboardExitFailureProcessLike = process,
): void {
  const failIncompleteStep = (): void => {
    if (isComplete()) return;
    // A non-null return means a step was in progress, so the session records a
    // resumable point — surface `--resume` for exit paths that don't print
    // their own recovery guidance (#6003). When an explicit cancel has already
    // cleared the session (or no step started), this is null and stays silent;
    // printOnboardResumeHint also self-dedupes against tailored hints.
    if (markLastStartedStepFailed(deps, message)) printOnboardResumeHint();
  };

  processLike.once("exit", (code) => {
    if (code === 0) return;
    failIncompleteStep();
  });

  const on = processLike.on?.bind(processLike);
  const removeListener = processLike.removeListener?.bind(processLike);
  const kill = processLike.kill?.bind(processLike);
  const pid = processLike.pid;
  if (!on || !removeListener || !kill || pid === undefined) return;

  let pendingSignal: OnboardInterruptSignal | null = null;
  const handleSignal = (signal: OnboardInterruptSignal): void => {
    // Prompt handlers restore the terminal and may synchronously re-raise the
    // signal. Keep this listener installed until the next turn so a nested
    // delivery cannot terminate the process before the resume hint is printed.
    if (pendingSignal) return;
    pendingSignal = signal;
    setImmediate(() => {
      removeListener("SIGINT", onSigint);
      removeListener("SIGTERM", onSigterm);
      failIncompleteStep();
      kill(pid, signal);
    });
  };
  const onSigint = (): void => handleSignal("SIGINT");
  const onSigterm = (): void => handleSignal("SIGTERM");

  on("SIGINT", onSigint);
  on("SIGTERM", onSigterm);
}
