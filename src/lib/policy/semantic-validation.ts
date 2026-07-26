// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isObjectRecord } from "../core/json-types";

export type SemanticFinding = {
  path: string;
  message: string;
  severity: "error" | "warning";
};

export type SemanticCheck = {
  name: string;
  description: string;
  run: (document: unknown) => readonly SemanticFinding[];
};

export type DangerousHostFinding = SemanticFinding & {
  host: string;
};

export const DANGEROUS_HOSTS: ReadonlySet<string> = new Set([
  "*",
  "0.0.0.0",
  "0.0.0.0/0",
  "::",
  "::/0",
]);

/** Run every supplied semantic check, preserving findings in check order. */
export function runSemanticChecks(
  document: unknown,
  checks: readonly SemanticCheck[],
): SemanticFinding[] {
  return checks.flatMap((check) => check.run(document));
}

export function splitSemanticFindings(findings: readonly SemanticFinding[]): {
  errors: SemanticFinding[];
  warnings: SemanticFinding[];
} {
  const errors: SemanticFinding[] = [];
  const warnings: SemanticFinding[] = [];
  for (const finding of findings) {
    if (finding.severity === "error") errors.push(finding);
    else warnings.push(finding);
  }
  return { errors, warnings };
}

/** Return true when a host grants egress to every destination. */
export function isDangerousHost(host: unknown): boolean {
  if (typeof host !== "string") return false;
  const trimmed = host.trim();
  const withoutPort = trimmed.replace(/:\d+$/, "");
  const normalized = withoutPort.match(/^\[(.*)\]$/u)?.[1] ?? withoutPort;
  return DANGEROUS_HOSTS.has(trimmed) || DANGEROUS_HOSTS.has(normalized);
}

/**
 * Reject catch-all hosts in policy endpoints while allowing scoped subdomain
 * wildcards such as `*.example.com`.
 */
export function findDangerousHosts(document: unknown): DangerousHostFinding[] {
  if (!isObjectRecord(document) || !isObjectRecord(document.network_policies)) return [];

  const findings: DangerousHostFinding[] = [];
  for (const [policyName, policy] of Object.entries(document.network_policies)) {
    if (!isObjectRecord(policy) || !Array.isArray(policy.endpoints)) continue;
    policy.endpoints.forEach((endpoint, index) => {
      if (!isObjectRecord(endpoint) || !isDangerousHost(endpoint.host)) return;
      const host = String(endpoint.host);
      findings.push({
        path: `/network_policies/${policyName}/endpoints/${index}/host`,
        host,
        severity: "error",
        message:
          `host "${host}" is not allowed — use a specific public hostname ` +
          `(subdomain wildcards like "*.example.com" are allowed for policy hosts)`,
      });
    });
  }
  return findings;
}

export const DANGEROUS_HOST_CHECK: SemanticCheck = {
  name: "dangerous-host",
  description: "Rejects network policy endpoints that allow egress to every destination.",
  run: findDangerousHosts,
};

export const POLICY_SEMANTIC_CHECKS: readonly SemanticCheck[] = [DANGEROUS_HOST_CHECK];

/** Validate policy-specific invariants after structural parsing. */
export function validatePolicySemantics(document: unknown): SemanticFinding[] {
  return runSemanticChecks(document, POLICY_SEMANTIC_CHECKS);
}
