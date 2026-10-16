// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readOpenedRegularFile } from "../runtime/native-security.mts";

// The protected caller authenticates the run. This reader only binds its documents.
export function readAvailabilityDocuments(input: {
  evidenceRoot: string;
  evidenceManifestSha256: string;
}) {
  assert.match(input.evidenceManifestSha256, /^[a-f0-9]{64}$/u);
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const object = (value: unknown): Record<string, unknown> => {
    assert(value !== null && typeof value === "object" && !Array.isArray(value));
    return value as Record<string, unknown>;
  };
  const root = path.resolve(input.evidenceRoot);
  function read(relative: string) {
    const file = path.join(root, relative);
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
      const stat = fs.lstatSync(parent);
      assert(
        stat.isDirectory() && !stat.isSymbolicLink(),
        "Evidence traverses a linked directory.",
      );
      if (parent === root) break;
      assert(parent.startsWith(root + path.sep), "Evidence escaped its root.");
    }
    const bytes = readOpenedRegularFile(file, {
      maxBytes: 2 * 1024 * 1024,
      rejectLinks: true,
      rejectHardLinks: true,
    });
    assert(bytes && bytes.length > 0, "Required qualification evidence is missing.");
    return bytes;
  }
  const manifestBytes = read("evidence-manifest.json");
  assert.equal(digest(manifestBytes), input.evidenceManifestSha256);
  const manifest = object(JSON.parse(manifestBytes.toString("utf8")));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.classification, "accidental-runnable-free-windows-evidence");
  assert(
    Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 4096,
  );
  const entries = new Map<string, { bytes: number; sha256: string }>();
  for (const value of manifest.files) {
    const row = object(value);
    assert.equal(typeof row.path, "string");
    const name = row.path as string;
    assert(!name.includes("\\") && !name.includes("\0") && !path.isAbsolute(name));
    assert(name.split("/").every((part) => part && part !== "." && part !== ".."));
    assert(!entries.has(name.toLowerCase()), "Duplicate evidence path.");
    assert(typeof row.bytes === "number" && Number.isSafeInteger(row.bytes) && row.bytes >= 0);
    assert.equal(typeof row.sha256, "string");
    assert.match(row.sha256 as string, /^[a-f0-9]{64}$/u);
    entries.set(name.toLowerCase(), { bytes: row.bytes, sha256: row.sha256 as string });
  }
  return function document(relative: string) {
    const entry = entries.get(relative.toLowerCase());
    assert(entry, "Required qualification receipt is absent from the manifest.");
    const bytes = read(relative);
    assert.equal(bytes.length, entry.bytes);
    assert.equal(digest(bytes), entry.sha256, "Qualification receipt changed after staging.");
    return { bytes, sha256: entry.sha256, value: object(JSON.parse(bytes.toString("utf8"))) };
  };
}
