// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type CompositeAction, readYaml } from "./helpers/e2e-workflow-contract";
import { execTimeout } from "./helpers/timeouts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const helper = path.join(repoRoot, ".github/actions/base-image-resolver.sh");
const sandboxAction = readYaml<CompositeAction>(
  ".github/actions/resolve-sandbox-base-image/action.yaml",
);
const hermesAction = readYaml<CompositeAction>(
  ".github/actions/resolve-hermes-base-image/action.yaml",
);
const tempDirs: string[] = [];
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Base Resolver Test",
  GIT_AUTHOR_EMAIL: "base-resolver@example.com",
  GIT_COMMITTER_NAME: "Base Resolver Test",
  GIT_COMMITTER_EMAIL: "base-resolver@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function run(script: string, env: NodeJS.ProcessEnv = {}, cwd = repoRoot) {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", `source "$HELPER"\n${script}`], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HELPER: helper, ...env },
  });
}

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
    encoding: "utf8",
    env: gitEnv,
  });
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  return result.stdout.trim();
}

function writeFixture(root: string, relativePath: string, contents: string) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

type ComparisonFixture = {
  feature: string;
  remote: string;
  seed: string;
};

function createComparisonFixture(): ComparisonFixture {
  const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-base-comparison-"));
  tempDirs.push(root);
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const feature = path.join(root, "feature");
  mkdirSync(seed);

  git(root, ["init", "--bare", remote]);
  git(seed, ["init", "-b", "main"]);
  writeFixture(seed, "Dockerfile.base", "FROM node:22\n");
  writeFixture(seed, "nemoclaw-blueprint/blueprint.yaml", "version: 1\n");
  writeFixture(seed, "src/other.ts", "export const value = 1;\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "initial"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  git(root, ["clone", remote, feature]);
  git(feature, ["switch", "-c", "feature"]);
  writeFixture(feature, "src/other.ts", "export const value = 2;\n");
  git(feature, ["add", "src/other.ts"]);
  git(feature, ["commit", "-m", "feature source change"]);
  git(feature, ["push", "-u", "origin", "feature"]);
  return { feature, remote, seed };
}

function advanceMain(seed: string, relativePath: string, contents: string) {
  writeFixture(seed, relativePath, contents);
  git(seed, ["add", relativePath]);
  git(seed, ["commit", "-m", `update ${relativePath}`]);
  git(seed, ["push", "origin", "main"]);
}

function fakeDocker(body: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "nemoclaw-base-resolver-"));
  tempDirs.push(dir);
  const executable = path.join(dir, "docker");
  writeFileSync(executable, `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("base image resolver helper (#6957)", () => {
  it("executes the sandbox action and exports a compatible candidate", () => {
    const bin = fakeDocker(`
if [[ "$1" == pull ]]; then exit 0; fi
if [[ "$1" == run ]]; then echo "ldd (Ubuntu GLIBC 2.39-0ubuntu8) 2.39"; exit 0; fi
exit 1`);
    const githubEnv = path.join(bin, "github.env");
    writeFileSync(githubEnv, "");
    const resolver = sandboxAction.runs.steps.find(
      (step) => step.name === "Resolve sandbox base image",
    )?.run;

    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", resolver ?? ""], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: execTimeout(),
      env: {
        ...process.env,
        GITHUB_ACTION_PATH: path.join(repoRoot, ".github/actions/resolve-sandbox-base-image"),
        GITHUB_ENV: githubEnv,
        GITHUB_SHA: "1".repeat(40),
        PATH: `${bin}:${process.env.PATH}`,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(githubEnv, "utf8")).toBe(
      "BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:11111111\n",
    );
  });

  it("rejects an incompatible Hermes candidate and builds the local fallback", () => {
    const remoteDigest = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`;
    const bin = fakeDocker(`
printf "%s\\0" "$@" >> "$DOCKER_LOG"
printf "\\0" >> "$DOCKER_LOG"
if [[ "$1" == pull || "$1" == build ]]; then exit 0; fi
if [[ "$1" == image && "$2" == inspect ]]; then printf "%s\\n" "$REMOTE_DIGEST"; exit 0; fi
if [[ "$1" == run ]]; then
  entrypoint=""
  image=""
  while (($#)); do
    if [[ "$1" == --entrypoint ]]; then entrypoint="$2"; image="$3"; break; fi
    shift
  done
  if [[ "$entrypoint" == /usr/bin/ldd ]]; then printf "ldd (Ubuntu GLIBC 2.39) 2.39\\n"; exit 0; fi
  if [[ "$entrypoint" == sh ]]; then exit 0; fi
  if [[ "$entrypoint" == /opt/hermes/.venv/bin/python ]]; then [[ "$image" != "$REMOTE_DIGEST" ]]; exit; fi
fi
exit 2`);
    const dockerLog = path.join(bin, "docker.log");
    const githubEnv = path.join(bin, "github.env");
    writeFileSync(githubEnv, "");
    const resolver = hermesAction.runs.steps.find(
      (step) => step.name === "Resolve Hermes sandbox base image",
    )?.run;

    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", resolver ?? ""], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: execTimeout(),
      env: {
        ...process.env,
        DOCKER_LOG: dockerLog,
        GITHUB_ACTION_PATH: path.join(repoRoot, ".github/actions/resolve-hermes-base-image"),
        GITHUB_ENV: githubEnv,
        GITHUB_SHA: "1".repeat(40),
        PATH: `${bin}:${process.env.PATH}`,
        REMOTE_DIGEST: remoteDigest,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("lacks the packaged MCP Streamable HTTP client imports");
    expect(result.stdout).toContain("building locally");
    expect(readFileSync(githubEnv, "utf8").trim()).toBe(
      "HERMES_BASE_IMAGE=nemoclaw-hermes-base-local",
    );
    const calls = readFileSync(dockerLog, "utf8")
      .split("\0\0")
      .filter(Boolean)
      .map((call) => call.split("\0").filter(Boolean));
    const firstPull = calls.find((args) => args[0] === "pull");
    expect(firstPull?.[0]).toBe("pull");
    expect(firstPull?.[1]).toMatch(
      /^ghcr\.io\/nvidia\/nemoclaw\/hermes-sandbox-base@sha256:[0-9a-f]{64}$/,
    );
    const remoteProbe = calls.findIndex(
      (args) => args.includes("/opt/hermes/.venv/bin/python") && args.includes(remoteDigest),
    );
    const localBuild = calls.findIndex((args) => args[0] === "build");
    const localProbe = calls.findIndex(
      (args) =>
        args.includes("/opt/hermes/.venv/bin/python") &&
        args.includes("nemoclaw-hermes-base-local"),
    );
    expect(remoteProbe).toBeGreaterThanOrEqual(0);
    expect(localBuild).toBeGreaterThan(remoteProbe);
    expect(localProbe).toBeGreaterThan(localBuild);
  });

  it("pulls a remote image and accepts a compatible glibc version", () => {
    const bin = fakeDocker(`
if [[ "$1" == pull ]]; then exit 0; fi
if [[ "$1" == run ]]; then echo "ldd (Ubuntu GLIBC 2.39-0ubuntu8) 2.39"; exit 0; fi
exit 1`);

    const result = run(
      'resolver_pull example:test && version="$(resolver_glibc_version example:test)" && resolver_glibc_ok "$version" 2.39 && printf "%s" "$version"',
      { PATH: `${bin}:${process.env.PATH}` },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("2.39");
  });

  it("rejects an incompatible or missing glibc version", () => {
    expect(run('resolver_glibc_ok "2.38" 2.39').status).not.toBe(0);
    expect(run('resolver_glibc_ok "" 2.39').status).not.toBe(0);
  });

  it("returns only the requested repository digest", () => {
    const bin = fakeDocker(`
cat <<'EOF'
other.example/base@sha256:aaaaaaaa
ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:bbbbbbbb
EOF`);
    const env = { PATH: `${bin}:${process.env.PATH}` };

    const found = run(
      "resolver_repo_digest mutable:tag ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
      env,
    );
    const missing = run("resolver_repo_digest mutable:tag ghcr.io/nvidia/nemoclaw/missing", env);

    expect(found.status).toBe(0);
    expect(found.stdout.trim()).toBe("ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:bbbbbbbb");
    expect(missing.status).not.toBe(0);
  });

  it("iterates candidates through an agent-owned validator and reports exhaustion", () => {
    const selected = run(`
validate() { [[ "$1" == compatible ]] && printf '%s' "$1"; }
resolver_try_candidates validate rejected compatible later`);
    const exhausted = run(`
reject() { return 1; }
resolver_try_candidates reject first second`);

    expect(selected.status).toBe(0);
    expect(selected.stdout).toBe("compatible");
    expect(exhausted.status).not.toBe(0);
  });

  it("builds a local fallback with the exact Dockerfile and tag", () => {
    const bin = fakeDocker('printf "%s\\0" "$@" >> "$DOCKER_LOG"');
    const log = path.join(bin, "docker.log");

    const result = run("resolver_build_local agents/hermes/Dockerfile.base local:test", {
      DOCKER_LOG: log,
      PATH: `${bin}:${process.env.PATH}`,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8").split("\0")).toEqual([
      "build",
      "-f",
      "agents/hermes/Dockerfile.base",
      "-t",
      "local:test",
      ".",
      "",
    ]);
  });

  it("writes one validated GitHub environment assignment", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nemoclaw-base-env-"));
    tempDirs.push(dir);
    const githubEnv = path.join(dir, "github.env");

    const valid = run("resolver_write_env BASE_IMAGE ghcr.io/nvidia/nemoclaw/sandbox-base:latest", {
      GITHUB_ENV: githubEnv,
    });
    const invalidName = run('resolver_write_env "BAD-NAME" image', { GITHUB_ENV: githubEnv });
    const emptyValue = run('resolver_write_env BASE_IMAGE ""', { GITHUB_ENV: githubEnv });
    const multilineValue = run("resolver_write_env BASE_IMAGE $'first\\nsecond'", {
      GITHUB_ENV: githubEnv,
    });

    expect(valid.status).toBe(0);
    expect(invalidName.status).not.toBe(0);
    expect(emptyValue.status).not.toBe(0);
    expect(multilineValue.status).not.toBe(0);
    expect(readFileSync(githubEnv, "utf8")).toBe(
      "BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest\n",
    );
  });
});

describe("sandbox base-image merge-base comparison (#7140)", () => {
  it("compares base inputs from the merge base so base-only drift reuses the published image", () => {
    const fixture = createComparisonFixture();
    advanceMain(fixture.seed, "Dockerfile.base", "FROM node:24\n");

    const result = run(
      "resolver_base_inputs_changed_since_base main Dockerfile.base nemoclaw-blueprint/blueprint.yaml",
      gitEnv,
      fixture.feature,
    );

    expect(result.status, result.stderr).toBe(1);
  });

  it("routes base-only main drift to latest without building locally", () => {
    const fixture = createComparisonFixture();
    advanceMain(fixture.seed, "Dockerfile.base", "FROM node:24\n");
    const bin = fakeDocker(`
printf "%s\\0" "$@" >> "$DOCKER_LOG"
printf "\\0" >> "$DOCKER_LOG"
if [[ "$1" == pull ]]; then [[ "$2" == *:latest ]]; exit; fi
if [[ "$1" == run ]]; then echo "ldd (Ubuntu GLIBC 2.39-0ubuntu8) 2.39"; exit 0; fi
if [[ "$1" == build ]]; then exit 42; fi
exit 1`);
    const dockerLog = path.join(bin, "docker.log");
    const githubEnv = path.join(bin, "github.env");
    writeFileSync(githubEnv, "");
    const resolver = sandboxAction.runs.steps.find(
      (step) => step.name === "Resolve sandbox base image",
    )?.run;

    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", resolver ?? ""], {
      cwd: fixture.feature,
      encoding: "utf8",
      env: {
        ...gitEnv,
        DOCKER_LOG: dockerLog,
        GITHUB_ACTION_PATH: path.join(repoRoot, ".github/actions/resolve-sandbox-base-image"),
        GITHUB_BASE_REF: "main",
        GITHUB_ENV: githubEnv,
        GITHUB_SHA: git(fixture.feature, ["rev-parse", "HEAD"]),
        PATH: `${bin}:${process.env.PATH}`,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(githubEnv, "utf8")).toBe(
      "BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest\n",
    );
    const calls = readFileSync(dockerLog, "utf8")
      .split("\0\0")
      .filter(Boolean)
      .map((call) => call.split("\0").filter(Boolean));
    expect(calls.some((args) => args[0] === "build")).toBe(false);
  });

  it("forces a local image for feature-owned base changes", () => {
    const fixture = createComparisonFixture();
    writeFixture(fixture.feature, "Dockerfile.base", "FROM node:22\nRUN echo feature\n");
    git(fixture.feature, ["add", "Dockerfile.base"]);
    git(fixture.feature, ["commit", "-m", "feature base change"]);

    const result = run(
      "resolver_base_inputs_changed_since_base main Dockerfile.base nemoclaw-blueprint/blueprint.yaml",
      gitEnv,
      fixture.feature,
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it("forces a local image for feature-owned base changes even when main also changed", () => {
    const fixture = createComparisonFixture();
    advanceMain(fixture.seed, "nemoclaw-blueprint/blueprint.yaml", "version: 2\n");
    writeFixture(fixture.feature, "Dockerfile.base", "FROM node:22\nRUN echo feature\n");
    git(fixture.feature, ["add", "Dockerfile.base"]);
    git(fixture.feature, ["commit", "-m", "feature base change"]);

    const result = run(
      "resolver_base_inputs_changed_since_base main Dockerfile.base nemoclaw-blueprint/blueprint.yaml",
      gitEnv,
      fixture.feature,
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it("forces a local image for staged and unstaged tracked base changes", () => {
    const fixture = createComparisonFixture();
    writeFixture(fixture.feature, "Dockerfile.base", "FROM node:22\nRUN echo dirty\n");
    const unstaged = run(
      "resolver_base_inputs_changed_since_base main Dockerfile.base nemoclaw-blueprint/blueprint.yaml",
      gitEnv,
      fixture.feature,
    );
    git(fixture.feature, ["add", "Dockerfile.base"]);
    const staged = run(
      "resolver_base_inputs_changed_since_base main Dockerfile.base nemoclaw-blueprint/blueprint.yaml",
      gitEnv,
      fixture.feature,
    );

    expect(unstaged.status, unstaged.stderr).toBe(0);
    expect(staged.status, staged.stderr).toBe(0);
  });

  it("fails closed when the feature and base branches have no common ancestor", () => {
    const fixture = createComparisonFixture();
    git(fixture.seed, ["switch", "--orphan", "replacement"]);
    git(fixture.seed, ["rm", "-rf", "--ignore-unmatch", "."]);
    writeFixture(fixture.seed, "Dockerfile.base", "FROM node:24\n");
    writeFixture(fixture.seed, "nemoclaw-blueprint/blueprint.yaml", "version: 2\n");
    git(fixture.seed, ["add", "."]);
    git(fixture.seed, ["commit", "-m", "replace main history"]);
    git(fixture.seed, ["push", "--force", "origin", "HEAD:main"]);

    const result = run(
      "resolver_base_inputs_changed_since_base main Dockerfile.base nemoclaw-blueprint/blueprint.yaml",
      gitEnv,
      fixture.feature,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("No common ancestor");
  });

  it("recovers detached shallow history before comparing base-only drift", () => {
    const fixture = createComparisonFixture();
    advanceMain(fixture.seed, "Dockerfile.base", "FROM node:24\n");
    const shallow = path.join(path.dirname(fixture.feature), "shallow");
    git(path.dirname(fixture.feature), [
      "clone",
      "--depth=1",
      "--branch",
      "feature",
      `file://${fixture.remote}`,
      shallow,
    ]);
    git(shallow, ["checkout", "--detach"]);
    expect(git(shallow, ["rev-parse", "--is-shallow-repository"])).toBe("true");

    const result = run(
      "resolver_base_inputs_changed_since_base main Dockerfile.base nemoclaw-blueprint/blueprint.yaml",
      gitEnv,
      shallow,
    );

    expect(result.status, result.stderr).toBe(1);
    expect(git(shallow, ["rev-parse", "--is-shallow-repository"])).toBe("false");
  });

  it("fails closed when the base branch cannot be fetched", () => {
    const fixture = createComparisonFixture();
    git(fixture.feature, ["remote", "set-url", "origin", path.join(fixture.remote, "missing")]);

    const result = run(
      "resolver_base_inputs_changed_since_base main Dockerfile.base nemoclaw-blueprint/blueprint.yaml",
      gitEnv,
      fixture.feature,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Could not fetch base branch");
  });

  it("fails closed when Git cannot inspect the tracked base inputs", () => {
    const fixture = createComparisonFixture();
    const invalidIndex = path.join(fixture.feature, ".git", "index-directory");
    mkdirSync(invalidIndex);

    const result = run(
      "resolver_base_inputs_changed_since_base main Dockerfile.base nemoclaw-blueprint/blueprint.yaml",
      { ...gitEnv, GIT_INDEX_FILE: invalidIndex },
      fixture.feature,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Could not inspect unstaged sandbox base-image inputs");
  });

  it("normalizes invalid base refs before fetching comparison history", () => {
    const fixture = createComparisonFixture();

    const result = run(
      "resolver_base_inputs_changed_since_base 'main:refs/heads/injected' Dockerfile.base nemoclaw-blueprint/blueprint.yaml",
      gitEnv,
      fixture.feature,
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Invalid base branch");
  });
});
