// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import {
  assertPolicyRequirementContainment,
  parseOpenShellPolicy,
  type OpenShellPolicyInspection,
} from "../../adapters/openshell/policy-boundary";
import {
  fingerprintOpenShellSandboxId,
  parseStrictOpenShellSandboxListJson,
} from "../../adapters/openshell/sandbox-identity";
import { validSafeEvidence } from "../../state/onboard-session/retained-sandbox-recovery";
import type { ExternalComponentActivationProof } from "./activation";

export class ExternalComponentProofError extends Error {
  constructor() {
    super("External component activation proof is unavailable. Reason class: evidence_mismatch.");
    this.name = "ExternalComponentProofError";
  }
}

interface PolicyContext {
  readonly basePolicyDocument: string;
  readonly gatewayName: string;
  readonly inspection: OpenShellPolicyInspection;
}

interface ExternalComponentProofDeps {
  getSandbox(name: string): {
    readonly name: string;
    readonly gatewayName?: string | null;
    readonly gatewayPort?: number | null;
    readonly lifecycleGeneration?: string;
    readonly lifecycleLiveIdentityFingerprint?: string;
  } | null;
  inspectPolicy(
    name: string,
    operation: string,
    gatewayName: string,
  ): PolicyContext | Promise<PolicyContext>;
  listSandboxes(gatewayName: string): string;
}

interface ProofSnapshot {
  readonly gatewayName: string;
  readonly lifecycleGeneration: string;
  readonly policyActiveVersion: number;
  readonly policyHash: string;
  readonly policySource: "sandbox";
  readonly sandboxId: string;
  readonly sandboxIdentityFingerprint: string;
}

async function captureProofSnapshotUnchecked(
  sandboxName: string,
  expectedGatewayName: string,
  deps: ExternalComponentProofDeps,
): Promise<ProofSnapshot> {
  const entry = deps.getSandbox(sandboxName);
  if (
    !entry ||
    entry.name !== sandboxName ||
    entry.gatewayName !== expectedGatewayName ||
    typeof entry.gatewayPort !== "number" ||
    !Number.isSafeInteger(entry.gatewayPort) ||
    !validSafeEvidence(entry.lifecycleGeneration) ||
    typeof entry.lifecycleLiveIdentityFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(entry.lifecycleLiveIdentityFingerprint)
  ) {
    throw new ExternalComponentProofError();
  }
  const rows = parseStrictOpenShellSandboxListJson(deps.listSandboxes(expectedGatewayName));
  const matches = rows?.filter((row) => row.name === sandboxName) ?? [];
  if (matches.length !== 1) throw new ExternalComponentProofError();
  const row = matches[0]!;
  const fingerprint = fingerprintOpenShellSandboxId(row.id);
  if (fingerprint !== entry.lifecycleLiveIdentityFingerprint) {
    throw new ExternalComponentProofError();
  }
  const policy = await deps.inspectPolicy(
    sandboxName,
    "verify external component activation policy",
    expectedGatewayName,
  );
  const policyDigest = policy.inspection.policyIdentity.hash.replace(/^sha256:/u, "");
  if (
    policy.gatewayName !== expectedGatewayName ||
    policy.inspection.policySource !== "sandbox" ||
    row.current_policy_version !== policy.inspection.policyIdentity.activeVersion ||
    !/^[0-9a-f]{64}$/u.test(policyDigest)
  ) {
    throw new ExternalComponentProofError();
  }
  try {
    assertPolicyRequirementContainment(
      policy.inspection,
      parseOpenShellPolicy(policy.basePolicyDocument).policy,
    );
  } catch {
    throw new ExternalComponentProofError();
  }
  return {
    gatewayName: expectedGatewayName,
    lifecycleGeneration: entry.lifecycleGeneration,
    policyActiveVersion: policy.inspection.policyIdentity.activeVersion,
    policyHash: `sha256:${policyDigest}`,
    policySource: policy.inspection.policySource,
    sandboxId: row.id,
    sandboxIdentityFingerprint: `sha256:${fingerprint}`,
  };
}

async function captureProofSnapshot(
  sandboxName: string,
  expectedGatewayName: string,
  deps: ExternalComponentProofDeps,
): Promise<ProofSnapshot> {
  try {
    return await captureProofSnapshotUnchecked(sandboxName, expectedGatewayName, deps);
  } catch {
    throw new ExternalComponentProofError();
  }
}

export async function createExternalComponentActivationProof(
  sandboxName: string,
  gatewayName: string,
  deps: ExternalComponentProofDeps,
): Promise<ExternalComponentActivationProof> {
  const initial = await captureProofSnapshot(sandboxName, gatewayName, deps);
  return {
    ...initial,
    revalidate: async () => {
      if (!isDeepStrictEqual(await captureProofSnapshot(sandboxName, gatewayName, deps), initial)) {
        throw new ExternalComponentProofError();
      }
    },
  };
}
