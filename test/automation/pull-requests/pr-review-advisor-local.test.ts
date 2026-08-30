// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalReviewSnapshot,
  defaultLocalReviewLifecycle,
  runLocalReview,
  type LocalReviewLifecycle,
  type LocalReviewPublication,
} from "../../../tools/pr-review-advisor/local-review-implementation.mts";
import { defaultOpenShellTools } from "../../../tools/openshell-agent/runtime.mts";
import { ADVISOR_PI_IMAGE } from "../../../tools/pr-review-advisor/runtime-constants.mts";
import {
  redactAdvisorDiagnostic,
  runAdvisorSpecialist,
  runAdvisorSpecialistCommand,
} from "../../../tools/pr-review-advisor/specialist-lifecycle.mts";
import { ADVISOR_SPECIALISTS } from "../../../tools/pr-review-advisor/specialist-catalog.mts";

const SIGTERM_IGNORING_CHILD_FIXTURE = fileURLToPath(
  new URL("./fixtures/sigterm-ignoring-child.ts", import.meta.url),
);

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-review-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sourceState(source: string): unknown {
  return {
    head: git(source, ["rev-parse", "HEAD"]),
    status: git(source, ["status", "--porcelain=v1", "-uall"]),
    staged: git(source, ["diff", "--cached", "--binary"]),
    unstaged: git(source, ["diff", "--binary"]),
    files: ["committed.txt", "staged.txt", "unstaged.txt", "untracked.txt"].map((name) =>
      fs.readFileSync(path.join(source, name), "utf8"),
    ),
    link: fs.readlinkSync(path.join(source, "untracked-link")),
  };
}

function installFakeNpm(source: string, body?: string): string {
  const bin = path.join(temporaryDirectory(), ".local", "bin");
  body ??= `printf "%s\\n" "$@" > ${JSON.stringify(path.join(source, "npm-args"))}
env | sort > ${JSON.stringify(path.join(source, "npm-env"))}
mkdir -p node_modules`;
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\nset -eu\n${body}\n`);
  fs.chmodSync(path.join(bin, "npm"), 0o755);
  fs.writeFileSync(
    path.join(source, "package.json"),
    '{"name":"trusted-review","version":"1.0.0"}\n',
  );
  fs.writeFileSync(
    path.join(source, "package-lock.json"),
    '{"name":"trusted-review","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"trusted-review","version":"1.0.0"}}}\n',
  );
  return bin;
}

function artifactLifecycle(stop = async (): Promise<void> => undefined): LocalReviewLifecycle {
  return {
    prepare: async () => undefined,
    startGateway: () => ({ configure: Promise.resolve(), stop }),
    create: () => undefined,
    run: () => undefined,
    download: (env) => {
      const interest = env.PR_REVIEW_ADVISOR_INTEREST as string;
      const output = path.join(
        env.GITHUB_WORKSPACE as string,
        "artifacts",
        env.PR_REVIEW_ADVISOR_ARTIFACT_DIR as string,
      );
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, "pr-review-" + interest + "-summary.md"), "review\n");
      fs.writeFileSync(path.join(output, "pr-review-" + interest + "-session.jsonl"), "{}\n");
    },
    remove: () => undefined,
  };
}

function repository(): string {
  const directory = temporaryDirectory();
  git(directory, ["init", "--initial-branch=main"]);
  git(directory, ["config", "user.name", "Test"]);
  git(directory, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(
    path.join(directory, ".gitignore"),
    "ignored.txt\nartifacts/pr-review-advisor-local/\n",
  );
  fs.writeFileSync(path.join(directory, "committed.txt"), "base\n");
  fs.writeFileSync(path.join(directory, "staged.txt"), "base\n");
  fs.writeFileSync(path.join(directory, "unstaged.txt"), "base\n");
  fs.mkdirSync(path.join(directory, "tools", "pr-review-advisor"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "tools", "pr-review-advisor", "policy.txt"),
    "base policy\n",
  );
  git(directory, ["add", "."]);
  git(directory, ["commit", "-m", "base"]);
  git(directory, ["remote", "add", "origin", directory]);
  git(directory, ["fetch", "origin", "main"]);
  git(directory, ["switch", "-c", "feature"]);
  fs.writeFileSync(path.join(directory, "committed.txt"), "branch\n");
  git(directory, ["commit", "-am", "branch"]);
  fs.writeFileSync(path.join(directory, "staged.txt"), "staged\n");
  git(directory, ["add", "staged.txt"]);
  fs.writeFileSync(path.join(directory, "unstaged.txt"), "unstaged\n");
  fs.writeFileSync(path.join(directory, "untracked.txt"), "untracked\n");
  fs.symlinkSync("/etc/passwd", path.join(directory, "untracked-link"));
  fs.writeFileSync(path.join(directory, "ignored.txt"), "ignored\n");
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  temporaryDirectories
    .splice(0)
    .forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
});

describe("local PR review advisor", () => {
  it.each([
    ["environment value", "failure env-secret", "failure [REDACTED]"],
    ["secret assignment", "failure token=literal-secret", "failure token=[REDACTED]"],
    [
      "authorization",
      "failure Authorization: Basic literal-secret",
      "failure Authorization: [REDACTED]",
    ],
    ["bearer credential", "failure Bearer literal-secret", "failure Bearer [REDACTED]"],
  ])("redacts %s diagnostics", (_case, diagnostic, expected) => {
    vi.stubEnv("ADVISOR_TEST_SECRET", "env-secret");
    const redacted = redactAdvisorDiagnostic(diagnostic);
    expect(redacted).toContain(expected);
    expect(redacted).not.toMatch(/env-secret|literal-secret/u);
  });

  it("owns CI analysis gateway cleanup across lifecycle outcomes", async () => {
    const unavailable = vi.fn();
    const stop = vi.fn(async () => undefined);
    const lifecycle = { ...artifactLifecycle(stop), unavailable };
    const prepare = vi.spyOn(lifecycle, "prepare");
    const startGateway = vi.spyOn(lifecycle, "startGateway");

    await runAdvisorSpecialistCommand("prepare", {}, lifecycle);
    await runAdvisorSpecialistCommand(
      "analysis",
      { PR_REVIEW_ADVISOR_RUN_ANALYSIS: "0" },
      lifecycle,
    );
    await expect(runAdvisorSpecialistCommand(undefined, {}, lifecycle)).rejects.toThrow(
      "Unsupported specialist lifecycle command: missing",
    );

    expect(prepare).toHaveBeenCalledOnce();
    expect(startGateway).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "success",
      configure: () => Promise.resolve(),
      downloadFailure: undefined,
      expected: "complete",
      unavailable: 0,
    },
    {
      name: "configuration failure",
      configure: () => Promise.reject(new Error("configuration api_key=ci-secret")),
      downloadFailure: undefined,
      expected: "configuration api_key=[REDACTED]",
      unavailable: 1,
    },
    {
      name: "later failure",
      configure: () => Promise.resolve(),
      downloadFailure: new Error("download failed"),
      expected: "download failed",
      unavailable: 0,
    },
  ])(
    "stops the CI-owned gateway after $name (#10611)",
    async ({ configure, downloadFailure, expected, unavailable }) => {
      const stop = vi.fn(async () => undefined);
      const unavailableArtifact = vi.fn();
      const configuration = configure();
      void configuration.catch(() => undefined);
      const lifecycle: LocalReviewLifecycle = {
        ...artifactLifecycle(stop),
        startGateway: () => ({ configure: configuration, stop }),
        download: () => {
          downloadFailure &&
            (() => {
              throw downloadFailure;
            })();
        },
        unavailable: unavailableArtifact,
      };

      const result = await runAdvisorSpecialistCommand(
        "analysis",
        { PR_REVIEW_ADVISOR_RUN_ANALYSIS: "1", PR_REVIEW_ADVISOR_API_KEY: "ci-secret" },
        lifecycle,
      ).then(
        () => "complete",
        (error: Error) => error.message,
      );

      expect(result).toContain(expected);
      expect(stop).toHaveBeenCalledOnce();
      expect(unavailableArtifact).toHaveBeenCalledTimes(unavailable);
    },
  );

  it("kills a SIGTERM-ignoring execution before sandbox and gateway cleanup (#10611)", async () => {
    const source = repository();
    const childDirectory = temporaryDirectory();
    const pidPath = path.join(childDirectory, "pid");
    const termPath = path.join(childDirectory, "term");
    const events: string[] = [];
    const stop = vi.fn(async () => {
      events.push("gateway");
    });
    let childPid = 0;
    const lifecycle: LocalReviewLifecycle = {
      ...artifactLifecycle(stop),
      create: () => undefined,
      run: () => {
        const execution = defaultOpenShellTools.runAsync!(
          process.execPath,
          ["--experimental-strip-types", "--no-warnings", SIGTERM_IGNORING_CHILD_FIXTURE],
          { env: { ...process.env, PID_PATH: pidPath, TERM_PATH: termPath } },
        );
        return {
          cancel: () => {
            events.push("cancel");
            return execution.cancel();
          },
          completion: execution.completion,
        };
      },
      remove: () => {
        events.push("sandbox");
      },
    };
    const realKill = process.kill.bind(process);
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, signal) =>
        pid === process.pid && signal !== 0 ? (events.push("signal"), true) : realKill(pid, signal),
      );

    const review = runLocalReview({
      source,
      specialists: ADVISOR_SPECIALISTS.slice(0, 1),
      lifecycle,
      temporaryRoot: temporaryDirectory(),
    });
    await vi.waitFor(() => expect(fs.existsSync(pidPath)).toBe(true));
    childPid = Number.parseInt(fs.readFileSync(pidPath, "utf8"), 10);
    process.emit("SIGTERM");
    await expect(review).rejects.toThrow(/failed during run/u);

    expect(events.slice(0, 4)).toEqual(["cancel", "sandbox", "gateway", "signal"]);
    expect(fs.readFileSync(termPath, "utf8")).toBe("SIGTERM");
    expect(() => realKill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(kill).toHaveBeenCalledWith(-childPid, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-childPid, "SIGKILL");
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });

  it("exports the digest-pinned advisor image for workflow consumers (#10610)", () => {
    const githubEnv = path.join(temporaryDirectory(), "github-env");
    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        path.resolve("tools/pr-review-advisor/export-runtime-env.mts"),
      ],
      { env: { ...process.env, GITHUB_ENV: githubEnv } },
    );

    expect(fs.readFileSync(githubEnv, "utf8")).toBe(`PI_IMAGE=${ADVISOR_PI_IMAGE}\n`);
    expect(ADVISOR_PI_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/u);
  });

  it("installs origin/main dependencies without executing contributor node_modules (#10611)", () => {
    const source = temporaryDirectory();
    git(source, ["init", "--initial-branch=main"]);
    git(source, ["config", "user.name", "Test"]);
    git(source, ["config", "user.email", "test@example.com"]);
    fs.mkdirSync(path.join(source, "tools", "pr-review-advisor"), { recursive: true });
    fs.copyFileSync(
      path.resolve("tools/pr-review-advisor/local-review.mts"),
      path.join(source, "tools", "pr-review-advisor", "local-review.mts"),
    );
    fs.writeFileSync(
      path.join(source, "tools", "pr-review-advisor", "trusted-host.mts"),
      'export const hostValue = "trusted host";\n',
    );
    fs.writeFileSync(
      path.join(source, "tools", "pr-review-advisor", "policy.txt"),
      "trusted policy\n",
    );
    fs.writeFileSync(
      path.join(source, "tools", "pr-review-advisor", "local-review-implementation.mts"),
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        'import { execFileSync } from "node:child_process";',
        'import { hostValue } from "./trusted-host.mts";',
        "const source = process.argv[2];",
        'const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();',
        'let detached = false; try { execFileSync("git", ["symbolic-ref", "-q", "HEAD"], { stdio: "ignore" }); } catch { detached = true; }',
        'const policy = fs.readFileSync(path.join(source, "tools/pr-review-advisor/policy.txt"), "utf8").trim();',
        'fs.writeFileSync(path.join(source, "bootstrap-result.txt"), [hostValue, policy].join("|") + "\\n");',
        'fs.writeFileSync(path.join(source, "trusted-child.json"), JSON.stringify({ pid: process.pid, nodeOptions: process.env.NODE_OPTIONS, nodePath: process.env.NODE_PATH, git: fs.existsSync(".git"), gitHead, detached }));',
      ].join("\n"),
    );
    const npmBin = installFakeNpm(source);
    const preloadMarker = path.join(source, "preload-marker");
    const preload = path.join(source, "contributor-preload.cjs");
    fs.writeFileSync(
      preload,
      `require("node:fs").appendFileSync(${JSON.stringify(preloadMarker)}, process.pid + ":" + (process.env.PR_REVIEW_ADVISOR_API_KEY || "absent") + "\\n");`,
    );
    const maliciousBin = path.join(source, "node_modules", ".bin");
    fs.mkdirSync(maliciousBin, { recursive: true });
    const maliciousGit = path.join(maliciousBin, "git");
    const maliciousNpm = path.join(maliciousBin, "npm");
    const maliciousOpenShell = path.join(maliciousBin, "openshell");
    fs.writeFileSync(
      maliciousGit,
      `#!/bin/sh\nenv > ${JSON.stringify(path.join(source, "git-malicious-env"))}\nexit 99\n`,
    );
    fs.writeFileSync(
      maliciousNpm,
      `#!/bin/sh\nenv > ${JSON.stringify(path.join(source, "npm-malicious-env"))}\nexit 99\n`,
    );
    fs.writeFileSync(
      maliciousOpenShell,
      `#!/bin/sh\nenv > ${JSON.stringify(path.join(source, "openshell-malicious-env"))}\nexit 99\n`,
    );
    fs.chmodSync(maliciousGit, 0o755);
    fs.chmodSync(maliciousNpm, 0o755);
    fs.chmodSync(maliciousOpenShell, 0o755);
    fs.writeFileSync(path.join(source, ".gitattributes"), "*.txt filter=hostile\n");
    git(source, ["add", "."]);
    git(source, ["commit", "-m", "trusted base"]);
    git(source, ["remote", "add", "origin", source]);
    git(source, ["fetch", "origin", "main"]);
    git(source, ["switch", "-c", "feature"]);
    fs.writeFileSync(
      path.join(source, "tools", "pr-review-advisor", "trusted-host.mts"),
      'throw new Error("branch host executed");\n',
    );
    fs.writeFileSync(
      path.join(source, "tools", "pr-review-advisor", "policy.txt"),
      'branch policy data; throw new Error("policy executed")\n',
    );
    git(source, ["commit", "-am", "untrusted branch changes"]);
    fs.mkdirSync(path.join(source, "node_modules", "malicious"), { recursive: true });
    const bootstrapFilterMarker = path.join(source, "bootstrap-filter-ran");
    execFileSync(
      "git",
      [
        "config",
        "--global",
        "filter.hostile.smudge",
        `sh -c 'printf %s \"$PR_REVIEW_ADVISOR_API_KEY\" > ${bootstrapFilterMarker}; cat'`,
      ],
      { env: { ...process.env, HOME: path.resolve(npmBin, "../..") } },
    );
    fs.writeFileSync(
      path.join(source, "node_modules", "malicious", "index.js"),
      'require("node:fs").writeFileSync("contributor-module-executed", "yes")\n',
    );

    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "tools/pr-review-advisor/local-review.mts"],
      {
        cwd: source,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: path.resolve(npmBin, "../.."),
          PATH: maliciousBin + path.delimiter + npmBin + path.delimiter + process.env.PATH,
          PR_REVIEW_ADVISOR_API_KEY: "must-not-reach-malicious-tools",
          NODE_OPTIONS: "--require=" + preload,
          NODE_PATH: maliciousBin,
          SECRET_TOKEN: "must-not-reach-npm",
          npm_config_cache: path.join(source, "npm-cache"),
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(source, "bootstrap-result.txt"), "utf8")).toBe(
      'trusted host|branch policy data; throw new Error("policy executed")\n',
    );
    expect(fs.readFileSync(preloadMarker, "utf8").trim().split("\n")).toHaveLength(1);
    const trustedChild = JSON.parse(
      fs.readFileSync(path.join(source, "trusted-child.json"), "utf8"),
    );
    expect(
      Number(preloadMarker && fs.readFileSync(preloadMarker, "utf8").split(":", 1)[0]),
    ).not.toBe(trustedChild.pid);
    expect(trustedChild).toEqual({
      pid: expect.any(Number),
      git: true,
      gitHead: git(source, ["rev-parse", "origin/main"]),
      detached: true,
    });
    expect(fs.existsSync(path.join(source, "contributor-module-executed"))).toBe(false);
    expect(fs.existsSync(path.join(source, "git-malicious-env"))).toBe(false);
    expect(fs.existsSync(bootstrapFilterMarker)).toBe(false);
    expect(fs.existsSync(path.join(source, "npm-malicious-env"))).toBe(false);
    expect(fs.existsSync(path.join(source, "openshell-malicious-env"))).toBe(false);
    expect(fs.readFileSync(path.join(source, "npm-args"), "utf8")).toBe(
      "ci\n--ignore-scripts\n--no-audit\n--no-fund\n",
    );
    const npmEnvironment = fs.readFileSync(path.join(source, "npm-env"), "utf8");
    expect(npmEnvironment).not.toContain("SECRET_TOKEN=");
    expect(npmEnvironment).toContain("npm_config_userconfig=" + os.devNull);
    expect(npmEnvironment).toMatch(/npm_config_globalconfig=.*nemoclaw-local-review-bootstrap-/u);
    expect(npmEnvironment).toContain("npm_config_cache=" + path.join(source, "npm-cache"));
  });

  it("removes the bootstrap checkout before preserving a termination signal (#10611)", async () => {
    const source = temporaryDirectory();
    const temporaryRoot = temporaryDirectory();
    git(source, ["init", "--initial-branch=main"]);
    git(source, ["config", "user.name", "Test"]);
    git(source, ["config", "user.email", "test@example.com"]);
    fs.mkdirSync(path.join(source, "tools", "pr-review-advisor"), { recursive: true });
    fs.copyFileSync(
      path.resolve("tools/pr-review-advisor/local-review.mts"),
      path.join(source, "tools", "pr-review-advisor", "local-review.mts"),
    );
    fs.writeFileSync(
      path.join(source, "tools", "pr-review-advisor", "local-review-implementation.mts"),
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        'fs.writeFileSync(path.join(process.argv[2], "wrapper-ready"), "ready\\n");',
        "setInterval(() => undefined, 1000);",
      ].join("\n"),
    );
    const npmStarted = path.join(source, "npm-started");
    const npmBin = installFakeNpm(
      source,
      `touch ${JSON.stringify(npmStarted)}\ntrap 'exit 143' TERM INT HUP\nwhile :; do sleep 1; done`,
    );
    git(source, ["add", "."]);
    git(source, ["commit", "-m", "trusted base"]);
    git(source, ["remote", "add", "origin", source]);
    git(source, ["fetch", "origin", "main"]);
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "tools/pr-review-advisor/local-review.mts"],
      {
        cwd: source,
        env: {
          ...process.env,
          HOME: path.resolve(npmBin, "../.."),
          TMPDIR: temporaryRoot,
          PATH: npmBin + path.delimiter + process.env.PATH,
        },
        stdio: "pipe",
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    await vi.waitFor(() => expect(fs.existsSync(npmStarted)).toBe(true));
    expect(fs.existsSync(path.join(source, "wrapper-ready"))).toBe(false);

    child.kill("SIGTERM");
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
    );

    expect(result, stderr).toEqual({ code: null, signal: "SIGTERM" });
    expect(
      fs
        .readdirSync(temporaryRoot)
        .filter((name) => name.startsWith("nemoclaw-local-review-bootstrap-")),
    ).toEqual([]);
  });

  it.each([
    ["status", "process.exitCode = 23;", 23, null, "exited with status 23"],
    ["signal", 'process.kill(process.pid, "SIGTERM");', null, "SIGTERM", "terminated by SIGTERM"],
  ])(
    "reports bootstrap cleanup failure with original %s semantics (#10611)",
    async (_mode, action, expectedStatus, expectedSignal, expectedDiagnostic) => {
      const source = temporaryDirectory();
      const temporaryRoot = temporaryDirectory();
      git(source, ["init", "--initial-branch=main"]);
      git(source, ["config", "user.name", "Test"]);
      git(source, ["config", "user.email", "test@example.com"]);
      fs.mkdirSync(path.join(source, "tools", "pr-review-advisor"), { recursive: true });
      fs.copyFileSync(
        path.resolve("tools/pr-review-advisor/local-review.mts"),
        path.join(source, "tools", "pr-review-advisor", "local-review.mts"),
      );
      fs.writeFileSync(
        path.join(source, "tools", "pr-review-advisor", "local-review-implementation.mts"),
        action + "\n",
      );
      const npmBin = installFakeNpm(source);
      git(source, ["add", "."]);
      git(source, ["commit", "-m", "trusted base"]);
      git(source, ["remote", "add", "origin", source]);
      git(source, ["fetch", "origin", "main"]);
      const patch = path.join(temporaryRoot, "fail-cleanup.cjs");
      fs.writeFileSync(
        patch,
        'const fs=require("node:fs");const rm=fs.rmSync;fs.rmSync=(p,o)=>String(p).includes("nemoclaw-local-review-bootstrap-")&&o?.recursive?(()=>{throw new Error("injected cleanup denial")})():rm(p,o);\n',
      );
      const result = spawnSync(
        process.execPath,
        [
          "--require",
          patch,
          "--experimental-strip-types",
          "--no-warnings",
          "tools/pr-review-advisor/local-review.mts",
        ],
        {
          cwd: source,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: path.resolve(npmBin, "../.."),
            PATH: npmBin + path.delimiter + process.env.PATH,
            TMPDIR: temporaryRoot,
          },
        },
      );
      expect(result.stderr).toContain("cleanup also failed for");
      expect(result.stderr).toContain("injected cleanup denial");
      expect(result.status).toBe(expectedStatus);
      expect(result.signal).toBe(expectedSignal);
      expect(result.stderr).toContain(expectedDiagnostic);
    },
  );

  it("explains that local review requires the bootstrap repair on origin/main (#10611)", () => {
    const source = repository();
    fs.mkdirSync(path.join(source, "node_modules"));

    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        path.resolve("tools/pr-review-advisor/local-review.mts"),
      ],
      { cwd: source, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "origin/main does not contain the trusted local review implementation",
    );
    expect(result.stderr).toContain("after the bootstrap repair is merged");
  });

  it("passes the default prepare boundary from a canonical advisor checkout (#10611)", async () => {
    const source = repository();
    const root = temporaryDirectory();
    const advisor = path.join(root, "advisor");
    const workdir = path.join(root, "pr-workdir");
    git(root, ["clone", "--quiet", source, advisor]);
    git(root, ["clone", "--quiet", source, workdir]);
    const runnerTemp = path.join(root, "runner");
    fs.mkdirSync(runnerTemp);

    await defaultLocalReviewLifecycle.prepare({
      ...process.env,
      ADVISOR_DIR: advisor,
      ADVISOR_WORKDIR: workdir,
      BASE_REF: git(workdir, ["rev-parse", "HEAD^"]),
      HEAD_REF: git(workdir, ["rev-parse", "HEAD"]),
      PR_REVIEW_ADVISOR_INTEREST: "design-architecture",
      RUNNER_TEMP: runnerTemp,
    });

    expect(
      fs.existsSync(path.join(runnerTemp, "pr-review-advisor-context", "github-context.json")),
    ).toBe(true);
    execFileSync("chmod", ["-R", "u+w", advisor, workdir, runnerTemp]);
  });

  it("snapshots branch, staged, unstaged, and nonignored untracked changes without source mutation (#10610)", () => {
    const source = repository();
    const before = git(source, ["status", "--porcelain=v1", "-uall"]);
    const snapshot = path.join(temporaryDirectory(), "pr-workdir");

    const refs = createLocalReviewSnapshot(source, snapshot);

    expect(
      git(snapshot, ["diff", "--name-only", refs.baseRef + ".." + refs.headRef]).split("\n"),
    ).toEqual(["committed.txt", "staged.txt", "unstaged.txt", "untracked-link", "untracked.txt"]);
    expect(fs.readFileSync(path.join(snapshot, "committed.txt"), "utf8")).toBe("branch\n");
    expect(fs.readFileSync(path.join(snapshot, "staged.txt"), "utf8")).toBe("staged\n");
    expect(fs.readFileSync(path.join(snapshot, "unstaged.txt"), "utf8")).toBe("unstaged\n");
    expect(fs.readFileSync(path.join(snapshot, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(fs.existsSync(path.join(snapshot, "ignored.txt"))).toBe(false);
    expect(git(snapshot, ["ls-tree", refs.headRef, "untracked-link"])).toContain("120000 blob");
    expect(fs.existsSync(path.join(snapshot, "untracked-link"))).toBe(false);
    expect(git(source, ["status", "--porcelain=v1", "-uall"])).toBe(before);
  });

  it("does not execute host Git filters or expose the advisor key while snapshotting (#10611)", () => {
    const source = repository();
    const home = temporaryDirectory();
    const marker = path.join(home, "filter-ran");
    fs.writeFileSync(path.join(source, ".gitattributes"), "*.txt filter=hostile\n");
    git(source, ["add", ".gitattributes"]);
    git(source, ["commit", "-m", "select hostile filter"]);
    execFileSync(
      "git",
      [
        "config",
        "--global",
        "filter.hostile.smudge",
        `sh -c 'printf %s \"$PR_REVIEW_ADVISOR_API_KEY\" > ${marker}; cat'`,
      ],
      { env: { ...process.env, HOME: home } },
    );
    vi.stubEnv("HOME", home);
    vi.stubEnv("PR_REVIEW_ADVISOR_API_KEY", "must-not-reach-filter");

    createLocalReviewSnapshot(source, path.join(temporaryDirectory(), "snapshot"));

    expect(fs.existsSync(marker)).toBe(false);
  });

  it("runs each catalogued specialist through the existing lifecycle and publishes only Markdown and JSONL (#10610)", async () => {
    const source = repository();
    const root = temporaryDirectory();
    const before = sourceState(source);
    const calls: string[] = [];
    const stopGateway = vi.fn(async () => undefined);
    const lifecycle: LocalReviewLifecycle = {
      prepare: async (env) => {
        calls.push("prepare:" + env.PR_REVIEW_ADVISOR_INTEREST);
      },
      startGateway: (env) => {
        calls.push("configure:" + env.PR_REVIEW_ADVISOR_INTEREST);
        expect(env.OPENSHELL_GATEWAY_ENDPOINT).toBe("http://127.0.0.1:8080");
        expect(env.PI_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/u);
        expect(env.SANDBOX_NAME).toMatch(/^lr-[0-9a-f]{4}-[0-9a-f]{8}$/u);
        expect(env.SANDBOX_NAME).toHaveLength(16);
        return { configure: Promise.resolve(), stop: stopGateway };
      },
      create: (env) => {
        calls.push("create:" + env.PR_REVIEW_ADVISOR_INTEREST);
      },
      run: (env) => {
        calls.push("run:" + env.PR_REVIEW_ADVISOR_INTEREST);
      },
      download: (env) => {
        const interest = env.PR_REVIEW_ADVISOR_INTEREST as string;
        calls.push("download:" + interest);
        const out = path.join(
          env.GITHUB_WORKSPACE as string,
          "artifacts",
          env.PR_REVIEW_ADVISOR_ARTIFACT_DIR as string,
        );
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, "pr-review-" + interest + "-summary.md"), "review\n");
        fs.writeFileSync(path.join(out, "pr-review-" + interest + "-session.jsonl"), "{}\n");
      },
      remove: (env) => {
        calls.push("remove:" + env.PR_REVIEW_ADVISOR_INTEREST);
      },
    };

    const destination = await runLocalReview({
      source,
      temporaryRoot: root,
      lifecycle,
    });

    expect(calls.filter((call) => call.startsWith("run:"))).toEqual(
      ADVISOR_SPECIALISTS.map(({ interest }) => "run:" + interest),
    );
    expect(calls.filter((call) => call.startsWith("configure:"))).toHaveLength(1);
    expect(stopGateway).toHaveBeenCalledOnce();
    expect(calls.filter((call) => call.startsWith("remove:"))).toHaveLength(
      ADVISOR_SPECIALISTS.length,
    );
    expect(fs.readdirSync(destination).sort()).toEqual(
      ADVISOR_SPECIALISTS.map(({ interest }) => "pr-review-specialist-" + interest).sort(),
    );
    expect(
      fs
        .readdirSync(destination, { recursive: true })
        .filter((name) => typeof name === "string" && name.includes("final-result")),
    ).toEqual([]);
    expect(sourceState(source)).toEqual(before);
  });

  it("owns gateway cleanup while provider configuration is pending (#10611)", async () => {
    const source = repository();
    let rejectConfiguration!: (error: Error) => void;
    const configuration = new Promise<void>((_resolve, reject) => {
      rejectConfiguration = reject;
    });
    const stopGateway = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("first stop failed"))
      .mockResolvedValueOnce();
    const lifecycle: LocalReviewLifecycle = {
      prepare: async () => undefined,
      startGateway: () => ({ configure: configuration, stop: stopGateway }),
      create: () => undefined,
      run: () => undefined,
      download: () => undefined,
      remove: () => undefined,
    };
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    const review = runLocalReview({
      source,
      specialists: ADVISOR_SPECIALISTS.slice(0, 1),
      lifecycle,
      temporaryRoot: temporaryDirectory(),
    });
    await vi.waitFor(() => expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0));
    process.emit("SIGTERM");
    await vi.waitFor(() => expect(stopGateway).toHaveBeenCalledOnce());
    rejectConfiguration(new Error("configuration failed"));

    await expect(review).rejects.toMatchObject({
      message: expect.stringContaining("failed during configure"),
      cause: expect.objectContaining({ message: "configuration failed" }),
    });
    expect(stopGateway).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });

  it.each(["provider create timed out", "inference set timed out"])(
    "reports bounded configuration failure and cleans owned resources: %s (#10611)",
    async (diagnostic) => {
      const source = repository();
      const stop = vi.fn(async () => undefined);
      let ownedRoot = "";
      const lifecycle: LocalReviewLifecycle = {
        prepare: async () => undefined,
        startGateway: () => ({ configure: Promise.reject(new Error(diagnostic)), stop }),
        create: vi.fn(),
        run: vi.fn(),
        download: vi.fn(),
        remove: vi.fn(),
      };
      const failure = (await runLocalReview({
        source,
        specialists: ADVISOR_SPECIALISTS.slice(0, 1),
        lifecycle,
        prepareSnapshot: (snapshotSource, target, baseRef) => {
          ownedRoot = path.dirname(target);
          return createLocalReviewSnapshot(snapshotSource, target, baseRef);
        },
      }).catch((error: unknown) => error)) as Error;
      expect(failure.message).toContain("failed during configure");
      expect(failure.message).toContain(diagnostic);
      expect(stop).toHaveBeenCalledOnce();
      expect(fs.existsSync(ownedRoot)).toBe(false);
      expect(lifecycle.create).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(source, "artifacts", "pr-review-advisor-local"))).toBe(false);
    },
  );

  it("stops an owned process group with bounded TERM then KILL and verifies exit (#10610)", async () => {
    const directory = temporaryDirectory();
    const pidPath = path.join(directory, "pid");
    const cleanup = defaultOpenShellTools.start(
      process.execPath,
      [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`,
      ],
      { env: process.env, logPath: path.join(directory, "process.log") },
    );
    expect(cleanup).toBeTypeOf("function");
    execFileSync("bash", [
      "-c",
      `for i in {1..100}; do test -s ${JSON.stringify(pidPath)} && exit 0; sleep .02; done; exit 1`,
    ]);
    const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8"), 10);

    await cleanup?.();

    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it("redacts specialist lifecycle failures without importing local review diagnostics", async () => {
    const credential = "specialist-lifecycle-secret";
    vi.stubEnv("PR_REVIEW_ADVISOR_API_KEY", credential);

    const failure = (await runAdvisorSpecialist({
      env: {
        PR_REVIEW_ADVISOR_INTEREST: "security",
        SANDBOX_NAME: "pr-adv-security",
      },
      lifecycle: {
        prepare: async () => undefined,
        startGateway: () => undefined,
        create: () => undefined,
        run: () => {
          throw new Error(
            `sandbox failed; api_key=${credential}; Authorization: Bearer other-secret`,
          );
        },
        download: () => undefined,
        remove: () => undefined,
      },
    }).catch((error: unknown) => error)) as Error;

    expect(failure.message).toContain("sandbox failed; api_key=[REDACTED]");
    expect(failure.message).toContain("Authorization: [REDACTED]");
    expect(failure.message).not.toContain(credential);
    expect(failure.message).not.toContain("other-secret");
  });

  it("redacts lifecycle credentials while preserving actionable OpenShell context (#10611)", async () => {
    const source = repository();
    const specialist = ADVISOR_SPECIALISTS[0]!;
    let sandboxName = "";
    const credential = "advisor-secret-value";
    vi.stubEnv("PR_REVIEW_ADVISOR_API_KEY", credential);
    const underlying = new Error(
      `openshell sandbox exec failed: connection refused; api_key=${credential}; Authorization: Bearer secondary-token`,
    );
    const lifecycle: LocalReviewLifecycle = {
      prepare: async () => undefined,
      startGateway: () => undefined,
      create: () => undefined,
      run: (env) => {
        sandboxName = env.SANDBOX_NAME as string;
        throw underlying;
      },
      download: () => undefined,
      remove: () => undefined,
    };

    const failure = (await runLocalReview({
      source,
      temporaryRoot: temporaryDirectory(),
      specialists: ADVISOR_SPECIALISTS.slice(0, 1),
      lifecycle,
    }).catch((error: unknown) => error)) as Error;

    expect(failure).toMatchObject({
      message: expect.stringContaining(
        `Local review failed during run for specialist ${specialist.interest}`,
      ),
      cause: expect.objectContaining({
        message: expect.stringContaining("openshell sandbox exec failed: connection refused"),
      }),
    });
    expect(failure).toMatchObject({ message: expect.stringContaining(`sandbox ${sandboxName}`) });
    expect(failure.message).toContain("openshell sandbox exec failed: connection refused");
    expect(failure.message).toContain("api_key=[REDACTED]");
    expect(failure.message).toContain("Authorization: [REDACTED]");
    expect((failure.cause as Error).message).not.toContain(credential);
    expect(failure.message).not.toContain(credential);
    expect(failure.message).not.toContain("secondary-token");
  });

  it("removes partial staging output after artifact copy failure (#10611)", async () => {
    const source = repository();
    const destination = path.join(source, "artifacts", "pr-review-advisor-local");
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "prior.txt"), "prior\n");
    const publication: LocalReviewPublication = {
      copy: (_source, staged) => {
        fs.mkdirSync(staged as string, { recursive: true });
        fs.writeFileSync(path.join(staged as string, "partial.txt"), "partial\n");
        throw new Error("copy failed");
      },
      remove: fs.rmSync,
      rename: fs.renameSync,
    };

    await expect(
      runLocalReview({
        source,
        temporaryRoot: temporaryDirectory(),
        specialists: ADVISOR_SPECIALISTS.slice(0, 1),
        lifecycle: artifactLifecycle(),
        publication,
      }),
    ).rejects.toThrow("copy failed");
    expect(fs.readFileSync(path.join(destination, "prior.txt"), "utf8")).toBe("prior\n");
    expect(
      fs.readdirSync(path.dirname(destination)).filter((name) => name.includes(".staged-")),
    ).toEqual([]);
  });

  it("rejects an artifacts symlink without touching its external target (#10611)", async () => {
    const source = repository();
    const external = temporaryDirectory();
    const sentinel = path.join(external, "sentinel");
    fs.writeFileSync(sentinel, "untouched\n");
    fs.symlinkSync(external, path.join(source, "artifacts"), "dir");

    await expect(
      runLocalReview({
        source,
        specialists: ADVISOR_SPECIALISTS.slice(0, 1),
        lifecycle: artifactLifecycle(),
        temporaryRoot: temporaryDirectory(),
      }),
    ).rejects.toThrow(/must be a directory and not a symbolic link/u);

    expect(fs.readFileSync(sentinel, "utf8")).toBe("untouched\n");
    expect(fs.readdirSync(external)).toEqual(["sentinel"]);
  });

  it("removes a run-created artifacts parent after copy failure (#10611)", async () => {
    const source = repository();
    const parent = path.join(source, "artifacts");
    fs.rmSync(parent, { recursive: true, force: true });

    await expect(
      runLocalReview({
        source,
        temporaryRoot: temporaryDirectory(),
        specialists: ADVISOR_SPECIALISTS.slice(0, 1),
        lifecycle: artifactLifecycle(),
        publication: {
          copy: () => {
            throw new Error("copy failed");
          },
          remove: fs.rmSync,
          rename: fs.renameSync,
        },
      }),
    ).rejects.toThrow("copy failed");
    expect(fs.existsSync(parent)).toBe(false);
  });

  it("restores prior output after previous-output removal fails (#10611)", async () => {
    const source = repository();
    const destination = path.join(source, "artifacts", "pr-review-advisor-local");
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "prior.txt"), "prior\n");
    const remove = vi
      .fn<typeof fs.rmSync>()
      .mockImplementationOnce(() => {
        throw new Error("previous removal failed");
      })
      .mockImplementation(fs.rmSync);
    const publication: LocalReviewPublication = { copy: fs.cpSync, remove, rename: fs.renameSync };

    await expect(
      runLocalReview({
        source,
        temporaryRoot: temporaryDirectory(),
        specialists: ADVISOR_SPECIALISTS.slice(0, 1),
        lifecycle: artifactLifecycle(),
        publication,
      }),
    ).rejects.toThrow("previous removal failed");
    expect(fs.readFileSync(path.join(destination, "prior.txt"), "utf8")).toBe("prior\n");
    expect(
      fs.readdirSync(path.dirname(destination)).filter((name) => name.includes(".previous-")),
    ).toEqual([]);
  });

  it("publishes no output when gateway cleanup fails after successful specialist work (#10611)", async () => {
    const source = repository();
    const underlying = new Error("gateway stop failed");
    const failure = (await runLocalReview({
      source,
      specialists: ADVISOR_SPECIALISTS.slice(0, 1),
      lifecycle: artifactLifecycle(async () => {
        throw underlying;
      }),
      temporaryRoot: temporaryDirectory(),
    }).catch((error: unknown) => error)) as Error;

    expect(failure).toMatchObject({
      message: expect.stringContaining("failed during cleanup for gateway"),
      cause: underlying,
    });
    expect(fs.existsSync(path.join(source, "artifacts", "pr-review-advisor-local"))).toBe(false);
  });

  it("preserves prior output when temporary-root cleanup fails (#10611)", async () => {
    const source = repository();
    const destination = path.join(source, "artifacts", "pr-review-advisor-local");
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "prior.txt"), "prior\n");
    const underlying = new Error("temporary root removal failed");
    const failure = (await runLocalReview({
      source,
      specialists: ADVISOR_SPECIALISTS.slice(0, 1),
      lifecycle: artifactLifecycle(),
      removeTemporaryRoot: () => {
        throw underlying;
      },
    }).catch((error: unknown) => error)) as Error;

    expect(failure).toMatchObject({
      message: expect.stringMatching(
        /failed during cleanup for temporary root .*temporary root removal failed/u,
      ),
      cause: underlying,
    });
    expect(fs.readdirSync(destination)).toEqual(["prior.txt"]);
    expect(fs.readFileSync(path.join(destination, "prior.txt"), "utf8")).toBe("prior\n");
  });

  it("retries sandbox deletion after successful work and publishes no output (#10611)", async () => {
    const source = repository();
    const lifecycle: LocalReviewLifecycle = {
      prepare: async () => undefined,
      startGateway: () => undefined,
      create: () => undefined,
      run: () => undefined,
      download: (env) => {
        const interest = env.PR_REVIEW_ADVISOR_INTEREST as string;
        const output = path.join(
          env.GITHUB_WORKSPACE as string,
          "artifacts",
          env.PR_REVIEW_ADVISOR_ARTIFACT_DIR as string,
        );
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(path.join(output, `pr-review-${interest}-summary.md`), "review\n");
        fs.writeFileSync(path.join(output, `pr-review-${interest}-session.jsonl`), "{}\n");
      },
      remove: vi
        .fn<() => void>()
        .mockImplementationOnce(() => {
          throw new Error("cleanup failed");
        })
        .mockImplementationOnce(() => undefined),
    };

    await expect(
      runLocalReview({
        source,
        temporaryRoot: temporaryDirectory(),
        specialists: ADVISOR_SPECIALISTS.slice(0, 1),
        lifecycle,
      }),
    ).rejects.toThrow(/failed during cleanup for specialist .*: cleanup failed/u);
    expect(lifecycle.remove).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(source, "artifacts", "pr-review-advisor-local"))).toBe(false);
  });

  it.each([
    ["missing", ["pr-review-design-architecture-summary.md"]],
    [
      "extra",
      [
        "pr-review-design-architecture-summary.md",
        "pr-review-design-architecture-session.jsonl",
        "extra.txt",
      ],
    ],
  ])("rejects %s specialist artifact sets (#10611)", async (_case, files) => {
    const source = repository();
    const lifecycle: LocalReviewLifecycle = {
      prepare: async () => undefined,
      startGateway: () => undefined,
      create: () => undefined,
      run: () => undefined,
      download: (env) => {
        const output = path.join(
          env.GITHUB_WORKSPACE as string,
          "artifacts",
          env.PR_REVIEW_ADVISOR_ARTIFACT_DIR as string,
        );
        fs.mkdirSync(output, { recursive: true });
        files.forEach((name) => fs.writeFileSync(path.join(output, name), "artifact\n"));
      },
      remove: () => undefined,
    };
    await expect(
      runLocalReview({
        source,
        temporaryRoot: temporaryDirectory(),
        specialists: ADVISOR_SPECIALISTS.slice(0, 1),
        lifecycle,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("failed during validate"),
      cause: expect.objectContaining({
        message: "Specialist artifacts do not match the existing Markdown and JSONL contract",
      }),
    });
  });

  it("retries failed sandbox deletion during final cleanup before reporting other cleanup failure (#10611)", async () => {
    const source = repository();
    const stopGateway = vi.fn(async () => {
      throw new Error("gateway cleanup failed");
    });
    const remove = vi
      .fn<() => void>()
      .mockImplementationOnce(() => {
        throw new Error("sandbox cleanup failed");
      })
      .mockImplementationOnce(() => undefined);
    let ownedRoot = "";
    const lifecycle: LocalReviewLifecycle = {
      prepare: async () => undefined,
      startGateway: () => ({ configure: Promise.resolve(), stop: stopGateway }),
      create: () => undefined,
      run: () => {
        throw new Error("primary run failed");
      },
      download: () => undefined,
      remove,
    };

    const failure = (await runLocalReview({
      source,
      specialists: ADVISOR_SPECIALISTS.slice(0, 1),
      lifecycle,
      prepareSnapshot: (snapshotSource, target, baseRef) => {
        ownedRoot = path.dirname(target);
        return createLocalReviewSnapshot(snapshotSource, target, baseRef);
      },
    }).catch((error: unknown) => error)) as AggregateError;
    expect(failure.message).toMatch(
      /failed during run.*failed during cleanup for gateway: gateway cleanup failed/u,
    );
    expect(failure.errors).toHaveLength(2);
    expect((failure.errors[0] as Error).message).toContain("failed during run");
    expect((failure.errors[1] as Error).message).toContain("failed during cleanup for gateway");
    expect(remove).toHaveBeenCalledTimes(2);
    expect(stopGateway).toHaveBeenCalledOnce();
    expect(fs.existsSync(ownedRoot)).toBe(false);
  });

  it("removes the active sandbox and publishes no partial output after failure (#10610)", async () => {
    const source = repository();
    const root = temporaryDirectory();
    const before = sourceState(source);
    const remove = vi.fn();
    const lifecycle: LocalReviewLifecycle = {
      prepare: async () => undefined,
      startGateway: () => undefined,
      create: () => undefined,
      run: () => {
        throw new Error("failed");
      },
      download: () => undefined,
      remove: () => {
        remove();
        throw new Error("cleanup failed");
      },
    };

    const failure = (await runLocalReview({
      source,
      temporaryRoot: root,
      specialists: ADVISOR_SPECIALISTS.slice(0, 1),
      lifecycle,
    }).catch((error: unknown) => error)) as AggregateError;
    expect(failure.message).toMatch(
      /failed during run.*failed during cleanup for specialist.*cleanup failed/u,
    );
    expect(failure.errors).toHaveLength(2);
    expect((failure.errors[0] as Error).message).toContain("failed during run");
    expect((failure.errors[1] as Error).message).toContain("failed during cleanup for specialist");
    expect(remove).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(source, "artifacts", "pr-review-advisor-local"))).toBe(false);
    expect(sourceState(source)).toEqual(before);
  });
});
