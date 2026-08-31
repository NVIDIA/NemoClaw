// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nextPatchReleaseTag } from "../../tools/post-merge-docs/contract.mts";
import { publishDocumentation, type Request } from "../../tools/post-merge-docs/publish.mts";
import { configurePostMergeDocs, executePostMergeDocs } from "../../tools/post-merge-docs/run.mts";
import type { OpenShellTools } from "../../tools/openshell-agent/runtime.mts";

const directories: string[] = [];
const repository = "NVIDIA/NemoClaw";
const repositoryId = "R_kgDOTestRepository";
const signOff =
  "Signed-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";
const rangeStartTag = "v1.0.0";
const targetReleaseTag = "v1.0.1";
const managedTitle = "docs: prepare v1.0.1 documentation";
const managedBody = `## Release target

This cumulative draft prepares documentation for \`v1.0.1\`.
It covers merged changes after \`v1.0.0\` through the reviewed \`main\` commit recorded as a parent of the latest workflow-created commit.
The workflow selects \`v1.0.1\` by incrementing the patch component of \`v1.0.0\`.

## Managed state

The workflow owns this branch while the PR is a draft. Ready-for-review status transfers branch ownership to maintainers, and later workflow runs leave the PR unchanged.

Follow [Post-Merge Documentation Catch-Up](https://github.com/NVIDIA/NemoClaw/blob/main/docs/AUTOMATION.md#post-merge-documentation-catch-up) for development, recovery, validation, and release-cutoff routing.

## Verification

- An independent documentation writer approved each exact cumulative patch.
- A maintainer must inspect and approve any approval-required workflow runs.

${signOff}`;
function legacyManagedBody(mainSha: string): string {
  return `## Summary

Updates documentation for merged changes through \`${mainSha}\`.

## Verification

- An independent documentation writer approved the exact patch.
- Required PR checks must run \`npm run docs\` before merge.
- A maintainer must inspect and approve any approval-required workflow runs.

${signOff}`;
}
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
      mainSha: value.mainSha,
      outcome: "approved",
      patchSha256: createHash("sha256").update(value.patch).digest("hex"),
      rangeStartTag,
      repository,
      targetReleaseTag,
      version: 2,
    }),
  );
  return directory;
}
class FakeGitHub {
  branchRef: { object: { sha: string }; ref?: string } | null = null;
  commitBodies: Record<string, unknown>[] = [];
  liveSha: string;
  openPulls: Array<ReturnType<FakeGitHub["pull"]>> = [];
  readonly branch: string;
  readonly commitSha = "c".repeat(40);
  readonly existingSha = "b".repeat(40);
  readonly initialParent = "a".repeat(40);
  readonly partialSha = "d".repeat(40);
  readonly commits = new Map<string, Record<string, unknown>>();
  beforePullCreation = (): void => undefined;
  beforeRefUpdate = (): void => undefined;
  afterWrite = (): void => undefined;
  afterPullRead = (): void => undefined;
  projectPullHead = (headSha: string): void => {
    this.openPulls = this.openPulls.map((pull) => ({
      ...pull,
      head: { ...pull.head, sha: headSha },
    }));
  };
  constructor(readonly value: Fixture) {
    this.branch = `automation/post-merge-docs-${value.mainSha.slice(0, 12)}`;
    this.liveSha = value.mainSha;
  }
  pull(
    body = managedBody,
    headSha = this.branchRef?.object.sha ?? this.commitSha,
    title = managedTitle,
  ) {
    return {
      body,
      base: { ref: "main", repo: { full_name: repository, node_id: repositoryId } },
      draft: true,
      head: {
        ref: this.branch,
        repo: { full_name: repository, node_id: repositoryId },
        sha: headSha,
      },
      html_url: `https://github.com/${repository}/pull/42`,
      number: 42,
      state: "open",
      title,
    };
  }
  installActive(
    tree = "e".repeat(40),
    authorEmail = "41898282+github-actions[bot]@users.noreply.github.com",
    legacy = false,
  ) {
    this.branchRef = {
      object: { sha: this.existingSha },
      ref: `refs/heads/${this.branch}`,
    };
    this.commits.set(this.existingSha, {
      author: { email: authorEmail },
      message: `docs: catch up after main\n\n${signOff}`,
      parents: [{ sha: this.initialParent }],
      sha: this.existingSha,
      tree: { sha: tree },
      verification: { verified: true },
    });
    this.openPulls = [
      legacy
        ? this.pull(
            legacyManagedBody(this.initialParent),
            this.existingSha,
            "docs: catch up after merged changes",
          )
        : this.pull(managedBody, this.existingSha, managedTitle),
    ];
  }
  installOrphan(tree = this.value.finalTree) {
    this.branchRef = {
      object: { sha: this.existingSha },
      ref: `refs/heads/${this.branch}`,
    };
    this.commits.set(this.existingSha, {
      author: { email: "41898282+github-actions[bot]@users.noreply.github.com" },
      message: `docs: catch up after main\n\n${signOff}`,
      parents: [{ sha: this.value.mainSha }],
      sha: this.existingSha,
      tree: { sha: tree },
      verification: { verified: true },
    });
    this.openPulls = [];
  }
  installPartiallyPublishedLegacy(tree = "f".repeat(40)) {
    this.installActive("e".repeat(40), undefined, true);
    this.commits.set(this.partialSha, {
      author: { email: "41898282+github-actions[bot]@users.noreply.github.com" },
      message: `docs: catch up after main\n\n${signOff}`,
      parents: [{ sha: this.existingSha }, { sha: this.initialParent }],
      sha: this.partialSha,
      tree: { sha: tree },
      verification: { verified: true },
    });
    this.branchRef = {
      object: { sha: this.partialSha },
      ref: `refs/heads/${this.branch}`,
    };
    this.openPulls = this.openPulls.map((pull) => ({
      ...pull,
      head: { ...pull.head, sha: this.partialSha },
    }));
  }
  readonly request = vi.fn<Request>(async (method, url, body) => {
    const key = `${method} ${url}`;
    switch (key) {
      case `GET /repos/${repository}/git/commits/${this.existingSha}`:
      case `GET /repos/${repository}/git/commits/${this.commitSha}`:
      case `GET /repos/${repository}/git/commits/${this.partialSha}`:
        return this.commits.get(url.slice(url.lastIndexOf("/") + 1));
      case `GET /repos/${repository}/git/ref/heads/main`:
        return { object: { sha: this.liveSha } };
      case `GET /repos/${repository}/pulls?state=open&base=main&per_page=100&page=1`: {
        const pulls = structuredClone(this.openPulls);
        this.afterPullRead();
        return pulls;
      }
      case `GET /repos/${repository}/git/ref/heads/${this.branch}`:
        return this.branchRef;
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
      case `POST /repos/${repository}/git/commits`: {
        const commitBody = body as Record<string, unknown>;
        this.commitBodies.push(commitBody);
        this.commits.set(this.commitSha, {
          author: { email: "41898282+github-actions[bot]@users.noreply.github.com" },
          message: commitBody.message,
          parents: (commitBody.parents as string[]).map((sha) => ({ sha })),
          sha: this.commitSha,
          tree: { sha: this.value.finalTree },
          verification: { verified: true },
        });
        return { sha: this.commitSha, verification: { verified: true } };
      }
      case `POST /repos/${repository}/git/refs`: {
        const ref = { object: { sha: this.commitSha }, ref: `refs/heads/${this.branch}` };
        this.branchRef = ref;
        this.afterWrite();
        return ref;
      }
      case "POST /graphql": {
        const graphql = body as {
          query: string;
          variables: {
            input: {
              clientMutationId: string;
              refUpdates: Array<{
                afterOid: string;
                beforeOid: string;
                force: boolean;
                name: string;
              }>;
              repositoryId: string;
            };
          };
        };
        const input = graphql.variables.input;
        expect(graphql.query).toContain("updateRefs");
        expect(input).toMatchObject({
          clientMutationId: this.commitSha,
          refUpdates: [
            {
              afterOid: this.commitSha,
              force: false,
              name: `refs/heads/${this.branch}`,
            },
          ],
          repositoryId,
        });
        this.beforeRefUpdate();
        expect(this.branchRef?.object.sha, "conditional branch update rejected").toBe(
          input.refUpdates[0]?.beforeOid,
        );
        const ref = { object: { sha: this.commitSha }, ref: `refs/heads/${this.branch}` };
        this.branchRef = ref;
        this.projectPullHead(this.commitSha);
        this.afterWrite();
        return { updateRefs: { clientMutationId: input.clientMutationId } };
      }
      case `POST /repos/${repository}/pulls`: {
        this.beforePullCreation();
        const metadata = body as { body: string; title: string };
        const pull = this.pull(metadata.body, undefined, metadata.title);
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
function requestCount(api: FakeGitHub, method: string, suffix?: string): number {
  return api.request.mock.calls.filter(
    ([calledMethod, url]) => calledMethod === method && (!suffix || url.endsWith(suffix)),
  ).length;
}
function writeCount(api: FakeGitHub): number {
  return api.request.mock.calls.filter(([method]) => method === "POST").length;
}

const credentials =
  "GH_TOKEN GITHUB_TOKEN NVIDIA_API_KEY OPENAI_API_KEY POST_MERGE_DOCS_API_KEY PR_REVIEW_ADVISOR_API_KEY".split(
    " ",
  );
type RunnerStage = "create" | "agent" | "export" | "download";
function runnerFixture(phase: "author" | "review", startTag = rangeStartTag) {
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
      OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:8080",
      PI_IMAGE: "image",
      POST_MERGE_DOCS_ARTIFACT_DIR: path.join(root, "artifact"),
      POST_MERGE_DOCS_CANDIDATE_DIR: candidate,
      POST_MERGE_DOCS_CONFIG_DIR: path.join(root, "config"),
      POST_MERGE_DOCS_PHASE: phase,
      POST_MERGE_DOCS_WORKDIR: path.join(root, "work"),
      RANGE_START_SHA: mainSha,
      RANGE_START_TAG: startTag,
      RUNNER_TEMP: path.join(root, "runner-temp"),
      SANDBOX_NAME: `docs-${phase}`,
      TRUSTED_CHECKOUT: source,
    },
  };
}
function runnerTools(
  input: ReturnType<typeof runnerFixture>,
  failure?: RunnerStage,
  decision: "approved" | "rejected" = "approved",
  reviewReport = "The candidate omits one user-visible change.\n",
) {
  const { env, root } = input;
  const sandbox = path.join(root, "sandbox");
  const output = path.join(root, "work/output");
  const state = {
    agentArgs: [] as readonly string[],
    createArgs: [] as readonly string[],
    deleted: false,
  };
  const handlers: Record<string, (args: readonly string[]) => unknown> = {
    create: (args) => {
      state.createArgs = args;
      fs.cpSync(path.join(root, "work/repo"), sandbox, { recursive: true });
      expect(git(sandbox, ["rev-parse", "HEAD"])).toBe(env.GITHUB_SHA);
    },
    agent: (args) => {
      state.agentArgs = args;
      const agents = {
        author: () => fs.writeFileSync(path.join(sandbox, "docs/guide.mdx"), "authored\n"),
        review: () => {
          const reports = {
            approved: () => undefined,
            rejected: () => fs.writeFileSync(path.join(output, "review-report.txt"), reviewReport),
          };
          fs.writeFileSync(
            path.join(output, "decision.json"),
            JSON.stringify({ outcome: decision }),
          );
          reports[decision]();
        },
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
  const run: OpenShellTools["run"] = (_command, args, options) => {
    for (const name of credentials) expect(options.env).not.toHaveProperty(name);
    const executable = path.basename(args[args.indexOf("--") + 1] ?? "");
    const stage = commands[executable] ?? args[1];
    expect(stage).not.toBe(failure);
    return String(handlers[stage](args) ?? "");
  };
  const tools: OpenShellTools = {
    run: vi.fn(run),
    runAsync: vi.fn(() => ({ cancel: vi.fn(), completion: Promise.resolve() })),
    start: () => undefined,
    wait: async () => undefined,
  };
  return { run, state, tools };
}
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { force: true, recursive: true });
});

describe("post-merge documentation publisher", () => {
  it("increments a canonical release tag", () => {
    expect(nextPatchReleaseTag("v1.2.3")).toBe("v1.2.4");
  });
  it.each(["v01.2.3", "v1.02.3", "v1.2.003"])("rejects non-canonical release tag %s", (tag) => {
    expect(() => nextPatchReleaseTag(tag)).toThrow("cannot produce a release target");
  });
  it("creates one verified branch and cumulative draft PR", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    await expect(publish(value, api)).rejects.toThrow("Documentation remains pending");
    expect(api.commitBodies[0]?.message).toEqual(expect.stringContaining(signOff));
    expect(api.commitBodies[0]).toMatchObject({
      parents: [value.mainSha],
      tree: value.finalTree,
    });
    expect(api.branchRef?.object.sha).toBe(api.commitSha);
    expect(api.openPulls[0]?.title).toBe(managedTitle);
    expect(api.openPulls[0]?.body).toContain(
      "through the reviewed `main` commit recorded as a parent of the latest workflow-created commit",
    );
    expect(api.openPulls[0]?.body).toContain(
      "https://github.com/NVIDIA/NemoClaw/blob/main/docs/AUTOMATION.md#post-merge-documentation-catch-up",
    );
    expect(api.openPulls[0]?.body).not.toContain("## Release cutoff");
  });
  it("creates no writes for an approved empty patch without an active PR", async () => {
    const value = emptyFixture();
    const api = new FakeGitHub(value);
    await publish(value, api);
    expect(writeCount(api)).toBe(0);
  });
  it("reports the exact orphaned branch when draft PR creation fails", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.beforePullCreation = () => {
      throw new Error("pull creation failed");
    };
    await expect(publish(value, api)).rejects.toThrow(
      `managed documentation branch ${api.branch} at ${api.commitSha} remains without a draft PR; PR creation failed: pull creation failed; follow https://github.com/NVIDIA/NemoClaw/blob/main/docs/AUTOMATION.md#recover-an-orphaned-managed-branch`,
    );
    expect(api.branchRef?.object.sha).toBe(api.commitSha);
    expect(api.openPulls).toEqual([]);
    expect(requestCount(api, "POST", "/pulls")).toBe(1);
  });
  it("reports the exact orphaned branch when another managed PR appears", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.beforePullCreation = () => {
      const other = api.pull();
      api.openPulls = [
        {
          ...other,
          head: {
            ...other.head,
            ref: `automation/post-merge-docs-${"f".repeat(12)}`,
          },
          html_url: `https://github.com/${repository}/pull/43`,
          number: 43,
        },
      ];
      throw new Error("pull creation failed");
    };
    await expect(publish(value, api)).rejects.toThrow(
      `managed documentation branch ${api.branch} at ${api.commitSha} remains without a draft PR`,
    );
    expect(console.error).toHaveBeenCalledWith(
      `managed documentation branch ${api.branch} at ${api.commitSha} was created; if publication stops before draft PR creation, follow https://github.com/NVIDIA/NemoClaw/blob/main/docs/AUTOMATION.md#recover-an-orphaned-managed-branch`,
    );
    expect(api.branchRef?.object.sha).toBe(api.commitSha);
    expect(api.openPulls[0]?.head.ref).not.toBe(api.branch);
  });
  it("keeps an active PR pending when the approved patch is empty", async () => {
    const value = emptyFixture();
    const api = new FakeGitHub(value);
    api.installActive();
    await expect(publish(value, api)).rejects.toThrow("Documentation remains pending");
    expect(writeCount(api)).toBe(0);
  });
  it("leaves a ready-for-review managed PR unchanged", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installActive();
    api.openPulls[0]!.draft = false;
    await publish(value, api);
    expect(api.branchRef?.object.sha).toBe(api.existingSha);
    expect(writeCount(api)).toBe(0);
  });
  it("rejects a patch whose digest was not approved", async () => {
    const value = emptyFixture();
    const approved = artifact(value);
    fs.writeFileSync(path.join(approved, "docs.patch"), "changed");
    const api = new FakeGitHub(value);
    await expect(publish(value, api, approved)).rejects.toThrow("does not approve the exact patch");
    expect(api.request).not.toHaveBeenCalled();
  });
  it("rejects a release target that is not the next patch", async () => {
    const value = emptyFixture();
    const approved = artifact(value);
    const reviewFile = path.join(approved, "review.json");
    const review = JSON.parse(fs.readFileSync(reviewFile, "utf8"));
    review.targetReleaseTag = "v1.0.2";
    fs.writeFileSync(reviewFile, JSON.stringify(review));
    const api = new FakeGitHub(value);
    await expect(publish(value, api, approved)).rejects.toThrow("release target");
    expect(api.request).not.toHaveBeenCalled();
  });
  it("preserves the publisher diagnostic for an invalid review range tag", async () => {
    const value = emptyFixture();
    const approved = artifact(value);
    const reviewFile = path.join(approved, "review.json");
    const review = JSON.parse(fs.readFileSync(reviewFile, "utf8"));
    review.rangeStartTag = "v01.0.0";
    fs.writeFileSync(reviewFile, JSON.stringify(review));
    const api = new FakeGitHub(value);
    await expect(publish(value, api, approved)).rejects.toThrow(
      "review range start tag cannot produce a release target",
    );
    expect(api.request).not.toHaveBeenCalled();
  });
  it.each(["src/bad.ts", "fern/package.json", "fern/.npmrc", "fern/components/CustomFooter.tsx"])(
    "rejects an approved patch at unsupported path %s",
    async (file) => {
      const value = fixture(file);
      const api = new FakeGitHub(value);
      await expect(publish(value, api)).rejects.toThrow("patch changes unsupported path");
      expect(writeCount(api)).toBe(0);
    },
  );
  it("stops when main moved after review", async () => {
    const value = emptyFixture();
    const api = new FakeGitHub(value);
    api.liveSha = "d".repeat(40);
    await expect(publish(value, api)).rejects.toThrow("main changed after documentation review");
  });
  it("fails when multiple managed documentation PRs are open", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installActive();
    api.openPulls.push({
      ...api.pull(),
      html_url: `https://github.com/${repository}/pull/43`,
      number: 43,
    });
    await expect(publish(value, api)).rejects.toThrow("multiple managed documentation PRs");
    expect(writeCount(api)).toBe(0);
  });
  it("refreshes the active PR with a verified fast-forward merge commit", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installActive();
    await expect(publish(value, api)).rejects.toThrow("Documentation remains pending");
    expect(api.commitBodies[0]).toMatchObject({
      parents: [api.existingSha, value.mainSha],
      tree: value.finalTree,
    });
    expect(api.branchRef?.object.sha).toBe(api.commitSha);
    expect(api.openPulls[0]?.head.sha).toBe(api.commitSha);
    expect(api.openPulls[0]?.body).toBe(managedBody);
    expect(api.openPulls[0]?.title).toBe(managedTitle);
    expect(requestCount(api, "POST", "/graphql")).toBe(1);
    expect(
      api.request.mock.calls.find(([method, url]) => method === "POST" && url === "/graphql")?.[2],
    ).toMatchObject({
      variables: {
        input: {
          refUpdates: [{ beforeOid: api.existingSha }],
        },
      },
    });
    expect(requestCount(api, "POST", "/pulls")).toBe(0);
  });
  it("accepts a confirmed fast-forward before the PR head projection catches up", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installActive();
    api.projectPullHead = () => undefined;
    await expect(publish(value, api)).rejects.toThrow("Documentation remains pending");
    expect(api.branchRef?.object.sha).toBe(api.commitSha);
    expect(api.openPulls[0]?.head.sha).toBe(api.existingSha);
    expect(requestCount(api, "POST", "/graphql")).toBe(1);
  });
  it("rejects a conditional update when the managed branch moves to an ancestor", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installActive();
    api.beforeRefUpdate = () => {
      api.branchRef = {
        object: { sha: api.initialParent },
        ref: `refs/heads/${api.branch}`,
      };
    };
    await expect(publish(value, api)).rejects.toThrow("conditional branch update rejected");
    expect(api.branchRef?.object.sha).toBe(api.initialParent);
    expect(
      api.request.mock.calls.find(([method, url]) => method === "POST" && url === "/graphql")?.[2],
    ).toMatchObject({
      variables: {
        input: {
          refUpdates: [{ beforeOid: api.existingSha }],
        },
      },
    });
  });
  it("stops without writes for exact previous workflow metadata", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installActive("e".repeat(40), undefined, true);
    await expect(publish(value, api)).rejects.toThrow(
      "managed documentation PR https://github.com/NVIDIA/NemoClaw/pull/42 uses previous workflow metadata; close this legacy draft so a later qualifying push can create a current workflow-owned draft, or mark the PR ready for review to transfer ownership",
    );
    expect(writeCount(api)).toBe(0);
  });
  it("stops without writes for previous metadata after a workflow refresh", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installPartiallyPublishedLegacy(value.finalTree);
    await expect(publish(value, api)).rejects.toThrow("uses previous workflow metadata");
    expect(writeCount(api)).toBe(0);
  });
  it("does not overwrite a concurrent edit to previous workflow metadata", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installActive("e".repeat(40), undefined, true);
    api.afterPullRead = () => {
      api.openPulls[0]!.title = "maintainer title";
      api.afterPullRead = () => undefined;
    };
    await expect(publish(value, api)).rejects.toThrow(
      "managed documentation PR changed during publication",
    );
    expect(writeCount(api)).toBe(0);
  });
  it("rejects a partially published legacy PR without a verified legacy parent", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installPartiallyPublishedLegacy();
    const previous = api.commits.get(api.existingSha)!;
    previous.verification = { verified: false };
    await expect(publish(value, api)).rejects.toThrow("not created by the workflow");
    expect(writeCount(api)).toBe(0);
  });
  it("names the managed PR and recovery paths when its metadata changes", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installActive();
    api.openPulls[0]!.title = "maintainer title";
    await expect(publish(value, api)).rejects.toThrow(
      "managed documentation PR https://github.com/NVIDIA/NemoClaw/pull/42 title or body no longer matches the workflow-owned release target; restore the previous workflow-authored title and body to resume updates on the next qualifying push, or mark the PR ready for review to transfer ownership",
    );
    expect(writeCount(api)).toBe(0);
  });
  it("does not add a redundant refresh when the active tree already matches", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installActive(value.finalTree);
    await expect(publish(value, api)).rejects.toThrow("Documentation remains pending");
    expect(writeCount(api)).toBe(0);
  });
  it("rejects a human commit at the active branch head", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installActive("e".repeat(40), "maintainer@example.com");
    await expect(publish(value, api)).rejects.toThrow("not created by the workflow");
    expect(writeCount(api)).toBe(0);
  });
  it("rejects an active PR whose branch ref moved", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installActive();
    api.branchRef = { object: { sha: "d".repeat(40) } };
    await expect(publish(value, api)).rejects.toThrow("point to different commits");
    expect(writeCount(api)).toBe(0);
  });
  it("rejects an unmanaged branch for the current main commit", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.branchRef = { object: { sha: api.existingSha } };
    await expect(publish(value, api)).rejects.toThrow("unmanaged documentation branch");
    expect(writeCount(api)).toBe(0);
  });
  it("reconciles a verified orphan branch into exactly one draft PR", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installOrphan();
    await expect(publish(value, api)).rejects.toThrow("Documentation remains pending");
    expect(api.branchRef?.object.sha).toBe(api.existingSha);
    expect(api.openPulls).toHaveLength(1);
    expect(api.openPulls[0]?.head.sha).toBe(api.existingSha);
    expect(api.commitBodies).toEqual([]);
    expect(requestCount(api, "POST", "/pulls")).toBe(1);
    expect(requestCount(api, "POST", "/git/refs")).toBe(0);
    expect(requestCount(api, "POST", "/graphql")).toBe(0);
  });
  it("preserves a concurrently attached draft while recovering an orphan", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installOrphan();
    api.beforePullCreation = () => {
      api.openPulls = [api.pull(managedBody, api.existingSha, managedTitle)];
      throw new Error("pull already attached");
    };
    await expect(publish(value, api)).rejects.toThrow("Documentation remains pending");
    expect(api.branchRef?.object.sha).toBe(api.existingSha);
    expect(api.openPulls).toHaveLength(1);
    expect(api.openPulls[0]?.head.sha).toBe(api.existingSha);
    expect(requestCount(api, "POST", "/pulls")).toBe(1);
  });
  it("rejects an orphan branch whose workflow commit has the wrong parent", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installOrphan();
    api.commits.get(api.existingSha)!.parents = [{ sha: api.initialParent }];
    await expect(publish(value, api)).rejects.toThrow("unmanaged documentation branch");
    expect(writeCount(api)).toBe(0);
  });
  it("rejects an orphan branch whose tree differs from the approved patch", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installOrphan("e".repeat(40));
    await expect(publish(value, api)).rejects.toThrow("unmanaged documentation branch");
    expect(api.branchRef?.object.sha).toBe(api.existingSha);
    expect(api.openPulls).toEqual([]);
    expect(writeCount(api)).toBe(0);
  });
  it("reconciles exact lost branch and PR responses without retrying", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.afterWrite = () => {
      throw new Error("lost response");
    };
    await expect(publish(value, api)).rejects.toThrow("Documentation remains pending");
    expect(requestCount(api, "POST", "/pulls")).toBe(1);
    expect(requestCount(api, "POST", "/git/refs")).toBe(1);
  });
  it("reconciles an applied conditional update after a lost response", async () => {
    const value = fixture();
    const api = new FakeGitHub(value);
    api.installActive();
    api.afterWrite = () => {
      throw new Error("lost response");
    };
    await expect(publish(value, api)).rejects.toThrow("Documentation remains pending");
    expect(api.branchRef?.object.sha).toBe(api.commitSha);
    expect(requestCount(api, "POST", "/graphql")).toBe(1);
  });
});

describe("post-merge documentation runner", () => {
  it("enables bind mounts before creating a reviewer sandbox", async () => {
    const input = runnerFixture("review");
    const responses = new Map([["which", "/trusted/bin/openshell-sandbox"]]);
    const tools: OpenShellTools = {
      run: vi.fn((command) => responses.get(command) ?? ""),
      runAsync: vi.fn(() => ({ cancel: vi.fn(), completion: Promise.resolve() })),
      start: vi.fn(),
      wait: async () => undefined,
    };
    await configurePostMergeDocs(input.env, tools);
    const config = fs.readFileSync(
      path.join(input.root, "runner-temp/openshell-gateway/gateway.toml"),
      "utf8",
    );
    expect(config).toContain("enable_bind_mounts = true");
  });

  it("authors from the triggering SHA without exposing host credentials", () => {
    const input = runnerFixture("author");
    const { state, tools } = runnerTools(input);
    executePostMergeDocs(input.env, tools);
    expect(fs.readFileSync(path.join(input.root, "artifact/docs.patch"), "utf8")).toContain(
      "+authored",
    );
    expect(state.createArgs.filter((argument) => argument === "--upload")).toHaveLength(3);
    expect(state.createArgs).not.toContain("--driver-config-json");
    expect(state.agentArgs.join("\n")).not.toContain("GIT_DIR=");
    expect(state.deleted).toBe(true);
  });
  it("records the exact independent approval", () => {
    const input = runnerFixture("review");
    const { state, tools } = runnerTools(input);
    executePostMergeDocs(input.env, tools);
    const driverConfigIndex = state.createArgs.indexOf("--driver-config-json");
    expect(JSON.parse(state.createArgs[driverConfigIndex + 1] as string)).toEqual({
      docker: {
        mounts: [
          {
            read_only: true,
            source: path.join(input.root, "work/repo"),
            target: "/sandbox/repo",
            type: "bind",
          },
          {
            read_only: true,
            source: path.join(input.root, "config"),
            target: "/sandbox/config",
            type: "bind",
          },
        ],
      },
    });
    expect(state.createArgs).not.toContain("--upload");
    expect(state.createArgs.slice(-6)).toEqual([
      "--",
      "/usr/bin/git",
      "--git-dir=/sandbox/repo/.git",
      "--work-tree=/sandbox/repo",
      "status",
      "--short",
    ]);
    expect(state.agentArgs).toEqual(
      expect.arrayContaining(["GIT_DIR=/sandbox/repo/.git", "GIT_WORK_TREE=/sandbox/repo"]),
    );
    expect(fs.statSync(path.join(input.root, "config")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(input.root, "config/task.txt")).mode & 0o777).toBe(0o444);
    expect(
      JSON.parse(fs.readFileSync(path.join(input.root, "artifact/review.json"), "utf8")),
    ).toEqual({
      mainSha: input.env.GITHUB_SHA,
      outcome: "approved",
      patchSha256: createHash("sha256").update("").digest("hex"),
      rangeStartTag,
      repository,
      targetReleaseTag,
      version: 2,
    });
  });
  it("produces and accepts an exact release target above the safe-integer range", async () => {
    const input = runnerFixture("review", "v9007199254740992.0.0");
    const { tools } = runnerTools(input);
    executePostMergeDocs(input.env, tools);
    const approved = path.join(input.root, "artifact");
    const review = JSON.parse(fs.readFileSync(path.join(approved, "review.json"), "utf8"));
    expect(review.targetReleaseTag).toBe("v9007199254740992.0.1");
    const value: Fixture = {
      finalTree: git(input.env.TRUSTED_CHECKOUT, ["rev-parse", `${input.env.GITHUB_SHA}^{tree}`]),
      mainSha: input.env.GITHUB_SHA,
      patch: Buffer.alloc(0),
      source: input.env.TRUSTED_CHECKOUT,
    };
    const api = new FakeGitHub(value);
    await publish(value, api, approved);
    expect(writeCount(api)).toBe(0);
  });
  it("preserves the runner diagnostic for an invalid range tag", () => {
    const input = runnerFixture("review", "v01.2.3");
    const { state, tools } = runnerTools(input);
    expect(() => executePostMergeDocs(input.env, tools)).toThrow(
      "RANGE_START_TAG cannot produce a release target",
    );
    expect(state.deleted).toBe(true);
  });
  it("rejects an independent review denial and deletes the sandbox", () => {
    const input = runnerFixture("review");
    const { state, tools } = runnerTools(input, undefined, "rejected");
    expect(() => executePostMergeDocs(input.env, tools)).toThrow("did not approve");
    expect(fs.readFileSync(path.join(input.root, "artifact/review-report.txt"), "utf8")).toBe(
      "The candidate omits one user-visible change.\n",
    );
    expect(fs.existsSync(path.join(input.root, "artifact/review.json"))).toBe(false);
    expect(state.deleted).toBe(true);
  });
  it("retains an independent review report at the size limit", () => {
    const input = runnerFixture("review");
    const report = "x".repeat(65_536);
    const { state, tools } = runnerTools(input, undefined, "rejected", report);
    expect(() => executePostMergeDocs(input.env, tools)).toThrow("did not approve");
    expect(fs.readFileSync(path.join(input.root, "artifact/review-report.txt"), "utf8")).toBe(
      report,
    );
    expect(state.deleted).toBe(true);
  });
  it("rejects an oversized independent review report and deletes the sandbox", () => {
    const input = runnerFixture("review");
    const { state, tools } = runnerTools(input, undefined, "rejected", "x".repeat(65_537));
    expect(() => executePostMergeDocs(input.env, tools)).toThrow("bounded regular file");
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
  it("attempts named cleanup and reports its failure when sandbox listing fails", () => {
    const input = runnerFixture("author");
    const { run, tools } = runnerTools(input);
    tools.run = vi
      .fn<OpenShellTools["run"]>()
      .mockImplementationOnce(run)
      .mockImplementationOnce(run)
      .mockImplementationOnce(run)
      .mockImplementationOnce(run)
      .mockImplementationOnce(() => {
        throw new Error("list failed");
      })
      .mockImplementationOnce(() => {
        throw new Error("delete failed");
      });
    expect(() => executePostMergeDocs(input.env, tools)).toThrow(
      "Failed to delete OpenShell sandbox docs-author: delete failed; sandbox listing also failed: list failed",
    );
    expect(vi.mocked(tools.run).mock.calls.some(([, args]) => args[1] === "delete")).toBe(true);
  });
  it("preserves the primary failure when named sandbox cleanup also fails", () => {
    const input = runnerFixture("author");
    const { run, tools } = runnerTools(input);
    tools.run = vi
      .fn<OpenShellTools["run"]>()
      .mockImplementationOnce(run)
      .mockImplementationOnce(() => {
        throw new Error("agent failed");
      })
      .mockImplementationOnce(() => {
        throw new Error("list failed");
      })
      .mockImplementationOnce(() => {
        throw new Error("delete failed");
      });
    expect(() => executePostMergeDocs(input.env, tools)).toThrow("agent failed");
    expect(console.error).toHaveBeenCalledWith(
      "Failed to delete OpenShell sandbox docs-author: delete failed; sandbox listing also failed: list failed",
    );
  });
});
