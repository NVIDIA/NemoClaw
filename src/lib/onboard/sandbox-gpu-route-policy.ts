// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  canFallbackToDockerGpuCompatibility,
  type DockerGpuRoutePlan,
  initialDockerGpuRoute,
} from "./docker-gpu-route";
import type { InitialSandboxPolicy } from "./initial-policy";
import { openShellPolicyValuesEqual } from "../policy/merge";

const PROC_PATH = "/proc";
const OPENSHELL_PROXY_REQUIRED_READ_ONLY_PATHS = new Set([
  "/usr",
  "/lib",
  "/etc",
  "/app",
  "/var/log",
  "/dev/urandom",
]);
const OPENSHELL_PROXY_REQUIRED_READ_WRITE_PATHS = new Set(["/tmp"]);
const OPENSHELL_GPU_READ_ONLY_PATHS = new Set(["/run/nvidia-persistenced", "/usr/lib/wsl"]);
const OPENSHELL_GPU_READ_WRITE_PATHS = new Set([
  "/dev/nvidiactl",
  "/dev/nvidia-uvm",
  "/dev/nvidia-uvm-tools",
  "/dev/nvidia-modeset",
  "/dev/dxg",
  PROC_PATH,
]);
const OPENSHELL_GPU_DEVICE_PATH = /^\/dev\/nvidia[0-9]+$/u;

type PrepareInitialSandboxCreatePolicy =
  typeof import("./initial-policy").prepareInitialSandboxCreatePolicy;
type InitialPolicyOptions = Parameters<PrepareInitialSandboxCreatePolicy>[2];

export type SandboxGpuRoutePolicies = {
  initialSandboxPolicy: InitialSandboxPolicy;
  compatibilityPolicyPath: string | null;
};

function policyWithoutFilesystemPolicy(policy: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(policy)) {
    if (key !== "filesystem_policy") result[key] = policy[key];
  }
  return result;
}

function filesystemPolicyWithoutPaths(policy: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(policy)) {
    if (key !== "read_only" && key !== "read_write") result[key] = policy[key];
  }
  return result;
}

function readUniquePaths(
  policy: Record<string, unknown>,
  key: "read_only" | "read_write",
): Set<string> | null {
  const value = policy[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  const paths = new Set(value);
  return paths.size === value.length ? paths : null;
}

function isSubset(subset: ReadonlySet<string>, superset: ReadonlySet<string>): boolean {
  return [...subset].every((entry) => superset.has(entry));
}

function setsOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].some((entry) => right.has(entry));
}

/** Accept only the documented filesystem additions made by OpenShell native-GPU injection. */
export function isOpenShellNativeGpuBaselineEnrichment(
  intended: Record<string, unknown>,
  live: Record<string, unknown>,
): boolean {
  if (
    !openShellPolicyValuesEqual(
      policyWithoutFilesystemPolicy(intended),
      policyWithoutFilesystemPolicy(live),
    )
  ) {
    return false;
  }
  const intendedFilesystem = intended.filesystem_policy;
  const liveFilesystem = live.filesystem_policy;
  if (
    !intendedFilesystem ||
    typeof intendedFilesystem !== "object" ||
    Array.isArray(intendedFilesystem) ||
    !liveFilesystem ||
    typeof liveFilesystem !== "object" ||
    Array.isArray(liveFilesystem)
  ) {
    return false;
  }
  const intendedFilesystemRecord = intendedFilesystem as Record<string, unknown>;
  const liveFilesystemRecord = liveFilesystem as Record<string, unknown>;
  if (
    !openShellPolicyValuesEqual(
      filesystemPolicyWithoutPaths(intendedFilesystemRecord),
      filesystemPolicyWithoutPaths(liveFilesystemRecord),
    )
  ) {
    return false;
  }
  const intendedReadOnly = readUniquePaths(intendedFilesystemRecord, "read_only");
  const intendedReadWrite = readUniquePaths(intendedFilesystemRecord, "read_write");
  const liveReadOnly = readUniquePaths(liveFilesystemRecord, "read_only");
  const liveReadWrite = readUniquePaths(liveFilesystemRecord, "read_write");
  if (!intendedReadOnly || !intendedReadWrite || !liveReadOnly || !liveReadWrite) return false;
  if (
    setsOverlap(intendedReadOnly, intendedReadWrite) ||
    setsOverlap(liveReadOnly, liveReadWrite)
  ) {
    return false;
  }

  // The native direct-GPU create policy deliberately omits /proc so OpenShell can add it
  // read-write only after it observes GPU devices. Ordinary policies retain /proc read-only.
  if (intendedReadOnly.has(PROC_PATH) || intendedReadWrite.has(PROC_PATH)) return false;
  if (
    !isSubset(OPENSHELL_PROXY_REQUIRED_READ_ONLY_PATHS, intendedReadOnly) ||
    !isSubset(OPENSHELL_PROXY_REQUIRED_READ_WRITE_PATHS, intendedReadWrite)
  ) {
    return false;
  }
  if (liveReadOnly.has(PROC_PATH) || !liveReadWrite.has(PROC_PATH)) return false;
  if (!isSubset(intendedReadOnly, liveReadOnly) || !isSubset(intendedReadWrite, liveReadWrite)) {
    return false;
  }

  for (const path of liveReadOnly) {
    if (!intendedReadOnly.has(path) && !OPENSHELL_GPU_READ_ONLY_PATHS.has(path)) return false;
  }
  for (const path of liveReadWrite) {
    if (
      !intendedReadWrite.has(path) &&
      !OPENSHELL_GPU_READ_WRITE_PATHS.has(path) &&
      !OPENSHELL_GPU_DEVICE_PATH.test(path)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Materialize narrow native and compatibility fallback policies before sandbox-create side
 * effects. `preparePolicy` may create secure temporary files; every successful result carries its
 * cleanup, this function combines both cleanups, and a failed second materialization immediately
 * cleans the first. No provider, registry, gateway, or sandbox mutation occurs here.
 */
export function prepareSandboxGpuRoutePolicies(
  basePolicyPath: string,
  activeMessagingChannels: string[],
  options: InitialPolicyOptions,
  gpuRoutePlan: DockerGpuRoutePlan,
  preparePolicy: PrepareInitialSandboxCreatePolicy,
): SandboxGpuRoutePolicies {
  const initialCompatibility = initialDockerGpuRoute(gpuRoutePlan) === "compatibility";
  const initialSandboxPolicy = preparePolicy(basePolicyPath, activeMessagingChannels, {
    ...options,
    dockerGpuPatch: initialCompatibility,
  });
  let compatibilityPolicy: InitialSandboxPolicy | null = null;
  try {
    if (canFallbackToDockerGpuCompatibility(gpuRoutePlan)) {
      compatibilityPolicy = preparePolicy(basePolicyPath, activeMessagingChannels, {
        ...options,
        dockerGpuPatch: true,
      });
    }
  } catch (error) {
    initialSandboxPolicy.cleanup?.();
    throw error;
  }

  const cleanupFns = [initialSandboxPolicy.cleanup, compatibilityPolicy?.cleanup].filter(
    (cleanup): cleanup is () => boolean => Boolean(cleanup),
  );
  return {
    initialSandboxPolicy: {
      ...initialSandboxPolicy,
      cleanup:
        cleanupFns.length > 0
          ? () => cleanupFns.map((cleanup) => cleanup()).every(Boolean)
          : undefined,
    },
    compatibilityPolicyPath: initialCompatibility
      ? initialSandboxPolicy.policyPath
      : (compatibilityPolicy?.policyPath ?? null),
  };
}
