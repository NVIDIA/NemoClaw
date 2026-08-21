// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { classifyPolicySetResult } from "../policy/policy-set-outcome";
import * as sandboxRegistry from "../policy/policy-registry";
import type { run } from "../runner";
import { redactShieldsDiagnostic } from "./audit";

const policyAuthority: typeof import("../adapters/openshell/policy-authority") = require("../adapters/openshell/policy-authority");

export const PolicyAuthorityRefusalError = policyAuthority.PolicyAuthorityRefusalError;
export const isPolicyAuthorityRefusalError = policyAuthority.isPolicyAuthorityRefusalError;

/** Reject a structured authoritative OpenShell policy-set refusal without exposing diagnostics. */
export function rejectFinalShieldsPolicySetResult(
  result: ReturnType<typeof run>,
  operation: string,
): void {
  const captured = result as ReturnType<typeof run> & {
    error?: Error;
    stderr?: string | Buffer | null;
  };
  const outcome = classifyPolicySetResult({
    status: typeof captured.status === "number" ? captured.status : null,
    ...(captured.error ? { error: captured.error } : {}),
    stderr: Buffer.isBuffer(captured.stderr)
      ? captured.stderr.toString("utf8")
      : (captured.stderr ?? null),
  });
  if (outcome.kind === "rejected") {
    throw new policyAuthority.PolicyAuthorityRefusalError(
      `Refusing to ${operation}: OpenShell rejected the policy change: ${redactShieldsDiagnostic(outcome.message)}`,
    );
  }
}

function readShieldsPolicyAuthorityEntry(
  sandboxName: string,
  operation: string,
): ReturnType<typeof sandboxRegistry.getSandbox> {
  try {
    return sandboxRegistry.getSandbox(sandboxName);
  } catch {
    throw new policyAuthority.PolicyAuthorityRefusalError(
      `Refusing to ${operation}: sandbox policy authority is unavailable.`,
    );
  }
}

/** Require the registry-bound live authority before a Shields-owned policy-adjacent mutation. */
export function assertShieldsPolicyMutationAuthority(sandboxName: string, operation: string): void {
  const entry = readShieldsPolicyAuthorityEntry(sandboxName, operation);
  if (!entry) {
    throw new policyAuthority.PolicyAuthorityRefusalError(
      `Refusing to ${operation}: sandbox policy authority is unavailable.`,
    );
  }
  const inspection = policyAuthority.inspectSandboxPolicyAuthority({
    sandboxName,
    gatewayName: entry.gatewayName ?? undefined,
  });
  if (entry.policyAuthority === undefined) {
    let updated: boolean;
    try {
      updated = sandboxRegistry.updateSandbox(sandboxName, {
        policyAuthority: inspection.authority,
      });
    } catch {
      throw new policyAuthority.PolicyAuthorityRefusalError(
        `Refusing to ${operation}: sandbox policy authority could not be recorded.`,
      );
    }
    if (!updated) {
      const current = readShieldsPolicyAuthorityEntry(sandboxName, operation);
      policyAuthority.assertRecordedPolicyAuthority(
        current?.policyAuthority,
        inspection.authority,
        operation,
      );
    }
  } else {
    policyAuthority.assertRecordedPolicyAuthority(
      entry.policyAuthority,
      inspection.authority,
      operation,
    );
  }
  if (inspection.authority === "externally-managed") {
    throw new policyAuthority.PolicyAuthorityRefusalError(
      `Refusing to ${operation}: OpenShell policy is externally managed.`,
    );
  }
}
