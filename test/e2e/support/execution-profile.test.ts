// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverExecutionProfileRows,
  discoverExecutionProfileTests,
  type ExecutionProfileModule,
  executionProfileRowFromModule,
  HERMETIC_EXECUTION_PROFILE,
} from "../../../tools/e2e/execution-profile.mts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const EXECUTION_PROFILE_CLI = path.join(REPO_ROOT, "tools", "e2e", "execution-profile.mts");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TAG_COMMENT = `// @module-tag ${HERMETIC_EXECUTION_PROFILE.tag}`;

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

  it("prints one compact JSON matrix line from the CLI", () => {
    const expected = discoverExecutionProfileTests();
    expect(expected.length).toBeGreaterThan(0);
    const result = spawnSync(TSX, [EXECUTION_PROFILE_CLI], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
  });

  it("rejects selector arguments owned by the workflow planner", () => {
    const result = spawnSync(TSX, [EXECUTION_PROFILE_CLI, "--jobs", "docs-validation"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "::error::Execution-profile discovery does not accept selectors; use workflow-plan.mts",
    );
  });
});
