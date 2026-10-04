// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** A durable, agent-scoped sandbox setting that can participate in resume and recreate. */
export interface ManagedSandboxFeature<T> {
  readonly id: string;
  readonly defaultValue: T;
  readonly isValue: (value: unknown) => value is T;
  readonly isEnabled: (value: T) => boolean;
  readonly supportsAgent: (agent: string | null | undefined) => boolean;
  readonly equals?: (left: T, right: T) => boolean;
}

export type ManagedSandboxFeatureIssue =
  | "unsupported-request"
  | "recorded-state-on-unsupported-agent";

export type ManagedSandboxFeatureIntentSource =
  | "explicit"
  | "session-explicit"
  | "registry"
  | "session"
  | "default";

export interface ManagedSandboxFeatureResolution<T> {
  value: T;
  source: ManagedSandboxFeatureIntentSource;
  requestedExplicitly: boolean;
  issue: ManagedSandboxFeatureIssue | null;
}

export interface ManagedSandboxFeatureIntentInput<T> {
  agent: string | null | undefined;
  requested?: T | null;
  resume?: boolean;
  sessionValue?: T | null;
  sessionRequestedExplicitly?: boolean;
  registryValue?: T | null;
}

function featureValuesEqual<T>(feature: ManagedSandboxFeature<T>, left: T, right: T): boolean {
  return feature.equals ? feature.equals(left, right) : Object.is(left, right);
}

export function managedSandboxFeatureIssue<T>(
  feature: ManagedSandboxFeature<T>,
  input: Pick<
    ManagedSandboxFeatureIntentInput<T>,
    "agent" | "requested" | "sessionValue" | "registryValue"
  >,
): ManagedSandboxFeatureIssue | null {
  if (feature.supportsAgent(input.agent)) return null;
  if (feature.isValue(input.requested) && feature.isEnabled(input.requested)) {
    return "unsupported-request";
  }
  if (feature.isValue(input.requested)) return null;
  const recordedEnabled = [input.sessionValue, input.registryValue].some(
    (value) => feature.isValue(value) && feature.isEnabled(value),
  );
  return recordedEnabled ? "recorded-state-on-unsupported-agent" : null;
}

/** Resolve explicit intent before durable registry/session state, preserving its provenance. */
export function resolveManagedSandboxFeature<T>(
  feature: ManagedSandboxFeature<T>,
  input: ManagedSandboxFeatureIntentInput<T>,
): ManagedSandboxFeatureResolution<T> {
  const issue = managedSandboxFeatureIssue(feature, input);
  const requestedExplicitly = feature.isValue(input.requested);
  if (!feature.supportsAgent(input.agent)) {
    return {
      value: feature.defaultValue,
      source: "default",
      requestedExplicitly,
      issue,
    };
  }
  if (feature.isValue(input.requested)) {
    return { value: input.requested, source: "explicit", requestedExplicitly: true, issue };
  }
  if (
    input.resume === true &&
    input.sessionRequestedExplicitly === true &&
    feature.isValue(input.sessionValue)
  ) {
    return {
      value: input.sessionValue,
      source: "session-explicit",
      requestedExplicitly: false,
      issue,
    };
  }
  if (feature.isValue(input.registryValue)) {
    return {
      value: input.registryValue,
      source: "registry",
      requestedExplicitly: false,
      issue,
    };
  }
  if (feature.isValue(input.sessionValue)) {
    return {
      value: input.sessionValue,
      source: "session",
      requestedExplicitly: false,
      issue,
    };
  }
  return {
    value: feature.defaultValue,
    source: "default",
    requestedExplicitly: false,
    issue,
  };
}

export function managedSandboxFeatureNeedsSessionUpdate<T>(
  feature: ManagedSandboxFeature<T>,
  sessionValue: T | null | undefined,
  sessionRequestedExplicitly: boolean | null | undefined,
  resolution: ManagedSandboxFeatureResolution<T>,
): boolean {
  return (
    !feature.isValue(sessionValue) ||
    !featureValuesEqual(feature, sessionValue, resolution.value) ||
    (resolution.requestedExplicitly && sessionRequestedExplicitly !== true)
  );
}

export function managedSandboxFeatureHasDrift<T>(
  feature: ManagedSandboxFeature<T>,
  input: {
    liveExists: boolean;
    hasRegistryEntry: boolean;
    agent: string | null | undefined;
    recordedValue: T | null | undefined;
    desiredValue: T;
  },
): boolean {
  if (!input.liveExists || !input.hasRegistryEntry || !feature.supportsAgent(input.agent)) {
    return false;
  }
  // A legacy row without authoritative create-time state must be recreated so
  // either enabling or disabling can establish the requested durable value.
  if (!feature.isValue(input.recordedValue)) return true;
  return !featureValuesEqual(feature, input.recordedValue, input.desiredValue);
}
