// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { findCoverageIgnoreDirectives } from "../scripts/checks/no-coverage-ignore";

const forbiddenDirective = ["v8", "ignore"].join(" ");

describe("coverage ignore guard", () => {
  it("flags line comment directives", () => {
    const source = `// ${forbiddenDirective} next`;

    expect(findCoverageIgnoreDirectives(source, "src/example.ts")).toMatchObject([
      { filePath: "src/example.ts", line: 1, column: 1, text: source },
    ]);
  });

  it("flags block comment directives", () => {
    const source = `const value = 1; /* ${forbiddenDirective} next */`;

    expect(findCoverageIgnoreDirectives(source, "src/example.ts")).toMatchObject([
      { filePath: "src/example.ts", line: 1, column: 18, text: source },
    ]);
  });

  it("allows non-comment string literals mentioning the directive", () => {
    const source = `const marker = '${forbiddenDirective} next';`;

    expect(findCoverageIgnoreDirectives(source, "src/example.ts")).toEqual([]);
  });
});
