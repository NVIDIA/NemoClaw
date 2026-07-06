// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture, dockerRun } from "../adapters/docker";
import type { DockerGpuPatchDeps } from "./docker-gpu-patch";

export const OPENSHELL_MANAGED_BY_LABEL = "openshell.ai/managed-by";
export const OPENSHELL_MANAGED_BY_VALUE = "openshell";
export const OPENSHELL_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";

const DOCKER_SANDBOX_QUERY_TIMEOUT_MS = 30_000;

type DockerSandboxContainerQueryDeps = Pick<DockerGpuPatchDeps, "dockerCapture" | "dockerRun">;

function sandboxContainerFilterArgs(sandboxName: string): string[] {
  return [
    "ps",
    "-a",
    "--filter",
    `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
    "--filter",
    `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}`,
  ];
}

function commandResultText(result: {
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
}): string {
  return `${String(result.stderr || "")} ${String(result.stdout || "")}`.trim();
}

/** Best-effort labeled-container lookup used by patch discovery and diagnostics. */
export function findOpenShellDockerSandboxContainerIds(
  sandboxName: string,
  deps: DockerSandboxContainerQueryDeps = {},
): string[] {
  const capture = deps.dockerCapture ?? dockerCapture;
  const output = capture([...sandboxContainerFilterArgs(sandboxName), "--format", "{{.ID}}"], {
    ignoreError: true,
    timeout: DOCKER_SANDBOX_QUERY_TIMEOUT_MS,
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export type OpenShellDockerSandboxContainerQuery =
  | { ok: true; ids: string[] }
  | { ok: false; ids: []; error: string };

/**
 * Status-bearing lookup used when an empty container list is a safety proof.
 * Unlike the best-effort discovery helper, this distinguishes Docker failure
 * from a successful query with zero labeled matches.
 */
export function queryOpenShellDockerSandboxContainers(
  sandboxName: string,
  deps: DockerSandboxContainerQueryDeps = {},
): OpenShellDockerSandboxContainerQuery {
  const run = deps.dockerRun ?? dockerRun;
  const result = run([...sandboxContainerFilterArgs(sandboxName), "--format", "{{.ID}}"], {
    ignoreError: true,
    suppressOutput: true,
    timeout: DOCKER_SANDBOX_QUERY_TIMEOUT_MS,
  });
  if (Number(result.status ?? 1) !== 0) {
    return {
      ok: false,
      ids: [],
      error: commandResultText(result) || "docker ps did not complete successfully",
    };
  }
  const ids = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return { ok: true, ids };
}

export type OpenShellDockerSandboxImageQuery =
  | { ok: true; imageRef: string; containerId: string }
  | { ok: false; error: string };

/** Resolve the one labeled native container's reusable image before deletion. */
export function queryOpenShellDockerSandboxImage(
  sandboxName: string,
  deps: DockerSandboxContainerQueryDeps = {},
): OpenShellDockerSandboxImageQuery {
  const containers = queryOpenShellDockerSandboxContainers(sandboxName, deps);
  if (!containers.ok) return { ok: false, error: containers.error };
  if (containers.ids.length !== 1) {
    return {
      ok: false,
      error: `expected one labeled sandbox container, found ${containers.ids.length}`,
    };
  }
  const run = deps.dockerRun ?? dockerRun;
  const containerId = containers.ids[0];
  const inspect = run(
    ["inspect", "--type", "container", "--format", "{{.Config.Image}}", containerId],
    {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_SANDBOX_QUERY_TIMEOUT_MS,
    },
  );
  const imageRef = String(inspect.stdout ?? "").trim();
  if (Number(inspect.status ?? 1) !== 0 || !imageRef) {
    return {
      ok: false,
      error:
        commandResultText(inspect) || "docker inspect did not return a reusable image reference",
    };
  }
  return { ok: true, imageRef, containerId };
}
