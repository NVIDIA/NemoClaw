// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  discoverMockParity,
  filterMockParityRelevantChangedFiles,
  isMockParityRelevantSourceChange,
  type MockParityManifest,
  validateMockParity,
} from "../../../scripts/checks/e2e-mock-parity.mts";

const live = "test/e2e/live/example.test.ts";
const liveHelper = "test/e2e/live/example-helper.ts";
const fast = "test/e2e/support/example.test.ts";
const TAGGED_NEW_SOURCE = "// @module-tag e2e/credential-free\n";
const exists = (file: string) => file === live || file === liveHelper || file === fast;

function manifest(entries: MockParityManifest["entries"]): MockParityManifest {
  return { version: 1, entries };
}

describe("changed live E2E mock parity", () => {
  it.each([
    ["array", "const values = [1, 2];", "const values = [1, 2,];"],
    ["call", "check(1, 2);", "check(1, 2,);"],
    ["parameter", "function check(first: number) {}", "function check(first: number,) {}"],
    ["object", "const options = { value: 1 };", "const options = { value: 1, };"],
    ["import", 'import { check } from "./check";', 'import { check, } from "./check";'],
    ["tuple", "type Values = [number, string];", "type Values = [number, string,];"],
    ["union", 'type Value = "a" | "b";', 'type Value = | "a" | "b";'],
    ["intersection", "type Value = A & B;", "type Value = & A & B;"],
  ])("ignores optional %s separators introduced by formatting", (_kind, base, head) => {
    expect(isMockParityRelevantSourceChange(base, head)).toBe(false);
  });

  it.each([
    ["array hole", "const values = [1,,];", "const values = [1,];"],
    ["comma operator", "const value = (first(), second());", "const value = second();"],
    ["runtime operator", "const value = first | second;", "const value = first & second;"],
    ["union member", 'type Value = "a" | "b";', 'type Value = "a" | "c";'],
    ["literal content", 'const value = "one,two";', 'const value = "onetwo";'],
  ])("retains a changed %s after ignoring optional separators", (_kind, base, head) => {
    expect(isMockParityRelevantSourceChange(base, head)).toBe(true);
  });

  it("retains recognized module-tag changes while ignoring ordinary comments", () => {
    expect(
      isMockParityRelevantSourceChange(
        "// SPDX-License-Identifier: Apache-2.0\n\nexport {};\n",
        "// SPDX-License-Identifier: Apache-2.0\n// @module-tag e2e/credential-free\n\nexport {};\n",
      ),
    ).toBe(true);
    expect(
      isMockParityRelevantSourceChange(
        "// @module-tag e2e/credential-free\n\nexport {};\n",
        "export {};\n",
      ),
    ).toBe(true);
    expect(
      isMockParityRelevantSourceChange(
        "// old terminology\nexport {};\n",
        "// current terminology\nexport {};\n",
      ),
    ).toBe(false);
    expect(
      isMockParityRelevantSourceChange(
        "// @module-tag e2e/credential-free\n\nexport {};\n",
        "// @module-tag e2e/credential-free\n\nexport const changed = true;\n",
      ),
    ).toBe(true);
    expect(
      isMockParityRelevantSourceChange(
        "export const fixture = `before\nafter`;\n",
        "export const fixture = `before\n// @module-tag e2e/credential-free\nafter`;\n",
      ),
    ).toBe(true);
    expect(
      isMockParityRelevantSourceChange(
        "// SPDX-License-Identifier: Apache-2.0\n\nexport {};\n",
        "// SPDX-License-Identifier: Apache-2.0\n/* @module-tag e2e/credential-free */\n\nexport {};\n",
      ),
    ).toBe(true);
    expect(
      isMockParityRelevantSourceChange(
        "/* @module-tag e2e/credential-free */\n\nexport {};\n",
        "export {};\n",
      ),
    ).toBe(true);
    expect(
      isMockParityRelevantSourceChange(
        `${"// @module"}-tag retired.value\n\nexport {};\n`,
        "// another ordinary comment\n\nexport {};\n",
      ),
    ).toBe(false);
    expect(isMockParityRelevantSourceChange(null, null)).toBe(true);
    expect(isMockParityRelevantSourceChange(null, TAGGED_NEW_SOURCE)).toBe(true);
  });

  it.each([
    {
      baseLive: "export const liveBehavior = 1;\n",
      headLive: "// @module-tag e2e/credential-free\nexport const liveBehavior = 1;\n",
      title: "adding a recognized module tag",
    },
    {
      baseLive: "// @module-tag e2e/credential-free\nexport const liveBehavior = 1;\n",
      headLive: "export const liveBehavior = 1;\n",
      title: "removing a recognized module tag",
    },
  ])("requires mapped fast coverage after $title", ({ baseLive, headLive }) => {
    const relevantFiles = filterMockParityRelevantChangedFiles(
      [live, fast],
      (file) => (file === live ? baseLive : "export const fastBehavior = 1;\n"),
      (file) =>
        file === live ? headLive : "// ordinary comment\nexport const fastBehavior = 1;\n",
    );

    expect(relevantFiles).toEqual([live]);
    expect(
      validateMockParity({
        manifest: manifest([{ live, fast: [fast] }]),
        changedFiles: relevantFiles,
        fileExists: exists,
      }),
    ).toEqual([`${live}: change at least one mapped fast PR test with the live source`]);
  });

  it("accepts a changed live E2E mapped to a fast PR test", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, fast: [fast] }]),
        changedFiles: [live, fast],
        fileExists: exists,
      }),
    ).toEqual([]);
  });

  it("rejects a stale fast-test mapping for changed live behavior", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, fast: [fast] }]),
        changedFiles: [live],
        fileExists: exists,
      }),
    ).toEqual([`${live}: change at least one mapped fast PR test with the live source`]);
  });

  it("requires mapped fast coverage when a declared live E2E helper changes", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live: liveHelper, fast: [fast] }]),
        changedFiles: [liveHelper],
        fileExists: exists,
      }),
    ).toEqual([`${liveHelper}: change at least one mapped fast PR test with the live source`]);
  });

  it("accepts a changed live E2E helper with a changed mapped fast test", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live: liveHelper, fast: [fast] }]),
        changedFiles: [liveHelper, fast],
        fileExists: exists,
      }),
    ).toEqual([]);
  });

  it("rejects a changed live E2E helper without an owning manifest entry", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, fast: [fast] }]),
        changedFiles: [liveHelper, fast],
        fileExists: exists,
      }),
    ).toEqual([
      `${liveHelper}: changed live E2E source needs a discovered fast test or an exception in test/e2e/fast-test-exceptions.json`,
    ]);
  });

  it("filters a comment-only live E2E helper change before ownership validation", () => {
    const relevantFiles = filterMockParityRelevantChangedFiles(
      [liveHelper],
      () => "// old wording\nexport const helper = true;\n",
      () => "// current wording\nexport const helper = true;\n",
    );

    expect(relevantFiles).toEqual([]);
  });

  it.each([
    {
      expected: [],
      fastHead: "export const fastBehavior = 2;\n",
      title: "retains a token-changing mapped fast test",
    },
    {
      expected: [`${live}: change at least one mapped fast PR test with the live source`],
      fastHead: "// formatting only\n\nexport const fastBehavior = 1;\n",
      title: "filters a comment-and-whitespace-only mapped fast test",
    },
  ])("$title", ({ expected, fastHead }) => {
    const baseSources = new Map([
      [live, "export const liveBehavior = 1;\n"],
      [fast, "export const fastBehavior = 1;\n"],
    ]);
    const headSources = new Map([
      [live, "export const liveBehavior = 2;\n"],
      [fast, fastHead],
    ]);
    const relevantFiles = filterMockParityRelevantChangedFiles(
      [live, fast],
      (file) => baseSources.get(file) ?? null,
      (file) => headSources.get(file) ?? null,
    );

    expect(
      validateMockParity({
        manifest: manifest([{ live, fast: [fast] }]),
        changedFiles: relevantFiles,
        fileExists: exists,
      }),
    ).toEqual(expected);
  });

  it("rejects a changed live E2E without a parity decision", () => {
    expect(
      validateMockParity({ manifest: manifest([]), changedFiles: [live], fileExists: exists }),
    ).toEqual([
      `${live}: changed live E2E source needs a discovered fast test or an exception in test/e2e/fast-test-exceptions.json`,
    ]);
  });

  it("rejects mappings to missing or non-PR tests", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, fast: ["test/e2e/live/not-fast.test.ts", fast] }]),
        changedFiles: [live, fast],
        fileExists: (file) => file === live,
      }),
    ).toEqual([
      `${live}: mapped fast test does not exist: ${fast}`,
      `${live}: test/e2e/live/not-fast.test.ts is not collected by a fast PR test project`,
    ]);
  });

  it("accepts an explicit decision for behavior that cannot be mocked", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, liveOnlyReason: "Requires public TLS and provider auth" }]),
        changedFiles: [live],
        fileExists: exists,
      }),
    ).toEqual([]);
  });

  it("reports a non-string live-only reason as a validation error", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, liveOnlyReason: 42 as unknown as string }]),
        changedFiles: [live],
        fileExists: exists,
      }),
    ).toEqual([`${live}: liveOnlyReason must be a string`]);
  });
});

describe("discovered live E2E fast tests", () => {
  it("uses a matching support test without a ledger entry", () => {
    const sources = new Map([
      [live, "export {};"],
      [fast, "export {};"],
    ]);
    const discovered = discoverMockParity(sources, manifest([]));
    expect(
      validateMockParity({ manifest: discovered, changedFiles: [live, fast], fileExists: exists }),
    ).toEqual([]);
    expect(
      validateMockParity({ manifest: discovered, changedFiles: [live], fileExists: exists }),
    ).toHaveLength(1);
  });

  it("finds fast tests through imported helpers and terminates on import cycles", () => {
    const indirect = "test/e2e/live/indirect.ts";
    const sources = new Map([
      [live, 'import "./example-helper.ts";'],
      [liveHelper, 'import "./indirect.ts";'],
      [indirect, 'import "./example-helper.ts";'],
      [fast, 'import "../live/indirect.ts";'],
    ]);
    const discovered = discoverMockParity(sources, manifest([]));
    expect(
      validateMockParity({
        manifest: discovered,
        changedFiles: [liveHelper, fast],
        fileExists: (file) => sources.has(file),
      }),
    ).toEqual([]);
    expect(
      validateMockParity({
        manifest: discovered,
        changedFiles: [liveHelper],
        fileExists: (file) => sources.has(file),
      }),
    ).toHaveLength(1);
  });

  it("rejects a new helper with no discovered fast test or explicit exception", () => {
    const sources = new Map([
      [liveHelper, "export {};"],
      [fast, "export {};"],
    ]);
    const discovered = discoverMockParity(sources, manifest([]));
    expect(
      validateMockParity({
        manifest: discovered,
        changedFiles: [liveHelper, fast],
        fileExists: (file) => sources.has(file),
      }),
    ).toEqual([
      `${liveHelper}: changed live E2E source needs a discovered fast test or an exception in test/e2e/fast-test-exceptions.json`,
    ]);
  });

  it("retains an explicit live-only decision without executing candidate code", () => {
    const sources = new Map([
      [live, 'throw new Error("must never run");'],
      [fast, "export {};"],
    ]);
    const discovered = discoverMockParity(
      sources,
      manifest([{ live, liveOnlyReason: "Requires a real sandbox" }]),
    );
    expect(
      validateMockParity({
        manifest: discovered,
        changedFiles: [live],
        fileExists: (file) => sources.has(file),
      }),
    ).toEqual([]);
  });
});
