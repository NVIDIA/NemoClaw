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

type FocusedValidationRunner = (
  input: Record<string, unknown>,
) => Promise<{ failed: unknown[]; ok: boolean }>;
type TargetedVitestRunner = (
  input: Record<string, unknown>,
) => Promise<{ code: number; stderr: string }>;

const nativeSandboxAvailable =
  (process.platform === "darwin" &&
    fs.existsSync("/usr/bin/sandbox-exec") &&
    spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)\n(allow default)", "/usr/bin/true"], {
      encoding: "utf8",
    }).status === 0) ||
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

function expectCommonIsolationBoundary(command: string): void {
  expect(command).toContain('PATH="$isolation_root/bin:');
  expect(command).toContain('exec /usr/bin/env GIT_DIR="$git_shadow" GIT_WORK_TREE="$repo_root"');
  expect(command).not.toContain("GIT_DIR=/git GIT_WORK_TREE=/workspace");
  expect(command).toMatch(/\(deny file-read\*\s+\(subpath \(param "GIT_DIR"\)\)/);
  expect(command).toMatch(/\(allow file-read\* \(subpath \(param "GIT_OBJECTS"\)\)\)/);
  expect(command).toContain('--ro-bind "$git_shadow" /workspace/.git');
  expect(command).toContain("(allow network-outbound (remote ip))");
  expect(command).toContain('(allow network* (subpath (param "ISOLATION_ROOT")))');
  expect(command).not.toContain("(allow network*)");
}

function expectFocusedNodeToolchainBoundary(command: string): void {
  expect(command).toContain('(subpath (param "NODE_PREFIX"))');
  expect(command).toContain('-D NODE_PREFIX="$node_prefix"');
  expect(command).toContain('--ro-bind "$node_prefix" "$node_prefix"');
  expectCommonIsolationBoundary(command);
}

function expectTargetedNodeToolchainBoundary(command: string): void {
  expect(command).toContain('(literal (param "NODE_EXECUTABLE"))');
  expect(command).toContain('-D NODE_EXECUTABLE="$node_executable"');
  expect(command).toContain('--ro-bind "$node_executable" "$node_executable"');
  expect(command).not.toContain('(subpath (param "NODE_PREFIX"))');
  expectCommonIsolationBoundary(command);
}

function createCheckoutFixture(
  linked: boolean,
  outsideSocket?: string,
  outsideReadableCanary?: string,
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
  const nestedConfig = path.join(repository, ".git", "modules", "fixture", "config");
  fs.mkdirSync(path.dirname(nestedConfig), { recursive: true });
  fs.writeFileSync(nestedConfig, "benign-submodule-git-config-canary\n", { mode: 0o600 });
  const sandboxConfig =
    process.platform === "linux" ? (linked ? "/git/config" : "/workspace/.git/config") : config;
  const sandboxNestedConfig =
    process.platform === "linux"
      ? linked
        ? "/git/modules/fixture/config"
        : "/workspace/.git/modules/fixture/config"
      : nestedConfig;
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
  const readableCanaryProbe = outsideReadableCanary
    ? `if /bin/cat ${shellQuote(outsideReadableCanary)} >/dev/null 2>&1; then
  printf '%s\\n' 'outside credential canary was readable' >&2
  exit 47
fi`
    : "";

  const bin = path.join(workdir, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  const probe = `#!/bin/sh
set -eu
git status --short >/dev/null
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
if git config --local --get-regexp '^http\\..*\\.extraHeader$' 2>/dev/null | /usr/bin/grep -F 'benign-git-config-canary' >/dev/null; then
  printf '%s\n' 'repository Git credential config was active' >&2
  exit 44
fi
if /bin/cat ${shellQuote(sandboxNestedConfig)} 2>/dev/null | /usr/bin/grep -F 'benign-submodule-git-config-canary' >/dev/null; then
  printf '%s\n' 'nested Git credential config was readable' >&2
  exit 46
fi
${socketProbe}
${readableCanaryProbe}
nested_repository="$TMPDIR/nested-repository"
/bin/mkdir "$nested_repository"
git init --initial-branch=main "$nested_repository" >/dev/null
printf '%s\n' 'nested fixture' >"$nested_repository/tracked.txt"
git -C "$nested_repository" add tracked.txt
test -f "$nested_repository/.git/index"
command -v node >/dev/null
printf '%s\n' "$HOME" >>"$PWD/wrapper-probe.log"
`;
  const vitest = path.join(bin, "vitest");
  fs.writeFileSync(vitest, probe, { mode: 0o755 });
  const vitestPackage = path.join(workdir, "node_modules", "vitest");
  fs.mkdirSync(vitestPackage, { recursive: true });
  fs.writeFileSync(
    path.join(vitestPackage, "vitest.mjs"),
    `import { spawnSync } from "node:child_process";
import path from "node:path";
const result = spawnSync(path.join(process.cwd(), "node_modules", ".bin", "vitest"), {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
  );
  return { config, root, sentinel, workdir };
}

function createShortSocketRoot(): string {
  const preferred = path.join(os.tmpdir(), "ncv-s.");
  const socketSuffixLength = 6 + "/outside.sock".length;
  return fs.mkdtempSync(preferred.length + socketSuffixLength <= 103 ? preferred : "/tmp/ncv-s.");
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
    expectFocusedNodeToolchainBoundary(commands[0]);
    expectTargetedNodeToolchainBoundary(commands[1]);
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

  it.runIf(nativeSandboxAvailable)(
    "denies sibling credentials when Node is installed directly under the host home",
    async () => {
      const syntheticHome = fs.mkdtempSync(path.join(os.tmpdir(), "ncv-node-home-"));
      const syntheticBin = path.join(syntheticHome, "bin");
      const syntheticNode = path.join(syntheticBin, "node");
      const credentialCanary = path.join(syntheticHome, ".ssh", "nemoclaw-canary");
      fs.mkdirSync(syntheticBin, { recursive: true });
      fs.mkdirSync(path.dirname(credentialCanary), { recursive: true });
      fs.writeFileSync(syntheticNode, '#!/bin/sh\nexec "$PWD/node_modules/.bin/vitest" "$@"\n', {
        mode: 0o755,
      });
      fs.writeFileSync(credentialCanary, "must remain unreadable\n", { mode: 0o600 });
      const fixture = createCheckoutFixture(false, undefined, credentialCanary);
      const originalExecPath = Object.getOwnPropertyDescriptor(process, "execPath");
      const originalHome = process.env.HOME;
      Object.defineProperty(process, "execPath", { ...originalExecPath, value: syntheticNode });
      process.env.HOME = syntheticHome;
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
        const [{ default: runFocusedValidation }, { default: runTargetedVitest }] =
          await Promise.all([
            vi.importActual<{ default: FocusedValidationRunner }>(
              "../../.dsh/tools/run_nemoclaw_focused_repair_validation/index",
            ),
            vi.importActual<{ default: TargetedVitestRunner }>(
              "../../.dsh/tools/run_targeted_vitest/index",
            ),
          ]);
        await expect(
          runFocusedValidation({
            workdir: fixture.workdir,
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
          }),
        ).rejects.toThrow("cannot expose the host HOME");
        const targeted = await runTargetedVitest({
          workdir: fixture.workdir,
          files: ["probe.test.ts"],
          projects: ["integration"],
        });
        expect(targeted, targeted.stderr).toMatchObject({ code: 0 });
        expect(fs.readFileSync(credentialCanary, "utf8")).toBe("must remain unreadable\n");
      } finally {
        Object.defineProperty(process, "execPath", originalExecPath as PropertyDescriptor);
        originalHome === undefined ? delete process.env.HOME : (process.env.HOME = originalHome);
        fs.rmSync(fixture.root, { recursive: true, force: true });
        fs.rmSync(syntheticHome, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "darwin")(
    "creates the Unix-socket fixture under the active bounded temporary root",
    async () => {
      const socketRoot = createShortSocketRoot();
      const socketPath = path.join(socketRoot, "outside.sock");
      const server = spawn(
        process.execPath,
        [
          "-e",
          'const net = require("node:net"); const server = net.createServer(); server.listen(process.argv[1], () => process.stdout.write("ready\\n"));',
          socketPath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.stdout.once("data", () => resolve());
        });
        expect(socketPath.length).toBeLessThanOrEqual(103);
        expect(socketRoot.startsWith(os.tmpdir()) || socketRoot.startsWith("/tmp/")).toBe(true);
      } finally {
        server.kill();
        fs.rmSync(socketRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "darwin" && nativeSandboxAvailable)(
    "denies outside Unix sockets through both actual macOS wrappers",
    async () => {
      const socketRoot = createShortSocketRoot();
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
