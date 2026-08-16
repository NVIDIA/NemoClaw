// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { publishDocumentation, type Request } from "../tools/post-merge-docs/publish.mts";

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
  private afterPull = (): void => undefined;
  private afterRef = (): void => undefined;
  constructor(readonly value: Fixture) {
    this.branch = `automation/post-merge-docs-${value.mainSha.slice(0, 12)}`;
    this.liveSha = value.mainSha;
  }
  get branchSha() {
    return this.branchRef?.object.sha ?? null;
  }
  get openPull() {
    return this.openPulls[0] ?? null;
  }
  loseResponses() {
    this.afterPull = () => {
      throw new Error("lost pull response");
    };
    this.afterRef = () => {
      throw new Error("lost ref response");
    };
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
        this.afterRef();
        return ref;
      }
      case `POST /repos/${repository}/pulls`: {
        const pull = this.pull((body as { body: string }).body);
        this.openPulls = [pull];
        this.afterPull();
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
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { force: true, recursive: true });
});

describe("post-merge documentation publisher", () => {
  it("creates one immutable branch and draft PR from the approved patch", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    expect(await publish(value, api)).toMatchObject({ status: "pr_created", prNumber: 42 });
    expect(api.commitBody).toMatchObject({
      message: expect.stringContaining(signOff),
      parents: [value.mainSha],
      tree: value.finalTree,
    });
    expect(api.branchSha).toBe(api.commitSha);
    expect(api.openPull?.body).toMatch(/docs:validate[\s\S]*approval-required/u);
  });
  it("returns no_changes for an approved empty patch without writes", async () => {
    const value = emptyFixture();
    const api = new FakeGitHub(value);
    await expect(publish(value, api)).resolves.toEqual({ status: "no_changes" });
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
  it("rejects an approved patch outside docs and fern", async () => {
    const value = fixture("src/bad.ts");
    const api = new FakeGitHub(value);
    await expect(publish(value, api)).rejects.toThrow("patch changes unsupported path");
    expect(postCount(api)).toBe(0);
  });
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
    api.loseResponses();
    expect(await publish(value, api)).toMatchObject({ status: "pr_created", prNumber: 42 });
    expect(postCount(api, "/pulls")).toBe(1);
    expect(postCount(api, "/git/refs")).toBe(1);
  });
});

describe("post-merge documentation workflow boundary", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const workflow = YAML.parse(
    fs.readFileSync(path.join(root, ".github/workflows/post-merge-docs.yaml"), "utf8"),
  ) as {
    jobs: Record<string, { permissions: Record<string, string> }>;
    permissions: Record<string, string>;
  };
  const policy = YAML.parse(
    fs.readFileSync(path.join(root, "tools/post-merge-docs/review-policy.yaml"), "utf8"),
  );

  // source-shape-contract: security -- The workflow must keep model credentials out of its repository-write privilege domain.
  it("separates the inference credential from repository writes", () => {
    expect(workflow.permissions).toEqual({});
    expect(JSON.stringify(workflow.jobs.gate)).toContain("| jq --slurp");
    expect(workflow.jobs.author?.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.validate?.permissions).toEqual({ actions: "read", contents: "read" });
    expect(workflow.jobs.publish?.permissions).toEqual({
      actions: "read",
      contents: "write",
      "pull-requests": "write",
    });
    expect(JSON.stringify(workflow).match(/secrets\.POST_MERGE_DOCS_API_KEY/gu)).toHaveLength(1);
    expect(JSON.stringify(workflow.jobs.publish)).not.toMatch(/API_KEY/u);
  });

  it("keeps the independent reviewer read-only and offline", () => {
    expect(policy.filesystem_policy.read_write).toEqual(["/dev", "/sandbox/output"]);
    expect(policy.filesystem_policy.read_only).toContain("/sandbox/repo");
    expect(policy.landlock).toEqual({ compatibility: "hard_requirement" });
    expect(policy.network_policies).toEqual({});
  });
});
