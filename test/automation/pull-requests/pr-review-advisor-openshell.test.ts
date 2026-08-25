// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADVISOR_OPENAI_COMPATIBLE_BASE_URL,
  ADVISOR_OPENSHELL_INFERENCE_BASE_URL,
  advisorInferenceBaseUrl,
  DEFAULT_ADVISOR_MODEL,
  openAiAdvisorProviderConfig,
} from "../../../tools/advisors/session.mts";
import type { OpenShellTools } from "../../../tools/openshell-agent/runtime.mts";
import {
  collectGitHubReviewContext,
  MAX_PREPARED_GITHUB_CONTEXT_BYTES,
  readPreparedGitHubContext,
  serializePreparedGitHubContext,
} from "../../../tools/pr-review-advisor/github-context.mts";
import {
  configureAdvisorOpenShellInference,
  createAdvisorSandbox,
  deleteAdvisorSandbox,
  downloadAdvisorArtifacts,
  prepareAdvisorSandboxInputs,
  runAdvisorSandbox,
  verifyAdvisorGitWorktree,
  writeUnavailableAdvisorArtifacts,
} from "../../../tools/pr-review-advisor/openshell.mts";
import { runPrReviewAdvisorAnalysis } from "../../../tools/pr-review-advisor/run-analysis.mts";
import { ADVISOR_INTERESTS } from "../../../tools/pr-review-advisor/specialists.mts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pr-advisor-openshell-"));
  temporaryDirectories.push(directory);
  return directory;
}

function advisorEnvironment(): NodeJS.ProcessEnv {
  const root = temporaryDirectory();
  const advisorDirectory = path.join(root, "advisor");
  const workDirectory = path.join(root, "pr-workdir");
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  for (const directory of [advisorDirectory, workDirectory, workspace, runnerTemp]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const directory of [advisorDirectory, workDirectory]) {
    fs.mkdirSync(path.join(directory, ".git"));
  }
  for (const name of ["pr-review-advisor-context", "pr-review-advisor-tools"]) {
    fs.mkdirSync(path.join(runnerTemp, name));
  }
  return {
    ADVISOR_DIR: advisorDirectory,
    ADVISOR_WORKDIR: workDirectory,
    BASE_REF: "target/base",
    GH_TOKEN: "github-host-secret",
    GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
    GITHUB_TOKEN: "github-default-secret",
    GITHUB_WORKSPACE: workspace,
    HEAD_REF: "HEAD",
    HOME: path.join(root, "home"),
    OPENAI_API_KEY: "model-host-secret",
    OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:8080",
    PATH: "/usr/bin",
    PI_IMAGE: "pinned-pi-image",
    PR_NUMBER: "7542",
    PR_REVIEW_ADVISOR_API_KEY: "advisor-host-secret",
    PR_REVIEW_ADVISOR_ARTIFACT_DIR: "pr-review-advisor",
    PR_REVIEW_ADVISOR_MODEL: DEFAULT_ADVISOR_MODEL,
    PR_REVIEW_ADVISOR_SANDBOX_TIMEOUT_SECONDS: "2100",
    RUNNER_TEMP: runnerTemp,
    SANDBOX_NAME: "pr-advisor-test",
    TARGET_REPO: "NVIDIA/NemoClaw",
  };
}

function advisorTools(runImplementation?: OpenShellTools["run"]): OpenShellTools {
  return {
    run: vi.fn(
      runImplementation ??
        ((command) => (command === "which" ? "/trusted/bin/openshell-sandbox" : "")),
    ),
    start: vi.fn(),
    wait: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("PR review advisor OpenShell wrapper", () => {
  it.each([
    "tools/pr-review-advisor/openshell.mts",
    "tools/pr-review-advisor/github-context.mts",
    "tools/advisors/provider-constants.mts",
    "tools/advisors/github.mts",
    "tools/advisors/json.mts",
    "tools/openshell-agent/runtime.mts",
  ])(
    "keeps credential-bearing host commands out of the Pi SDK import graph [case %#]",
    (relativePath) => {
      const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../..", relativePath), "utf8");
      expect(source, relativePath).not.toMatch(
        /(?:@earendil-works\/pi-coding-agent|\btypebox\b|\/session\.mts|\/analyze\.mts)/u,
      );
    },
  );

  it("allows only the hosted service and OpenShell inference gateway", () => {
    expect(advisorInferenceBaseUrl({})).toBe(ADVISOR_OPENAI_COMPATIBLE_BASE_URL);
    expect(
      advisorInferenceBaseUrl({
        PR_REVIEW_ADVISOR_BASE_URL: ADVISOR_OPENSHELL_INFERENCE_BASE_URL,
      }),
    ).toBe(ADVISOR_OPENSHELL_INFERENCE_BASE_URL);
    expect(
      (
        openAiAdvisorProviderConfig(
          "PR_REVIEW_ADVISOR_API_KEY",
          ADVISOR_OPENSHELL_INFERENCE_BASE_URL,
        ) as { baseUrl: string }
      ).baseUrl,
    ).toBe(ADVISOR_OPENSHELL_INFERENCE_BASE_URL);
    expect(() =>
      advisorInferenceBaseUrl({
        PR_REVIEW_ADVISOR_BASE_URL: "https://attacker.example/v1",
      }),
    ).toThrow("must use an approved advisor inference endpoint");
  });

  it("preserves hosted provider compatibility", () => {
    const config = openAiAdvisorProviderConfig("PR_REVIEW_ADVISOR_API_KEY") as {
      apiKey: string;
      baseUrl: string;
      models: Array<{ id: string; compat?: Record<string, unknown>; reasoning: boolean }>;
    };

    expect(config.apiKey).toBe("PR_REVIEW_ADVISOR_API_KEY");
    expect(config.baseUrl).toBe(ADVISOR_OPENAI_COMPATIBLE_BASE_URL);
    expect(config.models).toContainEqual(
      expect.objectContaining({
        id: DEFAULT_ADVISOR_MODEL,
        reasoning: false,
        compat: expect.objectContaining({
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsStore: false,
          supportsStrictMode: false,
          supportsUsageInStreaming: false,
          maxTokensField: "max_tokens",
        }),
      }),
    );
  });
  it("loads host-prepared GitHub context without a GitHub token", async () => {
    const directory = temporaryDirectory();
    const contextPath = path.join(directory, "github-context.json");
    const context = {
      repo: "NVIDIA/NemoClaw",
      prNumber: 7542,
      pullRequest: { title: "Wrap the advisor" },
    };
    fs.writeFileSync(contextPath, JSON.stringify(context), { mode: 0o600 });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      collectGitHubReviewContext({
        GITHUB_REPOSITORY: "NVIDIA/workflow-repository",
        PR_NUMBER: String(context.prNumber),
        PR_REVIEW_ADVISOR_GITHUB_CONTEXT_PATH: contextPath,
        TARGET_REPO: context.repo,
      }),
    ).resolves.toEqual(context);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves GitHub field names and marks bounded context explicitly", async () => {
    const longBody = `${"head ".repeat(10_000)}binding decision at the tail`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const payload = url.endsWith("/pulls/7542")
        ? {
            number: 7542,
            title: "Wrap the advisor",
            body: longBody,
            author_association: "MEMBER",
            created_at: "2026-07-26T00:00:00Z",
            head: { ref: "feature", sha: "b".repeat(40), repo: { full_name: "NVIDIA/NemoClaw" } },
            base: { ref: "main", sha: "a".repeat(40), repo: { full_name: "NVIDIA/NemoClaw" } },
          }
        : [];
      return {
        ok: true,
        json: async () => payload,
      } as Response;
    });

    const context = await collectGitHubReviewContext({
      GH_TOKEN: "host-token",
      GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      PR_NUMBER: "7542",
    });
    const pullRequest = context?.pullRequest as Record<string, unknown>;
    expect(pullRequest.author_association).toBe("MEMBER");
    expect(pullRequest).not.toHaveProperty("authorAssociation");
    expect((pullRequest.head as { repo: Record<string, unknown> }).repo.full_name).toBe(
      "NVIDIA/NemoClaw",
    );
    expect(String(pullRequest.body)).toContain("PR Review Advisor truncated content");
    expect(String(pullRequest.body)).toContain("binding decision at the tail");
    expect(Buffer.byteLength(serializePreparedGitHubContext(context), "utf8")).toBeLessThanOrEqual(
      MAX_PREPARED_GITHUB_CONTEXT_BYTES,
    );
  });

  it("bounds large overlap path sets before serializing sandbox context", async () => {
    const longFiles = Array.from({ length: 300 }, (_, index) => ({
      filename: `deep/${String(index).padStart(3, "0")}/${"segment/".repeat(480)}file.ts`,
    }));
    const openPulls = Array.from({ length: 30 }, (_, index) => ({
      number: 8_000 + index,
      title: index === 29 ? "Replaces PR #7542" : `Concurrent PR ${index}`,
      body: "",
      labels: [],
    }));
    expect(
      Buffer.byteLength(JSON.stringify(openPulls.map(() => longFiles)), "utf8"),
    ).toBeGreaterThan(MAX_PREPARED_GITHUB_CONTEXT_BYTES);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const routes: Array<{ matches: (requestUrl: string) => boolean; payload: unknown }> = [
        {
          matches: (requestUrl) => requestUrl.endsWith("/pulls/7542"),
          payload: {
            number: 7542,
            title: "Current PR",
            body: "",
            head: { ref: "feature", sha: "b".repeat(40) },
            base: { ref: "main", sha: "a".repeat(40) },
          },
        },
        {
          matches: (requestUrl) => requestUrl.includes("/pulls?state=open"),
          payload: openPulls,
        },
        {
          matches: (requestUrl) => requestUrl.includes("/files?"),
          payload: longFiles,
        },
      ];
      const payload = routes.find(({ matches }) => matches(url))?.payload ?? [];
      return {
        ok: true,
        json: async () => payload,
      } as Response;
    });

    const context = await collectGitHubReviewContext({
      GH_TOKEN: "host-token",
      GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      PR_NUMBER: "7542",
    });
    expect(context?.openPrOverlaps).toHaveLength(25);
    (context?.openPrOverlaps ?? []).forEach((overlap) => {
      expect(overlap.sameFileCount).toBe(300);
      expect(overlap.sameFiles).toHaveLength(20);
      expect(overlap.sameFiles.every((file) => file.length <= 300)).toBe(true);
    });
    expect(context?.openPrOverlaps?.filter((overlap) => overlap.replacesCurrentPr)).toEqual([
      expect.objectContaining({ number: 8_029 }),
    ]);
    expect(() => serializePreparedGitHubContext(context)).not.toThrow();
  });

  it("rejects substituted or non-regular prepared GitHub context", () => {
    const directory = temporaryDirectory();
    const contextPath = path.join(directory, "github-context.json");
    const symlinkPath = path.join(directory, "github-context-link.json");
    fs.writeFileSync(contextPath, JSON.stringify({ repo: "NVIDIA/NemoClaw", prNumber: 7542 }), {
      mode: 0o600,
    });
    fs.symlinkSync(contextPath, symlinkPath);

    expect(() =>
      readPreparedGitHubContext(contextPath, {
        repo: "NVIDIA/NemoClaw",
        prNumber: 9999,
      }),
    ).toThrow("pull request does not match");
    expect(() =>
      readPreparedGitHubContext(contextPath, {
        repo: "attacker/NemoClaw",
        prNumber: 7542,
      }),
    ).toThrow("repository does not match");
    expect(() => readPreparedGitHubContext(symlinkPath)).toThrow("must be a regular file");
  });

  it("bounds prepared GitHub context before parsing", () => {
    const contextPath = path.join(temporaryDirectory(), "github-context.json");
    fs.writeFileSync(contextPath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x20));

    expect(() => readPreparedGitHubContext(contextPath)).toThrow("exceeds the 5 MiB limit");
  });

  it.skipIf(
    process.platform === "win32" ||
      typeof fs.constants.O_NONBLOCK !== "number" ||
      typeof fs.constants.O_NOFOLLOW !== "number",
  )("rejects a prepared-context FIFO without blocking", () => {
    const fifoPath = path.join(temporaryDirectory(), "github-context.json");
    const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf8", timeout: 5_000 });
    expect(created.status, created.stderr).toBe(0);

    const moduleUrl = new URL("../../../tools/pr-review-advisor/github-context.mts", import.meta.url)
      .href;
    const read = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--input-type=module",
        "--eval",
        `import { readPreparedGitHubContext } from ${JSON.stringify(moduleUrl)}; readPreparedGitHubContext(${JSON.stringify(fifoPath)});`,
      ],
      { encoding: "utf8", timeout: 2_000 },
    );

    expect(read.error).toBeUndefined();
    expect(read.status).not.toBe(0);
    expect(read.stderr).toContain("Prepared GitHub context must be a regular file");
  });

  it("bounds a prepared context that grows after descriptor validation", () => {
    const contextPath = path.join(temporaryDirectory(), "github-context.json");
    fs.writeFileSync(contextPath, Buffer.alloc(MAX_PREPARED_GITHUB_CONTEXT_BYTES, 0x20));
    const originalFstatSync = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation((descriptor) => {
      const stat = originalFstatSync(descriptor);
      fs.appendFileSync(contextPath, "x");
      return stat;
    });

    expect(() => readPreparedGitHubContext(contextPath)).toThrow("exceeds the 5 MiB limit");
  });

  it("materializes bounded host context and pinned read tools for read-only mounts", async () => {
    const env = advisorEnvironment();
    env.PR_REVIEW_ADVISOR_GITHUB_CONTEXT_PATH = "/untrusted/recursive-context.json";
    const binaries = path.join(temporaryDirectory(), "binaries");
    fs.mkdirSync(binaries);
    for (const name of ["rg", "fdfind"]) {
      const executable = path.join(binaries, name);
      fs.writeFileSync(executable, `${name}\n`, { mode: 0o755 });
    }
    const collectContext = vi.fn(async (contextEnv: NodeJS.ProcessEnv) => {
      expect(contextEnv.GH_TOKEN).toBe("github-host-secret");
      expect(contextEnv.PR_REVIEW_ADVISOR_GITHUB_CONTEXT_PATH).toBeUndefined();
      return {
        repo: "NVIDIA/NemoClaw",
        prNumber: 7542,
        pullRequest: { title: "Wrap the advisor" },
      };
    });

    await prepareAdvisorSandboxInputs(env, {
      collectContext,
      resolveExecutable: (name) => path.join(binaries, name),
    });

    const runnerTemp = env.RUNNER_TEMP as string;
    const contextPath = path.join(runnerTemp, "pr-review-advisor-context", "github-context.json");
    const contextContent = fs.readFileSync(contextPath, "utf8");
    expect(JSON.parse(contextContent)).toMatchObject({
      repo: "NVIDIA/NemoClaw",
      prNumber: 7542,
    });
    expect(fs.statSync(contextPath).mode & 0o777).toBe(0o444);
    expect(contextContent).not.toContain("github-host-secret");
    expect(fs.existsSync(path.join(runnerTemp, "pr-review-advisor-runtime"))).toBe(false);
    for (const name of ["rg", "fdfind", "fd"]) {
      const executable = path.join(runnerTemp, "pr-review-advisor-tools", name);
      expect(fs.statSync(executable).mode & 0o777).toBe(0o555);
    }
    for (const [directory, relativeProofDirectory] of [
      [env.ADVISOR_DIR as string, ".git/.pr-review-advisor-boundary-proof"],
      [env.ADVISOR_WORKDIR as string, ".git/.pr-review-advisor-boundary-proof"],
      [path.join(runnerTemp, "pr-review-advisor-context"), ".pr-review-advisor-boundary-proof"],
      [path.join(runnerTemp, "pr-review-advisor-tools"), ".pr-review-advisor-boundary-proof"],
    ]) {
      const proofDirectory = path.join(directory, relativeProofDirectory);
      expect(fs.statSync(proofDirectory).isDirectory()).toBe(true);
      expect(fs.statSync(proofDirectory).mode & 0o777).toBe(0o777);
      for (const name of ["source", "target"]) {
        expect(fs.statSync(path.join(proofDirectory, name)).mode & 0o777).toBe(0o666);
      }
    }
  });

  it("prepares specialist diff evidence before the worktree becomes read-only", async () => {
    const env = advisorEnvironment();
    const workdir = env.ADVISOR_WORKDIR as string;
    fs.rmSync(path.join(workdir, ".git"), { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: workdir });
    fs.writeFileSync(path.join(workdir, "reviewed.txt"), "base\n");
    execFileSync("git", ["add", "reviewed.txt"], { cwd: workdir });
    const commit = (message: string) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=PR Review Advisor",
          "-c",
          "user.email=advisor@example.invalid",
          "commit",
          "--quiet",
          "-m",
          message,
        ],
        { cwd: workdir },
      );
    commit("test: add base content");
    fs.writeFileSync(path.join(workdir, "reviewed.txt"), "changed\n");
    execFileSync("git", ["add", "reviewed.txt"], { cwd: workdir });
    commit("test: change reviewed content");
    env.BASE_REF = "HEAD~1";
    env.HEAD_REF = "HEAD";
    env.PR_REVIEW_ADVISOR_INTEREST = "security";
    const binaries = path.join(temporaryDirectory(), "binaries");
    fs.mkdirSync(binaries);
    fs.writeFileSync(path.join(binaries, "rg"), "rg", { mode: 0o755 });
    fs.writeFileSync(path.join(binaries, "fdfind"), "fdfind", { mode: 0o755 });

    await prepareAdvisorSandboxInputs(env, {
      collectContext: async () => null,
      resolveExecutable: (name) => path.join(binaries, name),
    });

    const diffPath = path.join(
      env.RUNNER_TEMP as string,
      "pr-review-advisor-context",
      "specialist",
      "diff.patch",
    );
    expect(fs.readFileSync(diffPath, "utf8")).toContain("+changed");
    expect(fs.statSync(diffPath).mode & 0o777).toBe(0o444);
    expect(fs.existsSync(path.join(workdir, ".pr-review-advisor-context"))).toBe(false);
    fs.chmodSync(path.dirname(diffPath), 0o700);
    fs.chmodSync(diffPath, 0o600);
  });

  it("requires repository metadata before placing immutable-boundary proof files", async () => {
    const env = advisorEnvironment();
    fs.rmSync(path.join(env.ADVISOR_WORKDIR as string, ".git"), {
      recursive: true,
      force: true,
    });

    await expect(prepareAdvisorSandboxInputs(env)).rejects.toThrow(
      "ADVISOR_WORKDIR must contain a .git directory",
    );
  });

  it("pins the readable Git worktree explicitly across the sandbox ownership boundary", () => {
    const workdir = path.join(temporaryDirectory(), "pr-workdir");
    fs.mkdirSync(workdir);
    execFileSync("git", ["init", "--quiet"], { cwd: workdir });
    fs.writeFileSync(path.join(workdir, "tracked.txt"), "tracked\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workdir });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=PR Review Advisor",
        "-c",
        "user.email=advisor@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "test: initialize advisor worktree",
      ],
      { cwd: workdir },
    );

    const emptyGitConfig = path.join(workdir, "empty-gitconfig");
    fs.writeFileSync(emptyGitConfig, "");
    const differentOwnerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: emptyGitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
    };
    delete differentOwnerEnv.GIT_DIR;
    delete differentOwnerEnv.GIT_WORK_TREE;
    expect(() =>
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: workdir,
        env: differentOwnerEnv,
        stdio: "pipe",
      }),
    ).toThrow();

    vi.stubEnv("GIT_CONFIG_GLOBAL", emptyGitConfig);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1");
    try {
      expect(() => verifyAdvisorGitWorktree(workdir)).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
    fs.rmSync(path.join(workdir, ".git", "HEAD"));
    expect(() => verifyAdvisorGitWorktree(workdir)).toThrow(
      "Advisor sandbox Git checkout is unreadable or invalid",
    );
  });

  it("rejects oversized prepared context before writing a sandbox input", async () => {
    const env = advisorEnvironment();

    await expect(
      prepareAdvisorSandboxInputs(env, {
        collectContext: async () => ({
          repo: "NVIDIA/NemoClaw",
          prNumber: 7542,
          pullRequest: { body: "x".repeat(MAX_PREPARED_GITHUB_CONTEXT_BYTES) },
        }),
      }),
    ).rejects.toThrow("Prepared GitHub context exceeds the 5 MiB limit");
    expect(
      fs.existsSync(
        path.join(env.RUNNER_TEMP as string, "pr-review-advisor-context", "github-context.json"),
      ),
    ).toBe(false);
  });

  it("registers the selected model while confining the upstream key to provider creation", async () => {
    const env = advisorEnvironment();
    const tools = advisorTools();

    await configureAdvisorOpenShellInference(env, tools);

    const calls = vi.mocked(tools.run).mock.calls;
    expect(calls).toContainEqual([
      "openshell",
      [
        "inference",
        "set",
        "--provider",
        "advisor",
        "--model",
        DEFAULT_ADVISOR_MODEL,
        "--timeout",
        "900",
      ],
      expect.anything(),
    ]);
    const providerCalls = calls.filter(
      ([command, args]) =>
        command === "openshell" && args.slice(0, 2).join(" ") === "provider create",
    );
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.[2].env.OPENAI_API_KEY).toBe("model-host-secret");
    calls.forEach(([command, args, options]) => {
      expect(options.env.GH_TOKEN, `${command} ${args.join(" ")}`).toBeUndefined();
      expect(options.env.GITHUB_TOKEN, `${command} ${args.join(" ")}`).toBeUndefined();
      expect(options.env.PR_REVIEW_ADVISOR_API_KEY, `${command} ${args.join(" ")}`).toBeUndefined();
    });
    expect(calls.filter(([, , options]) => options.env.OPENAI_API_KEY)).toHaveLength(1);
    expect(vi.mocked(tools.start).mock.calls[0]?.[2].env.OPENAI_API_KEY).toBeUndefined();
    const gatewayConfig = fs.readFileSync(
      path.join(env.RUNNER_TEMP as string, "openshell-gateway", "gateway.toml"),
      "utf8",
    );
    expect(gatewayConfig).not.toContain("model-host-secret");
    expect(gatewayConfig).toContain("enable_bind_mounts = true");
  });

  it.each(["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "PR_REVIEW_ADVISOR_API_KEY"])(
    "writes unavailable artifacts through a credential-free trusted host fallback [case %#]",
    (name) => {
      const env = advisorEnvironment();
      env.PR_REVIEW_ADVISOR_UNAVAILABLE_REASON = "provider configuration failed";
      const tools = advisorTools();

      writeUnavailableAdvisorArtifacts(env, tools);

      expect(tools.run).toHaveBeenCalledTimes(1);
      const [command, args, options] = vi.mocked(tools.run).mock.calls[0]!;
      expect(command).toBe(process.execPath);
      expect(args).toEqual([
        "--experimental-strip-types",
        "--no-warnings",
        path.join(env.ADVISOR_DIR as string, "tools", "pr-review-advisor", "run-analysis.mts"),
      ]);
      expect(options.env.PR_REVIEW_ADVISOR_RUN_ANALYSIS).toBe("0");
      expect(options.env.PR_REVIEW_ADVISOR_UNAVAILABLE_REASON).toBe(
        "provider configuration failed",
      );
      expect(options.env.PR_REVIEW_ADVISOR_GITHUB_CONTEXT_PATH).toBe(
        path.join(env.RUNNER_TEMP as string, "pr-review-advisor-context", "github-context.json"),
      );

      expect(options.env[name]).toBeUndefined();
    },
  );

  it("creates, runs, downloads, and deletes the sandbox without host credentials", () => {
    const env = advisorEnvironment();
    env.GIT_DIR = "/untrusted/ambient-git-dir";
    env.GIT_WORK_TREE = "/untrusted/ambient-worktree";
    const commandResponses = new Map([["openshell sandbox list --names", "pr-advisor-test\n"]]);
    const tools = advisorTools(
      (command, args) => commandResponses.get(`${command} ${args.slice(0, 3).join(" ")}`) ?? "",
    );

    createAdvisorSandbox(env, tools);
    runAdvisorSandbox(env, tools);
    downloadAdvisorArtifacts(env, tools);
    deleteAdvisorSandbox(env, tools);

    const calls = vi.mocked(tools.run).mock.calls;
    const createArgs =
      calls.find(
        ([command, args]) =>
          command === "openshell" && args.slice(0, 2).join(" ") === "sandbox create",
      )?.[1] ?? [];
    expect(createArgs).toEqual(
      expect.arrayContaining([
        "sandbox",
        "create",
        "--name",
        "pr-advisor-test",
        "--from",
        "pinned-pi-image",
        "--driver-config-json",
        "--policy",
        path.join(
          fs.realpathSync(env.ADVISOR_DIR as string),
          "tools",
          "pr-review-advisor",
          "openshell-policy.yaml",
        ),
        "/advisor/tools/pr-review-advisor/openshell.mts",
        "initialize",
      ]),
    );
    const driverConfigIndex = createArgs.indexOf("--driver-config-json");
    expect(JSON.parse(createArgs[driverConfigIndex + 1] as string)).toEqual({
      docker: {
        mounts: [
          {
            type: "bind",
            source: fs.realpathSync(env.ADVISOR_DIR as string),
            target: "/advisor",
            read_only: true,
          },
          {
            type: "bind",
            source: fs.realpathSync(env.ADVISOR_WORKDIR as string),
            target: "/pr-workdir",
            read_only: true,
          },
          {
            type: "bind",
            source: fs.realpathSync(
              path.join(env.RUNNER_TEMP as string, "pr-review-advisor-context"),
            ),
            target: "/pr-review-advisor-context",
            read_only: true,
          },
          {
            type: "bind",
            source: fs.realpathSync(
              path.join(env.RUNNER_TEMP as string, "pr-review-advisor-tools"),
            ),
            target: "/pr-review-advisor-tools",
            read_only: true,
          },
          {
            type: "tmpfs",
            target: "/sandbox/pr-review-advisor-runtime",
            size_bytes: 512 * 1024 * 1024,
            mode: 0o1777,
          },
        ],
      },
    });
    expect(createArgs).not.toContain("--upload");
    expect(createArgs).not.toContain("--no-git-ignore");
    expect(createArgs.slice(-6)).toEqual([
      "--",
      "/usr/bin/node",
      "--experimental-strip-types",
      "--no-warnings",
      "/advisor/tools/pr-review-advisor/openshell.mts",
      "initialize",
    ]);
    expect(calls.some(([, args]) => args.slice(0, 2).join(" ") === "policy set")).toBe(false);

    const sandboxExecCalls = calls.filter(
      ([command, args]) => command === "openshell" && args.slice(0, 2).join(" ") === "sandbox exec",
    );
    const runArgs =
      sandboxExecCalls.find(([, args]) =>
        args.includes("/advisor/tools/pr-review-advisor/run-analysis.mts"),
      )?.[1] ?? [];
    expect(runArgs).toEqual(
      expect.arrayContaining([
        "sandbox",
        "exec",
        "--name",
        "pr-advisor-test",
        "--timeout",
        "2100",
        "--workdir",
        "/pr-workdir",
        "PR_REVIEW_ADVISOR_API_KEY=unused",
        "PR_REVIEW_ADVISOR_BASE_URL=https://inference.local/v1",
        "PR_REVIEW_ADVISOR_GITHUB_CONTEXT_PATH=/pr-review-advisor-context/github-context.json",
        "GIT_DIR=/pr-workdir/.git",
        "GIT_WORK_TREE=/pr-workdir",
        "TARGET_REPO=NVIDIA/NemoClaw",
        "/advisor/tools/pr-review-advisor/run-analysis.mts",
      ]),
    );
    expect(runArgs.join("\n")).not.toContain("github-host-secret");
    expect(runArgs.join("\n")).not.toContain("model-host-secret");
    expect(runArgs.join("\n")).not.toContain("advisor-host-secret");
    expect(runArgs.join("\n")).not.toContain("/untrusted/ambient");

    expect(
      calls.find(
        ([command, args]) =>
          command === "openshell" && args.slice(0, 2).join(" ") === "sandbox download",
      )?.[1],
    ).toEqual([
      "sandbox",
      "download",
      "pr-advisor-test",
      "/sandbox/pr-review-advisor-runtime/artifacts/pr-review-advisor",
      path.join(env.GITHUB_WORKSPACE as string, "artifacts", "pr-review-advisor"),
    ]);
    expect(
      fs
        .statSync(path.join(env.GITHUB_WORKSPACE as string, "artifacts", "pr-review-advisor"))
        .isDirectory(),
    ).toBe(true);
    expect(
      calls.find(
        ([command, args]) =>
          command === "openshell" && args.slice(0, 3).join(" ") === "sandbox list --names",
      )?.[1],
    ).toEqual(["sandbox", "list", "--names"]);
    expect(
      calls.find(
        ([command, args]) =>
          command === "openshell" && args.slice(0, 2).join(" ") === "sandbox delete",
      )?.[1],
    ).toEqual(["sandbox", "delete", "pr-advisor-test"]);
    calls.forEach(([command, args, options]) => {
      expect(options.env.GH_TOKEN, `${command} ${args.join(" ")}`).toBeUndefined();
      expect(options.env.GITHUB_TOKEN, `${command} ${args.join(" ")}`).toBeUndefined();
      expect(options.env.OPENAI_API_KEY, `${command} ${args.join(" ")}`).toBeUndefined();
      expect(options.env.PR_REVIEW_ADVISOR_API_KEY, `${command} ${args.join(" ")}`).toBeUndefined();
    });
  });

  it("exposes validated specialist sessions inside the standard Pi workdir (#9949)", () => {
    const env = advisorEnvironment();
    const sessionDirectory = path.join(
      env.ADVISOR_WORKDIR as string,
      ".pr-review-advisor-sessions",
    );
    const sessionAlias = path.join(env.GITHUB_WORKSPACE as string, "specialist-sessions-alias");
    fs.mkdirSync(sessionDirectory);
    const sessionEntries = Object.fromEntries(
      ADVISOR_INTERESTS.map((interest) => [interest, interest]),
    );
    Object.entries(sessionEntries).forEach(([interest, id]) =>
      fs.writeFileSync(
        path.join(sessionDirectory, `pr-review-${interest}-session.jsonl`),
        `${JSON.stringify({ type: "session", id })}\n`,
      ),
    );
    fs.symlinkSync(sessionDirectory, sessionAlias, "dir");
    env.PR_REVIEW_ADVISOR_SPECIALIST_SESSION_DIR = sessionAlias;
    const tools = advisorTools();

    createAdvisorSandbox(env, tools);
    runAdvisorSandbox(env, tools);

    const calls = vi.mocked(tools.run).mock.calls;
    const createArgs =
      calls.find(([, args]) => args.slice(0, 2).join(" ") === "sandbox create")?.[1] ?? [];
    const driverConfigIndex = createArgs.indexOf("--driver-config-json");
    const driverConfig = JSON.parse(createArgs[driverConfigIndex + 1] as string);
    expect(
      driverConfig.docker.mounts.filter(
        (mount: { target?: string }) => mount.target === "/pr-workdir",
      ),
    ).toEqual([expect.objectContaining({ read_only: true })]);
    const runArgs =
      calls.find(([, args]) =>
        args.includes("/advisor/tools/pr-review-advisor/run-analysis.mts"),
      )?.[1] ?? [];
    expect(runArgs).toContain(
      "PR_REVIEW_ADVISOR_SPECIALIST_SESSION_DIR=/pr-workdir/.pr-review-advisor-sessions",
    );
    expect(runArgs).not.toContain(expect.stringContaining("session-reader"));
  });

  it("rejects a specialist session alias outside the fixed workdir input (#9963)", () => {
    const env = advisorEnvironment();
    const outsideDirectory = path.join(env.GITHUB_WORKSPACE as string, "outside-sessions");
    const outsideAlias = path.join(env.ADVISOR_WORKDIR as string, "outside-sessions-alias");
    fs.mkdirSync(outsideDirectory);
    fs.symlinkSync(outsideDirectory, outsideAlias, "dir");
    env.PR_REVIEW_ADVISOR_SPECIALIST_SESSION_DIR = outsideAlias;
    const tools = advisorTools();

    expect(() => createAdvisorSandbox(env, tools)).toThrow(
      "PR_REVIEW_ADVISOR_SPECIALIST_SESSION_DIR must use the fixed workdir input path",
    );
    expect(tools.run).not.toHaveBeenCalled();
  });

  it("rejects artifact paths that could escape the sandbox runtime directory", () => {
    const env = advisorEnvironment();
    env.PR_REVIEW_ADVISOR_ARTIFACT_DIR = "../../advisor";
    const tools = advisorTools();

    expect(() => runAdvisorSandbox(env, tools)).toThrow(
      "PR_REVIEW_ADVISOR_ARTIFACT_DIR must be a simple directory name",
    );
    expect(() => downloadAdvisorArtifacts(env, tools)).toThrow(
      "PR_REVIEW_ADVISOR_ARTIFACT_DIR must be a simple directory name",
    );
    expect(tools.run).not.toHaveBeenCalled();
  });
});
