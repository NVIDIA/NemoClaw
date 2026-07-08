// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture } from "../adapters/docker";
import { OPENSHELL_SANDBOX_MIN_GLIBC } from "./types";

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
  const output = dockerCapture(
    ["run", "--rm", "--entrypoint", "/usr/bin/ldd", imageRef, "--version"],
    { ignoreError: true, timeout: 20_000 },
  );
  return parseGlibcVersion(output);
}

export function imageMeetsMinimumGlibc(
  imageRef: string,
  minVersion = OPENSHELL_SANDBOX_MIN_GLIBC,
): { ok: boolean; version: string | null } {
  const version = getImageGlibcVersion(imageRef);
  return { ok: !!version && versionGte(version, minVersion), version };
}
