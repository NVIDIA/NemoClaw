// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  findCompiledInternalViolations,
  isScannedTestPath,
} from "../scripts/checks/no-test-dist-imports";
import { findProjectOverlaps, parseProjectListing } from "../scripts/checks/vitest-project-overlap";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const SOURCE_RUNTIME = path.join(REPO_ROOT, "test", "helpers", "onboard-script-mocks.cjs");

describe("compiled-test import boundary", () => {
  it("detects every supported compiled-internal reference shape", () => {
    const specifier = (target: string) => ["..", "dist", target].join("/");
    const fixture = [
      `import value from ${JSON.stringify(specifier("lib/value.js"))};`,
      `export { value } from ${JSON.stringify(specifier("commands/value.js"))};`,
      `require(${JSON.stringify(specifier("lib/required.js"))});`,
      `require.resolve(${JSON.stringify(specifier("nemoclaw.js"))});`,
      `import(${JSON.stringify(specifier("commands/dynamic.js"))});`,
      `path.join(repoRoot, ${JSON.stringify("dist")}, ${JSON.stringify("lib")}, "joined.js");`,
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(6);
    expect(violations.map(({ detail }) => detail)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("imports compiled CLI internals"),
        "constructs a path into dist/lib",
      ]),
    );
  });

  it("scans ordinary tests while preserving explicit package, live, and fixture lanes", () => {
    expect(isScannedTestPath("src/lib/example.test.ts")).toBe(true);
    expect(isScannedTestPath("test/example.test.ts")).toBe(true);
    expect(isScannedTestPath("test/package-contract/example.test.ts")).toBe(false);
    expect(isScannedTestPath("test/e2e/example.test.ts")).toBe(false);
    expect(isScannedTestPath("test/dist-sourcemaps.test.ts")).toBe(false);
  });
});

describe("Vitest project membership boundary", () => {
  it("accepts disjoint listings and reports duplicate membership", () => {
    const disjoint = parseProjectListing("[cli] src/a.test.ts\n[integration] test/b.test.ts\n");
    expect(findProjectOverlaps(disjoint.projectsByFile)).toEqual([]);

    const overlapping = parseProjectListing(
      "[cli] src/a.test.ts\n[integration] test/b.test.ts\n[package-contract] src/a.test.ts\n",
    );
    expect(findProjectOverlaps(overlapping.projectsByFile)).toEqual([
      ["src/a.test.ts", new Set(["cli", "package-contract"])],
    ]);
  });

  it("fails closed when Vitest listing output changes shape", () => {
    expect(() => parseProjectListing("unexpected output")).toThrow(
      "Could not parse Vitest project listing line",
    );
  });
});

describe("CommonJS source runtime", () => {
  it("rewrites relative JavaScript requests only within the source tree", () => {
    const sourceFixture = fs.mkdtempSync(path.join(REPO_ROOT, "src", ".source-loader-test-"));
    const outsideFixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-loader-test-"));

    try {
      for (const directory of [sourceFixture, outsideFixture]) {
        fs.writeFileSync(path.join(directory, "value.ts"), 'export const marker = "source";\n');
        fs.writeFileSync(
          path.join(directory, "parent.cjs"),
          'process.stdout.write(require("./value.js").marker);\n',
        );
      }

      const run = (directory: string) =>
        spawnSync(
          process.execPath,
          ["--require", SOURCE_RUNTIME, path.join(directory, "parent.cjs")],
          {
            cwd: REPO_ROOT,
            encoding: "utf8",
            env: { ...process.env, NODE_OPTIONS: "" },
          },
        );

      const inside = run(sourceFixture);
      expect(inside.status, inside.stderr).toBe(0);
      expect(inside.stdout).toBe("source");

      const outside = run(outsideFixture);
      expect(outside.status).not.toBe(0);
      expect(outside.stderr).toContain("Cannot find module './value.js'");
    } finally {
      fs.rmSync(sourceFixture, { force: true, recursive: true });
      fs.rmSync(outsideFixture, { force: true, recursive: true });
    }
  });
});
