// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { type OpenRegularFile, openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import { DEFAULT_GATEWAY_PORT } from "../../core/ports";

export { DEFAULT_GATEWAY_PORT } from "../../core/ports";

export const BASE_GATEWAY_STATE_DIR_NAME = "openshell-docker-gateway";
export const MANAGED_GATEWAY_STATE_ROOT_MARKER = ".nemoclaw-managed-gateway-state.json";
const MANAGED_GATEWAY_STATE_ROOT_MARKER_MAX_BYTES = 4096;

export class UnsafeGatewayStateDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeGatewayStateDirectoryError";
  }
}

export function resolveGatewayStateDirName(port: number): string {
  return port === DEFAULT_GATEWAY_PORT
    ? BASE_GATEWAY_STATE_DIR_NAME
    : `${BASE_GATEWAY_STATE_DIR_NAME}-${port}`;
}

export function resolveGatewayStateDirForPort(options: {
  configured?: string;
  home: string;
  port: number;
}): string {
  const defaultRoot = path.resolve(options.home, ".local", "state", "nemoclaw");
  const configured = options.configured?.trim();
  if (!configured) return path.join(defaultRoot, resolveGatewayStateDirName(options.port));
  if (!path.isAbsolute(configured)) {
    throw new UnsafeGatewayStateDirectoryError(
      "NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR must be an absolute dedicated gateway state directory.",
    );
  }
  const resolved = path.resolve(configured);
  const relativeDefaultRoot = path.relative(resolved, defaultRoot);
  const containsDefaultRoot =
    relativeDefaultRoot === "" ||
    (relativeDefaultRoot !== ".." &&
      !relativeDefaultRoot.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeDefaultRoot));
  if (containsDefaultRoot) {
    throw new UnsafeGatewayStateDirectoryError(
      "NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR must not select the shared NemoClaw state root or one of its parent directories.",
    );
  }
  return resolved;
}

interface ManagedGatewayStateRootTarget {
  gatewayName: string;
  gatewayPort: number;
  stateDir: string;
}

function expectedStateRootMarker(target: ManagedGatewayStateRootTarget) {
  return {
    gatewayName: target.gatewayName,
    gatewayPort: target.gatewayPort,
    schemaVersion: 1,
    stateDir: path.resolve(target.stateDir),
  } as const;
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("gateway state directory ownership verification is unavailable");
  }
  return process.getuid();
}

function stateRootMarkerOwnershipFailure(target: ManagedGatewayStateRootTarget): string | null {
  const stateDir = path.resolve(target.stateDir);
  const markerPath = path.join(stateDir, MANAGED_GATEWAY_STATE_ROOT_MARKER);
  let directory: fs.Stats;
  try {
    directory = fs.lstatSync(stateDir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "the managed gateway state root marker is missing"
      : "the managed gateway state root marker cannot be inspected";
  }
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== currentUid() ||
    (directory.mode & 0o777) !== 0o700
  ) {
    return "the gateway state directory is not an owner-controlled real directory with mode 0700";
  }
  let markerFile: OpenRegularFile;
  try {
    markerFile = openRegularFileNoFollow(markerPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "the managed gateway state root marker is missing"
      : "the managed gateway state root marker cannot be inspected safely";
  }
  try {
    const marker = markerFile.stat();
    if (
      !marker.isFile() ||
      marker.nlink !== 1 ||
      marker.uid !== directory.uid ||
      (marker.mode & 0o077) !== 0
    ) {
      return "the managed gateway state root marker is not a private owned regular file";
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        markerFile.readBytes(MANAGED_GATEWAY_STATE_ROOT_MARKER_MAX_BYTES).toString("utf8"),
      );
    } catch {
      return "the managed gateway state root marker cannot be read safely as valid JSON";
    }
    const expected = expectedStateRootMarker(target);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as typeof expected).schemaVersion !== 1 ||
      (parsed as typeof expected).gatewayName !== expected.gatewayName ||
      (parsed as typeof expected).gatewayPort !== expected.gatewayPort ||
      (parsed as typeof expected).stateDir !== expected.stateDir
    ) {
      return "the managed gateway state root marker does not identify the selected gateway and directory";
    }
    return null;
  } finally {
    markerFile.close();
  }
}

/** Reserve or safely adopt an explicitly configured gateway root before onboarding writes it. */
export function ensureManagedGatewayStateRoot(
  target: ManagedGatewayStateRootTarget,
  options: { isLegacyManagedState?: () => boolean } = {},
): void {
  const stateDir = path.resolve(target.stateDir);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
    fs.chmodSync(stateDir, 0o700);
  }
  const markerPath = path.join(stateDir, MANAGED_GATEWAY_STATE_ROOT_MARKER);
  if (fs.existsSync(markerPath)) {
    const failure = stateRootMarkerOwnershipFailure({ ...target, stateDir });
    if (failure) throw new Error(`Unsafe gateway state directory: ${failure}.`);
    return;
  }
  const directory = fs.lstatSync(stateDir);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== currentUid() ||
    (directory.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      "Unsafe gateway state directory: the override must be an owner-controlled real directory with mode 0700.",
    );
  }
  if (fs.readdirSync(stateDir).length > 0 && !options.isLegacyManagedState?.()) {
    throw new Error(
      "Unsafe gateway state directory: refusing to adopt an existing nonempty directory without valid NemoClaw-managed gateway configuration.",
    );
  }
  let markerFile: OpenRegularFile | null = null;
  try {
    markerFile = openRegularFileNoFollow(markerPath, {
      create: true,
      mode: 0o600,
      writable: true,
    });
    markerFile.replaceUtf8(
      `${JSON.stringify(expectedStateRootMarker({ ...target, stateDir }), null, 2)}\n`,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    markerFile?.close();
  }
  const failure = stateRootMarkerOwnershipFailure({ ...target, stateDir });
  if (failure) throw new Error(`Unsafe gateway state directory: ${failure}.`);
}

/** Validate a port-bound marker, allowing owner-private generated pre-marker state. */
export function managedGatewayStateRootOwnershipFailure(
  target: ManagedGatewayStateRootTarget,
  options: { allowLegacyManagedState?: boolean } = {},
): string | null {
  const failure = stateRootMarkerOwnershipFailure(target);
  if (failure !== "the managed gateway state root marker is missing") return failure;
  return options.allowLegacyManagedState
    ? null
    : "the managed gateway state root marker and legacy managed configuration are both missing";
}
