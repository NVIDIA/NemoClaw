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

  it("detects source-tree walks that feed source text assertions", () => {
    const cases = detectedCaseNames(`
      import fs from "node:fs";
      import path from "node:path";
      import { expect, it } from "vitest";

      function collectProductionFiles(dir: string): string[] {
        return fs.readdirSync(dir).flatMap((entry) => {
          const absolute = path.join(dir, entry);
          const stats = fs.statSync(absolute);
          if (stats.isDirectory()) return collectProductionFiles(absolute);
          if (absolute.endsWith(".ts") && !absolute.endsWith(".test.ts")) return [absolute];
          return [];
        });
      }

      it("asserts import boundaries by reading source files", () => {
        const files = collectProductionFiles(path.join(process.cwd(), "src/lib/example"));
        for (const file of files) {
          const source = fs.readFileSync(file, "utf8");
          const specifiers = source.match(/node:fs/g) ?? [];
          expect(specifiers).toEqual([]);
        }
      });
    `);

    expect(cases).toEqual(["asserts import boundaries by reading source files"]);
  });

  it("detects direct assertions against source-tree helper results", () => {
    const cases = detectedCaseNames(`
      import fs from "node:fs";
      import path from "node:path";
      import { expect, it } from "vitest";

      function expectedIds(dir = path.join(process.cwd(), "src/commands")): string[] {
        return fs.readdirSync(dir).flatMap((entry) => {
          if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) return [];
          return [entry.replace(/\\.ts$/, "")];
        });
      }

      it("asserts discovered command ids", () => {
        expect(["onboard"]).toEqual(expectedIds());
      });
    `);

    expect(cases).toEqual(["asserts discovered command ids"]);
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

  it("does not treat uncalled source-reader helpers as source text", () => {
    const cases = detectedCaseNames(`
      import { readFileSync } from "node:fs";
      import { expect, it } from "vitest";

      const loadSource = () => readFileSync("src/lib/example.ts", "utf8");

      it("asserts helper shape only", () => {
        expect(loadSource).toBeTypeOf("function");
      });
    `);

    expect(cases).toEqual([]);
  });
});
