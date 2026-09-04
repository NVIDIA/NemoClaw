// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ConflictMatrixEntry,
  type PullRequest,
  selectConflictingPullRequests,
} from "../../../tools/pr-merge-conflict-fixer/discover.mts";
import { prepareMerge, writeTree } from "../../../tools/pr-merge-conflict-fixer/merge.mts";
import {
  publishResolution,
  validatePublicationState,
  validateResolutionPatch,
} from "../../../tools/pr-merge-conflict-fixer/publish.mts";
import {
  configureOpenShellInference,
  createResolutionSandbox,
  deleteResolutionSandbox,
  exportResolutionPatch,
  type ResolverTools,
  resolverModelConfiguration,
  resolverPrompt,
  runResolutionTask,
} from "../../../tools/pr-merge-conflict-fixer/resolve.mts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-conflict-fixer-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(repository: string, file: string, content: string): void {
  const target = path.join(repository, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function required<T>(value: T | null | undefined, message: string): T {
  expect(value, message).not.toBeNull();
  expect(value, message).toBeDefined();
  return value as T;
}

function resolverEnvironment(): NodeJS.ProcessEnv {
  const directory = temporaryDirectory();
  return {
    ARTIFACT_DIR: path.join(directory, "artifact"),
    CONFLICT_TREE: "a".repeat(40),
    GH_TOKEN: "gh-secret",
    GITHUB_TOKEN: "github-secret",
    HOME: path.join(directory, "home"),
    OPENAI_API_KEY: "provider-secret",
    OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:8080",
    PATH: "/usr/bin",
    PI_IMAGE: "pi-image",
    PR_REVIEW_ADVISOR_API_KEY: "advisor-secret",
    RESOLUTION_WORKDIR: "/resolution",
    RESOLVER_CONFIG_DIR: "/config",
    RUNNER_TEMP: directory,
    SANDBOX_NAME: "sandbox-test",
    TRUSTED_CHECKOUT: "/trusted",
  };
}

function resolverTools(outputs: string[] = []): ResolverTools {
  return {
    run: vi.fn(() => outputs.shift() ?? ""),
    runAsync: vi.fn(() => ({ cancel: vi.fn(), completion: Promise.resolve() })),
    start: vi.fn(),
    wait: vi.fn(async () => undefined),
  };
}

function createConflictFixture(): {
  baseSha: string;
  headSha: string;
  repository: string;
} {
  const repository = temporaryDirectory();
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Conflict Fixer Test"]);
  git(repository, ["config", "user.email", "conflict-fixer@example.test"]);
  git(repository, ["config", "commit.gpgsign", "false"]);
  write(repository, "conflict.txt", "shared\n");
  write(repository, "clean-merge.txt", "first\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nlast\n");
  write(repository, "pr-deleted.txt", "delete this on the PR branch\n");
  git(repository, ["add", "conflict.txt", "clean-merge.txt", "pr-deleted.txt"]);
  git(repository, ["commit", "-m", "test: add shared file"]);

  git(repository, ["checkout", "-b", "pull-request"]);
  write(repository, "conflict.txt", "pull request\n");
  write(
    repository,
    "clean-merge.txt",
    "pull request\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nlast\n",
  );
  fs.rmSync(path.join(repository, "pr-deleted.txt"));
  git(repository, ["add", "-A"]);
  git(repository, ["commit", "-m", "test: change PR side"]);
  const headSha = git(repository, ["rev-parse", "HEAD"]);

  git(repository, ["checkout", "main"]);
  write(repository, "conflict.txt", "main branch\n");
  write(
    repository,
    "clean-merge.txt",
    "first\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nmain branch\n",
  );
  write(repository, "main-only.txt", "main\n");
  git(repository, ["add", "conflict.txt", "clean-merge.txt", "main-only.txt"]);
  git(repository, ["commit", "-m", "test: change main side"]);
  const baseSha = git(repository, ["rev-parse", "HEAD"]);
  return { baseSha, headSha, repository };
}

function createMovedFileConflictFixture(): ReturnType<typeof createConflictFixture> {
  const repository = temporaryDirectory();
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Conflict Fixer Test"]);
  git(repository, ["config", "user.email", "conflict-fixer@example.test"]);
  git(repository, ["config", "commit.gpgsign", "false"]);
  write(repository, "adapter.js", "shared\n");
  git(repository, ["add", "adapter.js"]);
  git(repository, ["commit", "-m", "test: add shared adapter"]);

  git(repository, ["checkout", "-b", "pull-request"]);
  write(repository, "adapter.js", "pull request intent\n");
  git(repository, ["add", "adapter.js"]);
  git(repository, ["commit", "-m", "test: change PR adapter"]);
  const headSha = git(repository, ["rev-parse", "HEAD"]);

  git(repository, ["checkout", "main"]);
  fs.rmSync(path.join(repository, "adapter.js"));
  write(repository, "adapter.mts", "main migration\n");
  git(repository, ["add", "-A"]);
  git(repository, ["commit", "-m", "test: move main adapter"]);
  const baseSha = git(repository, ["rev-parse", "HEAD"]);
  return { baseSha, headSha, repository };
}

function entryFor(fixture: ReturnType<typeof createConflictFixture>): ConflictMatrixEntry {
  return {
    base_sha: fixture.baseSha,
    conflict_paths: ["conflict.txt"],
    head_ref: "pull-request",
    head_sha: fixture.headSha,
    pr_number: 42,
  };
}

function createResolutionPatch(
  fixture: ReturnType<typeof createConflictFixture>,
  patchPath: string,
  mutateRepository: (repository: string) => void = () => undefined,
): string {
  const repository = path.join(temporaryDirectory(), "resolver");
  const merge = required(
    prepareMerge(fixture.repository, repository, fixture.headSha, fixture.baseSha),
    "expected a conflicting merge fixture",
  );
  expect(merge.conflictPaths).toEqual(["conflict.txt"]);
  write(repository, "conflict.txt", "resolved intent\n");
  git(repository, ["add", "conflict.txt"]);
  mutateRepository(repository);
  const finalTree = writeTree(repository);
  const patch = execFileSync("git", ["diff", "--binary", merge.conflictTree, finalTree], {
    cwd: repository,
  });
  fs.writeFileSync(patchPath, patch);
  return finalTree;
}

function pullRequest(input: {
  baseRef?: string;
  draft?: boolean;
  headRef?: string;
  headRepository?: string;
  number: number;
  repository?: string;
  state?: string;
}): PullRequest {
  const repository = input.repository ?? "NVIDIA/NemoClaw";
  return {
    base: { ref: input.baseRef ?? "main" },
    draft: input.draft ?? false,
    head: {
      ref: input.headRef ?? `branch-${input.number}`,
      repo:
        input.headRepository === "deleted"
          ? null
          : { full_name: input.headRepository ?? repository },
      sha: String(input.number).padStart(40, "0"),
    },
    number: input.number,
    state: input.state ?? "open",
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("PR merge conflict fixer", () => {
  it("skips fork PRs before Git conflict analysis (#7542)", () => {
    const checkConflict = vi.fn(() => ["conflict.txt"]);
    const selected = selectConflictingPullRequests(
      [
        pullRequest({ number: 1 }),
        pullRequest({
          headRepository: "contributor/NemoClaw",
          number: 2,
        }),
      ],
      "NVIDIA/NemoClaw",
      "a".repeat(40),
      { checkConflict },
    );

    expect(selected.map((item) => item.pr_number)).toEqual([1]);
    expect(checkConflict).toHaveBeenCalledTimes(1);
  });

  it("skips draft same-repository conflicts (#7542)", () => {
    const selected = selectConflictingPullRequests(
      [pullRequest({ draft: true, number: 1 }), pullRequest({ number: 2 })],
      "NVIDIA/NemoClaw",
      "b".repeat(40),
      { checkConflict: () => ["conflict.txt"] },
    );

    expect(selected.map((item) => item.pr_number)).toEqual([2]);
  });

  it("skips GitHub workflow conflicts before model selection (#7542)", () => {
    const selected = selectConflictingPullRequests(
      [pullRequest({ number: 1 }), pullRequest({ number: 2 })],
      "NVIDIA/NemoClaw",
      "b".repeat(40),
      {
        checkConflict: (candidate) =>
          candidate.number === 1
            ? ["conflict.txt", ".github/workflows/e2e.yaml"]
            : ["conflict.txt"],
      },
    );

    expect(selected.map((item) => item.pr_number)).toEqual([2]);
  });

  it("accepts a patch that resolves the original conflict paths (#7542)", () => {
    const fixture = createConflictFixture();
    const patchPath = path.join(temporaryDirectory(), "resolution.patch");
    const expectedTree = createResolutionPatch(fixture, patchPath);

    const result = validateResolutionPatch({
      entry: entryFor(fixture),
      patchPath,
      sourceRepository: fixture.repository,
      workDirectory: path.join(temporaryDirectory(), "publisher"),
    });

    expect(result.finalTree).toBe(expectedTree);
    expect(git(result.repository, ["show", `${result.finalTree}:main-only.txt`])).toBe("main");
  });

  it("accepts a resolution that moves PR intent to main's replacement path (#7542)", () => {
    const fixture = createMovedFileConflictFixture();
    const patchPath = path.join(temporaryDirectory(), "resolution.patch");
    const repository = path.join(temporaryDirectory(), "resolver");
    const merge = required(
      prepareMerge(fixture.repository, repository, fixture.headSha, fixture.baseSha),
      "expected a moved-file conflict fixture",
    );
    expect(merge.conflictPaths).toEqual(["adapter.js"]);
    fs.rmSync(path.join(repository, "adapter.js"));
    write(repository, "adapter.mts", "main migration\npull request intent\n");
    git(repository, ["add", "-A"]);
    const expectedTree = writeTree(repository);
    const patch = execFileSync("git", ["diff", "--binary", merge.conflictTree, expectedTree], {
      cwd: repository,
    });
    fs.writeFileSync(patchPath, patch);

    const result = validateResolutionPatch({
      entry: {
        ...entryFor(fixture),
        conflict_paths: ["adapter.js"],
      },
      patchPath,
      sourceRepository: fixture.repository,
      workDirectory: path.join(temporaryDirectory(), "publisher"),
    });

    expect(result.finalTree).toBe(expectedTree);
    expect(git(result.repository, ["show", `${result.finalTree}:adapter.mts`])).toBe(
      "main migration\npull request intent",
    );
    expect(() => git(result.repository, ["show", `${result.finalTree}:adapter.js`])).toThrow();
  });

  it("rejects changed main state without comparing the live PR head SHA (#7542)", () => {
    const entry: ConflictMatrixEntry = {
      base_sha: "a".repeat(40),
      conflict_paths: ["conflict.txt"],
      head_ref: "feature",
      head_sha: "b".repeat(40),
      pr_number: 42,
    };
    const livePullRequest = {
      base: {
        ref: "main",
        repo: { full_name: "NVIDIA/NemoClaw", node_id: "R_repo" },
      },
      head: {
        ref: "feature",
        repo: { full_name: "NVIDIA/NemoClaw" },
      },
      draft: false,
      state: "open",
    };

    expect(() =>
      validatePublicationState(entry, "NVIDIA/NemoClaw", livePullRequest, {
        object: { sha: "c".repeat(40) },
      }),
    ).toThrow(/main changed/u);
    expect(() =>
      validatePublicationState(entry, "NVIDIA/NemoClaw", livePullRequest, {
        object: { sha: entry.base_sha },
      }),
    ).not.toThrow();
  });

  it("rejects publication when the pull request becomes a draft after discovery (#7542)", () => {
    const entry: ConflictMatrixEntry = {
      base_sha: "a".repeat(40),
      conflict_paths: ["conflict.txt"],
      head_ref: "feature",
      head_sha: "b".repeat(40),
      pr_number: 42,
    };
    expect(() =>
      validatePublicationState(
        entry,
        "NVIDIA/NemoClaw",
        {
          base: {
            ref: "main",
            repo: { full_name: "NVIDIA/NemoClaw", node_id: "R_repo" },
          },
          head: {
            ref: "feature",
            repo: { full_name: "NVIDIA/NemoClaw" },
          },
          draft: true,
          state: "open",
        },
        {
          object: { sha: entry.base_sha },
        },
      ),
    ).toThrow(/draft/u);
  });

  it("creates a verified commit from a main-relative tree before the atomic head update (#7542)", async () => {
    const fixture = createConflictFixture();
    for (let index = 0; index < 100; index += 1) {
      write(fixture.repository, `stale-main/${index}.txt`, `main ${index}\n`);
    }
    git(fixture.repository, ["add", "stale-main"]);
    git(fixture.repository, ["commit", "-m", "test: advance main beyond the PR head"]);
    fixture.baseSha = git(fixture.repository, ["rev-parse", "HEAD"]);
    const entry = entryFor(fixture);
    const patchPath = path.join(temporaryDirectory(), "resolution.patch");
    const finalTree = createResolutionPatch(fixture, patchPath);
    const commitSha = "c".repeat(40);
    const requests: Array<{ body: unknown; method: string; path: string }> = [];
    const graphql = vi.fn(async (_query: string, variables: Record<string, unknown>) => ({
      updateRefs: {
        clientMutationId: commitSha,
      },
      variables,
    }));
    const responseHandlers: Record<string, (body: unknown) => unknown> = {
      [`/repos/NVIDIA/NemoClaw/pulls/${entry.pr_number}`]: () => ({
        base: {
          ref: "main",
          repo: { full_name: "NVIDIA/NemoClaw", node_id: "R_repo" },
        },
        head: {
          ref: entry.head_ref,
          repo: { full_name: "NVIDIA/NemoClaw" },
        },
        draft: false,
        state: "open",
      }),
      "/repos/NVIDIA/NemoClaw/git/ref/heads/main": () => ({
        object: { sha: entry.base_sha },
      }),
      "/repos/NVIDIA/NemoClaw/git/blobs": (body) => {
        const encoded = (body as { content: string }).content;
        const content = Buffer.from(encoded, "base64");
        const header = Buffer.from(`blob ${content.length}\0`);
        return { sha: createHash("sha1").update(header).update(content).digest("hex") };
      },
      "/repos/NVIDIA/NemoClaw/git/trees": () => ({ sha: finalTree }),
      "/repos/NVIDIA/NemoClaw/git/commits": () => ({
        sha: commitSha,
        verification: { reason: "valid", verified: true },
      }),
    };
    const request = vi.fn(async (method: "GET" | "POST", apiPath: string, body?: unknown) => {
      requests.push({ body, method, path: apiPath });
      return required(responseHandlers[apiPath], `unexpected request: ${method} ${apiPath}`)(body);
    });

    await expect(
      publishResolution({
        entry,
        graphql,
        patchPath,
        repositoryName: "NVIDIA/NemoClaw",
        request,
        sourceRepository: fixture.repository,
      }),
    ).resolves.toBe(commitSha);

    const commitRequest = requests.find((item) => item.path.endsWith("/git/commits"));
    expect(commitRequest?.body).toEqual({
      message: "merge: resolve conflicts with main",
      parents: [entry.head_sha, entry.base_sha],
      tree: finalTree,
    });
    expect(JSON.stringify(commitRequest?.body)).not.toMatch(/author|committer|signature/u);
    const treeRequest = required(
      requests.find((item) => item.path.endsWith("/git/trees")),
      "missing tree request",
    );
    const treeBody = treeRequest.body as {
      base_tree: string;
      tree: Array<{ mode: string; path: string; sha: string | null; type: string }>;
    };
    expect(treeBody.base_tree).toBe(entry.base_sha);
    expect(treeBody.tree.map((item) => item.path)).toEqual([
      "clean-merge.txt",
      "conflict.txt",
      "pr-deleted.txt",
    ]);
    expect(treeBody.tree.find((item) => item.path === "pr-deleted.txt")).toEqual({
      mode: "100644",
      path: "pr-deleted.txt",
      sha: null,
      type: "blob",
    });
    expect(treeBody.tree.some((item) => item.path.startsWith("stale-main/"))).toBe(false);
    const blobRequests = requests.filter((item) => item.path.endsWith("/git/blobs"));
    expect(
      blobRequests
        .map((item) => Buffer.from((item.body as { content: string }).content, "base64").toString())
        .sort(),
    ).toEqual(
      [
        "pull request\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nmain branch\n",
        "resolved intent\n",
      ].sort(),
    );
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining("updateRefs"), {
      input: {
        clientMutationId: commitSha,
        refUpdates: [
          {
            afterOid: commitSha,
            beforeOid: entry.head_sha,
            force: false,
            name: `refs/heads/${entry.head_ref}`,
          },
        ],
        repositoryId: "R_repo",
      },
    });
    expect(requests.filter((item) => item.path.includes("/pulls/"))).toHaveLength(1);
    expect(requests.filter((item) => item.path.endsWith("/git/ref/heads/main"))).toHaveLength(1);
  });

  it("configures approved inference through a loopback gateway (#7542)", async () => {
    const env = resolverEnvironment();
    const tools = resolverTools(["/trusted/bin/openshell-sandbox"]);
    const stopGateway = vi.fn(async () => undefined);
    vi.mocked(tools.start).mockReturnValue(stopGateway);

    await configureOpenShellInference(env, tools);

    const gatewayDirectory = path.join(
      required(env.RUNNER_TEMP, "RUNNER_TEMP"),
      "openshell-gateway",
    );
    const configurationPath = path.join(gatewayDirectory, "gateway.toml");
    const configuration = fs.readFileSync(configurationPath, "utf8");
    expect(configuration).toContain('bind_address = "127.0.0.1:8080"');
    expect(configuration).toContain("allow_unauthenticated_users = true");
    expect(configuration).toContain('supervisor_bin = "/trusted/bin/openshell-sandbox"');
    expect(configuration).not.toContain("enable_bind_mounts");
    expect(configuration).not.toContain("provider-secret");
    expect(fs.statSync(configurationPath).mode & 0o777).toBe(0o600);

    const run = vi.mocked(tools.run);
    expect(run).toHaveBeenCalledWith(
      "openshell",
      [
        "provider",
        "create",
        "--name",
        "terra",
        "--type",
        "openai",
        "--credential",
        "OPENAI_API_KEY",
        "--config",
        "OPENAI_BASE_URL=https://inference-api.nvidia.com/v1",
      ],
      expect.objectContaining({
        env: expect.objectContaining({ OPENAI_API_KEY: "provider-secret" }),
      }),
    );
    expect(run).toHaveBeenCalledWith(
      "openshell",
      [
        "inference",
        "set",
        "--provider",
        "terra",
        "--model",
        "azure/openai/gpt-5.6-terra",
        "--no-verify",
      ],
      expect.anything(),
    );
    expect(vi.mocked(tools.start)).toHaveBeenCalledWith(
      "openshell-gateway",
      ["--config", configurationPath],
      expect.objectContaining({
        env: expect.not.objectContaining({ OPENAI_API_KEY: expect.anything() }),
        logPath: path.join(gatewayDirectory, "gateway.log"),
      }),
    );
    expect(run.mock.calls.filter(([, , options]) => options.env.OPENAI_API_KEY)).toHaveLength(1);
    expect(stopGateway).not.toHaveBeenCalled();
    const gatewayInfoCalls = run.mock.calls.filter(
      ([, args]) => args[0] === "gateway" && args[1] === "info",
    );
    expect(gatewayInfoCalls).toHaveLength(2);
    expect(gatewayInfoCalls.map(([, , options]) => options.timeout)).toEqual([10_000, 10_000]);
    expect(
      run.mock.calls.map(([command, args]) => [command, ...args].join(" ")).join("\n"),
    ).not.toContain("provider-secret");
  });

  it("rejects a non-loopback unauthenticated gateway (#7542)", async () => {
    const env = resolverEnvironment();
    env.OPENSHELL_GATEWAY_ENDPOINT = "http://192.0.2.1:8080";
    const tools = resolverTools();

    await expect(configureOpenShellInference(env, tools)).rejects.toThrow(
      "OPENSHELL_GATEWAY_ENDPOINT must use a loopback address",
    );
    expect(tools.run).not.toHaveBeenCalled();
    expect(tools.start).not.toHaveBeenCalled();
  });

  it("runs sandbox phases without host credentials (#7542)", () => {
    const env = resolverEnvironment();
    const tools = resolverTools(["", "", "", "", "sandbox-test\n", ""]);

    createResolutionSandbox(env, tools);
    runResolutionTask(env, tools);
    exportResolutionPatch(env, tools);
    deleteResolutionSandbox(env, tools);

    const calls = vi.mocked(tools.run).mock.calls;
    expect(calls).toHaveLength(6);
    expect(required(calls[0], "missing sandbox create call")[1]).toEqual(
      expect.arrayContaining([
        "sandbox",
        "create",
        "--from",
        "pi-image",
        "--policy",
        "/trusted/tools/pr-merge-conflict-fixer/policy.yaml",
        "--upload",
        "/resolution:/sandbox",
        "--upload",
        "/config:/sandbox",
        "--no-git-ignore",
      ]),
    );
    expect(required(calls[1], "missing Pi task call")[1]).toEqual(
      expect.arrayContaining([
        "sandbox",
        "exec",
        "--workdir",
        "/sandbox/repo",
        "PI_CODING_AGENT_DIR=/sandbox/pi-config",
        "--model",
        "azure/openai/gpt-5.6-terra",
        "--no-context-files",
        "--no-skills",
        "--offline",
      ]),
    );
    const exportArgs = required(calls[2], "missing patch export call")[1];
    expect(exportArgs).toEqual(
      expect.arrayContaining([
        "sandbox",
        "exec",
        "CONFLICT_TREE=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "/usr/bin/bash",
        "-c",
      ]),
    );
    expect(exportArgs.join("\n")).toContain("git ls-files -u");
    expect(exportArgs.join("\n")).toContain("git diff --binary");
    expect(required(calls[3], "missing patch download call")[1]).toEqual([
      "sandbox",
      "download",
      "sandbox-test",
      "/sandbox/resolution.patch",
      `${required(env.ARTIFACT_DIR, "ARTIFACT_DIR")}/`,
    ]);
    expect(required(calls[4], "missing sandbox list call")[2].capture).toBe(true);
    expect(required(calls[5], "missing sandbox delete call")[1]).toEqual([
      "sandbox",
      "delete",
      "sandbox-test",
    ]);
    calls.forEach(([, , options]) => {
      expect(options.env.GH_TOKEN).toBeUndefined();
      expect(options.env.GITHUB_TOKEN).toBeUndefined();
      expect(options.env.OPENAI_API_KEY).toBeUndefined();
      expect(options.env.PR_REVIEW_ADVISOR_API_KEY).toBeUndefined();
    });
    expect(fs.existsSync(required(env.ARTIFACT_DIR, "ARTIFACT_DIR"))).toBe(true);
  });

  it("deletes the named sandbox when listing is unavailable", () => {
    const tools = resolverTools();
    vi.mocked(tools.run)
      .mockImplementationOnce(() => {
        throw new Error("sandbox listing unavailable");
      })
      .mockImplementationOnce(() => "");

    expect(() => deleteResolutionSandbox(resolverEnvironment(), tools)).not.toThrow();
    expect(vi.mocked(tools.run).mock.calls[1]?.[1]).toEqual(["sandbox", "delete", "sandbox-test"]);
  });

  it("reports the named sandbox when listing and deletion both fail", () => {
    const tools = resolverTools();
    vi.mocked(tools.run)
      .mockImplementationOnce(() => {
        throw new Error("sandbox listing unavailable");
      })
      .mockImplementationOnce(() => {
        throw new Error("sandbox deletion unavailable");
      });

    expect(() => deleteResolutionSandbox(resolverEnvironment(), tools)).toThrow(
      "Failed to delete OpenShell sandbox sandbox-test: sandbox deletion unavailable; sandbox listing also failed: sandbox listing unavailable",
    );
    expect(tools.run).toHaveBeenCalledTimes(2);
  });

  it("configures Pi for credential-free OpenShell inference (#7542)", () => {
    const config = JSON.parse(resolverModelConfiguration());
    expect(config.providers.openshell).toMatchObject({
      api: "openai-completions",
      apiKey: "unused",
      baseUrl: "https://inference.local/v1",
      models: [{ id: "azure/openai/gpt-5.6-terra" }],
    });
    expect(resolverPrompt()).toContain("Stage every resolved conflict with Git.");
  });
});
