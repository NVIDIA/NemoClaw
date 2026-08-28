// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import {
  analyzeSourceArchitecture,
  evaluateSourceArchitectureBudget,
  formatSourceArchitectureViolations,
  parseSourceArchitectureBudget,
  type SourceArchitectureBudget,
} from "../../scripts/checks/source-architecture.mts";
import { describe, expect, test } from "../helpers/owned-test-resources";
import { testTimeoutOptions } from "../helpers/timeouts";

const REPO_ROOT = path.join(import.meta.dirname, "../..");

function writeModule(root: string, file: string, source: string): void {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source);
}

function budget(overrides: Partial<SourceArchitectureBudget> = {}): SourceArchitectureBudget {
  return {
    fanIn: { defaultMax: 10 },
    fanOut: { defaultMax: 10 },
    allowedCycles: [],
    maxRootFiles: {},
    ...overrides,
  };
}

describe("source architecture budget (#7692)", () => {
  test(
    "accepts the reviewed repository baseline",
    testTimeoutOptions(60_000),
    () => {
      const parsed = parseSourceArchitectureBudget(
        fs.readFileSync(path.join(REPO_ROOT, "ci/source-architecture-budget.json"), "utf8"),
      );
      const report = analyzeSourceArchitecture(REPO_ROOT, {
        rootFileDirectories: Object.keys(parsed.maxRootFiles),
      });

      expect(evaluateSourceArchitectureBudget(report, parsed)).toEqual([]);
    },
  );

  test("rejects a new runtime cycle and names its files", ({ resources }) => {
    const root = resources.temporaryDirectory("nemoclaw-architecture-cycle-");
    writeModule(root, "src/a.ts", 'import "./b";\n');
    writeModule(root, "src/b.ts", 'import "./a";\n');

    const violations = evaluateSourceArchitectureBudget(
      analyzeSourceArchitecture(root, { scanRoots: ["src"] }),
      budget(),
    );

    expect(violations).toEqual([{ kind: "new-cycle", files: ["src/a.ts", "src/b.ts"] }]);
    expect(formatSourceArchitectureViolations(violations)).toContain(
      "New runtime cycle contains: src/a.ts, src/b.ts.",
    );
  });

  test("rejects fan-out above the default limit", ({ resources }) => {
    const root = resources.temporaryDirectory("nemoclaw-architecture-fan-out-");
    writeModule(root, "src/a.ts", 'import "./b";\nimport "./c";\n');
    writeModule(root, "src/b.ts", "export {};\n");
    writeModule(root, "src/c.ts", "export {};\n");

    const violations = evaluateSourceArchitectureBudget(
      analyzeSourceArchitecture(root, { scanRoots: ["src"] }),
      budget({ fanOut: { defaultMax: 1 } }),
    );

    expect(violations).toContainEqual({
      kind: "metric-limit",
      metric: "fan-out",
      file: "src/a.ts",
      actual: 2,
      limit: 1,
    });
  });

  test("requires a transitional root-file limit to decrease with its count", ({ resources }) => {
    const root = resources.temporaryDirectory("nemoclaw-architecture-root-files-");
    writeModule(root, "src/feature/a.ts", "export {};\n");

    const violations = evaluateSourceArchitectureBudget(
      analyzeSourceArchitecture(root, {
        scanRoots: ["src"],
        rootFileDirectories: ["src/feature"],
      }),
      budget({ maxRootFiles: { "src/feature": 2 } }),
    );

    expect(violations).toEqual([
      {
        kind: "root-file-ratchet",
        directory: "src/feature",
        actual: 1,
        limit: 2,
      },
    ]);
  });

  test("rejects transitional root-file growth above its limit", ({ resources }) => {
    const root = resources.temporaryDirectory("nemoclaw-architecture-root-growth-");
    writeModule(root, "src/feature/a.ts", "export {};\n");
    writeModule(root, "src/feature/b.ts", "export {};\n");
    const report = analyzeSourceArchitecture(root, {
      scanRoots: ["src"],
      rootFileDirectories: ["src/feature"],
    });

    expect(
      evaluateSourceArchitectureBudget(report, budget({ maxRootFiles: { "src/feature": 1 } })),
    ).toEqual([
      {
        kind: "root-file-limit",
        directory: "src/feature",
        actual: 2,
        limit: 1,
      },
    ]);
    expect(
      evaluateSourceArchitectureBudget(report, budget({ maxRootFiles: { "src/feature": 2 } })),
    ).toEqual([]);
  });

  test("resolves checked JavaScript imports", ({ resources }) => {
    const root = resources.temporaryDirectory("nemoclaw-architecture-languages-");
    writeModule(root, "bin/a.js", 'require("./b");\n');
    writeModule(root, "bin/b.js", "module.exports = {};\n");

    const report = analyzeSourceArchitecture(root, { scanRoots: ["bin"] });

    expect(report.fanOut).toMatchObject({ "bin/a.js": 1 });
    expect(report.fanIn).toMatchObject({ "bin/b.js": 1 });
  });

  test.for([
    { emittedExtension: ".js", sourceExtension: ".ts" },
    { emittedExtension: ".mjs", sourceExtension: ".mts" },
    { emittedExtension: ".cjs", sourceExtension: ".cts" },
  ])(
    "resolves checked $emittedExtension specifiers to $sourceExtension sources",
    ({ emittedExtension, sourceExtension }, { resources }) => {
      const root = resources.temporaryDirectory("nemoclaw-architecture-emitted-specifier-");
      writeModule(root, "src/a.ts", `import "./b${emittedExtension}";\n`);
      writeModule(root, `src/b${sourceExtension}`, "export {};\n");

      const report = analyzeSourceArchitecture(root, { scanRoots: ["src"] });

      expect(report.fanOut).toMatchObject({ "src/a.ts": 1 });
      expect(report.fanIn).toMatchObject({ [`src/b${sourceExtension}`]: 1 });
    },
  );

  test("resolves checked dynamic import specifiers", ({ resources }) => {
    const root = resources.temporaryDirectory("nemoclaw-architecture-dynamic-import-");
    writeModule(root, "src/a.ts", 'export const value = import("./b");\n');
    writeModule(root, "src/b.ts", "export const value = true;\n");

    const report = analyzeSourceArchitecture(root, { scanRoots: ["src"] });

    expect(report.fanOut).toMatchObject({ "src/a.ts": 1 });
    expect(report.fanIn).toMatchObject({ "src/b.ts": 1 });
  });

  test("resolves checked nested import-equals specifiers", ({ resources }) => {
    const root = resources.temporaryDirectory("nemoclaw-architecture-import-equals-");
    writeModule(
      root,
      "src/a.ts",
      'namespace scope { export import dependency = require("./b"); }\n',
    );
    writeModule(root, "src/b.ts", "export const value = true;\n");

    const report = analyzeSourceArchitecture(root, { scanRoots: ["src"] });

    expect(report.fanOut).toMatchObject({ "src/a.ts": 1 });
    expect(report.fanIn).toMatchObject({ "src/b.ts": 1 });
  });

  test("reports repository-relative paths through an aliased repository root (#7692)", ({
    resources,
  }) => {
    const root = resources.temporaryDirectory("nemoclaw-architecture-canonical-root-");
    const aliasRoot = path.join(
      resources.temporaryDirectory("nemoclaw-architecture-root-alias-"),
      "repo",
    );
    writeModule(root, "src/a.ts", 'import "./b";\n');
    writeModule(root, "src/b.ts", "export {};\n");
    fs.symlinkSync(root, aliasRoot, process.platform === "win32" ? "junction" : "dir");

    const report = analyzeSourceArchitecture(aliasRoot, {
      scanRoots: ["src"],
      rootFileDirectories: ["src"],
    });

    expect(report).toMatchObject({
      files: ["src/a.ts", "src/b.ts"],
      fanIn: { "src/a.ts": 0, "src/b.ts": 1 },
      fanOut: { "src/a.ts": 1, "src/b.ts": 0 },
      rootFiles: { src: 2 },
    });
  });

  test("ignores type-only dependency cycles", ({ resources }) => {
    const root = resources.temporaryDirectory("nemoclaw-architecture-types-");
    writeModule(root, "src/a.ts", 'import type { B } from "./b";\nexport type A = B;\n');
    writeModule(root, "src/b.ts", 'export type { A as B } from "./a";\n');

    expect(analyzeSourceArchitecture(root, { scanRoots: ["src"] }).cycles).toEqual([]);
  });
});
