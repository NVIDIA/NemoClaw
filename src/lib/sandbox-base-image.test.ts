// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  baseImageInputsChangedSinceMain,
  formatBuildFailureDiagnostics,
  getSourceShortShaTags,
  getVersionedBaseImageTags,
  parseGlibcVersion,
  versionGte,
} from "../../dist/lib/sandbox-base-image";

const tmpRoots: string[] = [];
const emptyGitConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-empty-gitconfig-"));
const emptyGitConfig = path.join(emptyGitConfigDir, "gitconfig");
const emptyGitHooksDir = path.join(emptyGitConfigDir, "hooks");
const emptyGitConfigFd = fs.openSync(emptyGitConfig, "wx", 0o600);
fs.closeSync(emptyGitConfigFd);
fs.mkdirSync(emptyGitHooksDir, { mode: 0o700 });

function buildGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) {
      env[key] = value;
    }
  }
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
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  }
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

describe("sandbox base image helpers", () => {
  it("parses glibc versions from ldd output", () => {
    expect(parseGlibcVersion("ldd (Debian GLIBC 2.41-12+deb13u2) 2.41")).toBe("2.41");
    expect(parseGlibcVersion("ldd (Ubuntu GLIBC 2.39-0ubuntu8.6) 2.39")).toBe("2.39");
  });

  it("compares glibc versions numerically", () => {
    expect(versionGte("2.41", "2.39")).toBe(true);
    expect(versionGte("2.39", "2.39")).toBe(true);
    expect(versionGte("2.36", "2.39")).toBe(false);
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

  it("surfaces stderr build diagnostics on failure (#3584)", () => {
    const output = formatBuildFailureDiagnostics({
      stderr: "the --mount option requires BuildKit",
      stdout: "",
    });
    expect(output).toContain("the --mount option requires BuildKit");
  });

  it("surfaces stdout-only build diagnostics — BuildKit can land errors there (Codex review on #3584)", () => {
    const output = formatBuildFailureDiagnostics({
      stderr: "",
      stdout:
        'ERROR: failed to solve: process "/bin/sh -c apt-get install" did not complete successfully',
    });
    expect(output).toContain("ERROR: failed to solve");
  });

  it("combines stderr and stdout when both carry build output", () => {
    const output = formatBuildFailureDiagnostics({
      stderr: "build error line A",
      stdout: "build error line B",
    });
    expect(output).toBe("build error line A\nbuild error line B");
  });

  it("returns empty string when both streams are empty", () => {
    expect(formatBuildFailureDiagnostics({ stderr: "", stdout: "" })).toBe("");
    expect(formatBuildFailureDiagnostics({})).toBe("");
  });

  it("redacts captured build output before returning it", () => {
    // The runner's redact() pass strips Bearer tokens, NVIDIA API keys, etc.
    // Anything that looks like a secret in build output must not leak.
    const output = formatBuildFailureDiagnostics({
      stderr: "auth: Bearer sk-abcdef0123456789abcdef0123456789abcdef0123456789 failed",
      stdout: "",
    });
    expect(output).not.toContain("sk-abcdef0123456789abcdef0123456789abcdef0123456789");
  });

  it("accepts Buffer streams from spawnSync", () => {
    const output = formatBuildFailureDiagnostics({
      stderr: Buffer.from("buffered build error", "utf8"),
      stdout: null,
    });
    expect(output).toContain("buffered build error");
  });

  it("detects committed Dockerfile.base changes relative to origin/main", () => {
    const root = createGitFixture();
    git(root, ["switch", "-c", "feature"]);
    writeFixture(root, "Dockerfile.base", "FROM node:22\nRUN echo changed\n");
    git(root, ["add", "Dockerfile.base"]);
    git(root, ["commit", "-m", "change base"]);

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

  it("detects committed blueprint minimum-version changes relative to origin/main", () => {
    const root = createGitFixture();
    git(root, ["switch", "-c", "feature"]);
    writeFixture(root, "nemoclaw-blueprint/blueprint.yaml", "min_openclaw_version: 2026.4.25\n");
    git(root, ["add", "nemoclaw-blueprint/blueprint.yaml"]);
    git(root, ["commit", "-m", "change base input"]);

    expect(baseImageInputsChangedSinceMain(root, gitEnv)).toBe(true);
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

    expect(baseImageInputsChangedSinceMain(root, gitEnv)).toBe(true);
  });
});
