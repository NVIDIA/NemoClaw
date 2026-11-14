// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { terminateFixtureChild } from "../support/process-liveness.ts";
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

  it("selects recovery coverage when the executable dispatch procedure changes", () => {
    expect(
      relatedArguments([".agents/skills/nemoclaw-maintainer-e2e/references/manual-pr.md"]),
    ).toContain("test/repository/manual-pr-dispatch-checkpoint.test.ts");
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

  it("executes the changed-test CLI through a symlinked checkout", () => {
    const root = directory();
    symlinkSync(resolve("."), join(root, "checkout"), "dir");
    const result = spawnSync(
      process.execPath,
      [join(root, "checkout/scripts/tests/changed.mts"), "--changed=missing-base"],
      {
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing-base");
  });

  it("terminates a blocked test child and reports its timeout", () => {
    const root = directory();
    const pid = join(root, "child.pid");
    mkdirSync(join(root, "node_modules/vitest"), { recursive: true });
    writeFileSync(
      join(root, "node_modules/vitest/vitest.mjs"),
      `import { writeFileSync } from 'node:fs';
       writeFileSync(${JSON.stringify(pid)}, String(process.pid));
       process.on('SIGTERM', () => {});
       setInterval(() => {}, 1000);`,
    );
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { runRelatedTests } from ${JSON.stringify(pathToFileURL(resolve("scripts/tests/changed.mts")).href)};
           process.chdir(${JSON.stringify(root)});
           process.exitCode = runRelatedTests([], 2000);`,
        ],
        { encoding: "utf8", timeout: 8000, killSignal: "SIGKILL", env: {} },
      );
      expect(existsSync(pid)).toBe(true);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        timeoutMs: 2000,
        timedOut: true,
        signal: "SIGKILL",
        exitCode: null,
      });
      expect(report.elapsedMs).toBeGreaterThanOrEqual(2000);
      expect(result.stderr).toContain("ETIMEDOUT");
    } finally {
      terminateFixtureChild(pid);
    }
  }, 15000);

  it("reports success when an unrelated document selects no tests", () => {
    const root = directory();
    const config = join(root, "vitest.config.mjs");
    writeFileSync(
      config,
      `export default { test: { projects: [{ test: { name: 'integration', root: ${JSON.stringify(root)}, include: ['**/*.test.ts'] } }] } };`,
    );
    writeFileSync(join(root, "notes.md"), "Documentation only");
    const result = spawnSync(
      process.execPath,
      [
        resolve("node_modules/vitest/vitest.mjs"),
        ...relatedArguments(["notes.md"]),
        "--config",
        config,
        "--root",
        root,
      ],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
        timeout: 30000,
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain("No test files found");
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
