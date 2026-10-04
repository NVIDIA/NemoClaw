// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Supported headless lifecycle API for the packaged Hermes definition.
 *
 * The consumer supplies an OpenShell observation capability. This module does
 * not construct a transport, acquire credentials, persist state, or mutate a
 * sandbox.
 */
export { observeHermesLifecycle } from "../lib/actions/lifecycle/observe-hermes";
export type {
  ObserveOpenShellHermesAgentRequest,
  OpenShellHermesAgentHealthEvidence,
  OpenShellHermesAgentObservation,
  OpenShellHermesAgentObservationError,
  OpenShellHermesAgentObservationResult,
  OpenShellHermesAgentObserver,
} from "../lib/adapters/openshell/hermes-agent-observer";
export {
  NEMOCLAW_LIFECYCLE_API_VERSION,
  type HermesLifecycleCheck,
  type HermesLifecycleObservation,
  type HermesLifecycleObserveRequest,
  type HermesLifecyclePlan,
  type HermesLifecyclePlanRequest,
  type HermesLifecycleReadiness,
  type HermesLifecycleSandbox,
  type HermesLifecycleSandboxPhase,
  type HermesLifecycleTarget,
  type LifecycleCapabilityFailureReason,
  type LifecycleDigest,
  type LifecycleError,
  type LifecycleRequestField,
  type LifecycleResult,
  type LifecycleVerificationField,
} from "../lib/domain/lifecycle/contract";
export { HERMES_LIFECYCLE_DEFINITION } from "../lib/domain/lifecycle/hermes-definition";
export { planHermesLifecycle } from "../lib/domain/lifecycle/hermes-plan";
