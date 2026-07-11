// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverExecutionProfileRows,
  discoverExecutionProfileTests,
  type ExecutionProfileMatrixRow,
  type ExecutionProfileModule,
  executionProfileRowFromModule,
  HERMETIC_EXECUTION_PROFILE,
  selectExecutionProfileRows,
} from "../../../tools/e2e/execution-profile.mts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const EXECUTION_PROFILE_CLI = path.join(REPO_ROOT, "tools", "e2e", "execution-profile.mts");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TAG_COMMENT = `// @module-tag ${HERMETIC_EXECUTION_PROFILE.tag}`;

const SELECTION_ROWS: ExecutionProfileMatrixRow[] = [
  { id: "alpha", file: "test/e2e/live/alpha.test.ts", project: "e2e-live" },
  { id: "beta", file: "test/beta.test.ts", project: "integration" },
  { id: "gamma", file: "test/e2e/live/gamma.test.ts", project: "e2e-live" },
];

function module(overrides: Partial<ExecutionProfileModule> = {}): ExecutionProfileModule {
  return {
    file: "test/e2e/live/example.test.ts",
    project: "e2e-live",
    source: TAG_COMMENT,
    ...overrides,
  };
}

describe("hermetic E2E execution-profile discovery", () => {
  it("derives deterministic safe matrix rows without execution capabilities", () => {
    const rows = discoverExecutionProfileRows([
      module({ file: "test/zeta.test.ts", project: "integration" }),
      module({ file: "test/e2e/live/alpha.test.ts" }),
    ]);

    expect(rows).toEqual([
      { id: "alpha", file: "test/e2e/live/alpha.test.ts", project: "e2e-live" },
      { id: "zeta", file: "test/zeta.test.ts", project: "integration" },
    ]);
    expect(Object.keys(rows[0])).toEqual(["id", "file", "project"]);
  });

  it("rejects a profile-managed input without a profile tag", () => {
    expect(() => executionProfileRowFromModule(module({ source: "// no profile" }))).toThrow(
      "must declare exactly one e2e-profile/ module tag; found 0",
    );
  });

  it("rejects unknown execution profiles", () => {
    expect(() =>
      executionProfileRowFromModule(
        module({ source: `${"// @module"}-tag e2e-profile/privileged` }),
      ),
    ).toThrow("Unknown execution profile tag 'e2e-profile/privileged'");
  });

  it("rejects duplicate execution-profile tags", () => {
    expect(() =>
      executionProfileRowFromModule(module({ source: `${TAG_COMMENT}\n${TAG_COMMENT}` })),
    ).toThrow("must declare exactly one e2e-profile/ module tag; found 2");
  });

  it("only treats literal module-tag comments as profile declarations", () => {
    expect(() =>
      executionProfileRowFromModule(
        module({ source: `const example = ${JSON.stringify(TAG_COMMENT)};` }),
      ),
    ).toThrow("found 0");
    expect(() =>
      executionProfileRowFromModule(module({ source: `const example = \`\n${TAG_COMMENT}\n\`;` })),
    ).toThrow("found 0");
    expect(
      executionProfileRowFromModule(module({ source: `/* ${TAG_COMMENT.slice(3)} */` })),
    ).toEqual({
      id: "example",
      file: "test/e2e/live/example.test.ts",
      project: "e2e-live",
    });
  });

  it("rejects duplicate ids derived from different test files", () => {
    expect(() =>
      discoverExecutionProfileRows([
        module({ file: "test/e2e/live/nested/example.test.ts" }),
        module({ file: "test/example.test.ts", project: "integration" }),
      ]),
    ).toThrow(
      "Duplicate execution-profile test id 'example': test/e2e/live/nested/example.test.ts, test/example.test.ts",
    );
  });

  it.each([
    "../escape.test.ts",
    "/tmp/escape.test.ts",
    "test/e2e/live/../escape.test.ts",
    "test\\e2e\\live\\escape.test.ts",
    "test/e2e/live/bad id.test.ts",
  ])("rejects unsafe repo-relative test path %s", (file) => {
    expect(() => executionProfileRowFromModule(module({ file }))).toThrow(
      "must be a safe repo-relative test file",
    );
  });

  it("rejects unsafe ids derived from test filenames", () => {
    expect(() =>
      executionProfileRowFromModule(module({ file: "test/e2e/live/Bad_Name.test.ts" })),
    ).toThrow("filename must derive a safe id");
  });

  it("rejects a file that does not belong to its declared Vitest project", () => {
    expect(() =>
      executionProfileRowFromModule(
        module({ file: "test/e2e/live/example.test.ts", project: "integration" }),
      ),
    ).toThrow("integration execution-profile test must not live under test/e2e/");
  });

  it("discovers the tagged repository files through their real Vitest projects", () => {
    const rows = discoverExecutionProfileTests();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toEqual([...rows].sort((left, right) => left.id.localeCompare(right.id)));
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(["id", "file", "project"]);
      expect(row.file).toMatch(/^test\/.+\.test\.(?:js|ts)$/);
    }
  });

  it("selects the row intersection for jobs or targets and defaults to all rows", () => {
    expect(selectExecutionProfileRows(SELECTION_ROWS)).toEqual(SELECTION_ROWS);
    expect(
      selectExecutionProfileRows(SELECTION_ROWS, {
        jobs: "beta,alpha,unrelated-job",
      }),
    ).toEqual(SELECTION_ROWS.slice(0, 2));
    expect(selectExecutionProfileRows(SELECTION_ROWS, { targets: "gamma" })).toEqual([
      SELECTION_ROWS[2],
    ]);
    expect(selectExecutionProfileRows(SELECTION_ROWS, { jobs: "unrelated-job" })).toEqual([]);
  });

  it("rejects simultaneous jobs and targets selectors", () => {
    expect(() =>
      selectExecutionProfileRows(SELECTION_ROWS, {
        jobs: "alpha",
        targets: "gamma",
      }),
    ).toThrow("Use either jobs or targets, not both");
  });

  it("rejects non-canonical selector input", () => {
    expect(() => selectExecutionProfileRows(SELECTION_ROWS, { jobs: "../escape" })).toThrow(
      "Invalid jobs selector",
    );
  });

  it("prints one compact JSON matrix line from the CLI", () => {
    const [selected] = discoverExecutionProfileTests();
    expect(selected).toBeDefined();
    const result = spawnSync(TSX, [EXECUTION_PROFILE_CLI, "--jobs", selected.id], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify([selected])}\n`);
  });
});
