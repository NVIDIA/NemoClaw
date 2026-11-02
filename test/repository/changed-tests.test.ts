// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changedInputs, relatedArguments, sourceProjects } from "../../scripts/tests/changed.mts";

const roots: string[] = [];
function directory() {
  const root = mkdtempSync(join(tmpdir(), "changed-tests-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("changed-test selection", () => {
  it("selects existing integration contracts for dependency locks and patch inputs", () => {
    const args = relatedArguments([
      "agents/langchain-deepagents-code/requirements.lock",
      "agents/langchain-deepagents-code/patch-managed-deepagents-code.py",
    ]);
    expect(args).toContain("test/agents/deepagents/langchain-deepagents-code-image.test.ts");
    expect(args).toContain(
      "test/agents/deepagents/langchain-deepagents-code-managed-entrypoints.test.ts",
    );
    expect(
      args.filter(
        (arg) => arg === "test/agents/deepagents/langchain-deepagents-code-image.test.ts",
      ),
    ).toHaveLength(1);
    expect(sourceProjects).toContain("integration");
    expect(sourceProjects).not.toContain("e2e-live");
    expect(sourceProjects).not.toContain("package-contract");
  });

  it("includes staged, unstaged, deleted and untracked inputs relative to the chosen base", () => {
    const root = directory();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "--quiet");
    writeFileSync(join(root, "staged.py"), "before");
    writeFileSync(join(root, "unstaged.ts"), "before");
    writeFileSync(join(root, "deleted.lock"), "before");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    writeFileSync(join(root, "staged.py"), "after");
    git("add", "staged.py");
    writeFileSync(join(root, "unstaged.ts"), "after");
    rmSync(join(root, "deleted.lock"));
    writeFileSync(join(root, "untracked.ts"), "new");
    expect(changedInputs(root).sort()).toEqual([
      "deleted.lock",
      "staged.py",
      "unstaged.ts",
      "untracked.ts",
    ]);
    expect(() => changedInputs(root, "missing-base")).toThrow();
    expect(() => relatedArguments(["--help"])).toThrow(/options/);
  });

  it("executes a mapped integration test and propagates a real contract failure", () => {
    const root = directory();
    const test = "test/agents/deepagents/langchain-deepagents-code-image.test.ts";
    mkdirSync(join(root, "test/agents/deepagents"), { recursive: true });
    writeFileSync(join(root, "contract.txt"), "broken");
    writeFileSync(
      join(root, test),
      `import { readFileSync } from 'node:fs';
      import { test, expect } from ${JSON.stringify(resolve("node_modules/vitest/dist/index.js"))};
      test('rejects incompatible installed metadata', () => expect(readFileSync(${JSON.stringify(join(root, "contract.txt"))}, 'utf8')).toBe('compatible'));`,
    );
    const config = join(root, "vitest.config.mjs");
    writeFileSync(
      config,
      `export default { test: { projects: [{ test: { name: 'integration', root: ${JSON.stringify(root)}, include: ['test/**/*.test.ts'] } }] } };`,
    );
    const args = relatedArguments(["agents/langchain-deepagents-code/requirements.lock"]);
    const run = () =>
      spawnSync(
        process.execPath,
        [resolve("node_modules/vitest/vitest.mjs"), ...args, "--config", config, "--root", root],
        { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 30000 },
      );
    const failed = run();
    expect(failed.status, failed.stdout + failed.stderr).toBe(1);
    expect(failed.stdout + failed.stderr).toContain("rejects incompatible installed metadata");
    writeFileSync(join(root, "contract.txt"), "compatible");
    const passed = run();
    expect(passed.status, passed.stdout + passed.stderr).toBe(0);
  });
});
