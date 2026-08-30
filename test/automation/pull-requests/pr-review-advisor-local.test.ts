// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalReviewSnapshot,
  runLocalReview,
  type LocalReviewLifecycle,
} from "../../../tools/pr-review-advisor/local-review-implementation.mts";
import { defaultOpenShellTools } from "../../../tools/openshell-agent/runtime.mts";
import { ADVISOR_PI_IMAGE } from "../../../tools/pr-review-advisor/runtime-constants.mts";
import { ADVISOR_SPECIALISTS } from "../../../tools/pr-review-advisor/specialist-catalog.mts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-review-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

  it("launches origin/main implementation without executing modified branch host code (#10611)", () => {
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
        'import { hostValue } from "./trusted-host.mts";',
        "const source = process.argv[2];",
        'const policy = fs.readFileSync(path.join(source, "tools/pr-review-advisor/policy.txt"), "utf8").trim();',
        'fs.writeFileSync(path.join(source, "bootstrap-result.txt"), [hostValue, policy].join("|") + "\\n");',
      ].join("\n"),
    );
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
    fs.mkdirSync(path.join(source, "node_modules"));

    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "tools/pr-review-advisor/local-review.mts"],
      { cwd: source, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(source, "bootstrap-result.txt"), "utf8")).toBe(
      'trusted host|branch policy data; throw new Error("policy executed")\n',
    );
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

  it("runs each catalogued specialist through the existing lifecycle and publishes only Markdown and JSONL (#10610)", async () => {
    const source = repository();
    const root = temporaryDirectory();
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

  it("reports cleanup failure only when specialist work succeeds (#10610)", async () => {
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
      remove: () => {
        throw new Error("cleanup failed");
      },
    };

    await expect(
      runLocalReview({
        source,
        temporaryRoot: temporaryDirectory(),
        specialists: ADVISOR_SPECIALISTS.slice(0, 1),
        lifecycle,
      }),
    ).rejects.toThrow("cleanup failed");
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

  it("attempts sandbox, gateway, and owned-root cleanup independently with primary-error priority (#10611)", async () => {
    const source = repository();
    const stopGateway = vi.fn(async () => {
      throw new Error("gateway cleanup failed");
    });
    const remove = vi.fn(() => {
      throw new Error("sandbox cleanup failed");
    });
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

    await expect(
      runLocalReview({
        source,
        specialists: ADVISOR_SPECIALISTS.slice(0, 1),
        lifecycle,
        prepareSnapshot: (snapshotSource, target, baseRef) => {
          ownedRoot = path.dirname(target);
          return createLocalReviewSnapshot(snapshotSource, target, baseRef);
        },
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /failed during run.*cleanup also failed: gateway cleanup failed/u,
      ),
      cause: expect.objectContaining({
        message: expect.stringContaining("failed during run"),
        cause: expect.objectContaining({ message: "primary run failed" }),
      }),
    });
    expect(remove).toHaveBeenCalledOnce();
    expect(stopGateway).toHaveBeenCalledOnce();
    expect(fs.existsSync(ownedRoot)).toBe(false);
  });

  it("removes the active sandbox and publishes no partial output after failure (#10610)", async () => {
    const source = repository();
    const root = temporaryDirectory();
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

    await expect(
      runLocalReview({
        source,
        temporaryRoot: root,
        specialists: ADVISOR_SPECIALISTS.slice(0, 1),
        lifecycle,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Local review failed during run for specialist"),
      cause: expect.objectContaining({ message: "failed" }),
    });
    expect(remove).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(source, "artifacts", "pr-review-advisor-local"))).toBe(false);
  });
});
