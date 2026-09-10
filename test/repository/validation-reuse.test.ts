// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCachedCommand, validationEnvironment } from "../../scripts/checks/cached-command.mts";
import { changedCheckFiles } from "../../scripts/checks/run.mts";
import { fixtureGit, validationFixture, writeFixture } from "./validation-fixture";

let root: string;
beforeEach(() => {
  root = validationFixture();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function check(execute = vi.fn(() => 0), env: NodeJS.ProcessEnv = {}) {
  return {
    root,
    label: "fixture",
    command: [process.execPath, "--version"],
    execute,
    env,
    report: vi.fn(),
  };
}

describe("validation reuse", () => {
  it.skipIf(process.platform === "win32")(
    "reuses results with a repository directory alias",
    () => {
      symlinkSync("src", path.join(root, "alias"));
      fixtureGit(root, "add", "alias");
      fixtureGit(root, "commit", "-m", "test: alias");
      const options = check();
      runCachedCommand(options);
      runCachedCommand(options);
      expect(options.execute).toHaveBeenCalledTimes(1);
    },
  );
  it("executes once for identical successful input bytes", () => {
    const options = check();
    expect(runCachedCommand(options)).toBe(0);
    expect(runCachedCommand(options)).toBe(0);
    expect(options.execute).toHaveBeenCalledTimes(1);
    expect(options.report).toHaveBeenLastCalledWith(
      expect.stringContaining("reused successful validation"),
    );
  });

  it.each([
    "src/example.ts",
    "untracked.ts",
    "node_modules/typescript/compiler.js",
    "dist/generated.js",
    "nemoclaw/dist/boundary.js",
  ])("reruns after %s changes", (file) => {
    const options = check();
    runCachedCommand(options);
    writeFixture(root, file, "changed bytes\n");
    runCachedCommand(options);
    expect(options.execute).toHaveBeenCalledTimes(2);
  });

  it("reruns when an ignored source file changes", () => {
    writeFixture(root, ".git/info/exclude", "src/dist/\n");
    const options = check();
    runCachedCommand(options);
    writeFixture(root, "src/dist/ignored.ts", "invalid source\n");
    expect(fixtureGit(root, "status", "--porcelain")).toBe("");
    runCachedCommand(options);
    expect(options.execute).toHaveBeenCalledTimes(2);
  });

  it("reuses a source-only check after unrelated build outputs change", () => {
    const options = { ...check(), outputPaths: [] };
    runCachedCommand(options);
    writeFixture(root, "dist/generated.js", "new build\n");
    runCachedCommand(options);
    expect(options.execute).toHaveBeenCalledTimes(1);
  });

  it("reruns when a generated output is deleted", () => {
    writeFixture(root, "dist/generated.js", "generated\n");
    const options = check();
    runCachedCommand(options);
    rmSync(path.join(root, "dist/generated.js"));
    runCachedCommand(options);
    expect(options.execute).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures or erase a repeated failure", () => {
    const options = check(vi.fn(() => 7));
    expect(runCachedCommand(options)).toBe(7);
    expect(runCachedCommand(options)).toBe(7);
    expect(options.execute).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a result after the command or environment changes", () => {
    const options = check();
    runCachedCommand(options);
    runCachedCommand({ ...options, command: [process.execPath, "--help"] });
    runCachedCommand({ ...options, env: { NODE_OPTIONS: "--max-old-space-size=5120" } });
    expect(options.execute).toHaveBeenCalledTimes(3);
  });

  it("reruns when the canonical comparison ref changes", () => {
    const options = check();
    runCachedCommand(options);
    fixtureGit(root, "commit", "--allow-empty", "-m", "test: next");
    const next = fixtureGit(root, "rev-parse", "HEAD").trim();
    fixtureGit(root, "checkout", "--detach", "HEAD^");
    fixtureGit(root, "update-ref", "refs/remotes/origin/main", next);
    runCachedCommand(options);
    expect(options.execute).toHaveBeenCalledTimes(2);
  });

  it("reruns when the receipt is malformed", () => {
    const options = check();
    runCachedCommand(options);
    writeFixture(root, ".git/nemoclaw-validation/fixture.json", "broken");
    runCachedCommand(options);
    expect(options.execute).toHaveBeenCalledTimes(2);
  });

  it("does not cache source changes made during execution", () => {
    const options = check(
      vi.fn(() => {
        writeFixture(root, "src/example.ts", "changed\n");
        return 0;
      }),
    );
    runCachedCommand(options);
    fixtureGit(root, "restore", "src/example.ts");
    runCachedCommand(options);
    expect(options.execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    "--require /external/loader.cjs",
    "-r/external/loader.cjs",
    "--import=/external/loader.mjs",
  ])("does not reuse results with the external Node loader %s", (loader) => {
    const options = check(
      vi.fn(() => 0),
      { NODE_OPTIONS: loader },
    );
    runCachedCommand(options);
    runCachedCommand(options);
    expect(options.execute).toHaveBeenCalledTimes(2);
  });

  it.each(["script-shell", "node-options"])(
    "does not cache external execution from npm %s",
    (setting) => {
      writeFixture(root, ".npmrc", `${setting}=/external/tool\n`);
      fixtureGit(root, "add", ".npmrc");
      fixtureGit(root, "commit", "-m", "test: npm configuration");
      const options = check();
      runCachedCommand(options);
      runCachedCommand(options);
      expect(options.execute).toHaveBeenCalledTimes(2);
    },
  );

  it("normalizes the default Git helper path and npx install flags", () => {
    const gitPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
    const explicit = { PATH: process.env.PATH, npm_config_yes: "" };
    const pushed = {
      PATH: [gitPath, process.env.PATH].join(path.delimiter),
      GIT_EXEC_PATH: gitPath,
    };
    expect(validationEnvironment(pushed)).toEqual(validationEnvironment(explicit));
    const options = check();
    runCachedCommand({ ...options, env: explicit });
    runCachedCommand({ ...options, env: pushed });
    expect(options.execute).toHaveBeenCalledTimes(1);
  });

  it("preserves a custom Git execution path", () => {
    expect(
      validationEnvironment({ GIT_EXEC_PATH: "/custom/git", PATH: "/custom/git" }),
    ).toMatchObject({ GIT_EXEC_PATH: "/custom/git", PATH: "/custom/git" });
  });

  it("removes invocation metadata from execution while preserving relevant environment", () => {
    expect(
      validationEnvironment({
        PATH: ["/tools", "/tools", "/usr/bin"].join(path.delimiter),
        npm_lifecycle_event: "validate:pr",
        PRE_COMMIT_FROM_REF: "main",
        NODE_OPTIONS: "--max-old-space-size=5120",
      }),
    ).toEqual({
      PATH: ["/tools", "/usr/bin"].join(path.delimiter),
      NODE_OPTIONS: "--max-old-space-size=5120",
      npm_config_yes: "false",
    });
  });
});

describe("repository check input collection", () => {
  it("includes staged deletions omitted by the hook file list", () => {
    fixtureGit(root, "rm", "src/example.ts");
    expect(changedCheckFiles(["--files", "docs/overview.mdx"], {}, root)).toEqual([
      "docs/overview.mdx",
      "src/example.ts",
    ]);
  });

  it("includes both paths of a committed rename", () => {
    fixtureGit(root, "mv", "src/example.ts", "src/renamed.ts");
    fixtureGit(root, "commit", "-m", "test: rename");
    expect(
      changedCheckFiles(
        ["--files"],
        { PRE_COMMIT_FROM_REF: "HEAD^", PRE_COMMIT_TO_REF: "HEAD" },
        root,
      ),
    ).toEqual(["src/example.ts", "src/renamed.ts"]);
  });

  it("excludes changes merged only into the comparison branch", () => {
    writeFixture(root, "docs/overview.md", "candidate document\n");
    fixtureGit(root, "add", "docs/overview.md");
    fixtureGit(root, "commit", "-m", "docs: candidate");
    fixtureGit(root, "branch", "candidate");
    fixtureGit(root, "checkout", "--detach", "origin/main");
    writeFixture(root, "src/example.ts", "base change\n");
    fixtureGit(root, "add", "src/example.ts");
    fixtureGit(root, "commit", "-m", "test: base");
    expect(
      changedCheckFiles(
        ["--files"],
        { PRE_COMMIT_FROM_REF: "HEAD", PRE_COMMIT_TO_REF: "candidate" },
        root,
      ),
    ).toEqual(["docs/overview.md"]);
  });

  it("rejects a missing comparison ref instead of selecting no checks", () => {
    expect(() =>
      changedCheckFiles(
        ["--files"],
        { PRE_COMMIT_FROM_REF: "missing", PRE_COMMIT_TO_REF: "HEAD" },
        root,
      ),
    ).toThrow("Could not resolve");
  });

  it("rejects incomplete comparison evidence", () => {
    expect(() => changedCheckFiles(["--files"], { PRE_COMMIT_FROM_REF: "HEAD" }, root)).toThrow(
      "Both comparison refs",
    );
  });
});
