// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const skillRoot = path.join(
  repoRoot,
  ".agents",
  "skills",
  "nemoclaw-contributor-update-dependencies",
);
const collector = path.join(skillRoot, "scripts", "collect-release-ledger.py");
const temporaryDirectories: string[] = [];
const python3 = execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
const gitExecutable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

type Ledger = {
  publicationSource?: {
    apiHost: string;
    draftVisibility: string;
    fullName: string;
    provider: string;
    requestedName: string;
    repositoryId: number;
    url: string;
    verifiedAt: string;
    viewerCanPush: boolean | null;
    visibility: string;
  };
  requiredFixes: Array<{ ref: string; sha: string }>;
  remoteTagInventory?: {
    count: number;
    verifiedAt: string;
    tags: Array<{
      commitSha: string;
      ref: string;
      rootObjectType: string;
      tagObjectShas: string[];
    }>;
  };
  schemaVersion: number;
  releaseEndpoints: Array<{
    publication?: {
      draftVisibility?: string;
      immutable?: boolean;
      state: string;
      tag: string | null;
    };
    ref: string;
    remoteRef?: { commitSha: string; ref: string; repositoryId: number };
    remoteTag?: {
      commitSha: string;
      ref: string;
      rootObjectType: string;
      tagObjectShas: string[];
    };
    sha: string;
    tag: string | null;
    tagKind: "annotated" | "lightweight" | null;
    version: string | null;
  }>;
  ranges: Array<{
    from: { ref: string };
    to: { ref: string };
    commitCount: number;
    changedPaths: Array<{ path: string; previousPath?: string; status: string }>;
  }>;
  target: {
    kind: "commit" | "tag";
    remoteRef?: { commitSha: string; ref: string; repositoryId: number };
    remoteTag?: { commitSha: string; ref: string };
    requestedRef: string;
    sha: string;
    tag: string | null;
    version: string | null;
  };
};

type GitEvidence = {
  repo: string;
  tags: Record<string, { commitSha: string; objectSha: string; objectType: "commit" | "tag" }>;
  targetSha: string;
};

type FakeResponse = {
  delayMs?: number;
  exitCode?: number;
  json?: unknown;
  jsonSequence?: unknown[];
  rawStdout?: string;
  stderr?: string;
};

type FakeGitHubOptions = {
  additionalRemoteTags?: GitEvidence["tags"];
  apiHost?: string;
  fullName?: string;
  invocationLog?: string;
  permissionsPush?: boolean | null;
  releasePages?: unknown;
  repositoryPayload?: unknown;
  responseOverrides?: Record<string, FakeResponse>;
};

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function commit(repo: string, filename: string, contents: string, subject: string): string {
  fs.writeFileSync(path.join(repo, filename), contents);
  git(repo, "add", "--all");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-m", subject);
  return git(repo, "rev-parse", "HEAD");
}

function createTaggedRepository(): { repo: string; targetSha: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-release-ledger-"));
  temporaryDirectories.push(repo);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Dependency Test");
  git(repo, "config", "user.email", "dependency-test@example.com");

  commit(repo, "contract.txt", "one\n", "initial contract");
  git(repo, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
  commit(repo, "contract.txt", "release candidate\n", "prepare release candidate");
  git(repo, "tag", "v1.0.1-rc.1");
  commit(repo, "contract.txt", "stable\n", "stabilize contract");
  git(repo, "tag", "v1.0.1");
  git(repo, "mv", "contract.txt", "renamed-contract.txt");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "rename contract file");
  git(repo, "tag", "-a", "v1.0.2", "-m", "v1.0.2");
  const targetSha = commit(repo, "candidate.txt", "candidate\n", "unreleased candidate");
  return { repo, targetSha };
}

function readGitEvidence(repo: string, targetSha: string): GitEvidence {
  const tags: GitEvidence["tags"] = {};
  for (const tag of git(repo, "tag").split("\n").filter(Boolean)) {
    const objectType = git(repo, "cat-file", "-t", `refs/tags/${tag}`) as "commit" | "tag";
    tags[tag] = {
      commitSha: git(repo, "rev-parse", `refs/tags/${tag}^{commit}`),
      objectSha: git(repo, "rev-parse", `refs/tags/${tag}`),
      objectType,
    };
  }
  return {
    repo,
    tags,
    targetSha,
  };
}

function githubRelease(
  tag: string,
  id: number,
  options: {
    apiHost?: string;
    draft?: boolean;
    fullName?: string;
    immutable?: boolean;
    prerelease?: boolean;
    publishedAt?: string | null;
  } = {},
): Record<string, unknown> {
  const draft = options.draft ?? false;
  const apiHost = options.apiHost ?? "github.com";
  const fullName = options.fullName ?? "Acme/Dependency";
  return {
    draft,
    html_url: `https://${apiHost}/${fullName}/releases/tag/${tag}`,
    id,
    immutable: options.immutable ?? false,
    name: tag,
    prerelease: options.prerelease ?? false,
    published_at:
      options.publishedAt === undefined
        ? draft
          ? null
          : "2026-01-01T00:00:00Z"
        : options.publishedAt,
    tag_name: tag,
    target_commitish: "main",
  };
}

function fakeGitHubEnvironment(
  evidence: GitEvidence,
  options: FakeGitHubOptions = {},
): NodeJS.ProcessEnv {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-release-gh-"));
  temporaryDirectories.push(bin);
  const apiHost = options.apiHost ?? "github.com";
  const fullName = options.fullName ?? "Acme/Dependency";
  const requestedName = "acme/dependency";
  const remoteTags = { ...evidence.tags, ...options.additionalRemoteTags };
  const responses: Record<string, FakeResponse> = {};
  responses[`repos/${requestedName}`] = {
    json:
      options.repositoryPayload ??
      ({
        full_name: fullName,
        html_url: `https://${apiHost}/${fullName}`,
        id: 42,
        node_id: "R_kg_dependency",
        permissions:
          options.permissionsPush === null ? undefined : { push: options.permissionsPush ?? true },
        visibility: "public",
      } satisfies Record<string, unknown>),
  };
  responses[`repos/${fullName}/releases?per_page=100`] = {
    json: options.releasePages ?? [
      [
        githubRelease("v1.0.0", 100, { apiHost, fullName, immutable: true }),
        githubRelease("v1.0.1", 101, { apiHost, draft: true, fullName }),
      ],
    ],
  };
  responses[`repos/${fullName}/git/matching-refs/tags/?per_page=100`] = {
    json: [
      Object.entries(remoteTags).map(([tag, identity]) => ({
        object: { sha: identity.objectSha, type: identity.objectType },
        ref: `refs/tags/${tag}`,
      })),
    ],
  };
  for (const [tag, identity] of Object.entries(remoteTags).filter(
    ([, entry]) => entry.objectType === "tag",
  )) {
    responses[`repos/${fullName}/git/tags/${identity.objectSha}`] = {
      json: {
        object: { sha: identity.commitSha, type: "commit" },
        sha: identity.objectSha,
        tag,
      },
    };
  }
  responses[`repos/${fullName}/git/ref/heads/main`] = {
    json: {
      object: { sha: evidence.targetSha, type: "commit" },
      ref: "refs/heads/main",
    },
  };
  Object.assign(responses, options.responseOverrides ?? {});

  const gh = path.join(bin, "gh");
  const invocationLog = options.invocationLog ?? path.join(bin, "invocations.jsonl");
  fs.writeFileSync(
    gh,
    `#!${process.execPath}
const fs = require("node:fs");
const responses = ${JSON.stringify(responses)};
const args = process.argv.slice(2);
const endpoint = args.find((argument) => argument.startsWith("repos/"));
let priorEndpointCalls = 0;
if (fs.existsSync(${JSON.stringify(invocationLog)})) {
  priorEndpointCalls = fs.readFileSync(${JSON.stringify(invocationLog)}, "utf8")
    .trim().split("\\n").filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((invocation) => invocation.includes(endpoint)).length;
}
fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(args) + "\\n");
const response = responses[endpoint];
if (!response) {
  process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
  process.exit(2);
}
if (response.delayMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, response.delayMs);
}
if (response.stderr) process.stderr.write(response.stderr);
const json = response.jsonSequence
  ? response.jsonSequence[Math.min(priorEndpointCalls, response.jsonSequence.length - 1)]
  : response.json;
if (response.rawStdout !== undefined) process.stdout.write(response.rawStdout);
else if (json !== undefined) process.stdout.write(JSON.stringify(json) + "\\n");
process.exit(response.exitCode ?? 0);
`,
    { mode: 0o755 },
  );
  fs.chmodSync(gh, 0o755);
  return {
    ...process.env,
    DEPENDENCY_TEST_GH_INVOCATIONS: invocationLog,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

function environmentWithoutGh(): NodeJS.ProcessEnv {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-release-no-gh-"));
  temporaryDirectories.push(bin);
  fs.symlinkSync(gitExecutable, path.join(bin, "git"));
  return { ...process.env, PATH: bin };
}

function runCollector(
  repo: string,
  from: string,
  to: string,
  extraArgs: string[] = [],
  env?: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync(python3, [collector, "--repo", repo, "--from", from, "--to", to, ...extraArgs], {
    encoding: "utf8",
    env: env ?? process.env,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("dependency upgrade skill policy", () => {
  it("requires source-first adjacent-release migration evidence", () => {
    const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    const guide = fs.readFileSync(
      path.join(repoRoot, ".agents", "skills", "nemoclaw-skills-guide", "SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("never collapse the result into one aggregate");
    expect(skill).toContain("Release notes are leads, not proof");
    expect(skill).toContain("Existing green tests only prove what they cover");
    expect(skill).toContain("Inspect test selectors, version gates, conditional skips");
    expect(skill).toContain("Treat matrix flags, environment toggles, and workflow labels");
    expect(skill).toContain("A protocol identity must bind the behavior that interprets it");
    expect(skill).toContain("old sandbox and helper, new host runtime");
    expect(skill).toContain("Compare the intended matrix with the observed test IDs and count");
    expect(skill).toContain("never silently audit a stale checkout");
    expect(skill).toContain("Separate required-fix, upstream target/producer");
    expect(skill).toContain("--github-target-ref");
    expect(skill).toContain("raw commit-object lookup is");
    expect(skill).toContain("inventories and peels every remote semantic-version tag");
    expect(skill).toContain("Shallow history, replace refs, grafts");
    expect(skill).toContain("Reject partial/promisor clones before resolving refs");
    expect(skill).toContain("missing tag is `not-published`");
    expect(skill).toContain("Do not compare");
    expect(skill).toMatch(/unrelated upstream and downstream SHAs as if they should be equal/u);
    expect(skill).toContain("An unresolved high-impact concern blocks the version bump");
    expect(skill).toContain("This skill authorizes changes only in NVIDIA/NemoClaw");
    expect(skill).toMatch(/Do not open upstream\s+pull requests or issues/);
    expect(skill).toContain("references/contract-audit.md");
    expect(skill).toContain("scripts/collect-release-ledger.py");
    expect(guide).toContain("`nemoclaw-contributor-update-dependencies`");
  });

  it("requires resolved supply-chain, cache-key, and observed-target evidence", () => {
    const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    const contractAudit = fs.readFileSync(
      path.join(skillRoot, "references", "contract-audit.md"),
      "utf8",
    );

    expect(skill).toContain("Diff resolved dependency graphs, not only top-level manifests");
    expect(skill).toContain("lockfile checksum");
    expect(skill).toContain("Missing notice, SBOM, advisory, or provenance coverage");
    expect(skill).toContain("complete resolved lockfile closure with every shipped notice");
    expect(skill).toContain("UID/GID, user and group names");
    expect(skill).toContain("does not protect same-version configuration changes");
    expect(skill).toContain("machine-readable expected-versus-observed manifest");
    expect(skill).toContain("reject missing, duplicate, skipped, or stale results");
    expect(skill).toContain("Extracting one binary narrows the");
    expect(skill).toContain("does not erase unaudited content in the distributed artifact");
    expect(skill).toContain("mutable bases, unpinned package resolution");
    expect(skill).toContain("build provenance as unresolved reproducibility inputs");
    expect(skill).toContain("recursively resolve every CI job container and builder image");
    expect(skill).toContain("incomplete resolved dependencies is identity evidence");
    expect(skill).toContain("A CLI version is not the identity of a sibling daemon");
    expect(skill).toContain("same-version content replacement and mixed-component installs");
    expect(skill).toContain("base-image `Config.Env`, every Dockerfile stage");
    expect(skill).toContain("before that execution");
    expect(skill).toMatch(/safe\s+create-inspect-start runtime/u);
    expect(skill).toMatch(/create and start are atomic or create itself runs code/u);
    expect(skill).toMatch(/an inherited `SHELL` or\s+executable/u);
    expect(skill).toContain("never let trusted input self-attest");
    expect(skill).toContain("separate expected-versus-observed manifests");
    expect(skill).toContain("every helper or sidecar");
    expect(skill).toContain("`Config.Healthcheck`, `Config.Volumes`");
    expect(skill).toContain("engine-scheduled healthcheck, hook, and auxiliary exec");
    expect(skill).toContain("normalized-path-overlapping destinations");
    expect(skill).toContain("inherited healthchecks, image-declared and overlapping volumes");
    expect(skill).toMatch(/Never identify a workload as merely the first or sole\s+child/u);
    expect(skill).toMatch(/driver-owned token, TLS path, identity, or\s+endpoint/u);
    expect(skill).toMatch(/rather than reusing the\s+pre-merge expectation/u);
    expect(skill).toContain("poisoned-base and multi-stage fixtures");
    expect(skill).toContain("Text scanning");
    expect(skill).toContain("attempted transition, not its own");
    expect(skill).toContain("stopped, skipped, unknown");
    expect(skill).toContain(
      "When upstream marks a security, cleanup, or observability operation optional",
    );
    expect(skill).toContain("producer repository, workflow path, event, status, conclusion");
    expect(skill).toContain("before running code from the proposed change");
    expect(skill).toMatch(/prevent checked-out code\s+from poisoning `PATH`/u);
    expect(skill).toContain("Artifact metadata alone is insufficient");
    expect(contractAudit).toContain("| Configuration provenance |");
    expect(contractAudit).toContain("| Persisted state and caches |");
    expect(contractAudit).toContain("| Component selection and identity |");
    expect(contractAudit).toContain("| Dependency graph |");
    expect(contractAudit).toContain("| Build and image content |");
    expect(contractAudit).toContain("| Evidence pipeline |");
    expect(contractAudit).toContain("engine state before first execution");
    expect(contractAudit).toContain("engine-materialized `Config.Healthcheck`");
    expect(contractAudit).toContain("compare `Config.Volumes` with realized mount destinations");
    expect(contractAudit).toContain("Raw object lookup does not prove upstream-ref membership");
    expect(contractAudit).toContain("upstream required-fix SHAs");
  });
});

describe("dependency release ledger collector", () => {
  it("emits every adjacent stable range with Git evidence", () => {
    const { repo, targetSha } = createTaggedRepository();
    const result = runCollector(repo, "v1.0.0", targetSha);

    expect(result.status, result.stderr).toBe(0);
    const ledger = JSON.parse(result.stdout) as Ledger;
    expect(
      ledger.releaseEndpoints.map(({ ref, tagKind, version }) => ({ ref, tagKind, version })),
    ).toEqual([
      { ref: "v1.0.0", tagKind: "annotated", version: "1.0.0" },
      { ref: "v1.0.1", tagKind: "lightweight", version: "1.0.1" },
      { ref: "v1.0.2", tagKind: "annotated", version: "1.0.2" },
      { ref: targetSha, tagKind: null, version: null },
    ]);
    expect(
      ledger.ranges.map(({ from, to, commitCount }) => [from.ref, to.ref, commitCount]),
    ).toEqual([
      ["v1.0.0", "v1.0.1", 2],
      ["v1.0.1", "v1.0.2", 1],
      ["v1.0.2", targetSha, 1],
    ]);
    expect(ledger.ranges[1]?.changedPaths).toContainEqual({
      path: "renamed-contract.txt",
      previousPath: "contract.txt",
      status: "R100",
    });
    expect(ledger.schemaVersion).toBe(5);
    expect(ledger.target).toMatchObject({
      kind: "commit",
      requestedRef: targetSha,
      sha: targetSha,
      tag: null,
      version: null,
    });
  });

  it("binds canonical GitHub identity, peeled tags, releases, and the audit target", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    const result = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      [
        "--required-fix",
        "v1.0.1",
        "--github-repository",
        "acme/dependency",
        "--github-target-ref",
        "refs/heads/main",
      ],
      fakeGitHubEnvironment(evidence),
    );

    expect(result.status, result.stderr).toBe(0);
    const ledger = JSON.parse(result.stdout) as Ledger;
    expect(
      ledger.releaseEndpoints.map((endpoint) => [
        endpoint.ref,
        endpoint.tag,
        endpoint.publication?.state,
      ]),
    ).toEqual([
      ["v1.0.0", "v1.0.0", "published"],
      ["v1.0.1", "v1.0.1", "draft"],
      ["v1.0.2", "v1.0.2", "absent"],
      [targetSha, null, "unreleased-commit"],
    ]);
    expect(ledger.publicationSource).toEqual({
      apiHost: "github.com",
      collectedAt: expect.any(String),
      draftVisibility: "full",
      fullName: "Acme/Dependency",
      nodeId: "R_kg_dependency",
      provider: "github",
      requestedName: "acme/dependency",
      repositoryId: 42,
      url: "https://github.com/Acme/Dependency",
      verifiedAt: expect.any(String),
      viewerCanPush: true,
      visibility: "public",
    });
    expect(ledger.releaseEndpoints[0]?.remoteTag).toMatchObject({
      commitSha: evidence.tags["v1.0.0"]?.commitSha,
      rootObjectType: "tag",
      tagObjectShas: [evidence.tags["v1.0.0"]?.objectSha],
    });
    expect(ledger.releaseEndpoints[1]?.remoteTag).toMatchObject({
      commitSha: evidence.tags["v1.0.1"]?.commitSha,
      rootObjectType: "commit",
      tagObjectShas: [],
    });
    expect(ledger.remoteTagInventory).toMatchObject({
      count: 4,
      tags: expect.arrayContaining([
        expect.objectContaining({
          ref: "refs/tags/v1.0.0",
          rootObjectType: "tag",
          tagObjectShas: [evidence.tags["v1.0.0"]?.objectSha],
        }),
        expect.objectContaining({
          ref: "refs/tags/v1.0.1",
          rootObjectType: "commit",
          tagObjectShas: [],
        }),
      ]),
    });
    expect(ledger.target).toMatchObject({
      kind: "commit",
      requestedRef: targetSha,
      remoteRef: {
        commitSha: targetSha,
        ref: "refs/heads/main",
        repositoryId: 42,
      },
      sha: targetSha,
    });
    expect(ledger.requiredFixes).toEqual([
      {
        ref: "v1.0.1",
        sha: evidence.tags["v1.0.1"]?.commitSha,
      },
    ]);
  });

  it("rejects a fork-only object unless the advertised upstream target ref matches", () => {
    const { repo, targetSha: upstreamTargetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, upstreamTargetSha);
    git(repo, "switch", "--create", "external-fork");
    const forkOnlySha = commit(repo, "fork-only.txt", "fork\n", "fork-only target");
    git(repo, "switch", "main");

    const result = runCollector(
      repo,
      "v1.0.0",
      forkOnlySha,
      ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main"],
      fakeGitHubEnvironment(evidence),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("target ref 'refs/heads/main' resolves to");
    expect(result.stderr).toContain(upstreamTargetSha);
    expect(result.stderr).toContain(forkOnlySha);
  });

  it("rejects an in-range remote semantic-version tag missing from the local checkout", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    const result = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main"],
      fakeGitHubEnvironment(evidence, {
        additionalRemoteTags: {
          "v1.0.3": {
            commitSha: targetSha,
            objectSha: targetSha,
            objectType: "commit",
          },
        },
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("remote semantic-version tag 'v1.0.3'");
    expect(result.stderr).toContain("missing from the local checkout");
  });

  it("ignores absent remote tag commits outside the proven target closure", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    const missingSha = "a".repeat(40);
    const result = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main"],
      fakeGitHubEnvironment(evidence, {
        additionalRemoteTags: {
          "v9.9.9": {
            commitSha: missingSha,
            objectSha: missingSha,
            objectType: "commit",
          },
        },
      }),
    );
    expect(result.status, result.stderr).toBe(0);
    expect((JSON.parse(result.stdout) as Ledger).remoteTagInventory?.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ commitSha: missingSha, ref: "refs/tags/v9.9.9" }),
      ]),
    );
  });

  it("rejects an in-range local semantic-version tag absent from the remote inventory", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    git(repo, "tag", "v1.0.1-local.1", "v1.0.1");
    const result = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main"],
      fakeGitHubEnvironment(evidence),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("local semantic-version tag 'v1.0.1-local.1'");
    expect(result.stderr).toContain("absent from the bound GitHub repository");
  });

  it("rejects a redirected or renamed canonical repository identity", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    const result = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main"],
      fakeGitHubEnvironment(evidence, { fullName: "Renamed/Dependency" }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("canonical repository 'Renamed/Dependency' differs");
    expect(result.stderr).toContain("rerun with the canonical");
  });

  it("requires an advertised branch ref for an untagged GitHub target", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    const result = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      ["--github-repository", "acme/dependency"],
      fakeGitHubEnvironment(evidence),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires --github-target-ref");
  });

  it("does not claim an unlisted release is absent without draft visibility", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    const result = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main"],
      fakeGitHubEnvironment(evidence, {
        permissionsPush: false,
        releasePages: [[githubRelease("v1.0.0", 100)]],
      }),
    );

    expect(result.status, result.stderr).toBe(0);
    const ledger = JSON.parse(result.stdout) as Ledger;
    expect(ledger.publicationSource?.draftVisibility).toBe("published-only");
    expect(
      ledger.releaseEndpoints
        .slice(0, 3)
        .map((endpoint) => [endpoint.publication?.state, endpoint.publication?.draftVisibility]),
    ).toEqual([
      ["published", undefined],
      ["not-published", "published-only"],
      ["not-published", "published-only"],
    ]);
  });

  it("distinguishes unknown draft visibility from proven full visibility", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    const releasePages = [[githubRelease("v1.0.0", 100)]];
    const args = [
      "--github-repository",
      "acme/dependency",
      "--github-target-ref",
      "refs/heads/main",
    ];
    const unknown = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      args,
      fakeGitHubEnvironment(evidence, { permissionsPush: null, releasePages }),
    );
    const full = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      args,
      fakeGitHubEnvironment(evidence, { permissionsPush: true, releasePages }),
    );

    expect(unknown.status, unknown.stderr).toBe(0);
    expect(full.status, full.stderr).toBe(0);
    const unknownLedger = JSON.parse(unknown.stdout) as Ledger;
    const fullLedger = JSON.parse(full.stdout) as Ledger;
    expect(unknownLedger.publicationSource).toMatchObject({
      draftVisibility: "unknown",
      viewerCanPush: null,
    });
    expect(
      unknownLedger.releaseEndpoints.slice(1, 3).map((endpoint) => endpoint.publication?.state),
    ).toEqual(["not-published", "not-published"]);
    expect(fullLedger.publicationSource).toMatchObject({
      draftVisibility: "full",
      viewerCanPush: true,
    });
    expect(
      fullLedger.releaseEndpoints.slice(1, 3).map((endpoint) => endpoint.publication?.state),
    ).toEqual(["absent", "absent"]);
  });

  it("records prereleases from every release-list page", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    const result = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      [
        "--include-prereleases",
        "--github-repository",
        "acme/dependency",
        "--github-target-ref",
        "refs/heads/main",
      ],
      fakeGitHubEnvironment(evidence, {
        releasePages: [
          [githubRelease("v1.0.0", 100, { immutable: true })],
          [
            githubRelease("v1.0.1-rc.1", 101, {
              prerelease: true,
              publishedAt: "2026-01-02T00:00:00+00:00",
            }),
          ],
        ],
      }),
    );

    expect(result.status, result.stderr).toBe(0);
    const ledger = JSON.parse(result.stdout) as Ledger;
    expect(
      ledger.releaseEndpoints.find((endpoint) => endpoint.tag === "v1.0.1-rc.1")?.publication,
    ).toMatchObject({
      immutable: false,
      publishedAt: "2026-01-02T00:00:00+00:00",
      state: "prerelease",
      tag: "v1.0.1-rc.1",
    });
  });

  it("fails when a remote tag does not peel to the local endpoint commit", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    const result = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main"],
      fakeGitHubEnvironment(evidence, {
        responseOverrides: {
          [`repos/Acme/Dependency/git/tags/${evidence.tags["v1.0.0"]?.objectSha}`]: {
            json: {
              object: { sha: targetSha, type: "commit" },
              sha: evidence.tags["v1.0.0"]?.objectSha,
              tag: "v1.0.0",
            },
          },
        },
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not local");

    const tagKindMismatch = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main"],
      fakeGitHubEnvironment(evidence, {
        additionalRemoteTags: {
          "v1.0.1": {
            commitSha: targetSha,
            objectSha: targetSha,
            objectType: "commit",
          },
        },
      }),
    );
    expect(tagKindMismatch.status).toBe(1);
    expect(tagKindMismatch.stderr).toContain("root object differs");
  });

  it("rejects malformed or internally inconsistent remote tag inventories", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    const inventoryEndpoint = "repos/Acme/Dependency/git/matching-refs/tags/?per_page=100";
    const annotatedObject = evidence.tags["v1.0.0"]!;
    const validEntry = {
      object: { sha: annotatedObject.objectSha, type: annotatedObject.objectType },
      ref: "refs/tags/v1.0.0",
    };
    const cases: Array<{ expected: string; options: FakeGitHubOptions }> = [
      {
        expected: "tag-ref inventory had the wrong shape",
        options: { responseOverrides: { [inventoryEndpoint]: { json: {} } } },
      },
      {
        expected: "returned non-tag ref",
        options: {
          responseOverrides: {
            [inventoryEndpoint]: {
              json: [[{ object: { sha: targetSha, type: "commit" }, ref: "refs/heads/main" }]],
            },
          },
        },
      },
      {
        expected: "returned duplicate tag 'v1.0.0'",
        options: {
          responseOverrides: { [inventoryEndpoint]: { json: [[validEntry, validEntry]] } },
        },
      },
      {
        expected: "unsupported object type 'tree'",
        options: {
          responseOverrides: {
            [inventoryEndpoint]: {
              json: [
                [
                  {
                    object: { sha: annotatedObject.objectSha, type: "tree" },
                    ref: "refs/tags/v1.0.0",
                  },
                ],
              ],
            },
          },
        },
      },
      {
        expected: "returned the wrong object",
        options: {
          responseOverrides: {
            [`repos/Acme/Dependency/git/tags/${annotatedObject.objectSha}`]: {
              json: {
                object: { sha: annotatedObject.commitSha, type: "commit" },
                sha: targetSha,
                tag: "v1.0.0",
              },
            },
          },
        },
      },
    ];

    for (const testCase of cases) {
      const result = runCollector(
        repo,
        "v1.0.0",
        targetSha,
        ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main"],
        fakeGitHubEnvironment(evidence, testCase.options),
      );
      expect(result.status, testCase.expected).toBe(1);
      expect(result.stderr).toContain(testCase.expected);
    }
  }, 45_000);

  it("binds github.com explicitly instead of inheriting GH_HOST", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    const invocationLog = path.join(repo, "gh-invocations.jsonl");
    const apiHost = "github.com";
    const result = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      [
        "--github-repository",
        "acme/dependency",
        "--github-host",
        apiHost,
        "--github-target-ref",
        "refs/heads/main",
      ],
      {
        ...fakeGitHubEnvironment(evidence, { apiHost, invocationLog }),
        GH_HOST: "attacker.invalid",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const ledger = JSON.parse(result.stdout) as Ledger;
    expect(ledger.publicationSource?.apiHost).toBe(apiHost);
    const invocations = fs
      .readFileSync(invocationLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation).toEqual(expect.arrayContaining(["--hostname", apiHost]));
      expect(invocation).toEqual(expect.arrayContaining(["--method", "GET"]));
      expect(invocation).not.toContain("attacker.invalid");
    }
    expect(invocations[0]).toContain("repos/acme/dependency");
    for (const invocation of invocations.slice(1)) {
      expect(invocation.find((argument) => argument.startsWith("repos/"))).toMatch(
        /^(?:repos\/acme\/dependency|repos\/Acme\/Dependency\/)/u,
      );
    }
    const paginatedInvocations = invocations.filter((invocation) =>
      invocation.some(
        (argument) =>
          argument.includes("/git/matching-refs/tags/") || argument.includes("/releases?"),
      ),
    );
    expect(paginatedInvocations).toHaveLength(4);
    for (const invocation of paginatedInvocations) {
      expect(invocation).toEqual(expect.arrayContaining(["--paginate", "--slurp"]));
    }
  });

  it("fails when any remote identity changes during collection", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    const fullName = "Acme/Dependency";
    const repositoryEndpoint = "repos/acme/dependency";
    const inventoryEndpoint = `repos/${fullName}/git/matching-refs/tags/?per_page=100`;
    const releaseEndpoint = `repos/${fullName}/releases?per_page=100`;
    const targetEndpoint = `repos/${fullName}/git/ref/heads/main`;
    const repositoryPayload = {
      full_name: fullName,
      html_url: `https://github.com/${fullName}`,
      id: 42,
      node_id: "R_kg_dependency",
      permissions: { push: true },
      visibility: "public",
    };
    const refs = Object.entries(evidence.tags).map(([tag, identity]) => ({
      object: { sha: identity.objectSha, type: identity.objectType },
      ref: `refs/tags/${tag}`,
    }));
    const releases = [
      githubRelease("v1.0.0", 100, { immutable: true }),
      githubRelease("v1.0.1", 101, { draft: true }),
    ];
    const cases: Array<{ expected: string; overrides: Record<string, FakeResponse> }> = [
      {
        expected: "semantic-version tag refs changed",
        overrides: {
          [inventoryEndpoint]: {
            jsonSequence: [
              [refs],
              [[...refs, { object: { sha: targetSha, type: "commit" }, ref: "refs/tags/v1.0.3" }]],
            ],
          },
        },
      },
      {
        expected: "release publications changed",
        overrides: {
          [releaseEndpoint]: {
            jsonSequence: [[releases], [[...releases, githubRelease("v1.0.2", 102)]]],
          },
        },
      },
      {
        expected: "not audit target",
        overrides: {
          [targetEndpoint]: {
            jsonSequence: [
              { object: { sha: targetSha, type: "commit" }, ref: "refs/heads/main" },
              {
                object: { sha: evidence.tags["v1.0.2"]?.commitSha, type: "commit" },
                ref: "refs/heads/main",
              },
            ],
          },
        },
      },
      {
        expected: "repository identity or permissions changed",
        overrides: {
          [repositoryEndpoint]: {
            jsonSequence: [repositoryPayload, { ...repositoryPayload, id: 43 }],
          },
        },
      },
    ];

    for (const testCase of cases) {
      const result = runCollector(
        repo,
        "v1.0.0",
        targetSha,
        ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main"],
        fakeGitHubEnvironment(evidence, { responseOverrides: testCase.overrides }),
      );
      expect(result.status, testCase.expected).toBe(1);
      expect(result.stderr).toContain(testCase.expected);
    }
  }, 60_000);

  it("fails closed for API errors, missing gh, and timeouts", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    const apiFailure = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main"],
      fakeGitHubEnvironment(evidence, {
        responseOverrides: {
          "repos/acme/dependency": {
            exitCode: 1,
            stderr: "gh: Resource not accessible (HTTP 403)\n",
          },
        },
      }),
    );
    const missingGh = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main"],
      environmentWithoutGh(),
    );
    const repositoryNotFound = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main"],
      fakeGitHubEnvironment(evidence, {
        responseOverrides: {
          "repos/acme/dependency": {
            exitCode: 1,
            stderr: "gh: Not Found (HTTP 404)\n",
          },
        },
      }),
    );
    const timedOut = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      [
        "--github-repository",
        "acme/dependency",
        "--github-timeout-seconds",
        "1",
        "--github-target-ref",
        "refs/heads/main",
      ],
      fakeGitHubEnvironment(evidence, {
        responseOverrides: { "repos/acme/dependency": { delayMs: 1500, json: {} } },
      }),
    );

    expect(apiFailure.status).toBe(1);
    expect(apiFailure.stderr).toContain("HTTP 403");
    expect(missingGh.status).toBe(1);
    expect(missingGh.stderr).toContain("could not execute gh");
    expect(repositoryNotFound.status).toBe(1);
    expect(repositoryNotFound.stderr).toContain("HTTP 404");
    expect(timedOut.status).toBe(1);
    expect(timedOut.stderr).toContain("timed out after 1 seconds");
  });

  it("rejects malformed repository and release payloads", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    const releaseEndpoint = "repos/Acme/Dependency/releases?per_page=100";
    const cases: Array<{ expected: string; options: FakeGitHubOptions }> = [
      {
        expected: "malformed JSON",
        options: {
          responseOverrides: { [releaseEndpoint]: { rawStdout: "{" } },
        },
      },
      { expected: "wrong shape", options: { releasePages: {} } },
      {
        expected: "immutable",
        options: {
          releasePages: [[{ ...githubRelease("v1.0.0", 100), immutable: undefined }]],
        },
      },
      {
        expected: "draft",
        options: {
          releasePages: [[{ ...githubRelease("v1.0.0", 100), draft: 0 }]],
        },
      },
      {
        expected: "tag_name",
        options: {
          releasePages: [[{ ...githubRelease("v1.0.0", 100), tag_name: 100 }]],
        },
      },
      {
        expected: "published_at",
        options: {
          releasePages: [[githubRelease("v1.0.0", 100, { publishedAt: null })]],
        },
      },
      {
        expected: "RFC3339",
        options: {
          releasePages: [[githubRelease("v1.0.0", 100, { publishedAt: "2026-01-01 00:00:00" })]],
        },
      },
      {
        expected: "outside",
        options: {
          releasePages: [
            [
              {
                ...githubRelease("v1.0.0", 100),
                html_url: "https://attacker.invalid/Acme/Dependency/releases/tag/v1.0.0",
              },
            ],
          ],
        },
      },
      {
        expected: "duplicate tag",
        options: {
          releasePages: [[githubRelease("v1.0.0", 100)], [githubRelease("v1.0.0", 101)]],
        },
      },
      {
        expected: "wrong repository",
        options: {
          repositoryPayload: {
            full_name: "Acme/Dependency",
            html_url: "https://github.com/Wrong/Repository",
            id: 42,
            node_id: "R_kg_dependency",
            permissions: { push: true },
            visibility: "public",
          },
        },
      },
      {
        expected: "positive integer",
        options: {
          repositoryPayload: {
            full_name: "Acme/Dependency",
            html_url: "https://github.com/Acme/Dependency",
            id: true,
            node_id: "R_kg_dependency",
            permissions: { push: true },
            visibility: "public",
          },
        },
      },
    ];

    for (const testCase of cases) {
      const result = runCollector(
        repo,
        "v1.0.0",
        targetSha,
        ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main"],
        fakeGitHubEnvironment(evidence, testCase.options),
      );
      expect(result.status, testCase.expected).toBe(1);
      expect(result.stderr).toContain(testCase.expected);
    }
  }, 60_000);

  it("rejects draft visibility contradictions", () => {
    const { repo, targetSha } = createTaggedRepository();
    const evidence = readGitEvidence(repo, targetSha);
    const result = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main"],
      fakeGitHubEnvironment(evidence, { permissionsPush: false }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("permissions.push=false");
  });

  it("includes prereleases only when requested and preserves semantic ordering", () => {
    const { repo, targetSha } = createTaggedRepository();
    const withoutPrereleases = runCollector(repo, "v1.0.0", targetSha);
    const withPrereleases = runCollector(repo, "v1.0.0", targetSha, ["--include-prereleases"]);

    expect(withoutPrereleases.status, withoutPrereleases.stderr).toBe(0);
    expect(withPrereleases.status, withPrereleases.stderr).toBe(0);
    expect(
      (JSON.parse(withoutPrereleases.stdout) as Ledger).releaseEndpoints.map(({ ref }) => ref),
    ).not.toContain("v1.0.1-rc.1");
    expect(
      (JSON.parse(withPrereleases.stdout) as Ledger).releaseEndpoints.map(({ ref }) => ref),
    ).toEqual(["v1.0.0", "v1.0.1-rc.1", "v1.0.1", "v1.0.2", targetSha]);
  });

  it("preserves an explicitly targeted prerelease identity without widening the ledger", () => {
    const { repo } = createTaggedRepository();
    const result = runCollector(repo, "v1.0.0", "refs/tags/v1.0.1-rc.1");

    expect(result.status, result.stderr).toBe(0);
    const ledger = JSON.parse(result.stdout) as Ledger;
    expect(
      ledger.releaseEndpoints.map(({ ref, tagKind, version }) => ({ ref, tagKind, version })),
    ).toEqual([
      { ref: "v1.0.0", tagKind: "annotated", version: "1.0.0" },
      { ref: "v1.0.1-rc.1", tagKind: "lightweight", version: "1.0.1-rc.1" },
    ]);
    expect(ledger.ranges).toHaveLength(1);
    expect(ledger.ranges[0]?.to.ref).toBe("v1.0.1-rc.1");
  });

  it("preserves SemVer build metadata as part of the release identity", () => {
    const { repo, targetSha } = createTaggedRepository();
    git(repo, "tag", "v1.0.3+build.7", targetSha);
    const result = runCollector(repo, "v1.0.0", "refs/tags/v1.0.3+build.7");

    expect(result.status, result.stderr).toBe(0);
    const ledger = JSON.parse(result.stdout) as Ledger;
    expect(ledger.releaseEndpoints.at(-1)).toMatchObject({
      ref: "v1.0.3+build.7",
      sha: targetSha,
      version: "1.0.3+build.7",
    });
    expect(ledger.target).toEqual({
      kind: "tag",
      requestedRef: "refs/tags/v1.0.3+build.7",
      sha: targetSha,
      tag: "v1.0.3+build.7",
      version: "1.0.3+build.7",
    });
  });

  it("preserves build-metadata tag identities from the remote inventory", () => {
    const { repo, targetSha } = createTaggedRepository();
    git(repo, "tag", "v1.0.3+build.7", targetSha);
    const evidence = readGitEvidence(repo, targetSha);
    const result = runCollector(
      repo,
      "v1.0.0",
      "refs/tags/v1.0.3+build.7",
      ["--github-repository", "acme/dependency"],
      fakeGitHubEnvironment(evidence),
    );

    expect(result.status, result.stderr).toBe(0);
    const ledger = JSON.parse(result.stdout) as Ledger;
    expect(ledger.target).toMatchObject({
      remoteTag: {
        commitSha: targetSha,
        ref: "refs/tags/v1.0.3+build.7",
      },
    });
  });

  it("orders equal-precedence build identities by proven commit ancestry", () => {
    const { repo, targetSha: earlierSha } = createTaggedRepository();
    git(repo, "tag", "v1.0.3+z", earlierSha);
    const laterSha = commit(repo, "candidate.txt", "later build\n", "rebuild release");
    git(repo, "tag", "v1.0.3+a", laterSha);

    const result = runCollector(repo, "v1.0.0", "refs/tags/v1.0.3+a");
    expect(result.status, result.stderr).toBe(0);
    const ledger = JSON.parse(result.stdout) as Ledger;
    expect(ledger.releaseEndpoints.slice(-2).map(({ ref, sha }) => ({ ref, sha }))).toEqual([
      { ref: "v1.0.3+z", sha: earlierSha },
      { ref: "v1.0.3+a", sha: laterSha },
    ]);
    expect(ledger.ranges.at(-1)?.commitCount).toBe(1);
  });

  it("ignores malformed SemVer tags and rejects them as explicit endpoints", () => {
    const { repo } = createTaggedRepository();
    const invalidTags = ["v1.0.3-01", "v1.0.3-rc.01"];
    for (const tag of invalidTags) {
      git(repo, "tag", tag);
    }

    const ordinary = runCollector(repo, "v1.0.0", "HEAD");
    expect(ordinary.status, ordinary.stderr).toBe(0);
    expect(
      (JSON.parse(ordinary.stdout) as Ledger).releaseEndpoints.map(({ ref }) => ref),
    ).not.toEqual(expect.arrayContaining(invalidTags));

    for (const tag of invalidTags) {
      const explicit = runCollector(repo, "v1.0.0", `refs/tags/${tag}`);
      expect(explicit.status).toBe(1);
      expect(explicit.stderr).toContain("semantic-version tag");
    }
  });

  it("rejects empty prerelease and build identifiers before Git collection", () => {
    const probe = spawnSync(
      python3,
      [
        "-c",
        [
          "import json, runpy, sys",
          "version = runpy.run_path(sys.argv[1], run_name='ledger_module')['Version']",
          "print(json.dumps([version.parse(value) is None for value in sys.argv[2:]]))",
        ].join("; "),
        collector,
        "v1.0.3-rc..1",
        "v1.0.3+build..7",
      ],
      { encoding: "utf8" },
    );

    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout) as boolean[]).toEqual([true, true]);
  });

  it("fails closed for missing refs, reversed ancestry, and existing output", () => {
    const { repo, targetSha } = createTaggedRepository();
    const missing = runCollector(repo, "v1.0.0", "missing-ref");
    const reversed = runCollector(repo, "v1.0.2", "v1.0.1");
    const output = path.join(repo, "existing.json");
    fs.writeFileSync(output, "preserve me\n");
    const overwrite = runCollector(repo, "v1.0.0", targetSha, ["--output", output]);

    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("missing-ref");
    expect(reversed.status).toBe(1);
    expect(reversed.stderr).toContain("is not an ancestor");
    expect(overwrite.status).toBe(1);
    expect(overwrite.stderr).toContain("refusing to overwrite");
    expect(fs.readFileSync(output, "utf8")).toBe("preserve me\n");
  });

  it("rejects shallow or promisor history, replace refs, and grafted ancestry", () => {
    const { repo, targetSha } = createTaggedRepository();
    const shallowRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-release-shallow-"));
    temporaryDirectories.push(shallowRepo);
    execFileSync("git", ["clone", "--depth", "1", "--no-local", repo, shallowRepo], {
      encoding: "utf8",
      stdio: "pipe",
    });
    const shallow = runCollector(shallowRepo, "v1.0.0", "HEAD");
    expect(shallow.status).toBe(1);
    expect(shallow.stderr).toContain("worktree is shallow");

    git(repo, "config", "extensions.partialClone", "origin");
    const partial = runCollector(repo, "v1.0.0", targetSha);
    expect(partial.status).toBe(1);
    expect(partial.stderr).toContain("configures extensions.partialClone");
    expect(partial.stderr).toContain("'origin'");
    git(repo, "config", "--unset", "extensions.partialClone");

    git(repo, "config", "remote.origin.promisor", "true");
    const promisor = runCollector(repo, "v1.0.0", targetSha);
    expect(promisor.status).toBe(1);
    expect(promisor.stderr).toContain("enabled promisor setting");
    expect(promisor.stderr).toContain("remote.origin.promisor='true'");
    git(repo, "config", "--unset", "remote.origin.promisor");

    const replacedCommit = git(repo, "rev-parse", "v1.0.0^{commit}");
    const replacementCommit = git(repo, "rev-parse", "v1.0.1^{commit}");
    git(repo, "replace", replacedCommit, replacementCommit);
    const replaced = runCollector(repo, "v1.0.0", targetSha);
    expect(replaced.status).toBe(1);
    expect(replaced.stderr).toContain("refs/replace history overrides");
    git(repo, "replace", "-d", replacedCommit);

    const graftPathText = git(repo, "rev-parse", "--git-path", "info/grafts");
    const graftPath = path.isAbsolute(graftPathText)
      ? graftPathText
      : path.join(repo, graftPathText);
    fs.writeFileSync(graftPath, `${targetSha} ${git(repo, "rev-parse", "v1.0.0")}\n`);
    const grafted = runCollector(repo, "v1.0.0", targetSha);
    expect(grafted.status).toBe(1);
    expect(grafted.stderr).toContain("contains a grafts file");
  });

  it("proves every required fix is an ancestor of the audit target", () => {
    const { repo, targetSha } = createTaggedRepository();
    const accepted = runCollector(repo, "v1.0.0", targetSha, [
      "--required-fix",
      "v1.0.1",
      "--required-fix",
      "v1.0.2",
    ]);
    expect(accepted.status, accepted.stderr).toBe(0);
    const ledger = JSON.parse(accepted.stdout) as Ledger;
    expect(ledger.requiredFixes.map(({ ref }) => ref)).toEqual(["v1.0.1", "v1.0.2"]);

    git(repo, "switch", "--create", "unmerged-fix", "v1.0.0");
    const unrelatedFix = commit(repo, "side.txt", "side\n", "unmerged fix");
    git(repo, "switch", "main");
    const rejected = runCollector(repo, "v1.0.0", targetSha, ["--required-fix", unrelatedFix]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("is not an ancestor of audit target");
  });

  it("validates GitHub CLI arguments before any API query", () => {
    const { repo, targetSha } = createTaggedRepository();
    const invalidRepository = runCollector(repo, "v1.0.0", targetSha, [
      "--github-repository",
      "acme/dependency/extra",
    ]);
    const invalidHost = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      ["--github-repository", "acme/dependency", "--github-host", "attacker.example"],
      environmentWithoutGh(),
    );
    const invalidTimeout = runCollector(repo, "v1.0.0", targetSha, [
      "--github-repository",
      "acme/dependency",
      "--github-timeout-seconds",
      "0",
    ]);
    const orphanTargetRef = runCollector(repo, "v1.0.0", targetSha, [
      "--github-target-ref",
      "refs/heads/main",
    ]);
    const abbreviatedTargetRef = runCollector(repo, "v1.0.0", targetSha, [
      "--github-repository",
      "acme/dependency",
      "--github-target-ref",
      "main",
    ]);
    const malformedTargetRef = runCollector(
      repo,
      "v1.0.0",
      targetSha,
      ["--github-repository", "acme/dependency", "--github-target-ref", "refs/heads/main..invalid"],
      environmentWithoutGh(),
    );

    expect(invalidRepository.status).toBe(2);
    expect(invalidRepository.stderr).toContain("OWNER/REPO");
    expect(invalidHost.status).toBe(2);
    expect(invalidHost.stderr).toContain("invalid choice");
    expect(invalidHost.stderr).not.toContain("could not execute gh");
    expect(invalidTimeout.status).toBe(2);
    expect(invalidTimeout.stderr).toContain("between 1 and 300");
    expect(orphanTargetRef.status).toBe(2);
    expect(orphanTargetRef.stderr).toContain("requires --github-repository");
    expect(abbreviatedTargetRef.status).toBe(2);
    expect(abbreviatedTargetRef.stderr).toContain("complete refs/heads/");
    expect(malformedTargetRef.status).toBe(1);
    expect(malformedTargetRef.stderr).toContain("not a valid Git ref");
  });

  it("does not invoke gh when GitHub evidence is not requested", () => {
    const { repo, targetSha } = createTaggedRepository();
    const result = runCollector(repo, "v1.0.0", targetSha, [], environmentWithoutGh());

    expect(result.status, result.stderr).toBe(0);
  });

  it("preserves multiple release identities at one target commit deterministically", () => {
    const { repo, targetSha } = createTaggedRepository();
    git(repo, "tag", "v1.0.3", targetSha);
    git(repo, "tag", "v1.0.4", targetSha);

    const first = runCollector(repo, "v1.0.0", targetSha);
    const second = runCollector(repo, "v1.0.0", targetSha);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toBe(first.stdout);

    const ledger = JSON.parse(first.stdout) as Ledger;
    expect(ledger.releaseEndpoints.slice(-2).map(({ ref, sha }) => ({ ref, sha }))).toEqual([
      { ref: "v1.0.3", sha: targetSha },
      { ref: "v1.0.4", sha: targetSha },
    ]);
    expect(ledger.ranges.at(-1)?.commitCount).toBe(0);
  });
});
