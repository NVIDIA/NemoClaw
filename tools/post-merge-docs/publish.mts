#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { allowedDocumentationPath, readBoundedFile } from "./contract.mts";

const PREFIX = "automation/post-merge-docs-";
const SIGN_OFF =
  "Signed-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";
const SHA = /^[0-9a-f]{40}$/u;
type Method = "GET" | "POST";
export type Request = (method: Method, apiPath: string, body?: unknown) => Promise<unknown>;
type Repo = { full_name: string };
type Pull = {
  body: string | null;
  base: { ref: string; repo: Repo };
  draft: boolean;
  head: { ref: string; repo: Repo | null; sha: string };
  html_url: string;
  number: number;
  state: string;
};
type Change = { mode: "100644"; path: string; sha: string | null; type: "blob" };
function fail(message: string): never {
  throw new Error(message);
}
function environment(name: string): string {
  return process.env[name] || fail(`${name} is required`);
}
function sha(value: string, name: string): string {
  return SHA.test(value) ? value : fail(`${name} must be a lowercase 40-character Git SHA`);
}
function approvedPatch(directory: string, repository: string, mainSha: string): Buffer {
  const patch = readBoundedFile(path.join(directory, "docs.patch"), 5_242_880, true);
  let value: unknown;
  try {
    value = JSON.parse(
      readBoundedFile(path.join(directory, "review.json"), 8_192).toString("utf8"),
    );
  } catch {
    fail("review.json must contain valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("review is invalid");
  const review = value as Record<string, unknown>;
  if (
    Object.keys(review).sort().join() !== "mainSha,outcome,patchSha256,repository,version" ||
    review.version !== 1 ||
    review.repository !== repository ||
    review.mainSha !== mainSha ||
    review.patchSha256 !== createHash("sha256").update(patch).digest("hex") ||
    review.outcome !== "approved"
  )
    fail("review does not approve the exact patch for this main commit");
  return patch;
}

const gitEnv: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
};
function git(repository: string, args: readonly string[], buffer = false): string | Buffer {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.required=false",
      ...args,
    ],
    {
      cwd: repository,
      encoding: buffer ? undefined : "utf8",
      env: gitEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0)
    fail(`Git ${args[0] ?? "command"} failed: ${String(result.stderr).trim()}`);
  return result.stdout;
}
function prepare(source: string, destination: string, mainSha: string, patch: Buffer) {
  git(source, ["clone", "--no-hardlinks", "--no-checkout", source, destination]);
  git(destination, ["checkout", "--detach", mainSha]);
  const patchPath = path.join(path.dirname(destination), "docs.patch");
  fs.writeFileSync(patchPath, patch, { flag: "wx", mode: 0o600 });
  if (patch.length) git(destination, ["apply", "--index", "--binary", patchPath]);
  const finalTree = sha(String(git(destination, ["write-tree"])).trim(), "final tree");
  const diff = git(
    destination,
    ["diff", "--name-status", "--no-renames", "-z", mainSha, finalTree],
    true,
  ) as Buffer;
  const fields = diff.toString().split("\0").filter(Boolean);
  if (fields.length % 2 || fields.length > 400) fail("patch contains an invalid changed-path list");
  const changes: Change[] = [];
  let total = 0;
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index] ?? "";
    const file = fields[index + 1] ?? "";
    if (!/^[ADM]$/u.test(status) || !allowedDocumentationPath(file))
      fail(`patch changes unsupported path: ${file}`);
    const tree = status === "D" ? mainSha : finalTree;
    const entry = String(git(destination, ["ls-tree", tree, "--", file])).trim();
    const match = /^100644 blob ([0-9a-f]{40})\t/u.exec(entry);
    if (!match) fail(`patch changes a non-regular file: ${file}`);
    const size = status === "D" ? 0 : Number(git(destination, ["cat-file", "-s", match[1]!]));
    total += size;
    if (!Number.isSafeInteger(size) || size > 1_048_576 || total > 5_242_880)
      fail("documentation files exceed publication limits");
    const objectSha = status === "D" ? null : match[1]!;
    changes.push({ mode: "100644", path: file, sha: objectSha, type: "blob" });
  }
  return { changes, finalTree, repository: destination };
}

function checkedPull(pull: Pull, repository: string, branch?: string, body?: string): Pull {
  if (
    pull.state !== "open" ||
    typeof pull.draft !== "boolean" ||
    !Number.isSafeInteger(pull.number) ||
    pull.number < 1 ||
    pull.base.ref !== "main" ||
    pull.base.repo.full_name !== repository ||
    pull.head.repo?.full_name !== repository ||
    !SHA.test(pull.head.sha) ||
    (branch !== undefined && pull.head.ref !== branch) ||
    (body !== undefined && (pull.body !== body || !pull.draft)) ||
    pull.html_url !== `https://github.com/${repository}/pull/${pull.number}`
  )
    fail("GitHub returned an invalid managed documentation PR");
  return pull;
}
async function managed(repository: string, request: Request): Promise<Pull[]> {
  const found: Pull[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = `/repos/${repository}/pulls?state=open&base=main&per_page=100&page=${page}`;
    const pulls = (await request("GET", url)) as Pull[];
    if (!Array.isArray(pulls)) fail("GitHub returned an invalid pull request list");
    for (const pull of pulls) {
      if (
        /^automation\/post-merge-docs-[0-9a-f]{12}$/u.test(pull.head?.ref ?? "") &&
        pull.head.repo?.full_name === repository
      )
        found.push(checkedPull(pull, repository));
    }
    if (pulls.length < 100) return found;
  }
  return fail("GitHub pull request pagination exceeded 100 pages");
}
async function checkpoint(repo: string, main: string, request: Request): Promise<void> {
  const ref = (await request("GET", `/repos/${repo}/git/ref/heads/main`)) as {
    object?: { sha?: string };
  };
  if (ref?.object?.sha !== main) fail("main changed after documentation review");
  const pulls = await managed(repo, request);
  if (pulls.length > 1) fail("multiple managed documentation PRs are open");
  if (pulls.length) fail("a managed documentation PR opened during publication");
}

export async function publishDocumentation(input: {
  artifactDirectory: string;
  expectedMainSha: string;
  expectedRepository: string;
  request: Request;
  sourceRepository: string;
}): Promise<void> {
  const { expectedRepository: repository, request } = input;
  const mainSha = sha(input.expectedMainSha, "GITHUB_SHA");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) fail("GITHUB_REPOSITORY is invalid");
  const patch = approvedPatch(input.artifactDirectory, repository, mainSha);
  await checkpoint(repository, mainSha, request);
  const temporary = fs.mkdtempSync(path.join(tmpdir(), "nemoclaw-docs-publish-"));
  try {
    const destination = path.join(temporary, "repository");
    const prepared = prepare(input.sourceRepository, destination, mainSha, patch);
    await checkpoint(repository, mainSha, request);
    if (!prepared.changes.length) return;
    const branch = `${PREFIX}${mainSha.slice(0, 12)}`;
    const refPath = `/repos/${repository}/git/ref/heads/${branch}`;
    const ref = (await request("GET", refPath)) as { object?: { sha?: string } } | null;
    let commitSha =
      ref === null ? undefined : sha(ref.object?.sha ?? "", "existing documentation branch SHA");
    const message = `docs: catch up after main\n\n${SIGN_OFF}`;
    if (commitSha) {
      const commit = (await request("GET", `/repos/${repository}/git/commits/${commitSha}`)) as {
        message?: string;
        parents?: Array<{ sha?: string }>;
        sha?: string;
        tree?: { sha?: string };
        verification?: { verified?: boolean };
      };
      if (
        commit.sha !== commitSha ||
        commit.tree?.sha !== prepared.finalTree ||
        commit.parents?.length !== 1 ||
        commit.parents[0]?.sha !== mainSha ||
        commit.message !== message ||
        !commit.verification?.verified
      )
        fail("existing immutable documentation branch has unexpected content");
    } else {
      for (const entry of prepared.changes) {
        if (!entry.sha) continue;
        const content = git(prepared.repository, ["cat-file", "blob", entry.sha], true) as Buffer;
        const blob = (await request("POST", `/repos/${repository}/git/blobs`, {
          content: content.toString("base64"),
          encoding: "base64",
        })) as { sha?: string };
        if (blob.sha !== entry.sha) fail(`GitHub returned an unexpected blob for ${entry.path}`);
      }
      const base = String(git(prepared.repository, ["rev-parse", `${mainSha}^{tree}`])).trim();
      const tree = (await request("POST", `/repos/${repository}/git/trees`, {
        base_tree: base,
        tree: prepared.changes,
      })) as { sha?: string };
      if (tree.sha !== prepared.finalTree)
        fail("GitHub returned a tree different from the reviewed tree");
      const commit = (await request("POST", `/repos/${repository}/git/commits`, {
        message,
        parents: [mainSha],
        tree: prepared.finalTree,
      })) as { sha?: string; verification?: { reason?: string; verified?: boolean } };
      commitSha = sha(commit.sha ?? "", "created commit SHA");
      if (!commit.verification?.verified)
        fail(
          `GitHub did not verify the documentation commit: ${commit.verification?.reason ?? "unknown reason"}`,
        );
      await checkpoint(repository, mainSha, request);
      try {
        const created = (await request("POST", `/repos/${repository}/git/refs`, {
          ref: `refs/heads/${branch}`,
          sha: commitSha,
        })) as { object?: { sha?: string }; ref?: string };
        if (created.ref !== `refs/heads/${branch}` || created.object?.sha !== commitSha)
          fail("GitHub did not confirm immutable branch creation");
      } catch (error) {
        const reconciled = (await request("GET", refPath)) as { object?: { sha?: string } } | null;
        if (reconciled?.object?.sha !== commitSha) throw error;
      }
    }
    await checkpoint(repository, mainSha, request);
    const body = `## Summary\n\nUpdates documentation for merged changes through \`${mainSha}\`.\n\n## Verification\n\n- An independent documentation writer approved the exact patch.\n- Required PR checks must run \`npm run docs\` before merge.\n- A maintainer must inspect and approve any approval-required workflow runs.\n\n${SIGN_OFF}`;
    let pull: Pull;
    try {
      pull = (await request("POST", `/repos/${repository}/pulls`, {
        base: "main",
        body,
        draft: true,
        head: branch,
        title: "docs: catch up after merged changes",
      })) as Pull;
    } catch (error) {
      const reconciled = await managed(repository, request);
      if (reconciled.length !== 1 || reconciled[0]?.head.ref !== branch) throw error;
      pull = reconciled[0];
    }
    checkedPull(pull, repository, branch, body);
    if (pull.head.sha !== commitSha) fail("documentation PR does not point to the verified commit");
    fail(`Documentation remains pending in ${pull.html_url}`);
  } finally {
    fs.rmSync(temporary, { force: true, recursive: true });
  }
}

function client(token: string): Request {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  return async (method, apiPath, body) => {
    const response = await fetch(`https://api.github.com${apiPath}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers,
      method,
      signal: AbortSignal.timeout(30_000),
    });
    if (method === "GET" && response.status === 404) return null;
    const value = (await response.json()) as { message?: string };
    if (!response.ok)
      fail(`GitHub API request failed: ${value.message ?? `HTTP ${response.status}`}`);
    return value;
  };
}
async function main(): Promise<void> {
  await publishDocumentation({
    artifactDirectory: environment("POST_MERGE_DOCS_ARTIFACT_DIR"),
    expectedMainSha: environment("GITHUB_SHA"),
    expectedRepository: environment("GITHUB_REPOSITORY"),
    request: client(environment("GITHUB_TOKEN")),
    sourceRepository: environment("TRUSTED_CHECKOUT"),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
