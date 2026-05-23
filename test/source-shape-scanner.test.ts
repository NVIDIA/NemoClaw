// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { scanTextForTest } from "../scripts/find-source-shape-tests";

function detectedCaseNames(source: string): string[] {
  return scanTextForTest("test/virtual-source-shape.test.ts", source).map((entry) => entry.name);
}

describe("source-shape scanner", () => {
  it("detects source reads through variable-declared arrow helpers", () => {
    const cases = detectedCaseNames(`
      import { readFileSync } from "node:fs";
      import path from "node:path";
      import { expect, it } from "vitest";

      const loadSource = (repoPath: string) => readFileSync(path.join(process.cwd(), repoPath), "utf8");

      it("asserts source text", () => {
        const source = loadSource("src/lib/example.ts");
        expect(source).toContain("implementation detail");
      });
    `);

    expect(cases).toEqual(["asserts source text"]);
  });

  it("detects source reads through variable-declared function expression helpers", () => {
    const cases = detectedCaseNames(`
      import fs from "node:fs";
      import path from "node:path";
      import { expect, it } from "vitest";

      const loadSource = function (repoPath: string) {
        return fs.readFileSync(path.join(process.cwd(), repoPath), "utf8");
      };

      it("asserts function-expression source text", () => {
        const source = loadSource("scripts/example.sh");
        expect(source).not.toContain("implementation detail");
      });
    `);

    expect(cases).toEqual(["asserts function-expression source text"]);
  });
});
