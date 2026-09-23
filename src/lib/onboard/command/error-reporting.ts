// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { GatewayManagementDeclarationError } from "../gateway-management";
import { GatewayStateConflictError } from "../errors/gateway-state-conflict";
import { noteOnboardResumeHintShown } from "../resume-hint";
import { GatewayAuthorityError, gatewayAuthorityFailureLines } from "../gateway-teardown-authority";
import { PortableInferenceDescriptorError } from "../experimental/portable-inference-descriptor";
import {
  OnboardRestoreSnapshotDriftError,
  redactOnboardErrorText,
  sanitizeOnboardFailure,
} from "../session-bootstrap";

interface OnboardErrorReporter {
  error?: (message?: string) => void;
}

/** Report operator errors without exposing multiline secrets or truncating later recovery lines. */
export function reportOnboardCommandError(deps: OnboardErrorReporter, message: string): number {
  const redacted = redactOnboardErrorText(message);
  (deps.error ?? console.error)(redacted);
  return 1;
}

/** Preserve cancellation and failure behavior without exposing secrets through CLI errors. */
export function handleOnboardCommandError(
  error: unknown,
  deps: OnboardErrorReporter,
  cancellationCode: string | null,
): number | null {
  const sanitizedError = sanitizeOnboardFailure(error);
  if (cancellationCode === "SIGINT") {
    // The prompt has already restored terminal state and re-raised SIGINT.
    // Let the onboard signal handler print resumable-step guidance and
    // preserve status 130 without leaking this rejected prompt error through
    // oclif as a raw stack trace (#7439).
    return null;
  }
  // A rejected NEMOCLAW_GATEWAY_MANAGEMENT contract is operator input error,
  // not a crash: print the validation reason as a clean single-line CLI error
  // and exit nonzero instead of re-throwing it into a Node.js stack trace
  // (#7627).
  if (sanitizedError instanceof GatewayManagementDeclarationError) {
    return reportOnboardCommandError(deps, `  ${sanitizedError.message}`);
  }
  if (sanitizedError instanceof PortableInferenceDescriptorError) {
    return reportOnboardCommandError(deps, `  ${sanitizedError.message}`);
  }
  if (sanitizedError instanceof GatewayStateConflictError) {
    if (sanitizedError.hasRecoveryGuidance) noteOnboardResumeHintShown();
    return reportOnboardCommandError(deps, `  ${sanitizedError.message}`);
  }
  if (sanitizedError instanceof OnboardRestoreSnapshotDriftError) {
    return reportOnboardCommandError(deps, `  ${sanitizedError.message}`);
  }
  // Gateway-authority refusals are reported, never rethrown. Recreation is not
  // selected in one place: `--recreate-sandbox` sets the flag, but `runOnboard`
  // independently honours NEMOCLAW_RECREATE_SANDBOX and reaches the same
  // journal when it detects sandbox drift. Keying this branch on the flag left
  // both of those paths emitting a raw stack trace (#8103). Within onboarding
  // the recreate journal's authority revalidation is the only source of this
  // typed error, so the operation label holds however recreation was selected.
  if (sanitizedError instanceof GatewayAuthorityError) {
    return reportOnboardCommandError(
      deps,
      gatewayAuthorityFailureLines(sanitizedError, "sandbox recreate").join("\n"),
    );
  }
  // Stdin EOF at any onboarding prompt is a cancellation, not a failure:
  // print a clear message and exit non-zero instead of either crashing with
  // a stack trace or — as in the original bug — exiting 0 silently (#5976).
  if (cancellationCode !== "EOF") {
    throw sanitizedError;
  }
  return reportOnboardCommandError(deps, "  Installation cancelled");
}
