// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ExpectedFailureContract,
  ExpectedFailurePhase,
  PhaseName,
  PhaseResult,
  RunPlan,
} from "../types.ts";

// Pure framework infrastructure: given a compiled RunPlan and the
// observed phase results, decide whether a negative scenario's
// declared failure contract was honored. Does not mutate inputs and
// does not perform I/O.
//
// Spec ownership boundaries:
// - Failure injection (uninstalling docker, planting a bad key,
//   occupying a gateway port) is runner-environment prep, NOT this
//   matcher's job. The matcher only inspects what actually happened.
// - Forbidden-side-effect verification (did a sandbox actually get
//   created when the scenario forbids it?) belongs to the
//   state-validation phase. The matcher reports the contract status
//   for phase + errorClass independently from those post-condition
//   probes so callers can combine the signals without confusing the
//   originating failure with forbidden side effects.

export type NegativeContractMatchOutcome =
  // Right phase, right errorClass match observed.
  | "matched"
  // Scenario expected a failure but every phase passed.
  | "no-failure-observed"
  // Wrong phase failed (e.g., expected onboarding, observed environment).
  | "wrong-phase"
  // Right phase, but the failure message did not advertise the
  // declared errorClass.
  | "wrong-error-class";

export interface NegativeContractObservation {
  failedPhase?: PhaseName;
  failedActionId?: string;
  failedActionMessage?: string;
  failedAssertionId?: string;
  failedAssertionMessage?: string;
  handledActionId?: string;
  handledAssertionId?: string;
  handledMessage?: string;
}

export interface NegativeContractResult {
  matched: boolean;
  outcome: NegativeContractMatchOutcome;
  expected: ExpectedFailureContract;
  observed: NegativeContractObservation;
  // Human-readable diagnostic; suitable for evidence logs and CI output.
  message: string;
}

// Internal id reserved for the runtime side-effect pending/probe step
// declared in assertions/registry.ts. The matcher excludes failures of
// that step from "observed failure" detection so the contract evaluation
// is not confused by its own enforcement scaffolding.
//
// As of the state-validation phase landing, forbidden side effects are
// observed by the typed gateway-absent / sandbox-absent probes during
// the state-validation phase, not by this pending step. The exclusion
// is kept to stay correct for any scenario that still references the
// legacy step id.
const SIDE_EFFECT_PROBE_STEP_ID = "runtime.expected-failure.no-side-effects";

// State-validation probe ids the matcher must skip when scanning for
// observed failures. For a negative scenario, these probes are real
// post-failure checks (gateway-absent, sandbox-absent) — their pass/fail
// status does NOT determine which phase advertised the original failure
// mode, only whether forbidden side effects occurred.
const STATE_VALIDATION_FORBIDDEN_PROBE_IDS: ReadonlySet<string> = new Set([
  "state-validation.gateway-absent",
  "state-validation.sandbox-absent",
]);

// Map the user-facing expected failure phase to the internal phase
// orchestrator that owns it. Today preflight assertions live under
// onboarding (see assertions/registry.ts: onboarding.preflight.*).
function resolveExpectedPhase(phase: ExpectedFailurePhase): PhaseName {
  if (phase === "preflight") {
    return "onboarding";
  }
  return phase;
}

function isOwnPhaseResult(phase: PhaseResult["phase"]): phase is PhaseName {
  return (
    phase === "environment" ||
    phase === "onboarding" ||
    phase === "state-validation" ||
    phase === "runtime"
  );
}

function findFirstObservedFailure(results: readonly PhaseResult[]): NegativeContractObservation | undefined {
  for (const result of results) {
    if (!isOwnPhaseResult(result.phase)) {
      continue;
    }
    // state-validation forbidden-side-effect probes (gateway-absent,
    // sandbox-absent) are post-failure verification, not the failure
    // mode itself; skip them when locating the originating failure.
    // A failed cli-installed probe IS a real observed failure (the
    // install action passed but the binary isn't reachable) and is
    // not skipped.
    const failedAction = result.actions.find(
      (action) =>
        action.status === "failed" && !STATE_VALIDATION_FORBIDDEN_PROBE_IDS.has(action.id),
    );
    if (failedAction) {
      return {
        failedPhase: result.phase,
        failedActionId: failedAction.id,
        failedActionMessage: failedAction.message,
      };
    }
    const failedAssertion = result.assertions.find(
      (assertion) =>
        assertion.status === "failed" &&
        assertion.id !== SIDE_EFFECT_PROBE_STEP_ID &&
        !STATE_VALIDATION_FORBIDDEN_PROBE_IDS.has(assertion.id),
    );
    if (failedAssertion) {
      return {
        failedPhase: result.phase,
        failedAssertionId: failedAssertion.id,
        failedAssertionMessage: failedAssertion.message,
      };
    }
  }
  return undefined;
}

function normalizeClass(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "-");
}

function errorClassVariants(errorClass: string): string[] {
  const normalized = normalizeClass(errorClass);
  switch (normalized) {
    case "docker-missing":
      return [normalized, "no-docker"];
    case "invalid-nvidia-api-key":
      return [normalized, "invalid-nvidia-key", "invalid-key"];
    case "gateway-port-conflict":
      return [normalized, "port-conflict"];
    default:
      return [normalized];
  }
}

function errorClassMatches(message: string | undefined, errorClass: string): boolean {
  if (!message) {
    return false;
  }
  // Substring-with-case-fold match. Negative scenarios assert their
  // failure mode by class name (e.g., "docker-missing",
  // "invalid-nvidia-api-key"); we match either the literal class
  // string or a normalized form where dashes/underscores/spaces are
  // interchangeable. This stays a pure string check so the matcher
  // can be fully tested in isolation.
  const normalizedMessage = normalizeClass(message);
  return errorClassVariants(errorClass).some((variant) => normalizedMessage.includes(variant));
}

function findHandledExpectedFailure(
  expected: ExpectedFailureContract,
  expectedPhase: PhaseName,
  results: readonly PhaseResult[],
): NegativeContractObservation | undefined {
  const phaseResult = results.find((result) => result.phase === expectedPhase);
  if (!phaseResult || phaseResult.status !== "passed") {
    return undefined;
  }

  const passedAssertion = phaseResult.assertions.find((assertion) => {
    if (assertion.status !== "passed") return false;
    const text = [assertion.id, assertion.message].filter(Boolean).join(" ");
    return (
      errorClassMatches(text, expected.errorClass) ||
      (expected.phase === "preflight" && assertion.id === "onboarding.preflight.expected-failed")
    );
  });
  if (passedAssertion) {
    return {
      failedPhase: expectedPhase,
      handledAssertionId: passedAssertion.id,
      handledMessage:
        passedAssertion.message ?? `expected failure assertion passed: ${expected.errorClass}`,
    };
  }

  const passedAction = phaseResult.actions.find((action) => {
    if (action.status !== "passed") return false;
    return errorClassMatches([action.id, action.message].filter(Boolean).join(" "), expected.errorClass);
  });
  if (passedAction) {
    return {
      failedPhase: expectedPhase,
      handledActionId: passedAction.id,
      handledMessage: passedAction.message ?? passedAction.id,
    };
  }
  return undefined;
}

function describeObservation(observation: NegativeContractObservation): string {
  const parts: string[] = [];
  if (observation.failedPhase) {
    parts.push(`phase=${observation.failedPhase}`);
  }
  if (observation.failedActionId) {
    parts.push(`action=${observation.failedActionId}`);
  }
  if (observation.failedAssertionId) {
    parts.push(`assertion=${observation.failedAssertionId}`);
  }
  if (observation.handledActionId) {
    parts.push(`handledAction=${observation.handledActionId}`);
  }
  if (observation.handledAssertionId) {
    parts.push(`handledAssertion=${observation.handledAssertionId}`);
  }
  const message = observation.failedActionMessage ?? observation.failedAssertionMessage ?? observation.handledMessage;
  if (message) {
    parts.push(`message="${message.slice(0, 240)}"`);
  }
  return parts.length > 0 ? parts.join(" ") : "no failure observed";
}

export function evaluateNegativeContract(plan: RunPlan, results: readonly PhaseResult[]): NegativeContractResult {
  const expected = plan.expectedFailure;
  if (!expected) {
    throw new Error(
      `evaluateNegativeContract called for scenario ${plan.scenarioId} which has no expectedFailure declared`,
    );
  }
  const expectedPhase = resolveExpectedPhase(expected.phase);
  const observation = findFirstObservedFailure(results) ?? findHandledExpectedFailure(expected, expectedPhase, results);

  if (!observation) {
    return {
      matched: false,
      outcome: "no-failure-observed",
      expected,
      observed: {},
      message: `scenario ${plan.scenarioId} expected to fail in ${expected.phase} (errorClass=${expected.errorClass}), but all phases passed`,
    };
  }

  if (observation.failedPhase !== expectedPhase) {
    return {
      matched: false,
      outcome: "wrong-phase",
      expected,
      observed: observation,
      message: `scenario ${plan.scenarioId} expected ${expected.phase} failure (errorClass=${expected.errorClass}); observed ${describeObservation(observation)}`,
    };
  }

  const observedMessage =
    observation.failedActionMessage ??
    observation.failedAssertionMessage ??
    observation.handledMessage ??
    observation.handledActionId ??
    observation.handledAssertionId;
  if (!errorClassMatches(observedMessage, expected.errorClass)) {
    return {
      matched: false,
      outcome: "wrong-error-class",
      expected,
      observed: observation,
      message: `scenario ${plan.scenarioId} ${expected.phase} failure errorClass mismatch: expected="${expected.errorClass}" observed=${describeObservation(observation)}`,
    };
  }

  return {
    matched: true,
    outcome: "matched",
    expected,
    observed: observation,
    message: `scenario ${plan.scenarioId} negative contract matched: ${expected.phase}/${expected.errorClass} (${describeObservation(observation)})`,
  };
}

// Convenience: build a synthetic PhaseResult for the runner to append
// to the per-phase results. Keeps run.ts and artifact writers honest
// (one shape, written through the same path as real phase results).
export function negativeContractPhaseResult(result: NegativeContractResult): PhaseResult {
  return {
    phase: "negative-contract",
    status: result.matched ? "passed" : "failed",
    actions: [],
    assertions: [
      {
        id: "negative-contract.match",
        status: result.matched ? "passed" : "failed",
        attempts: 1,
        durationMs: 0,
        message: result.message,
      },
    ],
  };
}
