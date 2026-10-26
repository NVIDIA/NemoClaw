// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveSandboxContainerOwner } from "../../domain/sandbox/container-owner";

type LabeledSandboxContainer = {
  readonly id: string;
  readonly name: string;
};

export type DockerPrivilegedSandboxTargetRecord = {
  readonly resourceHandle: string;
  readonly containerName: string;
};

export function dockerContainerNameMatchesSandbox(
  containerName: string,
  sandboxName: string,
): boolean {
  return resolveSandboxContainerOwner(containerName, sandboxName, [sandboxName]) === containerName;
}

function owningRegisteredSandboxName(
  containerName: string,
  registeredNames: readonly string[],
): string | null {
  return (
    registeredNames.find((name) => dockerContainerNameMatchesSandbox(containerName, name)) ?? null
  );
}

function parseLabeledSandboxContainers(output: string): LabeledSandboxContainer[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [id, name, role = "", ...unexpected] = line.split("\t");
      if (
        !id ||
        !name ||
        unexpected.length > 0 ||
        /\s/u.test(id) ||
        !["", "sandbox", "supervisor"].includes(role)
      ) {
        throw new Error("Docker returned malformed OpenShell sandbox container metadata.");
      }
      // Legacy workloads have no role label; 0.1.3 companions share the sandbox label.
      return role === "supervisor" ? [] : [{ id, name }];
    });
}

export function selectDockerPrivilegedSandboxTargetRecord(
  sandboxName: string,
  labeledContainerRows: string,
  registeredNames: readonly string[] = [sandboxName],
): DockerPrivilegedSandboxTargetRecord | null {
  const names = Array.from(new Set([...registeredNames, sandboxName])).sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
  const candidates = parseLabeledSandboxContainers(labeledContainerRows);
  if (
    candidates.some(
      ({ name }) =>
        !dockerContainerNameMatchesSandbox(name, sandboxName) ||
        owningRegisteredSandboxName(name, names) !== sandboxName,
    )
  ) {
    throw new Error(
      `OpenShell container labels and names disagree for sandbox '${sandboxName}'; ` +
        "refusing lifecycle execution.",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple OpenShell containers are labeled for sandbox '${sandboxName}'; ` +
        "refusing ambiguous lifecycle execution.",
    );
  }
  const selected = candidates[0];
  return selected
    ? Object.freeze({ resourceHandle: selected.id, containerName: selected.name })
    : null;
}

export function selectDockerPrivilegedSandboxTarget(
  sandboxName: string,
  labeledContainerRows: string,
  registeredNames: readonly string[] = [sandboxName],
): string | null {
  return (
    selectDockerPrivilegedSandboxTargetRecord(sandboxName, labeledContainerRows, registeredNames)
      ?.resourceHandle ?? null
  );
}
