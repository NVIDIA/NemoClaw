// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { CheckpointPortableRuntimeAuthority } from "../onboard-checkpoint-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function readCanonicalAbsolutePath(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || /[\0\r\n]/u.test(value)) return null;
  if (!path.isAbsolute(value) || path.normalize(value) !== value) return null;
  return value;
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

/** Parse the secret-free, current-user Podman authority shared by checkpoints and receipts. */
export function parsePortableRuntimeAuthority(
  value: unknown,
): CheckpointPortableRuntimeAuthority | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "ownership",
      "uid",
      "homeDir",
      "configHome",
      "runtimeDir",
      "socketPath",
    ])
  ) {
    return null;
  }
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "podman" ||
    value.ownership !== "current-user" ||
    !Number.isSafeInteger(value.uid) ||
    Number(value.uid) < 0
  ) {
    return null;
  }
  const homeDir = readCanonicalAbsolutePath(value.homeDir);
  const configHome = readCanonicalAbsolutePath(value.configHome);
  const runtimeDir = readCanonicalAbsolutePath(value.runtimeDir);
  const socketPath = readCanonicalAbsolutePath(value.socketPath);
  if (!homeDir || !configHome || !runtimeDir || !socketPath) return null;
  if (configHome !== path.join(homeDir, ".config")) return null;
  if (runtimeDir !== path.join("/run/user", String(value.uid))) return null;
  if (!isStrictDescendant(runtimeDir, socketPath)) return null;
  return {
    schemaVersion: 1,
    kind: "podman",
    ownership: "current-user",
    uid: Number(value.uid),
    homeDir,
    configHome,
    runtimeDir,
    socketPath,
  };
}
