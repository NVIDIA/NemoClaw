// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const SYSTEM_READINESS_SCHEMA_VERSION = "1.1.0" as const;
export const SUPPORTED_SYSTEM_READINESS_SCHEMA_MAJOR = 1;

export type ReadinessState = "present" | "absent" | "unknown";
export type ReadinessStatus = "supported" | "incompatible" | "inconclusive";
export type ReadinessExitCode = 0 | 2 | 3;
export type FindingSeverity = "info" | "warning" | "blocking" | "fatal";
export type QualificationStatus = "qualified" | "unqualified" | "unknown";
export type EvidenceScalar = string | number | boolean | null;

export interface ReadinessProvenance {
  nemoclawVersion: string;
  sourceRevision: string;
  observedAt: string;
  [key: string]: unknown;
}

export interface ReadinessObservation {
  id: string;
  state: ReadinessState;
  value?: EvidenceScalar;
  evidenceIds?: readonly string[];
  [key: string]: unknown;
}

export interface ReadinessCapability {
  id: string;
  state: ReadinessState;
  evidenceIds?: readonly string[];
  [key: string]: unknown;
}

export interface ReadinessQualification {
  id: string;
  status: QualificationStatus;
  capabilityIds?: readonly string[];
  [key: string]: unknown;
}

export interface ReadinessFinding {
  id: string;
  severity: FindingSeverity;
  summary: string;
  capabilityIds?: readonly string[];
  evidenceIds?: readonly string[];
  [key: string]: unknown;
}

export interface ReadinessEvidence {
  id: string;
  summary: string;
  details?: Readonly<Record<string, EvidenceScalar>>;
  [key: string]: unknown;
}

interface SystemReadinessReportFields {
  schemaVersion: string;
  mutated: false;
  provenance: ReadinessProvenance;
  observations: readonly ReadinessObservation[];
  capabilities: readonly ReadinessCapability[];
  qualifications: readonly ReadinessQualification[];
  findings: readonly ReadinessFinding[];
  evidence: readonly ReadinessEvidence[];
  [key: string]: unknown;
}

type SystemReadinessOutcome =
  | { status: "supported"; exitCode: 0 }
  | { status: "incompatible"; exitCode: 2 }
  | { status: "inconclusive"; exitCode: 3 };

export type SystemReadinessReport = SystemReadinessReportFields & SystemReadinessOutcome;
