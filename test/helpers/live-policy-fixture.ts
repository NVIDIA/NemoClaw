// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const POLICY_HASH = "policy-alpha";
export const POLICY_VERSION = 7;
export const LIFECYCLE_GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SANDBOX_ID = "sandbox-id";
export const SANDBOX_IDENTITY = createHash("sha256").update(SANDBOX_ID).digest("hex");

interface ManagedSandboxEntryOptions {
  readonly gatewayName?: string;
  readonly gatewayPort?: number;
  readonly lifecycleGeneration?: string;
  readonly policyHash?: string;
  readonly policyVersion?: number;
}

export function managedSandboxEntry(
  name: string,
  agent = "openclaw",
  options: ManagedSandboxEntryOptions = {},
) {
  const gatewayName = options.gatewayName ?? "nemoclaw";
  const gatewayPort = options.gatewayPort ?? 8080;
  const lifecycleGeneration = options.lifecycleGeneration ?? LIFECYCLE_GENERATION;
  return {
    name,
    agent,
    openshellDriver: "docker",
    gatewayName,
    gatewayPort,
    lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: SANDBOX_IDENTITY,
  };
}

export function livePolicyInspection() {
  return {
    policySource: "sandbox" as const,
    effectivePolicy: {},
    policyIdentity: {
      hash: POLICY_HASH,
      activeVersion: POLICY_VERSION,
    },
  };
}

export function managedRegistrationSource(name: string, agent = "openclaw"): string {
  return `registry.registerSandbox(${JSON.stringify(managedSandboxEntry(name, agent))});`;
}

export function livePolicyMetadata(sandboxName: string): string {
  return JSON.stringify({
    scope: "sandbox",
    sandbox: sandboxName,
    status: "effective",
    policy_source: "sandbox",
    hash: POLICY_HASH,
    active_version: POLICY_VERSION,
    policy: { version: 1, network_policies: {} },
  });
}

export function parseResultPayload(stdout: string): any {
  const marker = "__RESULT__";
  const markerIndex = stdout.indexOf(marker);
  if (markerIndex < 0) throw new Error("Expected the result marker");
  return JSON.parse(stdout.slice(markerIndex + marker.length));
}
