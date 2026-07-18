// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { findMissingDistSourcemapSources } from "../scripts/check-dist-sourcemaps.mts";

function writeCleanFixtureDist(root: string): string {
  const distLib = path.join(root, "dist", "lib");
  const srcLib = path.join(root, "src", "lib");
  fs.mkdirSync(distLib, { recursive: true });
  fs.mkdirSync(srcLib, { recursive: true });
  fs.writeFileSync(path.join(srcLib, "present.ts"), "export {};\n");
  fs.writeFileSync(
    path.join(distLib, "present.js.map"),
    JSON.stringify({ version: 3, sources: ["../../src/lib/present.ts"], mappings: "" }),
  );
  return path.join(root, "dist");
}

function writeStaleFixtureDist(root: string): string {
  const distDir = writeCleanFixtureDist(root);
  fs.writeFileSync(
    path.join(distDir, "lib", "missing.js.map"),
    JSON.stringify({ version: 3, sources: ["../../src/lib/missing.ts"], mappings: "" }),
  );
  return distDir;
}

describe("dist sourcemap checks", () => {
  it("reports JavaScript sourcemaps pointing at missing source files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sourcemap-check-"));
    const distDir = writeStaleFixtureDist(root);

    expect(findMissingDistSourcemapSources(distDir)).toEqual([
      `${path.join(distDir, "lib", "missing.js.map")} -> ../../src/lib/missing.ts`,
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("invoking the .mts entrypoint directly exits 0 for a clean dist directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sourcemap-cli-clean-"));
    const distDir = writeCleanFixtureDist(root);

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/check-dist-sourcemaps.mts", distDir],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `All JavaScript sourcemaps in ${distDir} reference existing sources.`,
    );

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("invoking the .mts entrypoint directly exits 1 and reports stale sources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sourcemap-cli-stale-"));
    const distDir = writeStaleFixtureDist(root);

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/check-dist-sourcemaps.mts", distDir],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Stale JavaScript sourcemap sources found in ${distDir}:`);
    expect(result.stderr).toContain(
      `${path.join(distDir, "lib", "missing.js.map")} -> ../../src/lib/missing.ts`,
    );

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("importing the .mts entrypoint does not run its CLI main", () => {
    const scriptUrl = pathToFileURL(path.resolve("scripts/check-dist-sourcemaps.mts")).href;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `import(${JSON.stringify(scriptUrl)}).then(() => { console.log("IMPORT_ONLY_OK"); });`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("IMPORT_ONLY_OK");
    expect(result.stdout).not.toContain("reference existing sources");
    expect(result.stdout).not.toContain("Stale JavaScript sourcemap sources found");
  });
});
