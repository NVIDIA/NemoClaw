// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function run(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", `source "$HELPER"\n${script}`], {
    encoding: "utf8",
    env: { ...process.env, HELPER: helper, ...env },
  });
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
