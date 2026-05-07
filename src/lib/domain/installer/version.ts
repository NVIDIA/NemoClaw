// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MIN_NODE_VERSION = "22.16.0";
export const MIN_NPM_MAJOR = 10;

export type RuntimeCheckResult =
  | { ok: true; nodeVersion: string; npmVersion: string }
  | { ok: false; reason: "invalid-node-version" | "invalid-npm-version" | "unsupported" };

const SEMVER_RE = /^[0-9]+(\.[0-9]+){0,2}$/;

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, "");
}

export function versionMajor(version: string): number | null {
  const major = normalizeVersion(version).split(".")[0] ?? "";
  return /^[0-9]+$/.test(major) ? Number.parseInt(major, 10) : null;
}

export function versionGte(actual: string, minimum: string): boolean {
  const normalizedActual = normalizeVersion(actual);
  const normalizedMinimum = normalizeVersion(minimum);
  if (!SEMVER_RE.test(normalizedActual) || !SEMVER_RE.test(normalizedMinimum)) return false;

  const actualParts = normalizedActual.split(".").map((part) => Number.parseInt(part, 10));
  const minimumParts = normalizedMinimum.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index += 1) {
    const actualPart = actualParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;
    if (actualPart > minimumPart) return true;
    if (actualPart < minimumPart) return false;
  }
  return true;
}

export function checkInstallerRuntime(input: {
  minNodeVersion?: string;
  minNpmMajor?: number;
  nodeVersion: string;
  npmVersion: string;
}): RuntimeCheckResult {
  const nodeVersion = input.nodeVersion.trim();
  const npmVersion = input.npmVersion.trim();
  const npmMajor = versionMajor(npmVersion);

  if (!SEMVER_RE.test(normalizeVersion(nodeVersion))) return { ok: false, reason: "invalid-node-version" };
  if (npmMajor === null) return { ok: false, reason: "invalid-npm-version" };

  if (
    !versionGte(nodeVersion, input.minNodeVersion ?? MIN_NODE_VERSION) ||
    npmMajor < (input.minNpmMajor ?? MIN_NPM_MAJOR)
  ) {
    return { ok: false, reason: "unsupported" };
  }

  return { ok: true, nodeVersion, npmVersion };
}
