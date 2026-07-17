// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface OrphanGatewayCleanupDeps {
  gatewayReuseState: string;
  isDockerDriverGatewayEnabled: boolean;
  /** When true, NemoClaw performs no container/volume/registry cleanup (#6576). */
  externallySupervised: boolean;
  gatewayName: string;
  dockerInspect(
    args: string[],
    opts: { ignoreError: true; suppressOutput: true },
  ): { status: number | null };
  dockerStop(name: string, opts: { ignoreError: true; suppressOutput: true }): unknown;
  dockerRm(name: string, opts: { ignoreError: true; suppressOutput: true }): unknown;
  dockerRemoveVolumesByPrefix(
    prefix: string,
    opts: { ignoreError: true; suppressOutput: true },
  ): unknown;
  clearRegistry(): void;
  log(message: string): void;
  warn(message: string): void;
}

/**
 * Remove a gateway container orphaned by an interrupted onboard (e.g. Ctrl+C
 * during gateway start): OpenShell can have no metadata for it
 * (`gatewayReuseState === "missing"`) while the container still runs.
 *
 * This is destructive — it stops and removes the container, deletes matching
 * volumes, and clears the sandbox registry — so it must never run against a
 * gateway NemoClaw does not own. Under external supervision, "missing" only
 * means NemoClaw holds no metadata; the supervisor's container is still the
 * live gateway, and destroying it here would happen before the FSM attachment
 * check ever runs (#6576).
 */
export function cleanupOrphanedGatewayContainer(deps: OrphanGatewayCleanupDeps): void {
  if (deps.externallySupervised) return;
  if (deps.gatewayReuseState !== "missing" || deps.isDockerDriverGatewayEnabled) return;

  const containerName = `openshell-cluster-${deps.gatewayName}`;
  const inspectResult = deps.dockerInspect(
    ["--type", "container", "--format", "{{.State.Status}}", containerName],
    { ignoreError: true, suppressOutput: true },
  );
  if (inspectResult.status !== 0) return;

  deps.log("  Cleaning up orphaned gateway container...");
  deps.dockerStop(containerName, { ignoreError: true, suppressOutput: true });
  deps.dockerRm(containerName, { ignoreError: true, suppressOutput: true });
  const postInspectResult = deps.dockerInspect(["--type", "container", containerName], {
    ignoreError: true,
    suppressOutput: true,
  });
  if (postInspectResult.status !== 0) {
    deps.dockerRemoveVolumesByPrefix(containerName, {
      ignoreError: true,
      suppressOutput: true,
    });
    deps.clearRegistry();
    deps.log("  ✓ Orphaned gateway container removed");
  } else {
    deps.warn("  ! Found an orphaned gateway container, but automatic cleanup failed.");
  }
}
