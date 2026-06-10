// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type GatewayContainerState = "running" | "stopped" | "missing" | "unknown";

type DockerInspect = (
  args: string[],
  opts: { ignoreError: true; suppressOutput: true },
) => { status: number | null; stdout?: unknown; stderr?: unknown };

// Distinguishes a stopped-but-existing legacy gateway container from a truly
// absent one. Conflating the two caused #4187: after a host VM stop/start the
// k3s-in-Docker `openshell-cluster-${gatewayName}` container is stopped but
// still holds the PVC volume. Treating that as "missing" routed onboarding
// through the destructive cleanup branch (`destroyGatewayWithVolumeCleanup`)
// which removes `openshell-cluster-${gatewayName}*` Docker volumes — i.e. the
// PVC backing store — before sandbox recreation, so the next `createSandbox`
// provisioned a fresh, empty workspace.
export function verifyGatewayContainerRunning(
  gatewayName: string,
  deps: { dockerInspect?: DockerInspect } = {},
): GatewayContainerState {
  const inspect =
    deps.dockerInspect ??
    (require("../adapters/docker") as { dockerInspect: DockerInspect }).dockerInspect;
  const containerName = `openshell-cluster-${gatewayName}`;
  const result = inspect(["--type", "container", "--format", "{{.State.Running}}", containerName], {
    ignoreError: true,
    suppressOutput: true,
  });

  if (result.status === 0 && String(result.stdout || "").trim() === "true") {
    return "running";
  }

  if (result.status === 0) {
    return "stopped";
  }

  const stderr = (result.stderr || "").toString();
  if (stderr.includes("No such object") || stderr.includes("No such container")) {
    return "missing";
  }

  return "unknown";
}
