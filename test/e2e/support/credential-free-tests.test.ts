// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_FREE_TEST_TAG,
  type CredentialFreeTestModule,
  credentialFreeTestProjectForFile,
  credentialFreeTestRowFromModule,
  discoverCredentialFreeTestRows,
  discoverCredentialFreeTests,
} from "../../../tools/e2e/credential-free-tests.mts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const CREDENTIAL_FREE_TESTS_CLI = path.join(REPO_ROOT, "tools", "e2e", "credential-free-tests.mts");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TAG_COMMENT = `// @module-tag ${CREDENTIAL_FREE_TEST_TAG}`;

function module(overrides: Partial<CredentialFreeTestModule> = {}): CredentialFreeTestModule {
  return {
    file: "test/e2e/live/example.test.ts",
    project: "e2e-live",
    source: TAG_COMMENT,
    ...overrides,
  };
}

describe("credential-free test discovery", () => {
  it.each([
    ["test/e2e/live/example.test.ts", "e2e-live"],
    ["test/e2e/live/nested/example.test.ts", "e2e-live"],
    ["test/example.test.ts", "integration"],
    ["test/nested/example.test.js", "integration"],
    ["test/e2e/support/example.test.ts", undefined],
    ["src/example.test.ts", undefined],
  ])("classifies %s in the expected Vitest project", (file, expected) => {
    expect(credentialFreeTestProjectForFile(file)).toBe(expected);
  });

  it("derives deterministic safe matrix rows without workflow capabilities", () => {
    const rows = discoverCredentialFreeTestRows([
      module({ file: "test/zeta.test.ts", project: "integration" }),
      module({ file: "test/e2e/live/alpha.test.ts" }),
    ]);

    expect(rows).toEqual([
      { id: "alpha", file: "test/e2e/live/alpha.test.ts", project: "e2e-live" },
      { id: "zeta", file: "test/zeta.test.ts", project: "integration" },
    ]);
    expect(Object.keys(rows[0])).toEqual(["id", "file", "project"]);
  });

  it("rejects a candidate without the credential-free tag", () => {
    expect(() => credentialFreeTestRowFromModule(module({ source: "// no tag" }))).toThrow(
      "must declare exactly one e2e/credential-free module tag; found 0",
    );
  });

  it("rejects unknown tags in the E2E namespace", () => {
    expect(() =>
      credentialFreeTestRowFromModule(
        module({ source: `${"// @module"}-tag e2e/credential-bearing` }),
      ),
    ).toThrow("Unknown E2E test tag 'e2e/credential-bearing' in test/e2e/live/example.test.ts");
  });

  it("rejects duplicate credential-free tags", () => {
    expect(() =>
      credentialFreeTestRowFromModule(module({ source: `${TAG_COMMENT}\n${TAG_COMMENT}` })),
    ).toThrow("must declare exactly one e2e/credential-free module tag; found 2");
  });

  it("only treats literal module-tag comments as credential-free declarations", () => {
    expect(() =>
      credentialFreeTestRowFromModule(
        module({ source: `const example = ${JSON.stringify(TAG_COMMENT)};` }),
      ),
    ).toThrow("found 0");
    expect(() =>
      credentialFreeTestRowFromModule(
        module({ source: `const example = \`\n${TAG_COMMENT}\n\`;` }),
      ),
    ).toThrow("found 0");
    expect(
      credentialFreeTestRowFromModule(module({ source: `/* ${TAG_COMMENT.slice(3)} */` })),
    ).toEqual({
      id: "example",
      file: "test/e2e/live/example.test.ts",
      project: "e2e-live",
    });
  });

  it("rejects duplicate ids derived from different test files", () => {
    expect(() =>
      discoverCredentialFreeTestRows([
        module({ file: "test/e2e/live/nested/example.test.ts" }),
        module({ file: "test/example.test.ts", project: "integration" }),
      ]),
    ).toThrow(
      "Duplicate credential-free test id 'example': test/e2e/live/nested/example.test.ts, test/example.test.ts",
    );
  });

  it.each([
    "../escape.test.ts",
    "/tmp/escape.test.ts",
    "test/e2e/live/../escape.test.ts",
    "test\\e2e\\live\\escape.test.ts",
    "test/e2e/live/bad id.test.ts",
  ])("rejects unsafe repo-relative test path %s", (file) => {
    expect(() => credentialFreeTestRowFromModule(module({ file }))).toThrow(
      "must be a safe repo-relative test file",
    );
  });

  it("rejects unsafe ids derived from test filenames", () => {
    expect(() =>
      credentialFreeTestRowFromModule(module({ file: "test/e2e/live/Bad_Name.test.ts" })),
    ).toThrow("filename must derive a safe id");
  });

  it("rejects a file that does not belong to its declared Vitest project", () => {
    expect(() =>
      credentialFreeTestRowFromModule(
        module({ file: "test/e2e/live/example.test.ts", project: "integration" }),
      ),
    ).toThrow("integration credential-free test must not live under test/e2e/");
  });

  it("discovers the tagged repository files through their real Vitest projects", () => {
    const rows = discoverCredentialFreeTests();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toEqual([...rows].sort((left, right) => left.id.localeCompare(right.id)));
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(["id", "file", "project"]);
      expect(row.file).toMatch(/^test\/.+\.test\.(?:js|ts)$/);
    }
  });

  it("prints one compact JSON matrix line from the CLI", () => {
    const expected = discoverCredentialFreeTests();
    expect(expected.length).toBeGreaterThan(0);
    const result = spawnSync(TSX, [CREDENTIAL_FREE_TESTS_CLI], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
  });

  it("rejects selector arguments owned by the workflow planner", () => {
    const result = spawnSync(TSX, [CREDENTIAL_FREE_TESTS_CLI, "--jobs", "docs-validation"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "::error::Credential-free test discovery does not accept selectors; use workflow-plan.mts",
    );
  });
});
