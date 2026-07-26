// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { JsonObject } from "../../core/json-types";
import type { Session } from "../../state/onboard-session";
import { createOnboardMachineEvent, type OnboardMachineEvent } from "./events";
import type { OnboardMachineState } from "./types";

/**
 * Focused builders for the "result-lifecycle" onboarding machine events
 * (`state.result.skipped`, `state.result.invalidated`). Extracted from
 * `OnboardRuntime` so the runtime monolith stays within the codebase-growth
 * guardrail while stale-replay diagnostics grow. Runtime methods stay
 * responsible for `ensureSession()` and dispatching the built event through
 * `deps.emitEvent`; only the metadata shape lives here.
 */

export type ResultInvalidationReason = "already_at_target" | "source_state_mismatch";

export interface ResultSkippedInputs {
  reason: ResultInvalidationReason;
  currentState: OnboardMachineState;
  targetState: OnboardMachineState;
  metadata?: Record<string, unknown> | null;
}

export interface ResultInvalidatedInputs extends ResultSkippedInputs {
  sourceState?: string | null;
}

function baseMetadata(metadata: Record<string, unknown> | null | undefined): JsonObject {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as JsonObject)
    : {};
}

export function buildResultSkippedEvent(
  session: Session,
  options: ResultSkippedInputs,
): OnboardMachineEvent {
  return createOnboardMachineEvent({
    type: "state.result.skipped",
    session,
    state: session.machine.state,
    step: null,
    error: null,
    metadata: {
      ...baseMetadata(options.metadata),
      reason: options.reason,
      currentState: options.currentState,
      targetState: options.targetState,
    },
  });
}

export function buildResultInvalidatedEvent(
  session: Session,
  options: ResultInvalidatedInputs,
): OnboardMachineEvent {
  return createOnboardMachineEvent({
    type: "state.result.invalidated",
    session,
    state: session.machine.state,
    step: null,
    error: null,
    metadata: {
      ...baseMetadata(options.metadata),
      reason: options.reason,
      currentState: options.currentState,
      targetState: options.targetState,
      sourceState: options.sourceState ?? undefined,
    },
  });
}
