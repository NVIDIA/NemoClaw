// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { resolveOpenshellBinaryOrNull } from "../adapters/openshell/resolve-shared";
import { type BoundedExecutableSnapshot, snapshotBoundedExecutable } from "./bounded-file";
import { parseCuaRuntimeReadiness } from "./schema";

const MAX_OPENSHELL_BINARY_BYTES = 64 * 1024 * 1024;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

export interface CuaOpenshellSnapshotOptions {
  selectedBinary?: string;
  expectedDigest?: string;
  env?: NodeJS.ProcessEnv;
}

/** Read the exact OpenShell digest from stored readiness without accepting a partial shape. */
export function getStoredCuaOpenshellDigest(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return parseCuaRuntimeReadiness(value).components.openshell.digest;
}

/**
 * Resolve OpenShell once and copy its exact bytes into a private executable snapshot.
 *
 * CUA observations invoke only the returned canonical snapshot. This prevents an
 * override or symlink from selecting different bytes after readiness hashes the
 * source. A supplied readiness or receipt digest is checked before the copy can run.
 */
export function snapshotCuaOpenshellExecutable(
  options: CuaOpenshellSnapshotOptions = {},
): BoundedExecutableSnapshot {
  const env = options.env ?? process.env;
  const selected =
    options.selectedBinary?.trim() ||
    env.NEMOCLAW_OPENSHELL_BIN?.trim() ||
    resolveOpenshellBinaryOrNull();
  if (!selected || !path.isAbsolute(selected)) {
    throw new Error("CUA requires one absolute OpenShell executable path");
  }
  if (options.expectedDigest !== undefined && !SHA256_DIGEST.test(options.expectedDigest)) {
    throw new Error("CUA OpenShell executable expected digest is invalid");
  }

  let canonical: string;
  try {
    canonical = fs.realpathSync(selected);
  } catch {
    throw new Error("CUA OpenShell executable is unavailable");
  }
  if (!path.isAbsolute(canonical)) {
    throw new Error("CUA OpenShell executable canonical path is invalid");
  }

  const snapshot = snapshotBoundedExecutable(canonical, {
    label: "CUA OpenShell executable",
    minBytes: 1,
    maxBytes: MAX_OPENSHELL_BINARY_BYTES,
    temporaryDirectoryPrefix: "nemoclaw-cua-openshell-",
    ...(options.expectedDigest ? { expectedDigest: options.expectedDigest } : {}),
  });
  return { ...snapshot, executable: fs.realpathSync(snapshot.executable) };
}
