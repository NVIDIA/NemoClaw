// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellHermesAgentHealthEvidence,
  OpenShellHermesAgentObservation,
  OpenShellHermesAgentObserver,
} from "../../adapters/openshell/hermes-agent-observer";
import {
  NEMOCLAW_LIFECYCLE_API_VERSION,
  type HermesLifecycleObservation,
  type HermesLifecycleObserveRequest,
  type HermesLifecycleReadiness,
  type HermesLifecycleSandboxPhase,
  type LifecycleCapabilityFailureReason,
  type LifecycleRequestField,
  type LifecycleResult,
  type LifecycleVerificationField,
} from "../../domain/lifecycle/contract";
import { HERMES_LIFECYCLE_DEFINITION } from "../../domain/lifecycle/hermes-definition";
import { planHermesLifecycle } from "../../domain/lifecycle/hermes-plan";

type UnknownRecord = Record<string, unknown>;

const OBSERVE_REQUEST_KEYS = new Set(["plan", "timeoutMs"]);
const CAPABILITY_FAILURE_REASONS = new Set<LifecycleCapabilityFailureReason>([
  "authentication",
  "command",
  "schema",
  "timeout",
  "transport",
]);
const READY_PHASES = new Set<HermesLifecycleSandboxPhase>(["Ready", "Running"]);
const TERMINAL_PHASES = new Set<HermesLifecycleSandboxPhase>([
  "CrashLoopBackOff",
  "Error",
  "Evicted",
  "Failed",
  "ImagePullBackOff",
  "Unknown",
]);
const KNOWN_PHASES = new Set<HermesLifecycleSandboxPhase>([
  ...READY_PHASES,
  ...TERMINAL_PHASES,
  "Creating",
  "Deleting",
  "NotReady",
  "Pending",
  "Provisioning",
  "Terminating",
  null,
]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(field: LifecycleRequestField): LifecycleResult<never> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "invalid-request",
      field,
      message: `Invalid lifecycle request field: ${field}.`,
    }),
  });
}

function capabilityFailure(reason: LifecycleCapabilityFailureReason): LifecycleResult<never> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "capability-failure",
      reason,
      message: `OpenShell agent observation failed: ${reason}.`,
    }),
  });
}

function verificationFailure(field: LifecycleVerificationField): LifecycleResult<never> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "verification-failed",
      field,
      message: `Hermes lifecycle verification failed: ${field}.`,
    }),
  });
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isCapabilityFailureReason(value: unknown): value is LifecycleCapabilityFailureReason {
  return (
    typeof value === "string" &&
    CAPABILITY_FAILURE_REASONS.has(value as LifecycleCapabilityFailureReason)
  );
}

function isSandboxPhase(value: unknown): value is HermesLifecycleSandboxPhase {
  return KNOWN_PHASES.has(value as HermesLifecycleSandboxPhase);
}

function normalizeObservation(value: unknown): OpenShellHermesAgentObservation | null {
  if (!isRecord(value)) return null;
  const state = value.state;
  if (state === "missing") return Object.freeze({ state });
  if (state !== "present") return null;

  const observedTarget = value.target;
  const observedSandbox = value.sandbox;
  const observedAgent = value.agent;
  if (!isRecord(observedTarget) || !isRecord(observedSandbox) || !isRecord(observedAgent)) {
    return null;
  }
  const gatewayIdentity = observedTarget.gatewayIdentity;
  const workspace = observedTarget.workspace;
  const openshellVersion = observedTarget.openshellVersion;
  const sandboxName = observedSandbox.name;
  const resourceIdentity = observedSandbox.resourceIdentity;
  const imageDigest = observedSandbox.imageDigest;
  const phase = observedSandbox.phase;
  const agentName = observedAgent.name;
  const agentVersion = observedAgent.version;
  const configurationFingerprint = observedAgent.configurationFingerprint;
  const health = observedAgent.health;
  if (
    !isDigest(gatewayIdentity) ||
    typeof workspace !== "string" ||
    typeof openshellVersion !== "string" ||
    typeof sandboxName !== "string" ||
    !isDigest(resourceIdentity) ||
    !isDigest(imageDigest) ||
    !isSandboxPhase(phase) ||
    typeof agentName !== "string" ||
    typeof agentVersion !== "string" ||
    !isDigest(configurationFingerprint) ||
    !isRecord(health)
  ) {
    return null;
  }
  const healthState = health.state;
  let healthEvidence: OpenShellHermesAgentHealthEvidence | null = null;
  if (healthState === "unreachable") {
    healthEvidence = Object.freeze({ state: healthState });
  } else if (healthState === "reachable") {
    const statusCode = health.statusCode;
    if (
      typeof statusCode === "number" &&
      Number.isInteger(statusCode) &&
      statusCode >= 100 &&
      statusCode <= 599
    ) {
      healthEvidence = Object.freeze({ state: healthState, statusCode });
    }
  }
  if (healthEvidence === null) return null;

  return Object.freeze({
    state,
    target: Object.freeze({ gatewayIdentity, workspace, openshellVersion }),
    sandbox: Object.freeze({ name: sandboxName, resourceIdentity, imageDigest, phase }),
    agent: Object.freeze({
      name: agentName,
      version: agentVersion,
      configurationFingerprint,
      health: healthEvidence,
    }),
  });
}

function sandboxReadinessForPhase(phase: HermesLifecycleSandboxPhase): HermesLifecycleReadiness {
  if (READY_PHASES.has(phase)) return "ready";
  if (TERMINAL_PHASES.has(phase)) return "terminal";
  return "not_ready";
}

function verifyObservation(
  expected: ReturnType<typeof planHermesLifecycle> & { ok: true },
  observed: OpenShellHermesAgentObservation,
): LifecycleResult<HermesLifecycleObservation> {
  const plan = expected.value;
  if (observed.state === "missing") {
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        apiVersion: NEMOCLAW_LIFECYCLE_API_VERSION,
        state: "missing",
        target: plan.target,
        sandbox: Object.freeze({
          name: plan.sandbox.name,
          resourceIdentity: plan.sandbox.resourceIdentity,
        }),
        readiness: "not_ready",
      }),
    });
  }
  const comparisons: readonly [LifecycleVerificationField, string, string][] = [
    ["target.gatewayIdentity", observed.target.gatewayIdentity, plan.target.gatewayIdentity],
    ["target.workspace", observed.target.workspace, plan.target.workspace],
    ["target.openshellVersion", observed.target.openshellVersion, plan.target.openshellVersion],
    ["sandbox.name", observed.sandbox.name, plan.sandbox.name],
    ["sandbox.resourceIdentity", observed.sandbox.resourceIdentity, plan.sandbox.resourceIdentity],
    ["sandbox.imageDigest", observed.sandbox.imageDigest, plan.sandbox.imageDigest],
    ["agent.name", observed.agent.name, plan.agent.name],
    ["agent.version", observed.agent.version, plan.agent.version],
    [
      "agent.configurationFingerprint",
      observed.agent.configurationFingerprint,
      plan.sandbox.configurationFingerprint,
    ],
  ];
  for (const [field, actual, wanted] of comparisons) {
    if (actual !== wanted) return verificationFailure(field);
  }

  const sandboxReadiness = sandboxReadinessForPhase(observed.sandbox.phase);
  const agentReadiness =
    observed.agent.health.state === "reachable" && observed.agent.health.statusCode === 200
      ? "ready"
      : "not_ready";
  const readiness =
    sandboxReadiness === "terminal"
      ? "terminal"
      : sandboxReadiness === "ready" && agentReadiness === "ready"
        ? "ready"
        : "not_ready";
  const value = Object.freeze({
    apiVersion: NEMOCLAW_LIFECYCLE_API_VERSION,
    state: "present" as const,
    agent: Object.freeze({
      name: HERMES_LIFECYCLE_DEFINITION.agent,
      version: HERMES_LIFECYCLE_DEFINITION.agentVersion,
      readiness: agentReadiness,
    }),
    target: plan.target,
    sandbox: Object.freeze({
      ...plan.sandbox,
      phase: observed.sandbox.phase,
      readiness: sandboxReadiness,
    }),
    readiness,
  });
  return Object.freeze({ ok: true, value });
}

/** Observe one recorded Hermes resource without retries or lifecycle effects. */
export async function observeHermesLifecycle(
  request: HermesLifecycleObserveRequest,
  capability: OpenShellHermesAgentObserver,
): Promise<LifecycleResult<HermesLifecycleObservation>> {
  let planned: Extract<ReturnType<typeof planHermesLifecycle>, { ok: true }>;
  let timeoutMs: number | undefined;
  try {
    if (!isRecord(request) || !Object.keys(request).every((key) => OBSERVE_REQUEST_KEYS.has(key))) {
      return invalid("request");
    }
    const candidate = planHermesLifecycle(request.plan);
    if (!candidate.ok) return candidate;
    timeoutMs = request.timeoutMs;
    if (
      timeoutMs !== undefined &&
      (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    ) {
      return invalid("timeoutMs");
    }
    planned = candidate;
  } catch {
    return invalid("request");
  }
  if ((typeof capability !== "object" || capability === null) && typeof capability !== "function") {
    return invalid("capability");
  }

  try {
    const observeHermesAgent = capability.observeHermesAgent;
    if (typeof observeHermesAgent !== "function") return invalid("capability");
    const response: unknown = await observeHermesAgent.call(
      capability,
      Object.freeze({
        target: planned.value.target,
        sandboxName: planned.value.sandbox.name,
        resourceIdentity: planned.value.sandbox.resourceIdentity,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
    );
    if (!isRecord(response)) {
      return capabilityFailure("schema");
    }
    const responseOk = response.ok;
    if (typeof responseOk !== "boolean") return capabilityFailure("schema");
    if (!responseOk) {
      const responseError = response.error;
      if (!isRecord(responseError)) return capabilityFailure("schema");
      const failureReason = responseError.kind;
      if (!isCapabilityFailureReason(failureReason)) {
        return capabilityFailure("schema");
      }
      return capabilityFailure(failureReason);
    }
    const responseValue = response.value;
    const observation = normalizeObservation(responseValue);
    if (observation === null) return capabilityFailure("schema");
    return verifyObservation(planned, observation);
  } catch {
    return capabilityFailure("exception");
  }
}
