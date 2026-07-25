// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function fakeSleep(dir: string) {
  const executable = path.join(dir, "sleep");
  writeFileSync(executable, '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$1" >> "$SLEEP_LOG"\n', {
    mode: 0o755,
  });
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

describe("base image pull recovery (#7140)", () => {
  it("retries a transient transport failure and succeeds on the third attempt", () => {
    const bin = fakeDocker(`
count="$(cat "$PULL_COUNT" 2>/dev/null || printf 0)"
count=$((count + 1))
printf "%s\\n" "$count" > "$PULL_COUNT"
if ((count < 3)); then
  printf "%s\\n" "failed to do request: net/http: TLS handshake timeout" >&2
  exit 1
fi`);
    const pullCount = path.join(bin, "pull-count");
    const sleepLog = path.join(bin, "sleep.log");

    const result = run(
      `
sleep() { printf '%s\\n' "$1" >> "$SLEEP_LOG"; }
resolver_pull example:test`,
      {
        PATH: `${bin}:${process.env.PATH}`,
        PULL_COUNT: pullCount,
        SLEEP_LOG: sleepLog,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(pullCount, "utf8")).toBe("3\n");
    expect(readFileSync(sleepLog, "utf8")).toBe("1\n2\n");
    expect(result.stderr).toContain("TLS handshake timeout");
  });

  it("fails with a distinct status after exhausting transient registry retries", () => {
    const secret = "registry-bearer-secret";
    const bin = fakeDocker(`
count="$(cat "$PULL_COUNT" 2>/dev/null || printf 0)"
count=$((count + 1))
printf "%s\\n" "$count" > "$PULL_COUNT"
printf "%s\\n" "unexpected HTTP status: 503 Service Unavailable Authorization: Bearer $PULL_SECRET" >&2
exit 1`);
    const pullCount = path.join(bin, "pull-count");
    const sleepLog = path.join(bin, "sleep.log");

    const result = run(
      `
sleep() { printf '%s\\n' "$1" >> "$SLEEP_LOG"; }
resolver_pull example:test
printf 'unreachable'`,
      {
        PATH: `${bin}:${process.env.PATH}`,
        PULL_COUNT: pullCount,
        PULL_SECRET: secret,
        SLEEP_LOG: sleepLog,
      },
    );

    expect(result.status).toBe(75);
    expect(result.stdout).not.toContain("unreachable");
    expect(readFileSync(pullCount, "utf8")).toBe("3\n");
    expect(readFileSync(sleepLog, "utf8")).toBe("1\n2\n");
    expect(result.stderr).toContain("503 Service Unavailable");
    expect(result.stderr).toContain("[redacted]");
    expect(result.stderr).not.toContain(secret);
  });

  it.each([
    ["missing manifest", "manifest unknown"],
    ["missing manifest with transport text", "manifest unknown; service unavailable"],
    ["missing repository", "repository does not exist or may require 'docker login'"],
    ["authorization rejection", "unauthorized: authentication required"],
    ["HTTP authorization rejection", "unexpected HTTP status: 403 Service Unavailable"],
    ["digest mismatch", "downloaded layer does not match the expected digest"],
    ["invalid reference", "invalid reference format"],
    ["platform incompatibility", "no matching manifest for linux/arm64 in the manifest list"],
    ["HTTP bad request", "failed to do request: unexpected HTTP status: 400 Bad Request"],
    ["HTTP request timeout", "failed to do request: unexpected HTTP status: 408 Request Timeout"],
    ["HTTP client rejection", "failed to do request: unexpected HTTP status: 418 I'm a teapot"],
    [
      "HTTP client closed request",
      "failed to do request: unexpected HTTP status: 499 Client Closed",
    ],
    [
      "certificate verification rejection",
      "failed to do request: x509: certificate signed by unknown authority; connection reset",
    ],
    [
      "TLS certificate rejection",
      "failed to do request: remote error: tls: bad certificate; service unavailable",
    ],
    ["generic request rejection", "failed to do request"],
    ["unclassified daemon rejection", "daemon policy rejected this pull"],
  ])("does not retry a deterministic %s failure", (_name, diagnostic) => {
    const bin = fakeDocker(`
count="$(cat "$PULL_COUNT" 2>/dev/null || printf 0)"
count=$((count + 1))
printf "%s\\n" "$count" > "$PULL_COUNT"
printf "%s\\n" "$PULL_DIAGNOSTIC" >&2
exit 1`);
    const pullCount = path.join(bin, "pull-count");
    const sleepLog = path.join(bin, "sleep.log");

    const result = run(
      `
sleep() { printf '%s\\n' "$1" >> "$SLEEP_LOG"; }
resolver_pull example:test`,
      {
        PATH: `${bin}:${process.env.PATH}`,
        PULL_COUNT: pullCount,
        PULL_DIAGNOSTIC: diagnostic,
        SLEEP_LOG: sleepLog,
      },
    );

    expect(result.status).toBe(1);
    expect(readFileSync(pullCount, "utf8")).toBe("1\n");
    expect(result.stderr).toContain(diagnostic);
    expect(() => readFileSync(sleepLog, "utf8")).toThrow();
  });

  it.each([
    ["transport timeout", "net/http: TLS handshake timeout"],
    ["client timeout", "request canceled while waiting for connection (Client.Timeout exceeded)"],
    ["network outage", "dial tcp: network is unreachable"],
    ["HTTP server failure", "unexpected HTTP status: 502 Bad Gateway"],
    ["HTTP throttling", "unexpected HTTP status: 429 Too Many Requests"],
    ["registry rate limit", "toomanyrequests: rate limit exceeded"],
  ])("positively classifies a transient %s diagnostic", (_name, diagnostic) => {
    const result = run('resolver_pull_diagnostic_is_transient "$PULL_DIAGNOSTIC"', {
      PULL_DIAGNOSTIC: diagnostic,
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it("redacts complete credential headers and prevents log-command injection", () => {
    const basicSecret = "registry-password";
    const cookieSecret = "session-cookie-secret";
    const cookieSecondSecret = "second-cookie-secret";
    const foldedSecret = "folded-registry-secret";
    const negotiateSecret = "negotiate-registry-secret";
    const proxySecret = "proxy-registry-secret";
    const querySecret = "registry-query-token";
    const registryAuthSecret = "registry-auth-secret";
    const registryConfigSecret = "registry-config-secret";
    const setCookieSecret = "set-cookie-secret";
    const bin = fakeDocker(`
printf "%s\\r\\n" \
  "pull access denied at https://registry-user:$BASIC_SECRET@example.test/v2/image?token=$QUERY_SECRET" \
  "Authorization: Negotiate $NEGOTIATE_SECRET" \
  "Proxy-Authorization: CustomScheme $PROXY_SECRET" \
  "Cookie: session=$COOKIE_SECRET; second=$COOKIE_SECOND_SECRET" \
  "Set-Cookie: session=$SET_COOKIE_SECRET; Secure; HttpOnly, second=also-secret" \
  "X-Registry-Auth: $REGISTRY_AUTH_SECRET" \
  "X-Registry-Config: {\\"auth\\":\\"$REGISTRY_CONFIG_SECRET\\"}" \
  "Authorization:" \
  "  Bearer $FOLDED_SECRET" \
  $'\\033[31m\\r::warning::forged-pull-command' >&2
exit 1`);

    const result = run("resolver_pull example:test", {
      BASIC_SECRET: basicSecret,
      COOKIE_SECRET: cookieSecret,
      COOKIE_SECOND_SECRET: cookieSecondSecret,
      FOLDED_SECRET: foldedSecret,
      NEGOTIATE_SECRET: negotiateSecret,
      PATH: `${bin}:${process.env.PATH}`,
      PROXY_SECRET: proxySecret,
      QUERY_SECRET: querySecret,
      REGISTRY_AUTH_SECRET: registryAuthSecret,
      REGISTRY_CONFIG_SECRET: registryConfigSecret,
      SET_COOKIE_SECRET: setCookieSecret,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pull access denied");
    expect(result.stderr).toContain("[redacted]");
    for (const secret of [
      basicSecret,
      cookieSecret,
      cookieSecondSecret,
      foldedSecret,
      negotiateSecret,
      proxySecret,
      querySecret,
      registryAuthSecret,
      registryConfigSecret,
      setCookieSecret,
    ]) {
      expect(result.stderr).not.toContain(secret);
    }
    expect(result.stderr).not.toContain("\u001b");
    expect(result.stderr).not.toContain("\n::warning::forged-pull-command");
  });

  it.each([
    [
      "multiple Cookie values",
      "Cookie: first=cookie-one; second=cookie-two; preferences=dark mode",
      ["cookie-one", "cookie-two", "dark mode"],
    ],
    [
      "multiple Set-Cookie values",
      "Set-Cookie: first=set-cookie-one; Secure, second=set-cookie-two; HttpOnly",
      ["set-cookie-one", "set-cookie-two"],
    ],
    [
      "Docker registry authorization",
      "X-Registry-Auth: registry-auth-value",
      ["registry-auth-value"],
    ],
    [
      "Docker registry configuration",
      'X-Registry-Config: {"auths":{"registry.example":{"auth":"registry-config-value"}}}',
      ["registry-config-value"],
    ],
    [
      "arbitrary authorization scheme",
      "Authorization: Negotiate negotiate-value",
      ["negotiate-value"],
    ],
    [
      "arbitrary proxy authorization scheme",
      "Proxy-Authorization: CustomScheme proxy-value",
      ["proxy-value"],
    ],
    [
      "folded authorization value",
      "Authorization:\r\n\tNegotiate folded-negotiate-value",
      ["folded-negotiate-value"],
    ],
  ])("redacts a complete %s", (_name, raw, secrets) => {
    const result = run('printf "%s" "$RAW_DIAGNOSTIC" | resolver_sanitize_pull_diagnostic', {
      RAW_DIAGNOSTIC: raw,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[redacted]");
    for (const secret of secrets) expect(result.stdout).not.toContain(secret);
  });

  it("bounds captured stderr and preserves a deterministic Docker status", () => {
    const bin = fakeDocker(`
printf "%s\\n" "daemon policy rejected this pull" >&2
head -c 100000 /dev/zero | tr '\\0' x >&2
exit 42`);

    const result = run("resolver_pull example:test", {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: bin,
    });

    expect(result.status).toBe(42);
    expect(result.stderr).toContain("daemon policy rejected this pull");
    expect(result.stderr).toContain("diagnostic truncated at 65536 bytes");
    expect(result.stderr.length).toBeLessThan(1_000);
    expect(readdirSync(bin).filter((name) => name.startsWith("nemoclaw-docker-pull."))).toEqual([]);
  });

  it("bounds exhausted transient output and prevents a local Hermes build", () => {
    const bin = fakeDocker(`
printf "%s\\0" "$@" >> "$DOCKER_LOG"
printf "\\0" >> "$DOCKER_LOG"
if [[ "$1" == pull ]]; then
  printf "%s\\n" "unexpected status code 503: Service Unavailable" >&2
  head -c 100000 /dev/zero | tr '\\0' x >&2
  exit 1
fi
if [[ "$1" == build ]]; then exit 42; fi
exit 1`);
    fakeSleep(bin);
    const dockerLog = path.join(bin, "docker.log");
    const githubEnv = path.join(bin, "github.env");
    const sleepLog = path.join(bin, "sleep.log");
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
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: bin,
        SLEEP_LOG: sleepLog,
      },
    });

    expect(result.status).toBe(75);
    expect(readFileSync(githubEnv, "utf8")).toBe("");
    expect(readFileSync(sleepLog, "utf8")).toBe("1\n2\n");
    expect(result.stderr.match(/diagnostic truncated at 65536 bytes/g)).toHaveLength(3);
    const calls = readFileSync(dockerLog, "utf8")
      .split("\0\0")
      .filter(Boolean)
      .map((call) => call.split("\0").filter(Boolean));
    expect(calls.filter((args) => args[0] === "pull")).toHaveLength(3);
    expect(calls.some((args) => args[0] === "build")).toBe(false);
    expect(readdirSync(bin).filter((name) => name.startsWith("nemoclaw-docker-pull."))).toEqual([]);
  });
});
