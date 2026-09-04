// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveSandboxContainerOwner } from "../../domain/sandbox/container-owner";

type LabeledSandboxContainer = {
  readonly id: string;
  readonly name: string;
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
    .map((line) => {
      const [id, name, ...unexpected] = line.split("\t");
      if (!id || !name || unexpected.length > 0 || /\s/u.test(id)) {
        throw new Error("Docker returned malformed OpenShell sandbox container metadata.");
      }
      return { id, name };
    });
}

export function selectDockerPrivilegedSandboxTarget(
  sandboxName: string,
  labeledContainerRows: string,
  registeredNames: readonly string[] = [sandboxName],
): string | null {
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
      `Multiple running OpenShell containers are labeled for sandbox '${sandboxName}'; ` +
        "refusing ambiguous lifecycle execution.",
    );
  }
  return candidates[0]?.id ?? null;
}
