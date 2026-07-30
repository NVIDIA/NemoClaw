// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  captureOpenshell,
  getOpenshellBinary,
  runOpenshell,
} from "../../../adapters/openshell/runtime";
import {
  resolveGatewayPortFromName,
  resolveManagedGatewayStateDirectory,
  resolveSandboxGatewayName,
} from "../../../onboard/gateway-binding";
import {
  createPodmanManagedSnapshotRuntimeAuthority,
  currentManagedSnapshotRuntimeAuthorityAdapters,
  resolveManagedSnapshotRuntimeAuthority as resolveManagedSnapshotRuntimeAuthorityWithAdapters,
} from "./runtime-authority";
import type { ManagedSnapshotRuntimePatchContext } from "./runtime-patch";

/**
 * Narrow dependency facade for the large snapshot lifecycle coordinator.
 *
 * Snapshot restore spans runtime, dashboard, profile, and launch boundaries.
 * Keep those leaf imports here so snapshot.ts depends on one explicit
 * integration seam instead of growing direct fan-out for every clone feature.
 */
export { dockerCapture } from "../../../adapters/docker";
export {
  HERMES_DASHBOARD_ENABLE_ENV,
  HERMES_DASHBOARD_INTERNAL_PORT_ENV,
  HERMES_DASHBOARD_PORT_ENV,
  HERMES_DASHBOARD_TUI_ENV,
} from "../../../hermes-dashboard";
export {
  findAvailableDashboardPort,
  getRegistryOccupiedDashboardPorts,
  withDashboardPortReservationLock,
} from "../../../onboard/dashboard-port";
export { isValidForwardPort } from "../../../onboard/dashboard-runtime";
export { createDockerGpuSandboxCreatePatch } from "../../../onboard/docker-gpu-sandbox-create";
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
export type { SandboxCreateRuntimePatch } from "../../../onboard/sandbox-create-runtime/types";
export {
  runSandboxProviderPreDeleteCleanup,
  SANDBOX_PROVIDER_SUFFIXES,
} from "../../../onboard/sandbox-provider-cleanup";
export { streamSandboxCreate } from "../../../sandbox/create-stream";
export { persistedHostContainerRuntimeActivation } from "../gateway-target";
export { formatSnapshotBaselineExclusionSummary } from "../snapshot-baseline-exclusion-summary";
export { printHermesGatewayRestoreHint } from "../snapshot-hermes-gateway-hint";
export type { PreparedManagedCloneProvider } from "./managed-clone-providers";
export {
  createManagedSnapshotRuntimePatch,
  runAuthorizedManagedSnapshotDestinationDelete,
} from "./runtime-patch";
export { captureOpenshell, getOpenshellBinary, resolveSandboxGatewayName, runOpenshell };

const SNAPSHOT_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function sleepSeconds(seconds: number): void {
  Atomics.wait(SNAPSHOT_SLEEP_BUFFER, 0, 0, Math.max(0, seconds) * 1000);
}

function runSnapshotHostCapture(args: string[], options: { ignoreError?: boolean } = {}): string {
  const [file, ...fileArgs] = args;
  if (!file) throw new Error("Snapshot runtime capture requires a command");
  const result = spawnSync(file, fileArgs, {
    encoding: "utf8",
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!result.error && result.status === 0) return (result.stdout ?? "").trim();
  if (options.ignoreError) return "";
  if (result.error) throw result.error;
  throw new Error(`Snapshot runtime command failed with status ${String(result.status)}`);
}

const MANAGED_SNAPSHOT_RUNTIME_AUTHORITY_ADAPTERS = currentManagedSnapshotRuntimeAuthorityAdapters(
  (context) =>
    createPodmanManagedSnapshotRuntimeAuthority(context, {
      captureOpenshell,
      getOpenshellBinary,
      resolveGatewayPortFromName,
      resolveManagedGatewayStateDirectory,
      resolveSandboxGatewayName,
      runCapture: runSnapshotHostCapture,
    }),
);

export function resolveManagedSnapshotRuntimeAuthority(
  driverName: string,
  context: ManagedSnapshotRuntimePatchContext,
): unknown {
  return resolveManagedSnapshotRuntimeAuthorityWithAdapters(
    driverName,
    context,
    MANAGED_SNAPSHOT_RUNTIME_AUTHORITY_ADAPTERS,
  );
}
