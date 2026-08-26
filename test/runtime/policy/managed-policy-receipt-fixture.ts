// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const POLICY_HASH = "policy-alpha";
export const POLICY_VERSION = 7;
export const LIFECYCLE_GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SANDBOX_ID = "sandbox-id";
export const SANDBOX_IDENTITY = createHash("sha256").update(SANDBOX_ID).digest("hex");

export function managedSandboxEntry(name: string, agent = "openclaw") {
  return {
    name,
    agent,
    policies: [],
    openshellDriver: "docker",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    lifecycleLiveIdentityFingerprint: SANDBOX_IDENTITY,
    policyAuthority: "nemoclaw-managed" as const,
    policyCreationReceipt: {
      schemaVersion: 1 as const,
      origin: "sandbox-create" as const,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sandboxName: name,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      sandboxIdentityFingerprint: SANDBOX_IDENTITY,
      policyHash: POLICY_HASH,
      policyVersion: POLICY_VERSION,
    },
  };
}

export function managedRegistrationSource(name: string, agent = "openclaw"): string {
  return `registry.registerSandbox(${JSON.stringify(managedSandboxEntry(name, agent))});`;
}

export function managedPolicyMetadata(sandboxName: string): string {
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
