// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { validatePostMergeDocsWorkflowBoundary } from "../tools/post-merge-docs/contract.mts";
import { publishDocumentation, type Request } from "../tools/post-merge-docs/publish.mts";
import { executePostMergeDocs } from "../tools/post-merge-docs/run.mts";
import type { OpenShellTools } from "../tools/openshell-agent/runtime.mts";

const directories: string[] = [];
const repository = "NVIDIA/NemoClaw";
const signOff =
  "Signed-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";
function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  directories.push(directory);
  return directory;
}
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}
function sourceFixture() {
  const source = temporary("docs-source");
  git(source, ["init", "-b", "main"]);
  git(source, ["config", "user.name", "Test"]);
  git(source, ["config", "user.email", "test@example.com"]);
  fs.mkdirSync(path.join(source, "docs"));
  fs.writeFileSync(path.join(source, "docs/guide.mdx"), "old\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "docs: initialize"]);
  const mainSha = git(source, ["rev-parse", "HEAD"]);
  const mainTree = git(source, ["rev-parse", "HEAD^{tree}"]);
  return { mainSha, mainTree, source };
}
function fixture(file = "docs/new.mdx") {
  const { mainSha, mainTree, source } = sourceFixture();
  const work = temporary("docs-change");
  git(work, ["clone", "--no-hardlinks", source, "."]);
  fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  fs.writeFileSync(path.join(work, file), "new\n");
  git(work, ["add", file]);
  const finalTree = git(work, ["write-tree"]);
  const patch = execFileSync("git", ["diff", "--binary", "--full-index", mainTree, finalTree], {
    cwd: work,
  });
  return { finalTree, mainSha, patch, source };
}
function emptyFixture() {
  const { mainSha, mainTree, source } = sourceFixture();
  return { finalTree: mainTree, mainSha, patch: Buffer.alloc(0), source };
}
type Fixture = ReturnType<typeof fixture>;
function artifact(value: Fixture): string {
  const directory = temporary("docs-artifact");
  fs.writeFileSync(path.join(directory, "docs.patch"), value.patch);
  fs.writeFileSync(
    path.join(directory, "review.json"),
    JSON.stringify({
      version: 1,
      repository,
      mainSha: value.mainSha,
      patchSha256: createHash("sha256").update(value.patch).digest("hex"),
      outcome: "approved",
    }),
  );
  return directory;
}
class FakeGitHub {
  branchRef: { object: { sha: string } } | null = null;
  commitBody: Record<string, unknown> | null = null;
  liveSha: string;
  openPulls: Array<ReturnType<FakeGitHub["pull"]>> = [];
  readonly branch: string;
  readonly commitSha = "c".repeat(40);
  afterWrite = (): void => undefined;
  constructor(readonly value: Fixture) {
    this.branch = `automation/post-merge-docs-${value.mainSha.slice(0, 12)}`;
    this.liveSha = value.mainSha;
  }
  pull(body = "existing") {
    return {
      body,
      base: { ref: "main", repo: { full_name: repository } },
      draft: true,
      head: { ref: this.branch, repo: { full_name: repository }, sha: this.commitSha },
      html_url: `https://github.com/${repository}/pull/42`,
      number: 42,
      state: "open",
    };
  }
  readonly request = vi.fn<Request>(async (method, url, body) => {
    const key = `${method} ${url}`;
    switch (key) {
      case `GET /repos/${repository}/git/ref/heads/main`:
        return { object: { sha: this.liveSha } };
      case `GET /repos/${repository}/pulls?state=open&base=main&per_page=100&page=1`:
        return this.openPulls;
      case `GET /repos/${repository}/git/ref/heads/${this.branch}`:
        return this.branchRef;
      case `GET /repos/${repository}/git/commits/${this.commitSha}`:
        return {
          message: `docs: catch up after main\n\n${signOff}`,
          parents: [{ sha: this.value.mainSha }],
          sha: this.commitSha,
          tree: { sha: this.value.finalTree },
          verification: { verified: true },
        };
      case `POST /repos/${repository}/git/blobs`: {
        const content = Buffer.from((body as { content: string }).content, "base64");
        return {
          sha: createHash("sha1")
            .update(Buffer.from(`blob ${content.length}\0`))
            .update(content)
            .digest("hex"),
        };
      }
      case `POST /repos/${repository}/git/trees`:
        return { sha: this.value.finalTree };
      case `POST /repos/${repository}/git/commits`:
        this.commitBody = body as Record<string, unknown>;
        return { sha: this.commitSha, verification: { verified: true } };
      case `POST /repos/${repository}/git/refs`: {
        const ref = { object: { sha: this.commitSha }, ref: `refs/heads/${this.branch}` };
        this.branchRef = ref;
        this.afterWrite();
        return ref;
      }
      case `POST /repos/${repository}/pulls`: {
        const pull = this.pull((body as { body: string }).body);
        this.openPulls = [pull];
        this.afterWrite();
        return pull;
      }
      default:
        throw new Error(`Unexpected request: ${key}`);
    }
  });
}
function publish(value: Fixture, api: FakeGitHub, approved = artifact(value)) {
  return publishDocumentation({
    artifactDirectory: approved,
    expectedMainSha: value.mainSha,
    expectedRepository: repository,
    request: api.request,
    sourceRepository: value.source,
  });
}
function postCount(api: FakeGitHub, suffix?: string): number {
  return api.request.mock.calls.filter(
    ([method, url]) => method === "POST" && (!suffix || url.endsWith(suffix)),
  ).length;
}

const credentials =
  "GH_TOKEN GITHUB_TOKEN NVIDIA_API_KEY OPENAI_API_KEY POST_MERGE_DOCS_API_KEY PR_REVIEW_ADVISOR_API_KEY".split(
    " ",
  );
type RunnerStage = "create" | "agent" | "export" | "download";
function runnerFixture(phase: "author" | "review") {
  const { mainSha, source } = sourceFixture();
  fs.writeFileSync(path.join(source, "docs/guide.mdx"), "later\n");
  git(source, ["commit", "-am", "docs: advance source"]);
  const root = temporary("docs-runner");
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(candidate);
  fs.writeFileSync(path.join(candidate, "docs.patch"), "");
  return {
    root,
    env: {
      ...process.env,
      ...Object.fromEntries(credentials.map((name) => [name, "secret"])),
      GITHUB_REPOSITORY: repository,
      GITHUB_SHA: mainSha,
      HOME: root,
      PI_IMAGE: "image",
      POST_MERGE_DOCS_ARTIFACT_DIR: path.join(root, "artifact"),
      POST_MERGE_DOCS_CANDIDATE_DIR: candidate,
      POST_MERGE_DOCS_CONFIG_DIR: path.join(root, "config"),
      POST_MERGE_DOCS_PHASE: phase,
      POST_MERGE_DOCS_WORKDIR: path.join(root, "work"),
      RANGE_START_SHA: mainSha,
      RANGE_START_TAG: "v1.0.0",
      SANDBOX_NAME: `docs-${phase}`,
      TRUSTED_CHECKOUT: source,
    },
  };
}
function runnerTools(
  input: ReturnType<typeof runnerFixture>,
  failure?: RunnerStage,
  decision = "approved",
) {
  const { env, root } = input;
  const sandbox = path.join(root, "sandbox");
  const output = path.join(root, "work/output");
  const state = { deleted: false };
  const handlers: Record<string, (args: readonly string[]) => unknown> = {
    create: () => {
      fs.cpSync(path.join(root, "work/repo"), sandbox, { recursive: true });
      expect(git(sandbox, ["rev-parse", "HEAD"])).toBe(env.GITHUB_SHA);
    },
    agent: () => {
      const agents = {
        author: () => fs.writeFileSync(path.join(sandbox, "docs/guide.mdx"), "authored\n"),
        review: () =>
          fs.writeFileSync(
            path.join(output, "decision.json"),
            JSON.stringify({ outcome: decision }),
          ),
      };
      agents[env.POST_MERGE_DOCS_PHASE]();
    },
    export: () => {
      const patch = execFileSync(
        "git",
        ["diff", "--binary", "--full-index", "HEAD", "--", "docs", "fern"],
        { cwd: sandbox },
      );
      fs.writeFileSync(path.join(output, "docs.patch"), patch);
    },
    download: (args) => {
      const name = path.basename(args[3]);
      fs.copyFileSync(path.join(output, name), path.join(args[4], name));
    },
    list: () => env.SANDBOX_NAME,
    delete: () => (state.deleted = true),
  };
  const commands: Record<string, string> = { bash: "export", node: "agent" };
  const tools: OpenShellTools = {
    run: (_command, args, options) => {
      for (const name of credentials) expect(options.env).not.toHaveProperty(name);
      const executable = path.basename(args[args.indexOf("--") + 1] ?? "");
      const stage = commands[executable] ?? args[1];
      expect(stage).not.toBe(failure);
      return String(handlers[stage](args) ?? "");
    },
    start: () => undefined,
    wait: async () => undefined,
  };
  return { state, tools };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { force: true, recursive: true });
});

describe("post-merge documentation publisher", () => {
  it("creates one immutable branch and draft PR", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    await expect(publish(value, api)).rejects.toThrow("Documentation remains pending");
    expect(api.commitBody?.message).toEqual(expect.stringContaining(signOff));
    expect(api.commitBody).toMatchObject({ parents: [value.mainSha], tree: value.finalTree });
    expect(api.branchRef?.object.sha).toBe(api.commitSha);
    expect(api.openPulls[0]?.body).toMatch(/`npm run docs`[\s\S]*approval-required/u);
  });
  it("creates no writes for an approved empty patch", async () => {
    const value = emptyFixture();
    const api = new FakeGitHub(value);
    await publish(value, api);
    expect(postCount(api)).toBe(0);
  });
  it("rejects a patch whose digest was not approved", async () => {
    const value = emptyFixture();
    const approved = artifact(value);
    fs.writeFileSync(path.join(approved, "docs.patch"), "changed");
    const api = new FakeGitHub(value);
    await expect(publish(value, api, approved)).rejects.toThrow("does not approve the exact patch");
    expect(api.request).not.toHaveBeenCalled();
  });
  it.each(["src/bad.ts", "fern/package.json", "fern/.npmrc", "fern/components/CustomFooter.tsx"])(
    "rejects an approved patch at unsupported path %s",
    async (file) => {
      const value = fixture(file);
      const api = new FakeGitHub(value);
      await expect(publish(value, api)).rejects.toThrow("patch changes unsupported path");
      expect(postCount(api)).toBe(0);
    },
  );
  it("stops when main moved after review", async () => {
    const value = emptyFixture();
    const api = new FakeGitHub(value);
    api.liveSha = "d".repeat(40);
    await expect(publish(value, api)).rejects.toThrow("main changed after documentation review");
  });
  it.each([1, 2])(
    "fails when %i managed documentation PRs open during publication",
    async (count) => {
      const value = fixture();
      const api = new FakeGitHub(value);
      api.openPulls = [
        api.pull(),
        { ...api.pull(), html_url: `https://github.com/${repository}/pull/43`, number: 43 },
      ].slice(0, count);
      await expect(publish(value, api)).rejects.toThrow(/managed documentation PR/u);
      expect(postCount(api)).toBe(0);
    },
  );
  it("rejects an existing immutable branch with unexpected content", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.branchRef = { object: { sha: api.commitSha } };
    value.finalTree = "d".repeat(40);
    await expect(publish(value, api)).rejects.toThrow("unexpected content");
    expect(postCount(api)).toBe(0);
  });
  it("reconciles exact lost branch and PR responses without retrying", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.afterWrite = () => {
      throw new Error("lost response");
    };
    await expect(publish(value, api)).rejects.toThrow("Documentation remains pending");
    expect(postCount(api, "/pulls")).toBe(1);
    expect(postCount(api, "/git/refs")).toBe(1);
  });
});

describe("post-merge documentation runner", () => {
  it("authors from the triggering SHA without exposing host credentials", () => {
    const input = runnerFixture("author");
    const { state, tools } = runnerTools(input);
    executePostMergeDocs(input.env, tools);
    expect(fs.readFileSync(path.join(input.root, "artifact/docs.patch"), "utf8")).toContain(
      "+authored",
    );
    expect(state.deleted).toBe(true);
  });
  it("records the exact independent approval", () => {
    const input = runnerFixture("review");
    executePostMergeDocs(input.env, runnerTools(input).tools);
    expect(
      JSON.parse(fs.readFileSync(path.join(input.root, "artifact/review.json"), "utf8")),
    ).toEqual({
      mainSha: input.env.GITHUB_SHA,
      outcome: "approved",
      patchSha256: createHash("sha256").update("").digest("hex"),
      repository,
      version: 1,
    });
  });
  it("rejects an independent review denial and deletes the sandbox", () => {
    const input = runnerFixture("review");
    const { state, tools } = runnerTools(input, undefined, "rejected");
    expect(() => executePostMergeDocs(input.env, tools)).toThrow("did not approve");
    expect(state.deleted).toBe(true);
  });
  it.each<RunnerStage>(["create", "agent", "export", "download"])(
    "deletes the sandbox after %s fails",
    (stage) => {
      const input = runnerFixture("author");
      const { state, tools } = runnerTools(input, stage);
      expect(() => executePostMergeDocs(input.env, tools)).toThrow();
      expect(state.deleted).toBe(true);
    },
  );
});

describe("post-merge documentation workflow boundary", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const workflow = YAML.parse(
    fs.readFileSync(path.join(root, ".github/workflows/post-merge-docs.yaml"), "utf8"),
  ) as Record<string, any>;
  const policy = YAML.parse(
    fs.readFileSync(path.join(root, "tools/post-merge-docs/review-policy.yaml"), "utf8"),
  );

  it("separates the model credential from repository writes", () => {
    expect(validatePostMergeDocsWorkflowBoundary(workflow)).toEqual([]);
  });

  it.each<(candidate: Record<string, any>) => void>([
    (candidate) => (candidate.jobs.author.permissions = { contents: "write" }),
    (candidate) => (candidate.jobs.publish.permissions.issues = "write"),
    (candidate) => (candidate.jobs.gate.secrets = "inherit"),
    (candidate) =>
      (candidate.jobs.author.steps.find(
        (step: Record<string, any>) => step.env?.OPENAI_API_KEY,
      ).name = "Other step"),
    (candidate) =>
      (candidate.jobs.publish.env = {
        OPENAI_API_KEY: "${{ secrets.POST_MERGE_DOCS_API_KEY }}",
      }),
  ])("rejects credential and permission boundary mutation %#", (mutate) => {
    const candidate = structuredClone(workflow);
    mutate(candidate);
    expect(validatePostMergeDocsWorkflowBoundary(candidate)).not.toEqual([]);
  });

  it("keeps the independent reviewer's repository read-only and offline", () => {
    expect(policy.filesystem_policy.read_write).toEqual(["/dev", "/sandbox/output"]);
    expect(policy.filesystem_policy.read_only).toContain("/sandbox/repo");
    expect(policy.landlock).toEqual({ compatibility: "hard_requirement" });
    expect(policy.network_policies).toEqual({});
  });
});
