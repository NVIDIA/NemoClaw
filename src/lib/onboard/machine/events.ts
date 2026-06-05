// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, JsonValue } from "../../core/json-types";
import { redactSensitiveText, redactUrl } from "../../security/redact";
import type { HermesAuthMethod, Session } from "../../state/onboard-session";
import {
  ONBOARD_MACHINE_STATE_DEFINITIONS,
  type OnboardMachineStateWithStepDefinition,
} from "./definition";
import type {
  OnboardMachineContext,
  OnboardMachineEventType,
  OnboardMachineState,
} from "./types";

type OnboardSessionStepDefinition = OnboardMachineStateWithStepDefinition;

export type OnboardSessionStepName = OnboardSessionStepDefinition["stepName"];

type OnboardSessionStepToMachineState = {
  readonly [StepName in OnboardSessionStepName]: Extract<
    OnboardSessionStepDefinition,
    { stepName: StepName }
  >["state"];
};

export const ONBOARD_SESSION_STEP_TO_MACHINE_STATE = Object.fromEntries(
  ONBOARD_MACHINE_STATE_DEFINITIONS.flatMap((definition) =>
    "stepName" in definition ? [[definition.stepName, definition.state]] : [],
  ),
) as OnboardSessionStepToMachineState;

export interface OnboardMachineEvent {
  version: 1;
  type: OnboardMachineEventType;
  occurredAt: string;
  sessionId: string | null;
  state: OnboardMachineState | null;
  step: OnboardSessionStepName | null;
  context: OnboardMachineContext;
  error: string | null;
  metadata: JsonObject;
}

export type OnboardMachineEventListener = (event: OnboardMachineEvent) => void;

const listeners = new Set<OnboardMachineEventListener>();

export function addOnboardMachineEventListener(
  listener: OnboardMachineEventListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearOnboardMachineEventListeners(): void {
  listeners.clear();
}

export function isOnboardSessionStepName(value: string): value is OnboardSessionStepName {
  return Object.prototype.hasOwnProperty.call(ONBOARD_SESSION_STEP_TO_MACHINE_STATE, value);
}

export function machineStateFromOnboardSessionStep(
  stepName: string | null | undefined,
): OnboardMachineState | null {
  if (!stepName || !isOnboardSessionStepName(stepName)) return null;
  return ONBOARD_SESSION_STEP_TO_MACHINE_STATE[stepName];
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function hermesAuthMethod(value: unknown): HermesAuthMethod | null {
  return value === "oauth" || value === "api_key" ? value : null;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function sanitizeJsonValue(value: unknown): JsonValue {
  if (typeof value === "string") return redactUrl(value) ?? redactSensitiveText(value) ?? "";
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeJsonValue(entry));
  if (typeof value !== "object") return String(value);

  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = sanitizeJsonValue(entry);
  }
  return result;
}

function endpointOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function sanitizeOnboardMachineEventMetadata(
  metadata: Record<string, unknown> | null | undefined,
): JsonObject {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const sanitized: JsonObject = {};
  for (const [key, value] of Object.entries(metadata)) {
    sanitized[key] = sanitizeJsonValue(value);
  }
  return sanitized;
}

export function buildOnboardMachineContext(session: Session): OnboardMachineContext {
  return {
    agent: nullableString(session.agent),
    sandboxName: nullableString(session.sandboxName),
    provider: nullableString(session.provider),
    model: nullableString(session.model),
    endpointOrigin: endpointOrigin(session.endpointUrl),
    credentialEnv: nullableString(session.credentialEnv),
    preferredInferenceApi: nullableString(session.preferredInferenceApi),
    hermesAuthMethod: hermesAuthMethod(session.hermesAuthMethod),
    hermesToolGateways: stringArray(session.hermesToolGateways),
    policyPresets: stringArray(session.policyPresets),
    messagingChannels: stringArray(session.messagingChannels),
    gpuPassthrough: booleanValue(session.gpuPassthrough),
  };
}

export function createOnboardMachineEvent({
  type,
  session,
  step,
  state,
  error = null,
  metadata = {},
}: {
  type: OnboardMachineEventType;
  session: Session;
  step?: string | null;
  state?: OnboardMachineState | null;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
}): OnboardMachineEvent {
  const normalizedStep = step && isOnboardSessionStepName(step) ? step : null;
  return {
    version: 1,
    type,
    occurredAt: new Date().toISOString(),
    sessionId: nullableString(session.sessionId),
    state: state ?? machineStateFromOnboardSessionStep(normalizedStep),
    step: normalizedStep,
    context: buildOnboardMachineContext(session),
    error: redactSensitiveText(error),
    metadata: sanitizeOnboardMachineEventMetadata(metadata),
  };
}

export function emitOnboardMachineEvent(event: OnboardMachineEvent): void {
  if (listeners.size === 0) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Event observers are diagnostics only. A broken observer must not
      // change onboarding behavior; hook failure events are introduced by the
      // later observe-only hook API.
    }
  }
}
