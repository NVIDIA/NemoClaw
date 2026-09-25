// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

export type NpmPackArchive = {
  filename: string;
  name: string;
  version: string;
};

function isNpmPackArchive(value: unknown): value is NpmPackArchive {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.filename === "string" &&
    typeof record.name === "string" &&
    typeof record.version === "string"
  );
}

export function parseNpmPackArchives(stdout: string): NpmPackArchive[] {
  const parsed: unknown = JSON.parse(stdout);
  const entries = Array.isArray(parsed)
    ? parsed
    : isNpmPackArchive(parsed)
      ? [parsed]
      : parsed && typeof parsed === "object"
        ? Object.values(parsed)
        : [];
  assert.ok(
    entries.length > 0 && entries.every(isNpmPackArchive),
    "npm pack --json returned invalid package metadata",
  );
  return entries;
}
