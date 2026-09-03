// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HermesLifecycleSandboxPhase,
  HermesLifecycleSandbox,
  HermesLifecycleTarget,
  LifecycleCapabilityFailureReason,
  LifecycleDigest,
} from "../../domain/lifecycle/contract";

export type OpenShellHermesAgentHealthEvidence =
  | Readonly<{ state: "reachable"; statusCode: number }>
  | Readonly<{ state: "unreachable" }>;

export type ObserveOpenShellHermesAgentRequest = Readonly<{
  target: HermesLifecycleTarget;
  sandboxName: HermesLifecycleSandbox["name"];
  resourceIdentity: LifecycleDigest;
  timeoutMs?: number;
}>;

export type OpenShellHermesAgentObservation =
  | Readonly<{ state: "missing" }>
  | Readonly<{
      state: "present";
      target: Readonly<{
        gatewayIdentity: LifecycleDigest;
        workspace: string;
        openshellVersion: string;
      }>;
      sandbox: Readonly<{
        name: string;
        resourceIdentity: LifecycleDigest;
        imageDigest: LifecycleDigest;
        phase: HermesLifecycleSandboxPhase;
      }>;
      agent: Readonly<{
        name: string;
        version: string;
        configurationFingerprint: LifecycleDigest;
        health: OpenShellHermesAgentHealthEvidence;
      }>;
    }>;

export type OpenShellHermesAgentObservationError = Readonly<{
  kind: Exclude<LifecycleCapabilityFailureReason, "exception">;
}>;

export type OpenShellHermesAgentObservationResult =
  | Readonly<{ ok: true; value: OpenShellHermesAgentObservation }>
  | Readonly<{ ok: false; error: OpenShellHermesAgentObservationError }>;

/**
 * Trusted transport boundary supplied by the consumer.
 *
 * The implementation must independently authenticate the requested target and
 * observe the live OpenShell version, resource identity, image digest, Hermes
 * version, configuration fingerprint, sandbox phase, and Hermes health
 * endpoint. It must not satisfy the result by echoing request values.
 */
export interface OpenShellHermesAgentObserver {
  observeHermesAgent(
    request: ObserveOpenShellHermesAgentRequest,
  ): Promise<OpenShellHermesAgentObservationResult>;
}
