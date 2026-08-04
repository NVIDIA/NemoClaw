// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type { SchemaCompatibility } from "./compatibility.js";
export { checkSystemReadinessSchemaVersion } from "./compatibility.js";
export type {
  CollectHostObservationsOptions,
  CreateHostReadinessReportOptions,
  HostObservationSnapshot,
  HostObservations,
} from "./host.js";
export {
  collectHostObservations,
  createHostReadinessReport,
  projectHostReadiness,
} from "./host.js";
export type {
  CollectPlatformIdentityOptions,
  PlatformIdentity,
  PlatformQualificationInput,
  PlatformQualificationProjection,
  StationProfile,
} from "./platform-qualification.js";
export {
  collectPlatformIdentity,
  projectPlatformQualification,
} from "./platform-qualification.js";
export { createPublicReadinessReport, renderReadinessReport } from "./presentation.js";
export { getSystemReadinessReferenceErrors } from "./references.js";
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
export {
  SUPPORTED_SYSTEM_READINESS_SCHEMA_MAJOR,
  SYSTEM_READINESS_SCHEMA_VERSION,
} from "./types.js";
