// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectMockParityChangedFiles,
  collectMockParityRenames,
  filterMockParityRelevantChangedFiles,
  isMockParityRelevantSourceChange,
  type MockParityManifest,
  validateMockParity,
} from "../../../scripts/checks/e2e-mock-parity.mts";

const live = "test/e2e/live/example.test.ts";
const liveHelper = "test/e2e/live/example-helper.ts";
const pythonLiveHelper = "test/e2e/live/example-helper.py";
const fast = "test/e2e/support/example.test.ts";
const TAGGED_NEW_SOURCE = "// @module-tag e2e/credential-free\n";
const exists = (file: string) =>
  file === live || file === liveHelper || file === pythonLiveHelper || file === fast;

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
    ).toEqual([`${live}: change at least one mapped fast PR test with the live E2E`]);
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
    ).toEqual([`${live}: change at least one mapped fast PR test with the live E2E`]);
  });

  it.each([
    [[], 2],
    [[fast], 0],
  ])(
    "enforces both declared shared-fixture owners with changed tests %j",
    (changedTests, errors) => {
      const shared = "test/e2e/fixtures/owned-sandbox-cleanup.ts";
      expect(
        validateMockParity({
          manifest: manifest([
            { live, liveSources: [shared], fast: [fast] },
            { live: "test/e2e/live/second.test.ts", liveSources: [shared], fast: [fast] },
          ]),
          changedFiles: [shared, ...changedTests],
          fileExists: () => true,
        }),
      ).toHaveLength(errors);
    },
  );

  it("does not impose new ownership requirements on undeclared shared fixtures", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, fast: [fast] }]),
        changedFiles: ["test/e2e/fixtures/unrelated.ts"],
        fileExists: exists,
      }),
    ).toEqual([]);
  });

  it("requires mapped relay evidence through the checked-in MCP bridge owner", () => {
    const relay = "test/e2e/fixtures/routed-private-relay.ts";
    const relayTest = "test/e2e/support/routed-private-relay.test.ts";
    const bridge = "test/e2e/live/mcp-bridge.test.ts";
    const checkedIn = JSON.parse(
      fs.readFileSync(new URL("../../e2e/mock-parity.json", import.meta.url), "utf8"),
    ) as MockParityManifest;
    expect(
      validateMockParity({ manifest: checkedIn, changedFiles: [relay], fileExists: fs.existsSync }),
    ).toEqual([`${relay}: change at least one fast PR test mapped from ${bridge}`]);
    expect(
      validateMockParity({
        manifest: checkedIn,
        changedFiles: [relay, relayTest],
        fileExists: fs.existsSync,
      }),
    ).toEqual([]);
  });

  it.each([{ changedTests: [] }, { changedTests: [fast] }])(
    "retains base fixture coverage when ownership is removed with changed tests %j",
    ({ changedTests }) => {
      const shared = "test/e2e/fixtures/owned-sandbox-cleanup.ts";
      expect(
        validateMockParity({
          manifest: manifest([{ live, fast: [fast] }]),
          baseManifest: manifest([{ live, liveSources: [shared], fast: [fast] }]),
          changedFiles: [shared, ...changedTests],
          fileExists: (file) => exists(file) || file === shared,
        }),
      ).toEqual(
        changedTests.length
          ? []
          : [`${shared}: change at least one fast PR test mapped from ${live}`],
      );
    },
  );

  it.each([true, false])(
    "credits an added same-owner test only with retained mapping: %s",
    (retained) => {
      const shared = "test/e2e/fixtures/owned-sandbox-cleanup.ts";
      const added = "test/e2e/support/added.test.ts";
      const result = validateMockParity({
        manifest: manifest([
          { live, liveSources: [shared], fast: retained ? [fast, added] : [added] },
        ]),
        baseManifest: manifest([{ live, liveSources: [shared], fast: [fast] }]),
        changedFiles: [shared, added],
        fileExists: (file) => exists(file) || file === shared || file === added,
      });
      expect(result).toEqual(
        retained ? [] : [`${shared}: change at least one fast PR test mapped from ${live}`],
      );
    },
  );

  it("ignores comment-only shared fixture changes without hiding behavioral changes", () => {
    const shared = "test/e2e/fixtures/owned-sandbox-cleanup.ts";
    expect(
      filterMockParityRelevantChangedFiles(
        [shared],
        () => "export const value = 1;",
        () => "// comment\nexport const value = 1;",
      ),
    ).toEqual([]);
    expect(
      filterMockParityRelevantChangedFiles(
        [shared],
        () => "export const value = 1;",
        () => "export const value = 2;",
      ),
    ).toEqual([shared]);
  });

  it("requires mapped fast coverage when a declared live E2E helper changes", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, liveSources: [liveHelper], fast: [fast] }]),
        changedFiles: [liveHelper],
        fileExists: exists,
      }),
    ).toEqual([`${liveHelper}: change at least one fast PR test mapped from ${live}`]);
  });

  it("accepts a changed live E2E helper with a changed mapped fast test", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, liveSources: [liveHelper], fast: [fast] }]),
        changedFiles: [liveHelper, fast],
        fileExists: exists,
      }),
    ).toEqual([]);
  });

  it("requires mapped fast coverage when a declared Python live helper changes", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, liveSources: [pythonLiveHelper], fast: [fast] }]),
        changedFiles: [pythonLiveHelper],
        fileExists: exists,
      }),
    ).toEqual([`${pythonLiveHelper}: change at least one fast PR test mapped from ${live}`]);
  });

  it("accepts a changed Python live helper with a changed mapped fast test", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, liveSources: [pythonLiveHelper], fast: [fast] }]),
        changedFiles: [pythonLiveHelper, fast],
        fileExists: exists,
      }),
    ).toEqual([]);
  });

  it("retains indentation-only Python helper changes for mapped fast coverage", () => {
    const relevantFiles = filterMockParityRelevantChangedFiles(
      [pythonLiveHelper],
      () => "if enabled:\n    inspect_boundary()\n",
      () => "if enabled:\n        inspect_boundary()\n",
    );

    expect(relevantFiles).toEqual([pythonLiveHelper]);
    expect(
      validateMockParity({
        manifest: manifest([{ live, liveSources: [pythonLiveHelper], fast: [fast] }]),
        changedFiles: relevantFiles,
        fileExists: exists,
      }),
    ).toEqual([`${pythonLiveHelper}: change at least one fast PR test mapped from ${live}`]);
  });

  it("rejects a changed live E2E helper without an owning manifest entry", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, fast: [fast] }]),
        changedFiles: [liveHelper, fast],
        fileExists: exists,
      }),
    ).toEqual([
      `${liveHelper}: changed live E2E helper needs an owning entry in test/e2e/mock-parity.json`,
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
      expected: [`${live}: change at least one mapped fast PR test with the live E2E`],
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
    ).toEqual([`${live}: changed live E2E needs an entry in test/e2e/mock-parity.json`]);
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

const removedFixture = "test/e2e/fixtures/removed.ts";
it.each([
  ["deletion", ["rm", removedFixture]],
  ["rename within fixtures", ["mv", removedFixture, "test/e2e/fixtures/renamed.ts"]],
  ["rename outside fixtures", ["mv", removedFixture, "renamed.ts"]],
])("keeps owned fixture obligations after %s in real Git classification", (_label, operation) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parity-deletion-"));
  const shared = removedFixture;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    git("init", "--quiet");
    fs.mkdirSync(path.dirname(path.join(root, shared)), { recursive: true });
    fs.writeFileSync(path.join(root, shared), "export const value = 1;\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Parity Test",
      "-c",
      "user.email=parity@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "base",
    );
    const base = git("rev-parse", "HEAD").trim();
    git(...operation);
    git(
      "-c",
      "user.name=Parity Test",
      "-c",
      "user.email=parity@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "remove",
    );
    const changedFiles = collectMockParityChangedFiles(base, "HEAD", root);
    expect(changedFiles).toContain(shared);
    const options = {
      manifest: manifest([{ live, fast: [fast] }]),
      baseManifest: manifest([{ live, liveSources: [shared], fast: [fast] }]),
      changedFiles,
      fileExists: exists,
    };
    expect(validateMockParity(options)).toEqual([
      `${shared}: change at least one fast PR test mapped from ${live}`,
    ]);
    expect(validateMockParity({ ...options, changedFiles: [...changedFiles, fast] })).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("describes both supported liveSources kinds in invalid-entry diagnostics", () => {
  const shared = "test/e2e/fixtures/missing.ts";
  expect(
    validateMockParity({
      manifest: manifest([{ live, fast: [fast], liveSources: [shared] }]),
      changedFiles: [],
      fileExists: exists,
    }),
  ).toEqual([`${live}: live E2E helper or shared fixture does not exist: ${shared}`]);
  expect(
    validateMockParity({
      manifest: manifest([{ live, fast: [fast], liveSources: 1 as unknown as string[] }]),
      changedFiles: [],
      fileExists: exists,
    }),
  ).toEqual([`${live}: liveSources must be an array of live E2E helper or shared fixture paths`]);
});

const renameFixture = "test/e2e/fixtures/owned.ts";
const renamedLive = "test/e2e/live/renamed.test.ts";
const replacementTest = "test/e2e/support/replacement.test.ts";
const renameSource = Array.from({ length: 20 }, (_, i) => `export const case${i}=${i};\n`).join("");
const replacementEntry = { live, liveSources: [renameFixture], fast: [replacementTest] };
const missingChangedTest = `${renameFixture}: change at least one fast PR test mapped from ${live}`;
it.each([
  {
    kind: "changed rename",
    operations: [["mv", fast, replacementTest]],
    source: `${renameSource}export const regression = 21;\n`,
    entries: [replacementEntry],
    expected: [],
  },
  {
    kind: "unchanged rename",
    operations: [["mv", fast, replacementTest]],
    source: renameSource,
    entries: [replacementEntry],
    expected: [missingChangedTest],
  },
  {
    kind: "unrelated deletion",
    operations: [["rm", fast]],
    source: "export const unrelated = true;\n",
    entries: [replacementEntry],
    expected: [missingChangedTest],
  },
  {
    kind: "wrong owner",
    operations: [["mv", fast, replacementTest]],
    source: `${renameSource}export const regression = 21;\n`,
    entries: [
      { live, fast: [fast] },
      { live: "test/e2e/live/other.test.ts", fast: [replacementTest] },
    ],
    expected: [missingChangedTest],
  },
  {
    kind: "co-renamed live owner and changed fast test",
    operations: [
      ["mv", fast, replacementTest],
      ["mv", live, renamedLive],
    ],
    source: `${renameSource}export const regression = 21;\n`,
    entries: [{ ...replacementEntry, live: renamedLive }],
    expected: [],
  },
  {
    kind: "co-renamed live owner and unchanged fast test",
    operations: [
      ["mv", fast, replacementTest],
      ["mv", live, renamedLive],
    ],
    source: renameSource,
    entries: [{ ...replacementEntry, live: renamedLive }],
    expected: [
      missingChangedTest,
      `${renameFixture}: change at least one fast PR test mapped from ${renamedLive}`,
    ],
  },
])("checks base fast-test obligations for $kind", ({ operations, source, entries, expected }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parity-fast-rename-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (file: string, contents: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  };
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Parity Test",
      "-c",
      "user.email=parity@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "test",
    );
  };
  try {
    git("init", "-q");
    write(renameFixture, "export const value = 1;\n");
    write(fast, renameSource);
    write(live, "export const liveScenario = true;\n");
    commit();
    const base = git("rev-parse", "HEAD");
    operations.forEach((operation) => git(...operation));
    write(replacementTest, source);
    write(renameFixture, "export const value = 2;\n");
    commit();
    expect(
      validateMockParity({
        manifest: manifest(entries),
        baseManifest: manifest([{ ...replacementEntry, fast: [fast] }]),
        changedFiles: collectMockParityChangedFiles(base, "HEAD", root),
        ...collectMockParityRenames(base, "HEAD", root),
        fileExists: () => true,
      }),
    ).toEqual(expected);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "requires semantic fast-test changes after rename (changed=%s)",
  (changed) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parity-current-rename-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const write = (file: string, source: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), source);
    };
    const commit = () => {
      git("add", ".");
      git(
        "-c",
        "user.name=Parity Test",
        "-c",
        "user.email=parity@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "test",
      );
    };
    try {
      git("init", "-q");
      write(live, "export const liveScenario = 1;\n");
      write(fast, renameSource);
      commit();
      const base = git("rev-parse", "HEAD");
      git("mv", fast, replacementTest);
      write(live, "export const liveScenario = 2;\n");
      write(
        replacementTest,
        changed ? `${renameSource}export const regression = 21;\n` : renameSource,
      );
      commit();
      const changedFiles = collectMockParityChangedFiles(base, "HEAD", root);
      expect(changedFiles.includes(replacementTest)).toBe(changed);
      expect(
        validateMockParity({
          manifest: manifest([{ live, fast: [replacementTest] }]),
          changedFiles,
          fileExists: (file) => fs.existsSync(path.join(root, file)),
        }),
      ).toEqual(
        changed ? [] : [`${live}: change at least one mapped fast PR test with the live E2E`],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
