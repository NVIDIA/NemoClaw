// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactForLog } from "../security/redact.js";
import type {
  EvidenceScalar,
  ReadinessCapability,
  ReadinessEvidence,
  ReadinessFinding,
  ReadinessObservation,
  ReadinessQualification,
  SystemReadinessReport,
} from "./types.js";

const MAX_SUMMARY_LENGTH = 512;
const MAX_EVIDENCE_LENGTH = 1024;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40,64}$/;
const ENVIRONMENT_DETAIL_KEYS = new Set([
  "env",
  "environment",
  "environmentdump",
  "environmentvariables",
  "envvars",
  "processenv",
  "processenvironment",
]);

function bounded(value: string, maxLength: number): string {
  return String(redactForLog(value))
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1<REDACTED>@")
    .slice(0, maxLength);
}

function scalar(value: EvidenceScalar): EvidenceScalar {
  return typeof value === "string" ? bounded(value, MAX_EVIDENCE_LENGTH) : value;
}

function isEnvironmentDetail(key: string): boolean {
  const segments = key.split(/[._-]/).filter(Boolean);
  return segments.some((segment) => ENVIRONMENT_DETAIL_KEYS.has(segment.toLowerCase()));
}

function observation(entry: ReadinessObservation): ReadinessObservation {
  return {
    id: entry.id,
    state: entry.state,
    ...(entry.value !== undefined ? { value: scalar(entry.value) } : {}),
    ...(entry.evidenceIds ? { evidenceIds: [...entry.evidenceIds] } : {}),
  };
}

function capability(entry: ReadinessCapability): ReadinessCapability {
  return {
    id: entry.id,
    state: entry.state,
    ...(entry.evidenceIds ? { evidenceIds: [...entry.evidenceIds] } : {}),
  };
}

function qualification(entry: ReadinessQualification): ReadinessQualification {
  return {
    id: entry.id,
    status: entry.status,
    ...(entry.capabilityIds ? { capabilityIds: [...entry.capabilityIds] } : {}),
  };
}

function finding(entry: ReadinessFinding): ReadinessFinding {
  return {
    id: entry.id,
    severity: entry.severity,
    summary: bounded(entry.summary, MAX_SUMMARY_LENGTH),
    ...(entry.capabilityIds ? { capabilityIds: [...entry.capabilityIds] } : {}),
    ...(entry.evidenceIds ? { evidenceIds: [...entry.evidenceIds] } : {}),
  };
}

function evidence(entry: ReadinessEvidence): ReadinessEvidence {
  const redactedDetails = entry.details
    ? (redactForLog(entry.details) as Record<string, EvidenceScalar>)
    : undefined;
  return {
    id: entry.id,
    summary: bounded(entry.summary, MAX_EVIDENCE_LENGTH),
    ...(redactedDetails
      ? {
          details: Object.fromEntries(
            Object.entries(redactedDetails)
              .filter(([key]) => !isEnvironmentDetail(key))
              .slice(0, 16)
              .map(([key, value]) => [key, scalar(value)]),
          ),
        }
      : {}),
  };
}

export function createPublicReadinessReport(
  report: Readonly<SystemReadinessReport>,
): SystemReadinessReport {
  return {
    schemaVersion: report.schemaVersion,
    status: report.status,
    exitCode: report.exitCode,
    mutated: false,
    provenance: {
      nemoclawVersion: bounded(report.provenance.nemoclawVersion, 128),
      ...(report.provenance.sourceRevision &&
      SOURCE_REVISION_PATTERN.test(report.provenance.sourceRevision)
        ? { sourceRevision: report.provenance.sourceRevision }
        : {}),
      observedAt: report.provenance.observedAt,
    },
    observations: report.observations.slice(0, 256).map(observation),
    capabilities: report.capabilities.slice(0, 256).map(capability),
    qualifications: report.qualifications.slice(0, 128).map(qualification),
    findings: report.findings.slice(0, 256).map(finding),
    evidence: report.evidence.slice(0, 256).map(evidence),
  };
}

export function renderReadinessReport(report: Readonly<SystemReadinessReport>): string {
  const lines = [
    `System readiness: ${report.status}`,
    `Schema: ${report.schemaVersion}`,
    `Observed: ${report.provenance.observedAt}`,
    "Mutation performed: no",
  ];

  if (report.findings.length === 0) {
    lines.push("Findings: none");
  } else {
    lines.push("Findings:");
    for (const entry of report.findings) {
      lines.push(`- [${entry.severity}] ${entry.id}: ${entry.summary}`);
    }
  }

  return lines.join("\n");
}
