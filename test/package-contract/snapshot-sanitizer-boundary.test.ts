// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  it("emits and runs both sanitizer modules from the shared boundary build owner", () => {
    const root = mkdtempSync(
      path.join(REPOSITORY_ROOT, "node_modules", ".nemoclaw-snapshot-shared-build-"),
    );
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

    const boundaryPath = path.join(output, "shared", "snapshot-sanitizer-boundary.cjs");
    const helperPath = path.join(output, "shared", "snapshot-sanitizer-helper.mjs");
    expect(existsSync(boundaryPath)).toBe(true);
    expect(existsSync(helperPath)).toBe(true);

    const snapshotPath = path.join(root, "snapshot");
    mkdirSync(snapshotPath);
    const observed = lstatSync(snapshotPath, { bigint: true });
    const request = {
      root: {
        canonicalPath: realpathSync(snapshotPath),
        identity: {
          dev: String(observed.dev),
          ino: String(observed.ino),
          mode: String(observed.mode),
          nlink: String(observed.nlink),
          size: String(observed.size),
          mtimeNs: String(observed.mtimeNs),
          ctimeNs: String(observed.ctimeNs),
        },
      },
      name: "installed.txt",
      content: Buffer.from("installed by emitted helper", "utf8").toString("base64"),
    };
    const result = spawnSync(process.execPath, [helperPath, "install"], {
      encoding: "utf8",
      env: {},
      input: JSON.stringify(request),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, result: true });
    expect(readFileSync(path.join(snapshotPath, "installed.txt"), "utf8")).toBe(
      "installed by emitted helper",
    );
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
