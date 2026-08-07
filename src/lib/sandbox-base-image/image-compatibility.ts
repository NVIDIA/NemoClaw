// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { dockerCapture, dockerForceRm } from "../adapters/docker";
import { OPENSHELL_SANDBOX_MIN_GLIBC } from "./types";

const GLIBC_PROBE_TIMEOUTS_MS = [20_000, 120_000] as const;
const GLIBC_PROBE_CLEANUP_TIMEOUT_MS = 20_000;

function removeRetainedGlibcProbe(containerName: string): void {
  const removal = dockerForceRm(containerName, {
    ignoreError: true,
    suppressOutput: true,
    timeout: GLIBC_PROBE_CLEANUP_TIMEOUT_MS,
  });
  const remainingNames = dockerCapture(
    ["container", "ls", "--all", "--filter", `name=^/${containerName}$`, "--format", "{{.Names}}"],
    { timeout: GLIBC_PROBE_CLEANUP_TIMEOUT_MS },
  )
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);

  if (remainingNames.includes(containerName)) {
    const removalStatus = removal.error
      ? "failed before returning an exit status"
      : `returned status ${String(removal.status)}`;
    throw new Error(
      `Docker glibc probe cleanup ${removalStatus}; container ${containerName} is still present`,
    );
  }
}

export function parseGlibcVersion(output: string | null | undefined): string | null {
  const text = String(output || "");
  const firstLine = text.split(/\r?\n/).find((line) => line.trim());
  const match =
    firstLine?.match(/\s([0-9]+(?:\.[0-9]+)+)\s*$/) || text.match(/GLIBC\s+([0-9]+(?:\.[0-9]+)+)/i);
  return match ? match[1] : null;
}

export function versionGte(left = "0.0.0", right = "0.0.0"): boolean {
  const lhs = String(left)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const rhs = String(right)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(lhs.length, rhs.length);
  for (let index = 0; index < length; index += 1) {
    const a = lhs[index] || 0;
    const b = rhs[index] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

export function getImageGlibcVersion(imageRef: string): string | null {
  for (const timeout of GLIBC_PROBE_TIMEOUTS_MS) {
    const containerName = `nemoclaw-glibc-probe-${randomUUID()}`;
    let output = "";
    try {
      output = dockerCapture(
        [
          "run",
          "--rm",
          "--name",
          containerName,
          "--entrypoint",
          "/usr/bin/ldd",
          imageRef,
          "--version",
        ],
        { ignoreError: true, timeout },
      );
    } finally {
      if (!output) {
        removeRetainedGlibcProbe(containerName);
      }
    }
    if (output) return parseGlibcVersion(output);
  }
  return null;
}

export function imageMeetsMinimumGlibc(
  imageRef: string,
  minVersion = OPENSHELL_SANDBOX_MIN_GLIBC,
): { ok: boolean; version: string | null } {
  const version = getImageGlibcVersion(imageRef);
  return { ok: !!version && versionGte(version, minVersion), version };
}
