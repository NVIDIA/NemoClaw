// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectProductionCreateRequireSources,
  collectTestSupportCreateRequireSources,
  containsCreateRequireIdentifier,
  createRequireBudgetFailure,
} from "../scripts/checks/test-create-require-budget";

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
});
