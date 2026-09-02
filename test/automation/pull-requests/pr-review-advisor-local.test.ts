// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalReviewSnapshot,
  runLocalReview,
  type LocalReviewLifecycle,
  type LocalReviewPublication,
} from "../../../tools/pr-review-advisor/local-review-implementation.mts";
import { ADVISOR_PI_IMAGE } from "../../../tools/pr-review-advisor/runtime-constants.mts";
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

function waitForFixturePath(
  file: string,
  child: ChildProcess,
  diagnostic: () => string,
): Promise<void> {
  const watcher = fs.watch(path.dirname(file));
  const ready = new Promise<void>((resolve) => {
    const detect = (): void => void (fs.existsSync(file) && resolve());
    watcher.on("change", detect);
    detect();
  });
  let onError!: (error: Error) => void;
  let onClose!: (code: number | null, signal: NodeJS.Signals | null) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    onError = reject;
    onClose = (code, signal) =>
      reject(
        new Error(
          `Fixture process exited before creating ${file}: ${signal ?? `code ${code ?? "unknown"}`}\n${diagnostic()}`,
        ),
      );
    child.once("error", onError);
    child.once("close", onClose);
  });
  return Promise.race([ready, stopped]).finally(() => {
    watcher.close();
    child.off("error", onError);
    child.off("close", onClose);
  });
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

  it("allows cleanup longer than 250 ms before removing its bootstrap checkout (#10611)", async () => {
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
    fs.copyFileSync(
      SIGTERM_IGNORING_CHILD_FIXTURE,
      path.join(source, "tools", "pr-review-advisor", "local-review-implementation.mts"),
    );
    const npmBin = installFakeNpm(source);
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
          PATH: npmBin + path.delimiter + process.env.PATH,
          TMPDIR: temporaryRoot,
        },
        stdio: "pipe",
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const pidPath = path.join(source, "trusted-child-pid");
    const termPath = path.join(source, "trusted-child-term");
    await waitForFixturePath(pidPath, child, () => stderr);
    const trustedPid = Number(fs.readFileSync(pidPath, "utf8"));

    child.kill("SIGTERM");
    await waitForFixturePath(termPath, child, () => stderr);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(() => process.kill(trustedPid, 0)).not.toThrow();
    process.kill(-trustedPid, "SIGKILL");
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
    fs.writeFileSync(path.join(source, "exported.txt"), "must be reviewed\n");
    fs.writeFileSync(
      path.join(source, ".gitattributes"),
      "*.txt filter=hostile\nexported.txt export-ignore\n",
    );
    git(source, ["add", ".gitattributes", "exported.txt"]);
    git(source, ["commit", "-m", "select hostile filter and export rule"]);
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

    const snapshot = path.join(temporaryDirectory(), "snapshot");
    const refs = createLocalReviewSnapshot(source, snapshot);

    expect(fs.readFileSync(path.join(snapshot, "exported.txt"), "utf8")).toBe("must be reviewed\n");
    expect(git(snapshot, ["show", refs.headRef + ":exported.txt"])).toBe("must be reviewed");
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
        expect(env.SANDBOX_NAME).toMatch(/^pr-adv-[a-f0-9]{12}$/u);
        expect(env.SANDBOX_NAME).toHaveLength(19);
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

    expect(calls.filter((call) => call.startsWith("prepare:"))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("run:"))).toEqual(
      ADVISOR_SPECIALISTS.map(({ interest }) => "run:" + interest),
    );
    expect(calls.filter((call) => call.startsWith("configure:"))).toHaveLength(
      ADVISOR_SPECIALISTS.length,
    );
    expect(stopGateway).toHaveBeenCalledTimes(ADVISOR_SPECIALISTS.length);
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

  it.each([
    ["success", artifactLifecycle(), { status: "fulfilled" }],
    [
      "lifecycle failure",
      {
        ...artifactLifecycle(),
        run: () => {
          throw new Error("run failed");
        },
      },
      {
        status: "rejected",
        reason: expect.objectContaining({ message: expect.stringContaining("failed during run") }),
      },
    ],
  ])("removes its temporary root after %s (#10611)", async (_case, lifecycle, expected) => {
    const source = repository();
    let removedRoot = "";
    const [result] = await Promise.allSettled([
      runLocalReview({
        source,
        specialists: ADVISOR_SPECIALISTS.slice(0, 1),
        lifecycle,
        removeTemporaryRoot: (root, options) => {
          removedRoot = root as string;
          fs.rmSync(root, options);
        },
      }),
    ]);

    expect(result).toMatchObject(expected);
    expect(path.basename(removedRoot)).toMatch(/^nemoclaw-local-review-/u);
    expect(fs.existsSync(removedRoot)).toBe(false);
  });

  it("stops between specialists and restores a received signal after cleanup (#10611)", async () => {
    const source = repository();
    const calls: string[] = [];
    let receiveSignal!: (signal: NodeJS.Signals) => void;
    let removedRoot = "";
    const restore = vi.fn();
    const lifecycle: LocalReviewLifecycle = {
      ...artifactLifecycle(),
      prepare: async (env) => void calls.push("prepare:" + env.PR_REVIEW_ADVISOR_INTEREST),
      remove: () => receiveSignal("SIGTERM"),
    };

    await expect(
      runLocalReview({
        source,
        specialists: ADVISOR_SPECIALISTS.slice(0, 2),
        lifecycle,
        signals: {
          listen: (callback) => {
            receiveSignal = callback;
            return () => undefined;
          },
          restore,
        },
        removeTemporaryRoot: (root, options) => {
          removedRoot = root as string;
          fs.rmSync(root, options);
        },
      }),
    ).resolves.toBe(path.join(source, "artifacts", "pr-review-advisor-local"));

    expect(calls).toEqual(["prepare:" + ADVISOR_SPECIALISTS[0]!.interest]);
    expect(restore).toHaveBeenCalledWith("SIGTERM");
    expect(fs.existsSync(removedRoot)).toBe(false);
    expect(fs.existsSync(path.join(source, "artifacts", "pr-review-advisor-local"))).toBe(false);
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

  it("redacts lifecycle credentials while preserving actionable OpenShell context (#10611)", async () => {
    const source = repository();
    const before = sourceState(source);
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
    expect(sourceState(source)).toEqual(before);
    expect(fs.existsSync(path.join(source, "artifacts", "pr-review-advisor-local"))).toBe(false);
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

    expect(failure.message).toContain("failed during gateway cleanup");
    expect(failure.message).toContain("gateway stop failed");
    expect(fs.existsSync(path.join(source, "artifacts", "pr-review-advisor-local"))).toBe(false);
  });

  const interest = ADVISOR_SPECIALISTS[0]!.interest;
  const summary = `pr-review-${interest}-summary.md`;
  const session = `pr-review-${interest}-session.jsonl`;
  it.each([
    ["missing", [summary]],
    ["extra", [summary, session, "extra.txt"]],
  ])("rejects %s specialist artifact sets (#10611)", async (_case, files) => {
    const source = repository();
    const lifecycle: LocalReviewLifecycle = {
      ...artifactLifecycle(),
      download: (env) => {
        const output = path.join(
          env.GITHUB_WORKSPACE as string,
          "artifacts",
          env.PR_REVIEW_ADVISOR_ARTIFACT_DIR as string,
        );
        fs.mkdirSync(output, { recursive: true });
        files.forEach((name) => fs.writeFileSync(path.join(output, name), "artifact\n"));
      },
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
});
