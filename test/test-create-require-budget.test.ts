// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";

import {
  extractTrustedCreateRequireAllowlists,
  trustedCreateRequireExpansionFailure,
} from "../.github/actions/ci-static-checks/create-require-ratchet-core.mts";
import {
  collectProductionCreateRequireSources,
  collectTestSupportCreateRequireSources,
  containsCreateRequireIdentifier,
  createRequireAllowlistExpansionFailure,
  createRequireBudgetFailure,
  extractCreateRequireAllowlists,
} from "../scripts/checks/test-create-require-budget.mts";

const tempDirs = new Set<string>();

afterEach(() => {
  for (const directory of tempDirs) fs.rmSync(directory, { force: true, recursive: true });
  tempDirs.clear();
});

describe("CLI createRequire budget", () => {
  it("detects direct and namespace-qualified createRequire references (#6245)", () => {
    expect(
      containsCreateRequireIdentifier(
        'import { createRequire } from "node:module";\ncreateRequire(import.meta.url);',
      ),
    ).toBe(true);
    expect(
      containsCreateRequireIdentifier(
        'import * as nodeModule from "node:module";\nnodeModule.createRequire(import.meta.url);',
      ),
    ).toBe(true);
  });

  it("ignores comments and string data that only mention createRequire (#6245)", () => {
    expect(
      containsCreateRequireIdentifier(
        '// createRequire is documentation\nconst fixture = "createRequire(import.meta.url)";',
      ),
    ).toBe(false);
    expect(
      containsCreateRequireIdentifier("const fixture = `createRequire(${notExecutable})`;"),
    ).toBe(false);
  });

  it("conservatively treats arbitrary createRequire properties as boundaries (#6245)", () => {
    expect(
      containsCreateRequireIdentifier("const helper = { createRequire: () => undefined };"),
    ).toBe(true);
    expect(containsCreateRequireIdentifier("helper.createRequire();")).toBe(true);
  });

  it("treats a production createRequire identifier as a real boundary (#6245)", () => {
    expect(containsCreateRequireIdentifier("function createRequire() {}")).toBe(true);
  });

  it("scans TypeScript module variants and non-test support files (#6245)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-require-budget-"));
    tempDirs.add(directory);
    fs.writeFileSync(
      path.join(directory, "production.mts"),
      'import { createRequire } from "node:module";',
    );
    fs.writeFileSync(
      path.join(directory, "helper.cts"),
      'import { createRequire } from "node:module";',
    );
    fs.writeFileSync(
      path.join(directory, "excluded.test.tsx"),
      'import { createRequire } from "node:module";',
    );
    fs.writeFileSync(
      path.join(directory, "component.tsx"),
      [
        'import { createRequire } from "node:module";',
        "export const fixture = <div>{createRequire(import.meta.url)}</div>;",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(directory, "jsx-text.tsx"),
      "export const fixture = <div>createRequire</div>;",
    );

    expect(
      collectProductionCreateRequireSources(directory).map((file) => path.basename(file)),
    ).toEqual(["component.tsx", "helper.cts", "production.mts"]);
    expect(
      collectTestSupportCreateRequireSources(directory).map((file) => path.basename(file)),
    ).toEqual(["component.tsx", "helper.cts", "production.mts"]);
  });

  it("does not follow symlinks outside the configured scan root (#6245)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-require-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-require-outside-"));
    tempDirs.add(directory);
    tempDirs.add(outside);
    fs.writeFileSync(
      path.join(outside, "external.ts"),
      'import { createRequire } from "node:module";',
    );
    fs.symlinkSync(outside, path.join(directory, "external"), "dir");
    fs.symlinkSync(path.join(outside, "external.ts"), path.join(directory, "external.ts"), "file");

    expect(collectProductionCreateRequireSources(directory)).toEqual([]);
    expect(collectTestSupportCreateRequireSources(directory)).toEqual([]);
  });

  it("requires the budget to fall with the remaining file count (#6245)", () => {
    expect(createRequireBudgetFailure(["src/a.test.ts"], ["src/a.test.ts"])).toBeNull();
    expect(
      createRequireBudgetFailure(["src/a.test.ts"], ["src/a.test.ts", "src/b.test.ts"]),
    ).toContain("Remove retired paths from CLI_CREATE_REQUIRE_FILES");
  });

  it("rejects a new path even when it replaces an allowed path one-for-one (#6245)", () => {
    const failure = createRequireBudgetFailure(
      ["src/allowed.test.ts", "src/new.test.ts"],
      ["src/allowed.test.ts", "src/retired.test.ts"],
    );

    expect(failure).toContain("src/new.test.ts");
    expect(failure).toContain("src/retired.test.ts");
  });

  it("rejects allowlist additions relative to the merge base while permitting removals (#6245)", () => {
    expect(
      createRequireAllowlistExpansionFailure(
        { cli: ["src/a.test.ts"], testSupport: [] },
        { cli: ["src/a.test.ts", "src/retired.test.ts"], testSupport: ["test/retired.ts"] },
      ),
    ).toBeNull();

    expect(
      createRequireAllowlistExpansionFailure(
        { cli: ["src/a.test.ts", "src/new.test.ts"], testSupport: ["test/new.ts"] },
        { cli: ["src/a.test.ts"], testSupport: [] },
      ),
    ).toBe(
      [
        "createRequire allowlists must not expand relative to the merge base.",
        "- CLI_CREATE_REQUIRE_FILES: src/new.test.ts",
        "- TEST_SUPPORT_CREATE_REQUIRE_FILES: test/new.ts",
      ].join("\n"),
    );
  });

  it("extracts only literal reviewed allowlists from the merge-base source (#6245)", () => {
    const source = [
      'export const CLI_CREATE_REQUIRE_FILES = ["src/a.test.ts"] as const;',
      'export const TEST_SUPPORT_CREATE_REQUIRE_FILES = ["test/helper.ts"] as const;',
    ].join("\n");

    expect(extractCreateRequireAllowlists(source)).toEqual({
      cli: ["src/a.test.ts"],
      testSupport: ["test/helper.ts"],
    });
    expect(() =>
      extractCreateRequireAllowlists(
        [
          "const dynamicPath = getPath();",
          "export const CLI_CREATE_REQUIRE_FILES = [dynamicPath] as const;",
          "export const TEST_SUPPORT_CREATE_REQUIRE_FILES = [] as const;",
        ].join("\n"),
      ),
    ).toThrow("CLI_CREATE_REQUIRE_FILES must be a literal string array");
  });

  it("duplicates the ratchet in base-trusted CI code that rejects PR additions (#6245)", () => {
    const baselineSource = [
      'export const CLI_CREATE_REQUIRE_FILES = ["src/a.test.ts"] as const;',
      "export const TEST_SUPPORT_CREATE_REQUIRE_FILES = [] as const;",
    ].join("\n");
    const currentSource = [
      'export const CLI_CREATE_REQUIRE_FILES = ["src/a.test.ts", "src/new.test.ts"] as const;',
      'export const TEST_SUPPORT_CREATE_REQUIRE_FILES = ["test/new.ts"] as const;',
    ].join("\n");

    expect(
      trustedCreateRequireExpansionFailure(
        extractTrustedCreateRequireAllowlists(ts, currentSource, "current-checker.mts"),
        extractTrustedCreateRequireAllowlists(ts, baselineSource, "baseline-checker.mts"),
      ),
    ).toContain("src/new.test.ts");
    expect(
      trustedCreateRequireExpansionFailure(
        extractTrustedCreateRequireAllowlists(ts, currentSource, "current-checker.mts"),
        extractTrustedCreateRequireAllowlists(ts, baselineSource, "baseline-checker.mts"),
      ),
    ).toContain("test/new.ts");
  });
});
