// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture, dockerRun } from "../adapters/docker";
import type { DockerGpuPatchDeps } from "./docker-gpu-patch-types";

export const OPENSHELL_MANAGED_BY_LABEL = "openshell.ai/managed-by";
export const OPENSHELL_MANAGED_BY_VALUE = "openshell";
export const OPENSHELL_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";

const DOCKER_SANDBOX_QUERY_TIMEOUT_MS = 30_000;

type DockerSandboxContainerQueryDeps = Pick<DockerGpuPatchDeps, "dockerCapture" | "dockerRun">;

function sandboxContainerFilterArgs(sandboxName: string): string[] {
  return [
    "ps",
    "-a",
    "--no-trunc",
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

export type OpenShellDockerDeviceRequest = {
  Driver: string;
  Count: number;
  DeviceIDs: string[] | null;
  Capabilities: string[][] | null;
  Options: Record<string, string> | null;
};

export type OpenShellDockerDeviceMapping = {
  PathOnHost: string;
  PathInContainer: string;
  CgroupPermissions: string;
};

export type OpenShellDockerGpuAttachmentState = "absent" | "present" | "unknown";

export type OpenShellDockerSandboxRuntimeSnapshotQuery =
  | {
      ok: true;
      /** Immutable identity used when rendering a compatibility retry. */
      imageId: string;
      /** Original Docker source reference, retained only for registry bookkeeping. */
      bookkeepingImageRef: string;
      stateError: string;
      deviceRequests: OpenShellDockerDeviceRequest[] | null;
      devices: OpenShellDockerDeviceMapping[] | null;
      runtime: string;
      /** Closed-world classification of host-owned Docker GPU configuration. */
      nativeGpuAttachmentState: OpenShellDockerGpuAttachmentState;
      containerId: string;
    }
  | { ok: false; error: string };

export function isImmutableDockerImageId(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/i.test(value);
}

function isSafeBookkeepingImageRef(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringMatrix(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every(isStringArray);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isDockerDeviceRequest(value: unknown): value is OpenShellDockerDeviceRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    hasExactKeys(request, ["Driver", "Count", "DeviceIDs", "Capabilities", "Options"]) &&
    typeof request.Driver === "string" &&
    typeof request.Count === "number" &&
    Number.isInteger(request.Count) &&
    (request.DeviceIDs === null || isStringArray(request.DeviceIDs)) &&
    (request.Capabilities === null || isStringMatrix(request.Capabilities)) &&
    (request.Options === null || isStringRecord(request.Options))
  );
}

function isDockerDeviceMapping(value: unknown): value is OpenShellDockerDeviceMapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const mapping = value as Record<string, unknown>;
  return (
    hasExactKeys(mapping, ["PathOnHost", "PathInContainer", "CgroupPermissions"]) &&
    typeof mapping.PathOnHost === "string" &&
    typeof mapping.PathInContainer === "string" &&
    typeof mapping.CgroupPermissions === "string"
  );
}

function isDockerDeviceRequestList(value: unknown): value is OpenShellDockerDeviceRequest[] | null {
  return value === null || (Array.isArray(value) && value.every(isDockerDeviceRequest));
}

function isDockerDeviceMappingList(value: unknown): value is OpenShellDockerDeviceMapping[] | null {
  return value === null || (Array.isArray(value) && value.every(isDockerDeviceMapping));
}

function isNvidiaCdiDevice(value: string): boolean {
  return /^nvidia\.com\/gpu(?:=|$)/i.test(value.trim());
}

function isKnownGpuDevicePath(value: string): boolean {
  const path = value.trim();
  return (
    isNvidiaCdiDevice(path) ||
    /^\/dev\/nvidia(?:[a-z0-9._/-]*)$/i.test(path) ||
    /^\/dev\/dri(?:\/[a-z0-9._/-]+)?$/i.test(path) ||
    /^\/dev\/nvhost[-a-z0-9._/]*$/i.test(path) ||
    /^\/dev\/nvmap$/i.test(path) ||
    /^\/dev\/tegra[-a-z0-9._/]*$/i.test(path)
  );
}

function classifyGpuAttachment(
  deviceRequests: OpenShellDockerDeviceRequest[] | null,
  devices: OpenShellDockerDeviceMapping[] | null,
  runtime: string,
): OpenShellDockerGpuAttachmentState {
  const normalizedRuntime = runtime.trim().toLowerCase();
  if (normalizedRuntime === "nvidia") return "present";
  if (
    deviceRequests?.some(
      (request) =>
        request.Driver.trim().toLowerCase() === "nvidia" ||
        request.DeviceIDs?.some(isNvidiaCdiDevice) === true ||
        request.Capabilities?.some((group) =>
          group.some((capability) => capability.trim().toLowerCase() === "gpu"),
        ) === true,
    )
  ) {
    return "present";
  }
  if (
    devices?.some(
      (mapping) =>
        isKnownGpuDevicePath(mapping.PathOnHost) || isKnownGpuDevicePath(mapping.PathInContainer),
    ) === true
  ) {
    return "present";
  }

  const noDeviceRequests = deviceRequests === null || deviceRequests.length === 0;
  const noDeviceMappings = devices === null || devices.length === 0;
  const knownNonGpuRuntime = ["", "crun", "io.containerd.runc.v2", "runc"].includes(
    normalizedRuntime,
  );
  return noDeviceRequests && noDeviceMappings && knownNonGpuRuntime ? "absent" : "unknown";
}

/**
 * Inspect the one exactly labeled native container before deletion.
 *
 * Docker owns the fields returned here: `.Image` is the immutable retry
 * identity, `.Config.Image` is bookkeeping-only, and HostConfig supplies the
 * structured GPU-attachment evidence. Malformed HostConfig shapes fail the
 * whole snapshot. Unknown but well-formed configurations remain `unknown`, so
 * only the closed-world `absent` state can authorize a broader retry.
 */
export function queryOpenShellDockerSandboxRuntimeSnapshot(
  sandboxName: string,
  deps: DockerSandboxContainerQueryDeps = {},
): OpenShellDockerSandboxRuntimeSnapshotQuery {
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
    [
      "inspect",
      "--type",
      "container",
      "--format",
      "[{{json .Image}},{{json .Config.Image}},{{json .State.Error}},{{json .HostConfig.DeviceRequests}},{{json .HostConfig.Devices}},{{json .HostConfig.Runtime}}]",
      containerId,
    ],
    {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_SANDBOX_QUERY_TIMEOUT_MS,
    },
  );
  if (Number(inspect.status ?? 1) !== 0) {
    return {
      ok: false,
      error: commandResultText(inspect) || "docker inspect did not complete successfully",
    };
  }
  let fields: unknown;
  try {
    fields = JSON.parse(String(inspect.stdout ?? "").trim());
  } catch {
    return { ok: false, error: "docker inspect returned malformed runtime metadata" };
  }
  if (
    !Array.isArray(fields) ||
    fields.length !== 6 ||
    typeof fields[0] !== "string" ||
    typeof fields[1] !== "string" ||
    typeof fields[2] !== "string" ||
    !isImmutableDockerImageId(fields[0]) ||
    !isSafeBookkeepingImageRef(fields[1]) ||
    !isDockerDeviceRequestList(fields[3]) ||
    !isDockerDeviceMappingList(fields[4]) ||
    typeof fields[5] !== "string"
  ) {
    return { ok: false, error: "docker inspect returned malformed runtime metadata" };
  }
  const deviceRequests = fields[3];
  const devices = fields[4];
  const runtime = fields[5];
  return {
    ok: true,
    imageId: fields[0].toLowerCase(),
    bookkeepingImageRef: fields[1],
    stateError: fields[2],
    deviceRequests,
    devices,
    runtime,
    nativeGpuAttachmentState: classifyGpuAttachment(deviceRequests, devices, runtime),
    containerId,
  };
}
