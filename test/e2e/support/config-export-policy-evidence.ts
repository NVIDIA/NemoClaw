// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellSandboxPolicyRead } from "../../../src/lib/adapters/openshell/sandbox-policy.ts";
import type { OpenShellSandboxResult } from "../../../src/lib/adapters/openshell/sandbox-observer.ts";

const REVISION_PATTERN = /^[0-9a-f]{40,64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface NetworkPolicyConfigExportLiveEvidence {
  readonly sandboxName: string;
  readonly managedImagePlaceholderIsNull: boolean;
  readonly effectivePolicyMatches: boolean;
  readonly identityDriftPreventedPublication: boolean;
  readonly producer: {
    readonly sourceRevision: string;
  };
  readonly yaml: {
    readonly artifact: string;
    readonly sha256: string;
  };
}

export function passesNetworkPolicyConfigExportLiveEvidence(
  evidence: NetworkPolicyConfigExportLiveEvidence,
): boolean {
  return (
    evidence.sandboxName.length > 0 &&
    evidence.managedImagePlaceholderIsNull &&
    evidence.effectivePolicyMatches &&
    evidence.identityDriftPreventedPublication &&
    REVISION_PATTERN.test(evidence.producer.sourceRevision) &&
    evidence.yaml.artifact === "config-export-live.yaml" &&
    SHA256_PATTERN.test(evidence.yaml.sha256)
  );
}

export function requireEffectivePolicyDocument(
  result: OpenShellSandboxResult<OpenShellSandboxPolicyRead>,
): string {
  if (!result.ok) {
    throw new Error(`the effective sandbox policy could not be read: ${result.error.message}`);
  }
  return result.value.document;
}
