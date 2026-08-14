// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type DockerCaptureOptions, type DockerRunOptions, dockerCapture, dockerRun } from "./run";

export type DockerSandboxIdentityRow = {
  id: string;
  managedBy: string;
  workspace: string;
  sandboxId: string;
};

export type DockerSandboxIdentityObservation =
  | { status: "observed"; rows: DockerSandboxIdentityRow[]; malformedRows: number }
  | { status: "probe-failed"; detail: string };

type DockerSandboxIdentityInspect = (
  args: readonly string[],
  opts?: DockerRunOptions,
) => Partial<Pick<ReturnType<typeof dockerRun>, "error" | "status" | "stderr" | "stdout">>;

const DOCKER_IDENTITY_PROBE_TIMEOUT_MS = 30_000;
const DOCKER_IDENTITY_PROBE_MAX_BUFFER_BYTES = 256 * 1024;
const IDENTITY_VALUE_MAX_LENGTH = 256;
const DOCKER_CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/iu;
const UNSAFE_IDENTITY_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

function isExactBoundedIdentityText(value: string): boolean {
  return (
    value === value.trim() &&
    value.length <= IDENTITY_VALUE_MAX_LENGTH &&
    !UNSAFE_IDENTITY_TEXT_PATTERN.test(value)
  );
}

/** Inspect and parse the exact Docker rows used by sandbox destroy. */
export function inspectDockerSandboxIdentities(
  sandboxNameLabel: string,
  labelKeys: { managedBy: string; workspace: string; sandboxId: string },
  inspect: DockerSandboxIdentityInspect = dockerRun,
): DockerSandboxIdentityObservation {
  const format = [
    "{{.ID}}",
    `{{.Label "${labelKeys.managedBy}"}}`,
    `{{.Label "${labelKeys.workspace}"}}`,
    `{{.Label "${labelKeys.sandboxId}"}}`,
  ].join("\t");
  const result = inspect(
    ["ps", "-a", "--no-trunc", "--filter", `label=${sandboxNameLabel}`, "--format", format],
    {
      ignoreError: true,
      maxBuffer: DOCKER_IDENTITY_PROBE_MAX_BUFFER_BYTES,
      suppressOutput: true,
      timeout: DOCKER_IDENTITY_PROBE_TIMEOUT_MS,
    },
  );
  if (Number(result.status ?? 1) !== 0) {
    const detail = [result.error?.message, result.stderr, result.stdout]
      .filter((value) => value !== undefined && value !== null && String(value).length > 0)
      .map(String)
      .join(" ")
      .trim();
    return { status: "probe-failed", detail };
  }

  const rows: DockerSandboxIdentityRow[] = [];
  let malformedRows = 0;
  for (const rawLine of String(result.stdout ?? "").split(/\r?\n/u)) {
    if (rawLine.length === 0) continue;
    const fields = rawLine.split("\t");
    if (
      fields.length !== 4 ||
      !DOCKER_CONTAINER_ID_PATTERN.test(fields[0] ?? "") ||
      !fields.every(isExactBoundedIdentityText)
    ) {
      malformedRows += 1;
      continue;
    }
    const [id, managedBy, workspace, sandboxId] = fields as [string, string, string, string];
    rows.push({ id, managedBy, workspace, sandboxId });
  }
  return { status: "observed", rows, malformedRows };
}

export function dockerInspect(args: readonly string[], opts: DockerRunOptions = {}) {
  return dockerRun(["inspect", ...args], opts);
}

export function dockerImageInspect(target: string, opts: DockerRunOptions = {}) {
  return dockerRun(["image", "inspect", target], opts);
}

export function dockerImageInspectFormat(
  format: string,
  target: string,
  opts: DockerCaptureOptions = {},
): string {
  return dockerCapture(["image", "inspect", "--format", format, target], opts);
}

export function dockerContainerInspectFormat(
  format: string,
  containerName: string,
  opts: DockerCaptureOptions = {},
): string {
  return dockerCapture(["inspect", "--type", "container", "--format", format, containerName], opts);
}

// Capture `docker manifest inspect <ref>` (registry manifest, not a local image).
// For a multi-arch tag this is the OCI image index JSON; callers parse it to
// resolve a per-arch digest. Returns "" on failure when ignoreError is set.
export function dockerManifestInspect(imageRef: string, opts: DockerCaptureOptions = {}): string {
  return dockerCapture(["manifest", "inspect", imageRef], opts);
}
