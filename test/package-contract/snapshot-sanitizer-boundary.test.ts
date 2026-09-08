// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("emits both sanitizer modules from the shared boundary build owner", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-snapshot-shared-build-"));
    roots.push(root);
    const output = path.join(root, "dist");
    execFileSync(
      process.execPath,
      [
        path.join(REPOSITORY_ROOT, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        path.join(REPOSITORY_ROOT, "nemoclaw", "tsconfig.shared.json"),
        "--outDir",
        output,
        "--pretty",
        "false",
      ],
      { cwd: REPOSITORY_ROOT },
    );

    expect(existsSync(path.join(output, "shared", "snapshot-sanitizer-boundary.cjs"))).toBe(true);
    expect(existsSync(path.join(output, "shared", "snapshot-sanitizer-helper.mjs"))).toBe(true);
  });

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
