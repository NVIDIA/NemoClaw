// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  getDockerDriverGatewayRuntimeMarkerPath,
  parseDockerDriverGatewayRuntimeMarker,
  readOwnedDockerDriverGatewayRuntimeFile,
  resolveDockerDriverGatewayStateDir,
} from "../../../src/lib/onboard/docker-driver-gateway-runtime-marker";
import type { RuntimeProviderOwnedGatewayReadinessInput } from "../../../src/lib/onboard/runtime-provider/contract";

export interface PodmanOwnerSnapshotReads {
  uid(): number;
  ownedFile(file: string, uid: number): string | null;
  executable(pid: number): string | null;
  realPath(file: string): string | null;
}

function realPath(file: string): string | null {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return null;
  }
}

const reads: PodmanOwnerSnapshotReads = {
  uid: () => process.getuid?.() ?? -1,
  ownedFile: readOwnedDockerDriverGatewayRuntimeFile,
  executable: (pid) => realPath(`/proc/${pid}/exe`),
  realPath,
};

/** Diagnostic snapshot only: never decides whether a listener may be adopted. */
export function snapshotPodmanOwner(
  input: RuntimeProviderOwnedGatewayReadinessInput,
  pid: number,
  source: PodmanOwnerSnapshotReads = reads,
) {
  const uid = source.uid();
  if (!Number.isSafeInteger(pid) || pid <= 0 || uid < 0 || !input.environment.HOME) {
    return { kind: "podman-owner-snapshot-v1", available: false } as const;
  }
  const stateDir = resolveDockerDriverGatewayStateDir(
    input.environment,
    input.environment.HOME,
    input.gatewayPort,
  );
  const pidText = source.ownedFile(path.join(stateDir, "openshell-gateway.pid"), uid);
  const markerText = source.ownedFile(getDockerDriverGatewayRuntimeMarkerPath(stateDir), uid);
  const marker = markerText ? parseDockerDriverGatewayRuntimeMarker(markerText) : null;
  const trusted = input.trustedGatewayBin ? source.realPath(input.trustedGatewayBin) : null;
  const recorded = marker?.gatewayBin ? source.realPath(marker.gatewayBin) : null;
  const running = source.executable(pid);
  return {
    kind: "podman-owner-snapshot-v1",
    available: true,
    pidFileReadable: pidText !== null,
    pidFileMatchesListener: pidText !== null && Number(pidText.trim()) === pid,
    markerReadable: markerText !== null,
    markerParsed: marker !== null,
    markerMatchesListener: marker?.pid === pid,
    markerIsPodman: marker?.driver === "podman",
    markerPlatformMatchesExpected: marker?.platform === input.platform,
    markerArchitectureMatchesExpected: marker?.arch === input.architecture,
    markerEndpointMatchesExpected: marker?.endpoint === input.expectedEndpoint,
    trustedExecutableResolved: trusted !== null,
    markerExecutableMatchesTrusted: trusted !== null && recorded === trusted,
    runningExecutableMatchesTrusted: trusted !== null && running === trusted,
  } as const;
}
