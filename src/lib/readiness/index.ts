// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type { SchemaCompatibility } from "./compatibility.js";
export { checkSystemReadinessSchemaVersion } from "./compatibility.js";
export type {
  CollectGatewayObservationsOptions,
  CreateGatewayReadinessProjectionOptions,
  GatewayAttachmentState,
  GatewayDriftState,
  GatewayObservationSnapshot,
  GatewayObservations,
  GatewayPortConflictState,
  GatewayReadinessDependencies,
  GatewayReadinessProjection,
  GatewayReuseObservation,
  ManagedGatewayObservations,
  ProjectGatewayReadinessOptions,
} from "./gateway.js";
export {
  collectGatewayObservations,
  createGatewayReadinessProjection,
  projectGatewayReadiness,
} from "./gateway.js";
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
  OnboardReadinessAdmissionDecision,
  OnboardReadinessAdmissionOptions,
  OnboardReadinessAdmissionReasonId,
} from "./onboard-admission.js";
export {
  evaluateOnboardGatewayReadinessAdmission,
  evaluateOnboardReadinessAdmission,
  ONBOARD_READINESS_ADMISSION_REASON_IDS,
  ONBOARD_READINESS_FINDING_IDS,
  ONBOARD_REQUIRED_CAPABILITY_IDS,
} from "./onboard-admission.js";
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
export {
  createPublicHostProbeReadinessReport,
  createPublicReadinessReport,
  renderReadinessReport,
} from "./presentation.js";
export { getSystemReadinessReferenceErrors } from "./references.js";
export type { CollectSystemReadinessOptions } from "./system.js";
export { composeSystemReadinessReport, createSystemReadinessReport } from "./system.js";
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
