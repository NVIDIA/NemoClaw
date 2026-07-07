// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { findLiveUnitBlocks, formatViolations } from "../scripts/checks/no-unit-blocks-in-live-e2e";

const FILE = "test/e2e/live/example.test.ts";

function linesFlagged(source: string): number[] {
  return findLiveUnitBlocks(source, FILE).map((v) => v.line);
}

describe("live E2E unit-block guard", () => {
  it("flags the it(...) unit primitive parked in a live file", () => {
    const source = [
      'describe("local classifiers", () => {',
      '  it("does something pure", () => {',
      "    expect(true).toBe(true);",
      "  });",
      "});",
    ].join("\n");
    expect(linesFlagged(source)).toEqual([2]);
  });

  it("flags it.each / it.only / it.skip member forms", () => {
    const source = [
      'it.each([1, 2])("case %s", () => {});',
      'it.only("focused", () => {});',
      'it.skip("skipped unit", () => {});',
    ].join("\n");
    expect(linesFlagged(source)).toEqual([1, 2, 3]);
  });

  it("does not flag test(...) — the live-case primitive", () => {
    const source = [
      'test("live case", async ({ host }) => {});',
      'test("live case with module helpers", async () => {});',
      'test.skipIf(process.platform !== "linux")("gated live case", async ({ sandbox }) => {});',
    ].join("\n");
    expect(linesFlagged(source)).toEqual([]);
  });

  it("does not flag platform-gated wrappers or test aliases", () => {
    const source = [
      'const liveTest = process.platform === "linux" ? test : test.skip;',
      'liveTest("a gated live case", async ({ host }) => {});',
      'openClawTest("openclaw live case", async ({ sandbox }) => {});',
      'describe.sequential("live targets", () => {',
      '  hermesTest("hermes live case", async ({ host }) => {});',
      "});",
    ].join("\n");
    expect(linesFlagged(source)).toEqual([]);
  });

  it("does not flag the vitest import or commented-out it(...) references", () => {
    const source = [
      'import { describe, it, test } from "vitest";',
      '// it("a commented unit case", () => {});',
      ' * it("a jsdoc example", () => {});',
    ].join("\n");
    expect(linesFlagged(source)).toEqual([]);
  });

  it("does not match it inside a longer identifier", () => {
    const source = [
      'const wait = () => {}; wait("not a test");',
      'commitEditor("noop", () => {});',
    ].join("\n");
    expect(linesFlagged(source)).toEqual([]);
  });

  it("formats a violation with file, line, and the offending text", () => {
    const violations = findLiveUnitBlocks('  it("x", () => {});', FILE);
    const rendered = formatViolations(violations);
    expect(rendered).toContain(`${FILE}:1`);
    expect(rendered).toContain('it("x"');
    expect(rendered).toContain("never runs");
  });
});
