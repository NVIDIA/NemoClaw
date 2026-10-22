// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
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
    spawnSync(
      "/bin/sh",
      [
        "-c",
        "command -v bwrap >/dev/null 2>&1 && bwrap --die-with-parent --new-session --unshare-all --share-net --ro-bind / / /bin/true",
      ],
      { encoding: "utf8" },
    ).status === 0);

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
  expect(command).toContain('GIT_DIR="$git_shadow" GIT_WORK_TREE="$repo_root"');
  expect(command).toContain("GIT_DIR=/git GIT_WORK_TREE=/workspace");
  expect(command).toContain('(literal (param "GIT_CONFIG_PATH"))');
  expect(command).toContain('--ro-bind "$git_shadow" /git');
  expect(command).toContain("(allow network-outbound (remote ip))");
  expect(command).toContain('(allow network* (subpath (param "ISOLATION_ROOT")))');
  expect(command).not.toContain("(allow network*)");
}

function createCheckoutFixture(
  linked: boolean,
  outsideSocket?: string,
): { config: string; root: string; sentinel: string; workdir: string } {
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
  git(
    "config",
    "http.https://example.invalid/.extraHeader",
    "Authorization: Bearer benign-git-config-canary",
  );
  fs.writeFileSync(path.join(repository, "tracked.txt"), "fixture\n");
  git("add", "tracked.txt");
  git("commit", "-m", "fixture");
  linked ? git("worktree", "add", "-b", "fixture-worktree", worktree) : undefined;
  const workdir = linked ? worktree : repository;
  const config = path.join(repository, ".git", "config");
  const sandboxConfig =
    process.platform === "linux" ? (linked ? "/git/config" : "/workspace/.git/config") : config;
  const sandboxGitMetadata =
    process.platform === "linux"
      ? linked
        ? "/git"
        : "/workspace/.git"
      : path.join(repository, ".git");
  const socketProbe = outsideSocket
    ? `if /usr/bin/nc -w 1 -U ${shellQuote(outsideSocket)} 2>/dev/null | /usr/bin/grep -F 'outside-unix-socket-canary' >/dev/null; then
  printf '%s\\n' 'outside Unix socket was reachable' >&2
  exit 45
fi`
    : "";

  const bin = path.join(workdir, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  const probe = `#!/bin/sh
set -eu
/usr/bin/git status --short >/dev/null
if /bin/cat ${shellQuote(sentinel)} >/dev/null 2>&1; then
  printf '%s\n' 'outside-checkout sentinel was readable' >&2
  exit 41
fi
if /usr/bin/touch ${shellQuote(path.join(sandboxGitMetadata, "nemoclaw-validation-write-probe"))} >/dev/null 2>&1; then
  printf '%s\n' 'Git metadata was writable' >&2
  exit 42
fi
if /bin/cat ${shellQuote(sandboxConfig)} 2>/dev/null | /usr/bin/grep -F 'benign-git-config-canary' >/dev/null; then
  printf '%s\n' 'repository Git credential config was readable' >&2
  exit 43
fi
if /usr/bin/git config --local --get-regexp '^http\\..*\\.extraHeader$' 2>/dev/null | /usr/bin/grep -F 'benign-git-config-canary' >/dev/null; then
  printf '%s\n' 'repository Git credential config was active' >&2
  exit 44
fi
${socketProbe}
command -v node >/dev/null
command -v npx >/dev/null
printf '%s\n' "$HOME" >>"$PWD/wrapper-probe.log"
`;
  const vitest = path.join(bin, "vitest");
  fs.writeFileSync(vitest, probe, { mode: 0o755 });
  return { config, root, sentinel, workdir };
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

  it.runIf(nativeSandboxAvailable).each([
    ["ordinary checkout", false],
    ["linked worktree", true],
  ] as const)(
    "runs both actual wrappers from a %s without exposing host files, Git credentials, or writable Git metadata",
    async (_name, linked) => {
      const fixture = createCheckoutFixture(linked);
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
        const result = await runBothWrappers(fixture.workdir);

        expect(result).toEqual({ focusedOk: true, targetedCode: 0 });
        const privateHomes = fs
          .readFileSync(path.join(fixture.workdir, "wrapper-probe.log"), "utf8")
          .trim()
          .split("\n");
        expect(privateHomes).toHaveLength(2);
        expect(privateHomes.every((home) => home !== os.homedir())).toBe(true);
        expect(fs.readFileSync(fixture.sentinel, "utf8")).toBe("must remain unreadable\n");
        expect(fs.readFileSync(fixture.config, "utf8")).toContain("benign-git-config-canary");
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "darwin" && nativeSandboxAvailable)(
    "denies outside Unix sockets through both actual macOS wrappers",
    async () => {
      const socketRoot = fs.mkdtempSync("/tmp/ncv-socket-");
      const socketPath = path.join(socketRoot, "outside.sock");
      const serverScript = path.join(socketRoot, "server.mjs");
      fs.writeFileSync(
        serverScript,
        `import net from "node:net";\nconst server = net.createServer((socket) => socket.end("outside-unix-socket-canary"));\nserver.listen(process.argv[2], () => process.stdout.write("ready\\n"));\n`,
      );
      const server = spawn(process.execPath, [serverScript, socketPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const fixture = createCheckoutFixture(true, socketPath);
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
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.stdout.once("data", () => resolve());
        });
        await expect(runBothWrappers(fixture.workdir)).resolves.toEqual({
          focusedOk: true,
          targetedCode: 0,
        });
      } finally {
        server.kill();
        fs.rmSync(fixture.root, { recursive: true, force: true });
        fs.rmSync(socketRoot, { recursive: true, force: true });
      }
    },
  );
});
