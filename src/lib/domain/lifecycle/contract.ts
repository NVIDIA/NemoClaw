// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HERMES_LIFECYCLE_DEFINITION } from "./hermes-definition";

export const NEMOCLAW_LIFECYCLE_API_VERSION = "v1alpha1" as const;

export type LifecycleDigest = `sha256:${string}`;

export type HermesLifecycleTarget = Readonly<{
  gatewayIdentity: LifecycleDigest;
  workspace: string;
  openshellVersion: typeof HERMES_LIFECYCLE_DEFINITION.openshellVersion;
}>;

export type HermesLifecycleSandbox = Readonly<{
  name: string;
  resourceIdentity: LifecycleDigest;
  imageDigest: LifecycleDigest;
  configurationFingerprint: LifecycleDigest;
}>;

export type HermesLifecyclePlanRequest = Readonly<{
  apiVersion: typeof NEMOCLAW_LIFECYCLE_API_VERSION;
  target: HermesLifecycleTarget;
  sandbox: HermesLifecycleSandbox;
}>;

export type HermesLifecycleCheck =
  | "target"
  | "resource-identity"
  | "image"
  | "agent"
  | "configuration"
  | "sandbox-readiness"
  | "agent-readiness";

export type HermesLifecyclePlan = Readonly<{
  apiVersion: typeof NEMOCLAW_LIFECYCLE_API_VERSION;
  operation: "observe";
  agent: Readonly<{
    name: typeof HERMES_LIFECYCLE_DEFINITION.agent;
    version: typeof HERMES_LIFECYCLE_DEFINITION.agentVersion;
  }>;
  target: HermesLifecycleTarget;
  sandbox: HermesLifecycleSandbox;
  checks: readonly HermesLifecycleCheck[];
}>;

export type HermesLifecycleObserveRequest = Readonly<{
  plan: HermesLifecyclePlanRequest;
  timeoutMs?: number;
}>;

export type HermesLifecycleReadiness = "ready" | "not_ready" | "terminal";

export type HermesLifecycleSandboxPhase =
  | "CrashLoopBackOff"
  | "Creating"
  | "Deleting"
  | "Error"
  | "Evicted"
  | "Failed"
  | "ImagePullBackOff"
  | "NotReady"
  | "Pending"
  | "Provisioning"
  | "Ready"
  | "Running"
  | "Terminating"
  | "Unknown"
  | null;

export type HermesLifecycleObservation =
  | Readonly<{
      apiVersion: typeof NEMOCLAW_LIFECYCLE_API_VERSION;
      state: "missing";
      target: HermesLifecycleTarget;
      sandbox: Readonly<{
        name: HermesLifecycleSandbox["name"];
        resourceIdentity: HermesLifecycleSandbox["resourceIdentity"];
      }>;
      readiness: "not_ready";
    }>
  | Readonly<{
      apiVersion: typeof NEMOCLAW_LIFECYCLE_API_VERSION;
      state: "present";
      agent: Readonly<{
        name: typeof HERMES_LIFECYCLE_DEFINITION.agent;
        version: typeof HERMES_LIFECYCLE_DEFINITION.agentVersion;
        readiness: Exclude<HermesLifecycleReadiness, "terminal">;
      }>;
      target: HermesLifecycleTarget;
      sandbox: HermesLifecycleSandbox &
        Readonly<{
          phase: HermesLifecycleSandboxPhase;
          readiness: HermesLifecycleReadiness;
        }>;
      readiness: HermesLifecycleReadiness;
    }>;

export type LifecycleRequestField =
  | "request"
  | "apiVersion"
  | "target"
  | "target.gatewayIdentity"
  | "target.workspace"
  | "target.openshellVersion"
  | "sandbox"
  | "sandbox.name"
  | "sandbox.resourceIdentity"
  | "sandbox.imageDigest"
  | "sandbox.configurationFingerprint"
  | "timeoutMs"
  | "capability";

export type LifecycleVerificationField =
  | "target.gatewayIdentity"
  | "target.workspace"
  | "target.openshellVersion"
  | "sandbox.name"
  | "sandbox.resourceIdentity"
  | "sandbox.imageDigest"
  | "agent.name"
  | "agent.version"
  | "agent.configurationFingerprint";

export type LifecycleCapabilityFailureReason =
  | "authentication"
  | "command"
  | "exception"
  | "schema"
  | "timeout"
  | "transport";

export type LifecycleError =
  | Readonly<{
      code: "invalid-request";
      field: LifecycleRequestField;
      message: string;
    }>
  | Readonly<{
      code: "capability-failure";
      reason: LifecycleCapabilityFailureReason;
      message: string;
    }>
  | Readonly<{
      code: "verification-failed";
      field: LifecycleVerificationField;
      message: string;
    }>;

export type LifecycleResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: LifecycleError }>;
