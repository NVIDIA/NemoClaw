// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { PARSER_EXIT_CODE, run } from "./helpers";

function expectCleanParseFailure(out: string): void {
  expect(out).not.toMatch(/^\s+at /m);
  expect(out).not.toContain("Node.js v");
  expect(out).not.toContain("@oclif/core/lib/parser");
  expect(out).not.toContain("InvalidOptionError");
  expect(out).not.toContain("showHelp:");
}

describe("oclif parse errors", () => {
  it("reports an invalid enum flag value without a stack trace (#8123)", () => {
    const r = run(
      "inference set --provider compatible-endpoint --model gpt-4o-mini --reasoning-effort ultra --no-verify",
    );

    expect(r.code).toBe(PARSER_EXIT_CODE);
    expect(r.out).toContain(
      "Expected --reasoning-effort=ultra to be one of: low, medium, high, default",
    );
    expectCleanParseFailure(r.out);
  });

  it("reports an invalid enum argument value without a stack trace (#8123)", () => {
    const r = run("completion powershell");

    expect(r.code).toBe(PARSER_EXIT_CODE);
    expect(r.out).toContain("Expected powershell to be one of: bash, zsh, fish");
    expectCleanParseFailure(r.out);
  });
});
