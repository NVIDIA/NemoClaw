// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BlueprintManifest } from "./resolve.js";

export interface VerificationResult {
  valid: boolean;
  expectedDigest: string;
  actualDigest: string;
  errors: string[];
}

export function verifyBlueprintDigest(
  blueprintPath: string,
  manifest: BlueprintManifest,
): VerificationResult {
  const errors: string[] = [];
  const actualDigest = computeDirectoryDigest(blueprintPath);

  if (!manifest.digest) {
    errors.push("Security Error: Blueprint manifest is missing a 'digest'. Verification required.");
  } else if (manifest.digest !== actualDigest) {
    errors.push(`Digest mismatch: expected ${manifest.digest}, got ${actualDigest}`);
  }

  return {
    valid: errors.length === 0,
    expectedDigest: manifest.digest || "missing",
    actualDigest,
    errors,
  };
}

export function checkCompatibility(
  manifest: BlueprintManifest,
  openshellVersion: string,
  openclawVersion: string,
): string[] {
  const errors: string[] = [];

  if (
    manifest.minOpenShellVersion &&
    !satisfiesMinVersion(openshellVersion, manifest.minOpenShellVersion)
  ) {
    errors.push(`OpenShell version ${openshellVersion} < required ${manifest.minOpenShellVersion}`);
  }

  if (
    manifest.minOpenClawVersion &&
    !satisfiesMinVersion(openclawVersion, manifest.minOpenClawVersion)
  ) {
    errors.push(`OpenClaw version ${openclawVersion} < required ${manifest.minOpenClawVersion}`);
  }

  return errors;
}

function satisfiesMinVersion(actual: string, minimum: string): boolean {
  const aParts = actual.split(".").map(Number);
  const mParts = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(aParts.length, mParts.length); i++) {
    const a = aParts[i] ?? 0;
    const m = mParts[i] ?? 0;
    if (a > m) return true;
    if (a < m) return false;
  }
  return true; // equal
}

function computeDirectoryDigest(dirPath: string): string {
  const hash = createHash("sha256");
  const files = collectFiles(dirPath).sort();
  for (const file of files) {
    hash.update(file); // include relative path
    hash.update(readFileSync(join(dirPath, file)));
  }
  return hash.digest("hex");
}

const IGNORE_PATTERNS = [
  ".git",
  "node_modules",
  "__pycache__",
  ".DS_Store",
  "dist",
];

function collectFiles(dirPath: string, prefix = ""): string[] {
  const entries = readdirSync(dirPath);
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORE_PATTERNS.includes(entry)) continue;

    const fullPath = join(dirPath, entry);
    const relativePath = prefix ? `${prefix}/${entry}` : entry;
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectFiles(fullPath, relativePath));
    } else {
      // Don't include the blueprint manifest itself in the digest calculation
      // to avoid chicken-and-egg problem during release computation.
      if (entry === "blueprint.yaml") continue;
      files.push(relativePath);
    }
  }
  return files;
}
