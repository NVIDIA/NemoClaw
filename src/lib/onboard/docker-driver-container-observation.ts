// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const OPENSHELL_MANAGED_BY_LABEL = "openshell.ai/managed-by";
export const OPENSHELL_MANAGED_BY_VALUE = "openshell";
export const OPENSHELL_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";

const DOCKER_PROBE_TIMEOUT_MS = 5_000;

type DockerCapture = (args: readonly string[], opts?: Record<string, unknown>) => string;

export interface LabeledSandboxContainer {
  readonly name: string;
  readonly status: string;
  readonly running: boolean;
}

export interface DockerDriverContainerObservationDeps {
  readonly dockerCapture?: DockerCapture;
  readonly ignoreError?: boolean;
}

function loadDockerCapture(): DockerCapture {
  return (require("../adapters/docker") as { dockerCapture: DockerCapture }).dockerCapture;
}

/** Read OpenShell-labeled Docker containers without taking lifecycle authority. */
export function findLabeledSandboxContainers(
  sandboxName: string,
  deps: DockerDriverContainerObservationDeps = {},
): LabeledSandboxContainer[] {
  const output = (deps.dockerCapture ?? loadDockerCapture())(
    [
      "ps",
      "-a",
      "--filter",
      `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
      "--filter",
      `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}`,
      "--format",
      "{{.Names}}\t{{.Status}}",
    ],
    { ignoreError: deps.ignoreError !== false, timeout: DOCKER_PROBE_TIMEOUT_MS },
  );
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split("\t");
      const status = rest.join("\t").trim();
      return { name, status, running: status.startsWith("Up") };
    });
}
