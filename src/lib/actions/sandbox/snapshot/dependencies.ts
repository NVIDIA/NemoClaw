// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Narrow dependency facade for the large snapshot lifecycle coordinator.
 *
 * Snapshot restore spans runtime, dashboard, profile, and launch boundaries.
 * Keep those leaf imports here so snapshot.ts depends on one explicit
 * integration seam instead of growing direct fan-out for every clone feature.
 */
export { dockerCapture } from "../../../adapters/docker";
export {
  captureOpenshell,
  getOpenshellBinary,
  runOpenshell,
} from "../../../adapters/openshell/runtime";
export {
  HERMES_DASHBOARD_ENABLE_ENV,
  HERMES_DASHBOARD_INTERNAL_PORT_ENV,
  HERMES_DASHBOARD_PORT_ENV,
  HERMES_DASHBOARD_TUI_ENV,
} from "../../../hermes-dashboard";
export {
  getHermesToolGatewayCloneBroker,
  type HermesToolGatewayCloneBroker,
} from "../../../hermes-tool-gateway-clone-broker";
export {
  findAvailableDashboardPort,
  getRegistryOccupiedDashboardPorts,
  withDashboardPortReservationLock,
} from "../../../onboard/dashboard-port";
export { isValidForwardPort } from "../../../onboard/dashboard-runtime";
export {
  createDockerGpuSandboxCreatePatch,
  type DockerGpuSandboxCreatePatch,
} from "../../../onboard/docker-gpu-sandbox-create";
export { resolveSandboxGatewayName } from "../../../onboard/gateway-binding";
export { resolveHermesDashboardOnboardState } from "../../../onboard/hermes-dashboard";
export { MANAGED_STARTUP_HOLD_EXECUTABLE } from "../../../onboard/managed-startup/hold";
export type {
  ManagedStartupAgent,
  ManagedStartupProfile,
} from "../../../onboard/managed-startup/profile";
export {
  createManagedStartupRootApplyRequest,
  type ManagedStartupRootApplyRequest,
} from "../../../onboard/managed-startup/root-apply";
export {
  MANAGED_STARTUP_CA_ENV,
  MANAGED_STARTUP_PROFILE_ENV,
} from "../../../onboard/managed-startup/transport";
export { assertSandboxCreateArgvWithinTransportLimit } from "../../../onboard/sandbox-create/transport";
export {
  cleanupHermesSandboxProviders,
  HERMES_SANDBOX_PROVIDER_SUFFIXES,
  runSandboxProviderPreDeleteCleanup,
  SANDBOX_PROVIDER_SUFFIXES,
} from "../../../onboard/sandbox-provider-cleanup";
export { streamSandboxCreate } from "../../../sandbox/create-stream";
export { formatSnapshotBaselineExclusionSummary } from "../snapshot-baseline-exclusion-summary";
export { printHermesGatewayRestoreHint } from "../snapshot-hermes-gateway-hint";
export type { PreparedManagedCloneProvider } from "./managed-clone-providers";
