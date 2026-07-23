// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type { SchemaCompatibility } from "./compatibility.js";
export { checkSystemReadinessSchemaVersion } from "./compatibility.js";
export { getSystemReadinessReferenceErrors } from "./references.js";
export {
  collectHostObservations,
  createHostReadinessReport,
  projectHostReadiness,
} from "./host.js";
export type {
  CollectHostObservationsOptions,
  CreateHostReadinessReportOptions,
  HostObservationSnapshot,
  HostObservations,
} from "./host.js";
export {
  SUPPORTED_SYSTEM_READINESS_SCHEMA_MAJOR,
  SYSTEM_READINESS_SCHEMA_VERSION,
} from "./types.js";
export type {
  EvidenceScalar,
  FindingSeverity,
  QualificationStatus,
  ReadinessCapability,
  ReadinessEvidence,
  ReadinessExitCode,
  ReadinessFinding,
  ReadinessObservation,
  ReadinessProvenance,
  ReadinessQualification,
  ReadinessState,
  ReadinessStatus,
  SystemReadinessReport,
} from "./types.js";
