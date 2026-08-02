// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertExecutionFoundationId, type ExecutionCapability } from "./execution-profile.ts";

export type RuntimeAgent = "openclaw" | "hermes" | "dcode";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface FsmTransition {
  from: string;
  event: string;
  to: string;
}

export interface TerminalOutcome {
  status: "succeeded" | "failed";
  state: string;
  failureClass?: string;
}

export interface ScenarioJourneyStep {
  id: string;
  /** Stable semantic action. Never a provider command or shell fragment. */
  action: string;
}

export interface ScenarioAssertionContract {
  desiredState: JsonValue;
  fsmTrace: readonly FsmTransition[];
  terminalOutcome: TerminalOutcome;
  userVisibleState: JsonValue;
}

export interface ScenarioSupportObligation {
  id: string;
  description: string;
  requiredCapabilities: readonly ExecutionCapability[];
}

/**
 * Product intent shared by runtime providers. Provider-specific setup and
 * evidence adapters belong to RuntimeBindingSpec, never in the scenario.
 */
export interface RuntimeNeutralScenario {
  id: string;
  agent: RuntimeAgent;
  description: string;
  journey: readonly Readonly<ScenarioJourneyStep>[];
  requiredCapabilities: readonly ExecutionCapability[];
  assertions: Readonly<ScenarioAssertionContract>;
  supportObligations: readonly Readonly<ScenarioSupportObligation>[];
}

const AGENTS = new Set<RuntimeAgent>(["openclaw", "hermes", "dcode"]);

/** Locale-independent ordering for canonical evidence and registry identities. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeJsonValue(
  value: unknown,
  fieldPath = "$",
  ancestors = new Set<object>(),
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${fieldPath} must contain only finite JSON numbers`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== "object") {
    throw new Error(`${fieldPath} must be JSON-serializable`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${fieldPath} must not contain cyclic values`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        normalizeJsonValue(entry, `${fieldPath}[${index}]`, ancestors),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${fieldPath} must contain only plain JSON objects`);
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, entry]) => [key, normalizeJsonValue(entry, `${fieldPath}.${key}`, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

export function freezeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJsonValue)) as unknown as JsonValue;
  }
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, freezeJsonValue(entry)]),
      ),
    );
  }
  return value;
}

function normalizeLabel(value: string, fieldPath: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized) {
    throw new Error(`${fieldPath} must be a non-empty string`);
  }
  return normalized;
}

export function normalizeFsmTrace(
  transitions: readonly FsmTransition[],
): readonly Readonly<FsmTransition>[] {
  if (transitions.length === 0) {
    throw new Error("FSM trace must contain at least one transition");
  }
  const normalized = transitions.map((transition, index) =>
    Object.freeze({
      from: normalizeLabel(transition.from, `fsmTrace[${index}].from`),
      event: normalizeLabel(transition.event, `fsmTrace[${index}].event`),
      to: normalizeLabel(transition.to, `fsmTrace[${index}].to`),
    }),
  );
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]?.to !== normalized[index]?.from) {
      throw new Error(`FSM trace is discontinuous between transitions ${index - 1} and ${index}`);
    }
  }
  return Object.freeze(normalized);
}

export function normalizeTerminalOutcome(outcome: TerminalOutcome): Readonly<TerminalOutcome> {
  const state = normalizeLabel(outcome.state, "terminalOutcome.state");
  if (outcome.status === "succeeded") {
    if (outcome.failureClass !== undefined) {
      throw new Error("Successful terminal outcome must not declare failureClass");
    }
    return Object.freeze({ status: outcome.status, state });
  }
  if (outcome.status !== "failed") {
    throw new Error(`Terminal outcome status '${String(outcome.status)}' is not recognized`);
  }
  if (outcome.failureClass === undefined) {
    throw new Error("Failed terminal outcome must declare failureClass");
  }
  return Object.freeze({
    status: outcome.status,
    state,
    failureClass: normalizeLabel(outcome.failureClass, "terminalOutcome.failureClass"),
  });
}

export function assertTerminalMatchesTrace(
  trace: readonly Readonly<FsmTransition>[],
  outcome: Readonly<TerminalOutcome>,
  fieldPath = "terminalOutcome",
): void {
  const terminalState = trace.at(-1)?.to;
  if (terminalState !== outcome.state) {
    throw new Error(
      `${fieldPath}.state '${outcome.state}' does not match FSM terminal state '${terminalState ?? "<missing>"}'`,
    );
  }
}

function normalizeDescription(value: string, fieldPath: string): string {
  const description = value.trim();
  if (!description || /[\r\n]/u.test(description)) {
    throw new Error(`${fieldPath} must be a single-line description`);
  }
  return description;
}

function normalizeCapabilities(
  values: readonly ExecutionCapability[],
  fieldPath: string,
): readonly ExecutionCapability[] {
  if (values.length === 0) {
    throw new Error(`${fieldPath} must declare capabilities`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${fieldPath} repeats a capability`);
  }
  return Object.freeze([...values].sort());
}

function assertUniqueIds(
  values: readonly { id: string }[],
  scenarioId: string,
  label: string,
): void {
  const ids = new Set<string>();
  for (const value of values) {
    assertExecutionFoundationId(value.id, `${label} id`);
    if (ids.has(value.id)) {
      throw new Error(`Runtime scenario '${scenarioId}' declares duplicate ${label} '${value.id}'`);
    }
    ids.add(value.id);
  }
}

export function defineRuntimeScenario(input: RuntimeNeutralScenario): RuntimeNeutralScenario {
  assertExecutionFoundationId(input.id, "Runtime scenario id");
  if (!AGENTS.has(input.agent)) {
    throw new Error(`Runtime scenario '${input.id}' agent '${input.agent}' is not recognized`);
  }
  const description = normalizeDescription(input.description, `Runtime scenario '${input.id}'`);
  if (input.journey.length === 0) {
    throw new Error(`Runtime scenario '${input.id}' must declare a user journey`);
  }
  if (!input.assertions) {
    throw new Error(`Runtime scenario '${input.id}' must declare normalized assertions`);
  }
  if (input.supportObligations.length === 0) {
    throw new Error(`Runtime scenario '${input.id}' must declare support obligations`);
  }

  assertUniqueIds(input.journey, input.id, "journey step");
  const journey = input.journey.map((step) => {
    assertExecutionFoundationId(step.action, "Journey action");
    return Object.freeze({ id: step.id, action: step.action });
  });

  assertUniqueIds(input.supportObligations, input.id, "obligation");
  const supportObligations = input.supportObligations.map((obligation) =>
    Object.freeze({
      id: obligation.id,
      description: normalizeDescription(
        obligation.description,
        `Runtime scenario '${input.id}' obligation '${obligation.id}'`,
      ),
      requiredCapabilities: normalizeCapabilities(
        obligation.requiredCapabilities,
        `Runtime scenario '${input.id}' obligation '${obligation.id}'`,
      ),
    }),
  );
  const fsmTrace = normalizeFsmTrace(input.assertions.fsmTrace);
  const terminalOutcome = normalizeTerminalOutcome(input.assertions.terminalOutcome);
  assertTerminalMatchesTrace(fsmTrace, terminalOutcome, "assertions.terminalOutcome");

  return Object.freeze({
    id: input.id,
    agent: input.agent,
    description,
    journey: Object.freeze(journey),
    requiredCapabilities: normalizeCapabilities(
      input.requiredCapabilities,
      `Runtime scenario '${input.id}'`,
    ),
    assertions: Object.freeze({
      desiredState: freezeJsonValue(
        normalizeJsonValue(input.assertions.desiredState, "assertions.desiredState"),
      ),
      fsmTrace,
      terminalOutcome,
      userVisibleState: freezeJsonValue(
        normalizeJsonValue(input.assertions.userVisibleState, "assertions.userVisibleState"),
      ),
    }),
    supportObligations: Object.freeze(supportObligations),
  });
}
