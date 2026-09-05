// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { validateBuildIdentity } from "../core/version.js";
import { redactForLog } from "../security/redact.js";
import { sanitizeReadinessText } from "./sanitize.js";
import { hasRemediableStorageConflict } from "./storage-remediation.js";
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
const MAX_OBSERVATIONS = 256;
const MAX_CAPABILITIES = 256;
const MAX_QUALIFICATIONS = 128;
const MAX_FINDINGS = 256;
const MAX_EVIDENCE = 256;
const MAX_CAPABILITY_REFERENCES = 64;
const MAX_EVIDENCE_REFERENCES = 32;
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
  return sanitizeReadinessText(String(redactForLog(value)), maxLength);
}

function scalar(value: EvidenceScalar): EvidenceScalar {
  return typeof value === "string" ? bounded(value, MAX_EVIDENCE_LENGTH) : value;
}

function isEnvironmentDetail(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, "$1.$2")
    .replace(/([A-Za-z])([0-9])/g, "$1.$2")
    .replace(/([0-9])([A-Za-z])/g, "$1.$2")
    .split(/[._-]/)
    .filter(Boolean);
  return segments.some((segment) => ENVIRONMENT_DETAIL_KEYS.has(segment.toLowerCase()));
}

function boundedReferences(
  references: readonly string[] | undefined,
  maxReferences: number,
  referenceName: string,
): readonly string[] | undefined {
  if (!references) return undefined;
  if (references.length > maxReferences) {
    throw new Error(`Readiness report exceeds the public boundary for ${referenceName}.`);
  }
  if (new Set(references).size !== references.length) {
    throw new Error(`Readiness report contains duplicate ${referenceName}.`);
  }
  return [...references];
}

function observation(entry: ReadinessObservation): ReadinessObservation {
  const evidenceIds = boundedReferences(
    entry.evidenceIds,
    MAX_EVIDENCE_REFERENCES,
    "observation evidence references",
  );
  return {
    id: entry.id,
    state: entry.state,
    ...(entry.value !== undefined ? { value: scalar(entry.value) } : {}),
    ...(evidenceIds ? { evidenceIds } : {}),
  };
}

function capability(entry: ReadinessCapability): ReadinessCapability {
  const evidenceIds = boundedReferences(
    entry.evidenceIds,
    MAX_EVIDENCE_REFERENCES,
    "capability evidence references",
  );
  return {
    id: entry.id,
    state: entry.state,
    ...(evidenceIds ? { evidenceIds } : {}),
  };
}

function qualification(entry: ReadinessQualification): ReadinessQualification {
  const capabilityIds = boundedReferences(
    entry.capabilityIds,
    MAX_CAPABILITY_REFERENCES,
    "qualification capability references",
  );
  return {
    id: entry.id,
    status: entry.status,
    ...(capabilityIds ? { capabilityIds } : {}),
  };
}

function finding(entry: ReadinessFinding): ReadinessFinding {
  const capabilityIds = boundedReferences(
    entry.capabilityIds,
    MAX_CAPABILITY_REFERENCES,
    "finding capability references",
  );
  const evidenceIds = boundedReferences(
    entry.evidenceIds,
    MAX_EVIDENCE_REFERENCES,
    "finding evidence references",
  );
  return {
    id: entry.id,
    severity: entry.severity,
    summary: bounded(entry.summary, MAX_SUMMARY_LENGTH),
    ...(capabilityIds ? { capabilityIds } : {}),
    ...(evidenceIds ? { evidenceIds } : {}),
  };
}

function boundedFindings(entries: readonly ReadinessFinding[]): readonly ReadinessFinding[] {
  const required = entries.filter(
    ({ severity }) => severity === "blocking" || severity === "fatal",
  );
  if (required.length > MAX_FINDINGS) {
    throw new Error("Readiness report exceeds the public boundary for required findings.");
  }

  const selected = new Set(required);
  for (const entry of entries) {
    if (selected.size >= MAX_FINDINGS) break;
    selected.add(entry);
  }
  return entries.filter((entry) => selected.has(entry));
}

function addReferences(target: Set<string>, references: readonly string[] | undefined): void {
  for (const id of references ?? []) target.add(id);
}

function assertUniqueIds<T extends { readonly id: string }>(
  entries: readonly T[],
  entityName: string,
): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new Error(`Readiness report contains duplicate ${entityName} IDs.`);
    }
    ids.add(entry.id);
  }
}

function boundedReferencedEntries<T extends { readonly id: string }>(
  entries: readonly T[],
  requiredIds: ReadonlySet<string>,
  maxEntries: number,
  entityName: string,
): readonly T[] {
  if (requiredIds.size > maxEntries) {
    throw new Error(
      `Readiness report exceeds the public boundary for referenced ${entityName} entries.`,
    );
  }

  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const missingIds = [...requiredIds].filter((id) => !entriesById.has(id));
  if (missingIds.length > 0) {
    throw new Error(`Readiness report contains unresolved ${entityName} references.`);
  }

  const selected = new Set([...requiredIds].map((id) => entriesById.get(id) as T));
  for (const entry of entries) {
    if (selected.size >= maxEntries) break;
    selected.add(entry);
  }
  return entries.filter((entry) => selected.has(entry));
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
  if (report.mutated !== false) {
    throw new Error("Readiness reports must be observation-only.");
  }
  assertUniqueIds(report.observations, "observation");
  assertUniqueIds(report.capabilities, "capability");
  assertUniqueIds(report.qualifications, "qualification");
  assertUniqueIds(report.findings, "finding");
  assertUniqueIds(report.evidence, "evidence");
  // Keep these branches so TypeScript preserves the correlation between status and exitCode.
  const outcome =
    report.status === "supported"
      ? ({ status: report.status, exitCode: report.exitCode } as const)
      : report.status === "incompatible"
        ? ({ status: report.status, exitCode: report.exitCode } as const)
        : ({ status: report.status, exitCode: report.exitCode } as const);
  const selectedObservations = report.observations.slice(0, MAX_OBSERVATIONS);
  const selectedQualifications = report.qualifications.slice(0, MAX_QUALIFICATIONS);
  const selectedFindings = boundedFindings(report.findings);
  const requiredCapabilityIds = new Set<string>();
  for (const entry of selectedQualifications) {
    addReferences(requiredCapabilityIds, entry.capabilityIds);
  }
  for (const entry of selectedFindings) {
    addReferences(requiredCapabilityIds, entry.capabilityIds);
  }
  const selectedCapabilities = boundedReferencedEntries(
    report.capabilities,
    requiredCapabilityIds,
    MAX_CAPABILITIES,
    "capability",
  );
  const requiredEvidenceIds = new Set<string>();
  for (const entry of selectedObservations) {
    addReferences(requiredEvidenceIds, entry.evidenceIds);
  }
  for (const entry of selectedCapabilities) {
    addReferences(requiredEvidenceIds, entry.evidenceIds);
  }
  for (const entry of selectedFindings) {
    addReferences(requiredEvidenceIds, entry.evidenceIds);
  }
  const selectedEvidence = boundedReferencedEntries(
    report.evidence,
    requiredEvidenceIds,
    MAX_EVIDENCE,
    "evidence",
  );
  const buildIdentity = validateBuildIdentity({
    nemoclawVersion: report.provenance.nemoclawVersion,
    sourceRevision: report.provenance.sourceRevision,
  });
  return {
    schemaVersion: report.schemaVersion,
    ...outcome,
    mutated: false,
    provenance: {
      nemoclawVersion: buildIdentity.nemoclawVersion,
      sourceRevision: buildIdentity.sourceRevision,
      observedAt: report.provenance.observedAt,
    },
    observations: selectedObservations.map(observation),
    capabilities: selectedCapabilities.map(capability),
    qualifications: selectedQualifications.map(qualification),
    findings: selectedFindings.map(finding),
    evidence: selectedEvidence.map(evidence),
  };
}

/** Apply the read-only host probe policy after the shared report is sanitized. */
export function createPublicHostProbeReadinessReport(
  report: Readonly<SystemReadinessReport>,
): SystemReadinessReport {
  const publicReport = createPublicReadinessReport(report);
  if (!hasRemediableStorageConflict(publicReport)) return publicReport;

  return {
    ...publicReport,
    status: "supported",
    exitCode: 0,
    findings: publicReport.findings.map((entry) =>
      entry.id === "host.docker.storage_incompatible" ? { ...entry, severity: "warning" } : entry,
    ),
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
