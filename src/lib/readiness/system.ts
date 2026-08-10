// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  collectGatewayObservations,
  type GatewayReadinessDependencies,
  type GatewayReadinessProjection,
  projectGatewayReadiness,
} from "./gateway.js";
import {
  type CollectHostObservationsOptions,
  type CreateHostReadinessReportOptions,
  collectHostObservations,
  projectHostReadiness,
} from "./host.js";
import { getSystemReadinessReferenceErrors } from "./references.js";
import type { SystemReadinessReport } from "./types.js";

export interface CollectSystemReadinessOptions {
  gateway: GatewayReadinessDependencies;
  host?: CollectHostObservationsOptions;
}

type ReadinessOutcome =
  | { status: "supported"; exitCode: 0 }
  | { status: "incompatible"; exitCode: 2 }
  | { status: "inconclusive"; exitCode: 3 };

function outcomeFor(
  capabilities: SystemReadinessReport["capabilities"],
  findings: SystemReadinessReport["findings"],
): ReadinessOutcome {
  if (findings.some(({ severity }) => severity === "blocking" || severity === "fatal")) {
    return { status: "incompatible", exitCode: 2 };
  }
  if (capabilities.some(({ state }) => state === "unknown")) {
    return { status: "inconclusive", exitCode: 3 };
  }
  return { status: "supported", exitCode: 0 };
}

/** Combine one host snapshot with the canonical gateway projection. */
export function composeSystemReadinessReport(
  host: Readonly<SystemReadinessReport>,
  gateway: Readonly<GatewayReadinessProjection>,
): SystemReadinessReport {
  const capabilities = [...host.capabilities, ...gateway.capabilities];
  const findings = [...host.findings, ...gateway.findings];

  const report: SystemReadinessReport = {
    ...host,
    ...outcomeFor(capabilities, findings),
    mutated: false,
    observations: [...host.observations, ...gateway.observations],
    capabilities,
    findings,
    evidence: [...host.evidence, ...gateway.evidence],
  };
  if (getSystemReadinessReferenceErrors(report).length > 0) {
    throw new Error("System readiness report failed internal reference validation.");
  }
  return report;
}

export async function createSystemReadinessReport(
  options: CreateHostReadinessReportOptions,
  collectionOptions: CollectSystemReadinessOptions,
): Promise<SystemReadinessReport> {
  const now = options.now ?? collectionOptions.host?.now ?? (() => new Date());
  const hostSnapshot = collectHostObservations({ ...collectionOptions.host, now });
  const gatewaySnapshot = await collectGatewayObservations(collectionOptions.gateway, { now });
  // Project both snapshots against the live clock after collection. Freezing
  // evaluation at collection start would let a slow gateway probe hide stale
  // host or gateway evidence from the 30-second reuse boundary.
  const host = projectHostReadiness(hostSnapshot, { ...options, now });
  const gateway = projectGatewayReadiness(gatewaySnapshot, { now });
  return composeSystemReadinessReport(host, gateway);
}
