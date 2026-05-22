// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function importSpecifiersFor(repoPath: string): string[] {
  const source = fs.readFileSync(path.join(process.cwd(), repoPath), "utf-8");
  const specifiers: string[] = [];
  const importPattern = /import(?:\s+type)?\s+(?:[^";]+?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

describe("public argv translation boundaries", () => {
  it("keeps public argv translation independent from runtime dispatch side effects", () => {
    expect(importSpecifiersFor("src/lib/cli/public-argv-translation.ts").sort()).toEqual([
      "./oclif-metadata",
      "./public-route-metadata",
    ]);
  });

  it("keeps public dispatch responsible for registry recovery and oclif execution", () => {
    const dispatchImports = importSpecifiersFor("src/lib/cli/public-dispatch.ts");
    expect(dispatchImports).toEqual(
      expect.arrayContaining([
        "./argv-normalizer",
        "./public-argv-translation",
      ]),
    );

    const translationImports = importSpecifiersFor("src/lib/cli/public-argv-translation.ts");
    expect(translationImports).not.toContain("./oclif-runner");
    expect(translationImports).not.toContain("../state/registry");
    expect(translationImports).not.toContain("../registry-recovery-action");
  });
});
