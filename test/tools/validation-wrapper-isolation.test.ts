// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

type BashInput = {
  command: string;
  workdir: string;
  timeoutMs: number;
};

type BashResult = {
  kind: "foreground";
  exitCode: number | null;
  stdout: { text: string; truncated: boolean };
  stderr: { text: string; truncated: boolean };
};

type FocusedValidationRunner = (input: Record<string, unknown>) => Promise<{ ok: boolean }>;
type TargetedVitestRunner = (input: Record<string, unknown>) => Promise<{ code: number }>;

const nativeSandboxAvailable =
  (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) ||
  (process.platform === "linux" &&
    spawnSync("/bin/sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).status === 0);

function foreground(exitCode: number | null = 0, stdout = "", stderr = ""): BashResult {
  return {
    kind: "foreground",
    exitCode,
    stdout: { text: stdout, truncated: false },
    stderr: { text: stderr, truncated: false },
  };
}

function installTools(runBash: (input: BashInput) => BashResult): void {
  vi.stubGlobal("tools", {
    bash: async (input: BashInput) => runBash(input),
    infer_validation_for_changed_files: async () => ({
      baseRef: "HEAD",
      files: [],
      branchFiles: [],
      workingTreeFiles: [],
      untrackedFiles: [],
      projects: ["integration"],
      targetedFiles: ["probe.test.ts"],
      commands: [],
      notes: [],
    }),
    project_diagnostic_text: async (input: { lines: string[]; sourceTruncated: boolean }) => ({
      text: input.lines.join("\n"),
      sourceTruncated: input.sourceTruncated,
      lineClipped: false,
      truncated: input.sourceTruncated,
      selectedLines: input.lines.length,
      returnedLines: input.lines.length,
    }),
  });
}

async function runBothWrappers(
  workdir: string,
): Promise<{ focusedOk: boolean; targetedCode: number }> {
  const [{ default: runFocusedValidation }, { default: runTargetedVitest }] = await Promise.all([
    vi.importActual<{ default: FocusedValidationRunner }>(
      "../../.dsh/tools/run_nemoclaw_focused_repair_validation/index",
    ),
    vi.importActual<{ default: TargetedVitestRunner }>(
      "../../.dsh/tools/run_targeted_vitest/index",
    ),
  ]);
  const focused = await runFocusedValidation({
    workdir,
    files: [],
    testFiles: ["probe.test.ts"],
    projects: ["integration"],
    baseRef: "HEAD",
    formatWrite: false,
    typecheckCli: false,
    typecheckPlugin: false,
    repoChecks: false,
    diffCheck: false,
    nulCheck: false,
    docs: false,
    dryRun: false,
  });
  const targeted = await runTargetedVitest({
    workdir,
    files: ["probe.test.ts"],
    projects: ["integration"],
  });
  return { focusedOk: focused.ok, targetedCode: targeted.code };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function expectNodeToolchainBoundary(command: string): void {
  expect(command).toContain('(subpath (param "NODE_PREFIX"))');
  expect(command).toContain('-D NODE_PREFIX="$node_prefix"');
  expect(command).toContain('--ro-bind "$node_prefix" "$node_prefix"');
  expect(command).toContain('PATH="$node_bin_dir:');
}

function createWorktreeFixture(): { root: string; sentinel: string; worktree: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wrapper-isolation-"));
  const repository = path.join(root, "repository");
  const worktree = path.join(root, "worktree");
  const sentinel = path.join(root, "outside-checkout-sentinel");
  fs.mkdirSync(repository);
  fs.writeFileSync(sentinel, "must remain unreadable\n", { mode: 0o600 });
  const git = (...args: string[]) => {
    const result = spawnSync("/usr/bin/git", args, {
      cwd: repository,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "NemoClaw Validation Test");
  git("config", "user.email", "validation-test@example.invalid");
  fs.writeFileSync(path.join(repository, "tracked.txt"), "fixture\n");
  git("add", "tracked.txt");
  git("commit", "-m", "fixture");
  git("worktree", "add", "-b", "fixture-worktree", worktree);

  const bin = path.join(worktree, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  const probe = `#!/bin/sh
set -eu
/usr/bin/git status --short >/dev/null
git_common=$(/usr/bin/git rev-parse --path-format=absolute --git-common-dir)
if /bin/cat ${shellQuote(sentinel)} >/dev/null 2>&1; then
  printf '%s\n' 'outside-checkout sentinel was readable' >&2
  exit 41
fi
if /usr/bin/touch "$git_common/nemoclaw-validation-write-probe" >/dev/null 2>&1; then
  printf '%s\n' 'Git metadata was writable' >&2
  exit 42
fi
command -v node >/dev/null
command -v npx >/dev/null
printf '%s\n' "$HOME" >>"$PWD/wrapper-probe.log"
`;
  const vitest = path.join(bin, "vitest");
  fs.writeFileSync(vitest, probe, { mode: 0o755 });
  return { root, sentinel, worktree };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("credential-isolated validation wrappers", () => {
  it("exposes the active host Node toolchain read-only in both sandbox implementations", async () => {
    const commands: string[] = [];
    installTools((input) => {
      commands.push(input.command);
      return foreground();
    });

    const result = await runBothWrappers(process.cwd());

    expect(result).toEqual({ focusedOk: true, targetedCode: 0 });
    expect(commands).toHaveLength(2);
    expectNodeToolchainBoundary(commands[0]);
    expectNodeToolchainBoundary(commands[1]);
  });

  it.runIf(nativeSandboxAvailable)(
    "runs both actual wrappers from a worktree without exposing host files or writable Git metadata",
    async () => {
      const fixture = createWorktreeFixture();
      installTools((input) => {
        const result = spawnSync("/bin/sh", ["-c", input.command], {
          cwd: input.workdir,
          encoding: "utf8",
          env: process.env,
          timeout: input.timeoutMs,
        });
        return foreground(
          result.status,
          result.stdout,
          result.stderr || result.error?.message || "",
        );
      });

      try {
        const result = await runBothWrappers(fixture.worktree);

        expect(result).toEqual({ focusedOk: true, targetedCode: 0 });
        const privateHomes = fs
          .readFileSync(path.join(fixture.worktree, "wrapper-probe.log"), "utf8")
          .trim()
          .split("\n");
        expect(privateHomes).toHaveLength(2);
        expect(privateHomes.every((home) => home !== os.homedir())).toBe(true);
        expect(fs.readFileSync(fixture.sentinel, "utf8")).toBe("must remain unreadable\n");
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );
});
