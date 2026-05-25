// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type GatewayContainerState = "running" | "missing" | "unknown";

type DockerInspect = (
  args: string[],
  opts: { ignoreError: true; suppressOutput: true },
) => { status: number | null; stdout?: unknown; stderr?: unknown };

export function verifyGatewayContainerRunning(
  gatewayName: string,
  deps: { dockerInspect?: DockerInspect } = {},
): GatewayContainerState {
  const inspect =
    deps.dockerInspect ??
    (require("../adapters/docker") as { dockerInspect: DockerInspect }).dockerInspect;
  const containerName = `openshell-cluster-${gatewayName}`;
  const result = inspect(
    ["--type", "container", "--format", "{{.State.Running}}", containerName],
    { ignoreError: true, suppressOutput: true },
  );

  if (result.status === 0 && String(result.stdout || "").trim() === "true") {
    return "running";
  }

  if (result.status === 0) {
    return "missing";
  }

  const stderr = (result.stderr || "").toString();
  if (stderr.includes("No such object") || stderr.includes("No such container")) {
    return "missing";
  }

  return "unknown";
}
