// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { readOnlyHookConfiguration } from "../../scripts/checks/read-only-config.mts";
import { validatePr } from "../../scripts/checks/validate-pr.mts";
import { fixtureGit, validationFixture, writeFixture } from "./validation-fixture";

let root: string;
beforeEach(() => {
  root = validationFixture();
  writeFixture(
    root,
    ".pre-commit-config.yaml",
    YAML.stringify({
      repos: [{ repo: "local", hooks: [{ id: "check-json", entry: "check-json" }] }],
    }),
  );
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-m", "test: hook configuration");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const hookCases = [
  {
    id: "spdx-headers",
    source: { entry: "bash scripts/check-spdx-headers.sh --fix" },
    expected: { entry: "bash scripts/check-spdx-headers.sh" },
  },
  {
    id: "oxfmt",
    source: { entry: "npx oxfmt --write --no-error-on-unmatched-pattern" },
    expected: { entry: "npx oxfmt --check --no-error-on-unmatched-pattern" },
  },
  {
    id: "oxlint-fix",
    source: { entry: "npx oxlint --fix --no-error-on-unmatched-pattern" },
    expected: { entry: "npx oxlint --no-error-on-unmatched-pattern" },
  },
  {
    id: "oxlint-type-aware",
    source: { entry: "npx oxlint --fix --type-aware --no-error-on-unmatched-pattern" },
    expected: { entry: "npx oxlint --type-aware --no-error-on-unmatched-pattern" },
  },
  {
    id: "trailing-whitespace",
    source: {},
    expected: { entry: "python scripts/checks/read-only-fixer.py trailing-whitespace", args: [] },
  },
  {
    id: "end-of-file-fixer",
    source: {},
    expected: { entry: "python scripts/checks/read-only-fixer.py end-of-file-fixer", args: [] },
  },
  {
    id: "mixed-line-ending",
    source: { args: ["--fix=lf"] },
    expected: { entry: "python scripts/checks/read-only-fixer.py mixed-line-ending", args: [] },
  },
  {
    id: "platform-matrix-sync",
    source: {
      entry:
        "bash -c 'python3 scripts/generate-platform-docs.py && git add docs/get-started/prerequisites.mdx docs/inference/choose-inference-provider.mdx docs/reference/platform-support.mdx'",
    },
    expected: { entry: "python3 scripts/generate-platform-docs.py --check" },
  },
  {
    id: "shfmt",
    source: { args: ["-w", "-i", "2", "-ci", "-bn"] },
    expected: { args: ["-d", "-i", "2", "-ci", "-bn"] },
  },
];

describe("read-only publication checks", () => {
  it.each(hookCases)("uses the non-writing command for $id", ({ id, source, expected }) => {
    const config = YAML.parse(
      readOnlyHookConfiguration(YAML.stringify({ repos: [{ hooks: [{ id, ...source }] }] })),
    );
    expect(config.repos[0].hooks[0]).toEqual({ id, ...expected });
  });

  it("passes all read-only conversions to the publication stage", () => {
    writeFixture(
      root,
      ".pre-commit-config.yaml",
      readFileSync(path.resolve(".pre-commit-config.yaml"), "utf8"),
    );
    fixtureGit(root, "add", ".pre-commit-config.yaml");
    fixtureGit(root, "commit", "-m", "test: complete hook fixture");
    const execute = vi
      .fn((_command: string, _args: string[]) => 0)
      .mockImplementationOnce((_command, args) => {
        const config = YAML.parse(readFileSync(args[args.indexOf("--config") + 1], "utf8"));
        expect(config.repos.flatMap((repo: { hooks: unknown[] }) => repo.hooks)).toEqual(
          expect.arrayContaining(
            hookCases.map(({ id, expected }) => expect.objectContaining({ id, ...expected })),
          ),
        );
        return 0;
      });
    expect(validatePr(root, execute)).toBe(0);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it.each(["new-hook", "renamed-oxfmt"])("rejects unclassified hook %s before execution", (id) => {
    writeFixture(
      root,
      ".pre-commit-config.yaml",
      YAML.stringify({ repos: [{ repo: "local", hooks: [{ id, entry: "npx oxfmt --write" }] }] }),
    );
    fixtureGit(root, "add", ".pre-commit-config.yaml");
    fixtureGit(root, "commit", "-m", "test: unclassified hook");
    const execute = vi.fn(() => 0);
    expect(() => validatePr(root, execute)).toThrow("Classify the read-only behavior");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects changed formatter commands instead of running an unreviewed fixer", () => {
    expect(() =>
      readOnlyHookConfiguration(
        YAML.stringify({ repos: [{ hooks: [{ id: "oxfmt", entry: "different-fixer" }] }] }),
      ),
    ).toThrow("Review the read-only command");
  });

  it("checks whitespace on copies without modifying the source file", () => {
    const file = path.join(root, "example.txt");
    writeFixture(root, "example.txt", "trailing space \n");
    const script = path.resolve("scripts/checks/read-only-fixer.py");
    const result = spawnSync(
      "python3",
      [
        "-c",
        `import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("checker", sys.argv[1])
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
def fix(files):
    pathlib.Path(files[0]).write_text("trailing space\\n")
    return 1
sys.exit(checker.check_files(fix, [sys.argv[2]]))`,
        script,
        file,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("trailing space \n");
    expect(result.stdout).toContain(`Formatting required: ${file}`);
  });

  it("runs all three validation stages and removes its temporary configuration", () => {
    const execute = vi.fn(() => 0);
    expect(validatePr(root, execute)).toBe(0);
    expect(execute.mock.calls).toHaveLength(3);
    expect(execute).toHaveBeenNthCalledWith(2, "npx", [
      "--no-install",
      "commitlint",
      "--from",
      "origin/main",
      "--to",
      "HEAD",
    ]);
    const args = execute.mock.calls[0] as unknown as [string, string[]];
    expect(existsSync(args[1][3])).toBe(false);
    expect(fixtureGit(root, "status", "--porcelain")).toBe("");
  });

  it("stops after a failed check without invoking later stages", () => {
    const execute = vi.fn(() => 3);
    expect(validatePr(root, execute)).toBe(3);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects an uncommitted candidate before executing hooks", () => {
    writeFixture(root, "src/example.ts", "uncommitted\n");
    const execute = vi.fn(() => 0);
    expect(() => validatePr(root, execute)).toThrow("Commit all changes");
    expect(execute).not.toHaveBeenCalled();
  });

  it("detects an unexpected repository write during validation", () => {
    const execute = vi.fn(() => {
      writeFixture(root, "src/example.ts", "unexpected\n");
      return 0;
    });
    expect(() => validatePr(root, execute)).toThrow("Validation changed repository files");
  });
});
