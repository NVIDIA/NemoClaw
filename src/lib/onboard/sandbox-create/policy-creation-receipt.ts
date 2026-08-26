// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import {
  captureSandboxBasePolicy,
  inspectSandboxPolicyAuthority,
  PolicyAuthorityRefusalError,
} from "../../adapters/openshell/policy-authority";
import type { NemoClawPolicyCreationReceipt } from "../../policy/merge";
import {
  openShellPolicyValuesEqual,
  parseNemoClawPolicyCreationReceipt,
  parseOpenShellPolicy,
} from "../../policy/merge";

export interface CreatedSandboxPolicyReceiptInput {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string;
  readonly lifecycleLiveIdentityFingerprint: string;
  readonly policySourcePath: string;
}

export interface CreatedSandboxPolicyReceiptDeps {
  readonly readFile?: typeof fs.readFileSync;
}

function refusal(reason: string): never {
  throw new PolicyAuthorityRefusalError(
    `Cannot record NemoClaw policy ownership: ${reason}. The sandbox remains owner-unknown and policy mutation is disabled.`,
  );
}

/**
 * Bind one successful create to its exact sandbox and effective policy.
 * Policy bytes are compared in memory and never enter the receipt or error.
 */
export function verifyCreatedSandboxPolicyCreationReceipt(
  input: CreatedSandboxPolicyReceiptInput,
  deps: CreatedSandboxPolicyReceiptDeps = {},
): NemoClawPolicyCreationReceipt {
  const readFile = deps.readFile ?? fs.readFileSync;
  let intendedPolicy: ReturnType<typeof parseOpenShellPolicy>["policy"];
  try {
    intendedPolicy = parseOpenShellPolicy(readFile(input.policySourcePath, "utf8")).policy;
  } catch {
    refusal("the intended base policy could not be read");
  }

  const before = inspectSandboxPolicyAuthority({
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
  });
  let liveBasePolicy: ReturnType<typeof parseOpenShellPolicy>["policy"];
  try {
    liveBasePolicy = parseOpenShellPolicy(
      captureSandboxBasePolicy(input.sandboxName, input.gatewayName),
    ).policy;
  } catch {
    refusal("the live base policy could not be compared");
  }
  const after = inspectSandboxPolicyAuthority({
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
  });
  if (before.authority !== "owner-unknown" || after.authority !== "owner-unknown") {
    refusal("OpenShell does not report the verified policy as sandbox-scoped");
  }
  if (
    before.policyIdentity.hash !== after.policyIdentity.hash ||
    before.policyIdentity.activeVersion !== after.policyIdentity.activeVersion
  ) {
    refusal("the effective policy identity changed during receipt verification");
  }
  if (!openShellPolicyValuesEqual(intendedPolicy, liveBasePolicy)) {
    refusal("the live base policy does not match the policy supplied by this create transaction");
  }
  try {
    return parseNemoClawPolicyCreationReceipt({
      schemaVersion: 1,
      origin: "sandbox-create",
      gatewayName: input.gatewayName,
      gatewayPort: input.gatewayPort,
      sandboxName: input.sandboxName,
      lifecycleGeneration: input.lifecycleGeneration,
      sandboxIdentityFingerprint: input.lifecycleLiveIdentityFingerprint,
      policyHash: after.policyIdentity.hash,
      policyVersion: after.policyIdentity.activeVersion,
    });
  } catch {
    refusal("the verified sandbox or policy identity is incomplete");
  }
}
