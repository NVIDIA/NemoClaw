// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  baseImageInputsChangedSinceMain,
  baseImageInputsDirty,
  buildLocalBaseTag,
  getSourceShortShaTags,
  getVersionedBaseImageTags,
  normalizeBaseImageInputPaths,
} from "./source-identity";

const tmpRoots: string[] = [];
const emptyGitConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-empty-gitconfig-"));
const emptyGitConfig = path.join(emptyGitConfigDir, "gitconfig");
const emptyGitHooksDir = path.join(emptyGitConfigDir, "hooks");
const emptyGitConfigFd = fs.openSync(emptyGitConfig, "wx", 0o600);
fs.closeSync(emptyGitConfigFd);
fs.mkdirSync(emptyGitHooksDir, { mode: 0o700 });

function buildGitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => !key.startsWith("GIT_") && value !== undefined,
    ),
  );
  return {
    ...env,
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Test User",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}

const gitEnv = buildGitEnv();

function git(root: string, args: string[]) {
  const result = spawnSync(
    "git",
    ["-c", `core.hooksPath=${emptyGitHooksDir}`, "-C", root, ...args],
    {
      encoding: "utf-8",
      env: gitEnv,
    },
  );
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`,
  );
  return result.stdout.trim();
}

function writeFixture(root: string, relativePath: string, contents: string) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
}

function createGitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-image-test-"));
  tmpRoots.push(root);
  git(root, ["init", "-b", "main"]);
  writeFixture(root, "Dockerfile.base", "FROM node:22\n");
  writeFixture(root, "agents/langchain-deepagents-code/Dockerfile.base", "FROM python:3.13\n");
  writeFixture(root, "nemoclaw-blueprint/blueprint.yaml", "min_openclaw_version: 2026.4.24\n");
  writeFixture(root, "src/other.ts", "export const value = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return root;
}

function createGitFixtureWithRemoteOnlyBaseRef() {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-image-remote-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-image-clone-"));
  tmpRoots.push(root, remote);

  git(remote, ["init", "--bare"]);
  git(root, ["init", "-b", "main"]);
  writeFixture(root, "Dockerfile.base", "FROM node:22\n");
  writeFixture(root, "nemoclaw-blueprint/blueprint.yaml", "min_openclaw_version: 2026.4.24\n");
  writeFixture(root, "src/other.ts", "export const value = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "origin", "main"]);
  return root;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

afterAll(() => {
  fs.rmSync(emptyGitConfigDir, { recursive: true, force: true });
});

describe("sandbox base-image source identity", () => {
  it("normalizes and deduplicates inputs inside the repository while rejecting traversal", () => {
    const root = path.join(os.tmpdir(), "nemoclaw-source-identity-root");
    const agentDockerfile = "agents/hermes/Dockerfile.base";

    expect(
      normalizeBaseImageInputPaths(root, [
        agentDockerfile,
        path.join(root, agentDockerfile),
        "Dockerfile.base",
        "../outside/Dockerfile.base",
      ]),
    ).toEqual(["Dockerfile.base", "nemoclaw-blueprint/blueprint.yaml", agentDockerfile]);
  });

  it("builds deterministic local tags from a source SHA and falls back without one", () => {
    const missingRoot = "/definitely/not/a/git/repo";

    expect(
      buildLocalBaseTag("nemoclaw-sandbox-base-local", missingRoot, {
        GITHUB_SHA: "1E94F2E207C5456EBC35E2BD5BB380D4430292C6",
      }),
    ).toBe("nemoclaw-sandbox-base-local:1e94f2e2");
    expect(buildLocalBaseTag("nemoclaw-sandbox-base-local", missingRoot, {})).toBe(
      "nemoclaw-sandbox-base-local:local",
    );
  });

  it("derives source-sha tags compatible with base-image workflow metadata", () => {
    const tags = getSourceShortShaTags("/definitely/not/a/git/repo", {
      GITHUB_SHA: "1E94F2E207C5456EBC35E2BD5BB380D4430292C6",
    } as NodeJS.ProcessEnv);
    expect(tags).toEqual(["1e94f2e2", "1e94f2e"]);
  });

  it("derives versioned sandbox-base tags from pinned install refs", () => {
    const tags = getVersionedBaseImageTags("/definitely/not/a/git/repo", {
      NEMOCLAW_INSTALL_REF: "v0.0.31",
      NEMOCLAW_INSTALL_TAG: "latest",
      GITHUB_SHA: "1e94f2e207c5456ebc35e2bd5bb380d4430292c6",
    } as NodeJS.ProcessEnv);
    expect(tags).toEqual(["v0.0.31"]);
  });

  it("normalizes .version files to release image tags", () => {
    const root = createGitFixture();
    writeFixture(root, ".version", "0.0.50\n");
    const tags = getVersionedBaseImageTags(root, {} as NodeJS.ProcessEnv);
    expect(tags).toEqual(["v0.0.50"]);
  });

  it("uses exact git release tags but ignores non-release refs", () => {
    const root = createGitFixture();
    git(root, ["tag", "v0.0.42"]);
    expect(getVersionedBaseImageTags(root, gitEnv)).toEqual(["v0.0.42"]);

    git(root, ["switch", "-c", "feature"]);
    writeFixture(root, "src/other.ts", "export const value = 42;\n");
    git(root, ["add", "src/other.ts"]);
    git(root, ["commit", "-m", "move off tag"]);
    expect(getVersionedBaseImageTags(root, gitEnv)).toEqual([]);
  });

  it("detects committed Dockerfile.base changes relative to origin/main", () => {
    const root = createGitFixture();
    git(root, ["switch", "-c", "feature"]);
    writeFixture(root, "Dockerfile.base", "FROM node:22\nRUN echo changed\n");
    git(root, ["add", "Dockerfile.base"]);
    git(root, ["commit", "-m", "change base"]);

    expect(baseImageInputsDirty(root, gitEnv)).toBe(false);
    expect(baseImageInputsChangedSinceMain(root, gitEnv)).toBe(true);
  });

  it("fetches the base ref before deciding detached dispatch checkouts can use latest", () => {
    const root = createGitFixtureWithRemoteOnlyBaseRef();
    git(root, ["switch", "-c", "feature"]);
    writeFixture(root, "Dockerfile.base", "FROM node:22\nRUN echo changed\n");
    git(root, ["add", "Dockerfile.base"]);
    git(root, ["commit", "-m", "change base"]);

    expect(git(root, ["rev-parse", "--verify", "origin/main"]).length).toBeGreaterThan(0);
    git(root, ["update-ref", "-d", "refs/remotes/origin/main"]);
    expect(baseImageInputsChangedSinceMain(root, { ...gitEnv, GITHUB_ACTIONS: "true" })).toBe(true);
  });

  it("normalizes invalid CI base refs before constructing a fetch refspec", () => {
    const root = createGitFixtureWithRemoteOnlyBaseRef();
    git(root, ["update-ref", "-d", "refs/remotes/origin/main"]);

    expect(
      baseImageInputsChangedSinceMain(root, {
        ...gitEnv,
        GITHUB_ACTIONS: "true",
        GITHUB_BASE_REF: "main:refs/heads/injected",
      }),
    ).toBe(false);
    expect(git(root, ["rev-parse", "--verify", "origin/main"]).length).toBeGreaterThan(0);
  });

  it("treats Git diff errors as changed instead of reusing a stale base", () => {
    const root = createGitFixture();
    const invalidIndex = path.join(root, ".git", "index-directory");
    fs.mkdirSync(invalidIndex);

    expect(
      baseImageInputsChangedSinceMain(root, {
        ...gitEnv,
        GIT_INDEX_FILE: invalidIndex,
      }),
    ).toBe(true);
  });

  it("fails closed when a Git checkout has no usable base comparison ref", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-image-no-base-ref-"));
    tmpRoots.push(root);
    git(root, ["init", "-b", "feature"]);
    writeFixture(root, "Dockerfile.base", "FROM node:22\n");
    writeFixture(root, "nemoclaw-blueprint/blueprint.yaml", "min_openclaw_version: 2026.4.24\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "initial"]);

    expect(baseImageInputsChangedSinceMain(root, gitEnv)).toBe(true);
  });

  it("uses published-image resolution outside a Git checkout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-image-no-git-"));
    tmpRoots.push(root);

    expect(baseImageInputsChangedSinceMain(root, gitEnv)).toBe(false);
  });

  it("does not inherit Git metadata from a release directory's parent", () => {
    const parent = createGitFixture();
    const root = path.join(parent, "packaged-release");
    fs.mkdirSync(root);

    expect(baseImageInputsChangedSinceMain(root, gitEnv)).toBe(false);
  });

  it("fails closed when Git metadata exists but the checkout is broken", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-image-broken-git-"));
    tmpRoots.push(root);
    fs.mkdirSync(path.join(root, ".git"));

    expect(baseImageInputsChangedSinceMain(root, gitEnv)).toBe(true);
  });

  it("detects committed blueprint minimum-version changes relative to origin/main", () => {
    const root = createGitFixture();
    git(root, ["switch", "-c", "feature"]);
    writeFixture(root, "nemoclaw-blueprint/blueprint.yaml", "min_openclaw_version: 2026.4.25\n");
    git(root, ["add", "nemoclaw-blueprint/blueprint.yaml"]);
    git(root, ["commit", "-m", "change base input"]);

    expect(baseImageInputsChangedSinceMain(root, gitEnv)).toBe(true);
  });

  it("detects committed agent Dockerfile.base changes when an agent base path is supplied", () => {
    const root = createGitFixture();
    const agentBase = path.join(root, "agents/langchain-deepagents-code/Dockerfile.base");
    git(root, ["switch", "-c", "feature"]);
    writeFixture(
      root,
      "agents/langchain-deepagents-code/Dockerfile.base",
      "FROM python:3.13\nRUN echo changed\n",
    );
    git(root, ["add", "agents/langchain-deepagents-code/Dockerfile.base"]);
    git(root, ["commit", "-m", "change agent base input"]);

    expect(baseImageInputsChangedSinceMain(root, gitEnv)).toBe(false);
    expect(baseImageInputsChangedSinceMain(root, gitEnv, [agentBase])).toBe(true);
  });

  it("rejects traversal paths before checking base-image input diffs", () => {
    const root = createGitFixture();
    git(root, ["switch", "-c", "feature"]);
    writeFixture(root, "src/other.ts", "export const value = 2;\n");
    git(root, ["add", "src/other.ts"]);
    git(root, ["commit", "-m", "change app code"]);

    expect(
      baseImageInputsChangedSinceMain(root, gitEnv, [
        "agents/foo/../../../outside/Dockerfile.base",
      ]),
    ).toBe(false);
  });

  it("ignores non-base-image source changes relative to origin/main", () => {
    const root = createGitFixture();
    git(root, ["switch", "-c", "feature"]);
    writeFixture(root, "src/other.ts", "export const value = 2;\n");
    git(root, ["add", "src/other.ts"]);
    git(root, ["commit", "-m", "change app code"]);

    expect(baseImageInputsChangedSinceMain(root, gitEnv)).toBe(false);
  });

  it("detects uncommitted Dockerfile.base changes", () => {
    const root = createGitFixture();
    writeFixture(root, "Dockerfile.base", "FROM node:22\nRUN echo dirty\n");

    expect(baseImageInputsDirty(root, gitEnv)).toBe(true);
    expect(baseImageInputsChangedSinceMain(root, gitEnv)).toBe(true);

    git(root, ["add", "Dockerfile.base"]);
    expect(baseImageInputsDirty(root, gitEnv)).toBe(true);
  });
});
