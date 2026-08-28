// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export const MCP_POLICY_BASE = "version: 1\nnetwork_policies:\n  baseline: {}\n";

export const MCP_POLICY_RECEIPT_AUTHORITY = {
  authority: "nemoclaw-managed" as const,
  authorityRecordedNow: false,
  gatewayName: "nemoclaw",
  inspection: {
    authority: "nemoclaw-managed" as const,
    effectivePolicy: {},
    policyIdentity: { hash: "receipt-bound-policy", activeVersion: 1 },
  },
  policyCreationReceipt: { policyHash: "receipt-bound-policy", policyVersion: 1 },
};

export function readMcpSandboxRegistry(home: string): {
  sandboxes: Record<
    string,
    { mcp?: { bridges: Record<string, unknown> }; customPolicies?: unknown[] }
  >;
} {
  return JSON.parse(fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8")) as {
    sandboxes: Record<
      string,
      { mcp?: { bridges: Record<string, unknown> }; customPolicies?: unknown[] }
    >;
  };
}

export function buildManagedMcpPolicyReceiptFixture(): string {
  return String.raw`
const policyAuthority = require("./src/lib/adapters/openshell/policy-authority.js");
const policies = require("./src/lib/policy/index.js");
const receiptAuthority = ${JSON.stringify(MCP_POLICY_RECEIPT_AUTHORITY)};
policyAuthority.captureSandboxBasePolicy = () => ${JSON.stringify(MCP_POLICY_BASE)};
policies.inspectPolicyMutationAuthority = () => receiptAuthority;
policies.assertNemoClawManagedPolicy = () => {};
policies.recheckPolicyMutationAuthority = () => receiptAuthority;
`;
}

export function buildMcpAddPolicyReceiptFixture(): string {
  return String.raw`
const policyAuthority = require("./src/lib/adapters/openshell/policy-authority.js");
const policies = require("./src/lib/policy/index.js");
const receiptMutationScenario =
  crashAfter === "policy-receipt-after-attach" ||
  crashAfter === "policy-receipt-finalize-pre-cas-failure" ||
  crashAfter === "policy-receipt-changed-before-compensation" ||
  crashAfter === "policy-receipt-finalize-post-cas-failure" ||
  crashAfter === "policy-receipt-after-attach-kill" ||
  crashAfter === "final-add-verification-refusal";
const receiptAuthority = ${JSON.stringify(MCP_POLICY_RECEIPT_AUTHORITY)};
const rotatedReceiptAuthority = {
  ...receiptAuthority,
  inspection: {
    ...receiptAuthority.inspection,
    policyIdentity: { hash: "concurrent-policy", activeVersion: 2 },
  },
  policyCreationReceipt: { policyHash: "concurrent-policy", policyVersion: 2 },
};
const inspectReceiptCurrent = () => {
  if (crashAfter === "initial-policy-receipt-mismatch" || marked("policy-receipt-mismatch")) {
    if (crashAfter === "policy-receipt-changed-before-compensation") {
      return rotatedReceiptAuthority;
    }
    throw new Error("Refusing to mutate managed MCP state: the NemoClaw policy creation receipt does not match the live sandbox policy.");
  }
  if (
    crashAfter === "incomplete-add-transient-authority-failure" &&
    !marked("transient-authority-refusal")
  ) {
    mark("transient-authority-refusal");
    throw new Error("simulated transient policy inspection failure");
  }
  return receiptAuthority;
};
policyAuthority.captureSandboxBasePolicy = () => ${JSON.stringify(MCP_POLICY_BASE)};
policies.inspectPolicyMutationAuthority = inspectReceiptCurrent;
policies.inspectManagedPolicyCompensationBoundary = () => ({
  gatewayName: crashAfter === "policy-receipt-changed-before-compensation"
    ? rotatedReceiptAuthority.gatewayName
    : receiptAuthority.gatewayName,
  inspection: {
    ...(crashAfter === "policy-receipt-changed-before-compensation"
      ? rotatedReceiptAuthority.inspection
      : receiptAuthority.inspection),
    policyIdentity: marked("policy-receipt-mismatch")
      ? crashAfter === "policy-receipt-changed-before-compensation"
        ? rotatedReceiptAuthority.inspection.policyIdentity
        : { hash: "receipt-with-attachment", activeVersion: 2 }
      : receiptAuthority.inspection.policyIdentity,
  },
  policyCreationReceipt: crashAfter === "policy-receipt-changed-before-compensation"
    ? rotatedReceiptAuthority.policyCreationReceipt
    : receiptAuthority.policyCreationReceipt,
});
policies.assertNemoClawManagedPolicy = () => {};
policies.recheckPolicyMutationAuthority = (_sandboxName, operation) => {
  const authority = inspectReceiptCurrent();
  if (
    operation === "add MCP server 'fake'" &&
    marked("reject-final-add-verification")
  ) {
    throw new Error("simulated final add policy authority refusal");
  }
  return authority;
};
policies.finalizePolicyMutationReceipt = () => {
  if (marked("reject-attachment-finalize-pre-cas")) {
    fs.rmSync(marker("reject-attachment-finalize-pre-cas"), { force: true });
    throw new Error("simulated pre-CAS receipt finalization failure");
  }
  if (crashAfter === "policy-receipt-after-attach-kill") process.exit(88);
  fs.rmSync(marker("policy-receipt-mismatch"), { force: true });
  mark("policy-receipt-finalized");
  if (marked("reject-attachment-finalize-post-cas")) {
    fs.rmSync(marker("reject-attachment-finalize-post-cas"), { force: true });
    throw new policies.PolicyMutationReceiptFinalVerificationError(
      "simulated post-CAS receipt finalization failure",
    );
  }
};
if (crashAfter === "policy-receipt-finalize-pre-cas-failure") {
  mark("reject-attachment-finalize-pre-cas");
}
if (crashAfter === "policy-receipt-changed-before-compensation") {
  mark("reject-attachment-finalize-pre-cas");
}
if (crashAfter === "policy-receipt-finalize-post-cas-failure") {
  mark("reject-attachment-finalize-post-cas");
}
if (crashAfter === "final-add-verification-refusal") {
  mark("reject-final-add-verification");
}
`;
}

export function buildMcpRemovePolicyReceiptFixture(): string {
  return String.raw`${buildManagedMcpPolicyReceiptFixture()}
policies.finalizePolicyMutationReceipt = () => {};
`;
}
