// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sanitizeSnapshotDirectory } from "../../dist/lib/security/snapshot-sanitizer.js";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");
const roots: string[] = [];

function readManifest(relativePath: string): { dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, relativePath), "utf8")) as {
    dependencies?: Record<string, string>;
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("snapshot sanitizer package boundary", () => {
  it("ships and runs the compiled native helper", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-snapshot-package-"));
    roots.push(root);
    const configPath = path.join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ apiKey: "sk-package-contract-secret" }));

    sanitizeSnapshotDirectory(root);

    expect(readFileSync(configPath, "utf8")).not.toContain("sk-package-contract-secret");
  });

  it("pins fs-safe in both published runtime manifests", () => {
    expect(readManifest("package.json").dependencies?.["@openclaw/fs-safe"]).toBe("0.8.6");
    expect(readManifest("nemoclaw/package.json").dependencies?.["@openclaw/fs-safe"]).toBe("0.8.6");
  });
});
