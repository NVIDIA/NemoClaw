// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const runtimeRoot = "/usr/local/lib/nemoclaw/mcp-tool-discovery-runtime";
const dockerfiles = [
  "Dockerfile",
  "agents/hermes/Dockerfile",
  "agents/langchain-deepagents-code/Dockerfile",
] as const;

describe("MCP tool discovery image contract", () => {
  // source-shape-contract: security -- Exact package pins and the CI audit mapping protect the shipped runtime graph
  it("pins reviewed packages and audits their lock outside image builds (#8253)", () => {
    const packageRoot = path.join(repoRoot, "tools", "mcp-tool-discovery-runtime");
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(packageRoot, "package-lock.json"), "utf8"));
    const auditConfig = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "ci", "reviewed-npm-audit.json"), "utf8"),
    );
    const review = fs.readFileSync(path.join(packageRoot, "dependency-review.md"), "utf8");
    const installer = fs.readFileSync(
      path.join(packageRoot, "install-reviewed-runtime.sh"),
      "utf8",
    );
    const reviewedSdk = {
      name: "@modelcontextprotocol/sdk",
      version: "1.30.0",
      resolved: "https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.30.0.tgz",
      integrity:
        "sha512-xKd8OIzlqNzcqcNumGAa6g+PW2kjD5vrpcKOnfldAUPP3j7lnqMPwlTXQm8gF+UwH72z0lqaRbjr9hqGz0eITA==",
    } as const;
    const reviewedPackages = {
      "@hono/node-server": {
        version: "2.0.12",
        resolved: "https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.12.tgz",
        integrity:
          "sha512-eWpQYr67tqJLeaSUl0Q+TquuYfUdTibpOJlUMV2FfUP7+KqCC5TufnwnlXL6mobZBJbGAYRd7ZvEBDCbLInjhg==",
      },
      "fast-uri": {
        version: "3.1.5",
        resolved: "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.5.tgz",
        integrity:
          "sha512-gHwA1O9LDIcKunMKhObS/HimwtehO1nPUECKAu5TpKgaO19fcWEl4bliWe1jWxVFvIXztJjjQ4L8XQ1EU9f7Jw==",
      },
      hono: {
        version: "4.12.34",
        resolved: "https://registry.npmjs.org/hono/-/hono-4.12.34.tgz",
        integrity:
          "sha512-GqXJqY/xJkJmuloTrnV1ZEXG3fqte+VjkUqoRNZXcrUidiUOP4fMSIHHY4tsqZBK++kVyWmt/AAfSUuy57/eSA==",
      },
      "ip-address": {
        version: "10.3.1",
        resolved: "https://registry.npmjs.org/ip-address/-/ip-address-10.3.1.tgz",
        integrity:
          "sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==",
      },
    } as const;

    expect(manifest.dependencies[reviewedSdk.name]).toBe(reviewedSdk.version);
    expect(lock.packages[`node_modules/${reviewedSdk.name}`]).toMatchObject({
      version: reviewedSdk.version,
      resolved: reviewedSdk.resolved,
      integrity: reviewedSdk.integrity,
    });
    expect(review).toContain(`\`${reviewedSdk.name}@${reviewedSdk.version}\``);
    expect(review).toContain(`\`${reviewedSdk.integrity}\``);
    expect(manifest.overrides).toEqual(
      Object.fromEntries(
        Object.entries(reviewedPackages).map(([packageName, metadata]) => [
          packageName,
          metadata.version,
        ]),
      ),
    );
    for (const [packageName, metadata] of Object.entries(reviewedPackages)) {
      expect(lock.packages[`node_modules/${packageName}`]).toMatchObject(metadata);
      expect(review).toContain(`\`${packageName}@${metadata.version}\``);
      expect(review).toContain(`\`${metadata.integrity}\``);
    }
    expect(
      installer
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("npm audit")),
    ).toEqual(["npm audit signatures"]);
    expect(auditConfig.lockedGraphs).toContainEqual({
      id: "mcp-tool-discovery-runtime",
      label: "MCP tool discovery runtime locked production graph",
      packageSpec: `${reviewedSdk.name}@${reviewedSdk.version}`,
      integrity: reviewedSdk.integrity,
      tarballUrl: reviewedSdk.resolved,
      directory: "tools/mcp-tool-discovery-runtime",
      lockSha256: "bc7e34d9eb1f72cf3016c8b88c72d3b7682a4f234903cb93b9476b10d7e954eb",
    });
    expect(installer).toContain(
      'export NODE_OPTIONS="${NODE_OPTIONS:---dns-result-order=ipv4first}"',
    );
    expect(installer).toContain('export NPM_CONFIG_MAXSOCKETS="${NPM_CONFIG_MAXSOCKETS:-4}"');
    const openClawDockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    expect(openClawDockerfile).toContain("FROM builder AS mcp-tool-discovery-runtime");
    expect(openClawDockerfile).toContain("RUN /opt/nemoclaw-build-tools/npm-ci-locked.sh");
  });

  it.each(
    dockerfiles,
  )("%s installs and probes the bundled runtime at its canonical path (#6901)", (relativePath) => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

    expect(dockerfile).toContain(
      `COPY --from=mcp-tool-discovery-runtime /opt/mcp-tool-discovery-runtime/dist/ ${runtimeRoot}/`,
    );
    expect(dockerfile).toContain("tools/mcp-tool-discovery-runtime/npm-ci-locked.sh");
    expect(dockerfile).toContain(`node ${runtimeRoot}/mcp-tool-discovery.mjs`);
    expect(dockerfile).not.toContain(`${runtimeRoot}/mcp-tool-discovery.ts`);
  });

  it.skipIf(process.platform === "win32")(
    "completes npm's exact internal exit-handler failure from locked cache archives",
    () => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-install-retry-"));
      const script = path.join(fixture, "install-reviewed-runtime.sh");
      const mockBin = path.join(fixture, "bin");
      const counter = path.join(fixture, "npm-counter");
      const invocations = path.join(fixture, "npm-invocations");
      fs.mkdirSync(mockBin);
      fs.copyFileSync(
        path.join(repoRoot, "tools", "mcp-tool-discovery-runtime", "install-reviewed-runtime.sh"),
        script,
      );
      fs.copyFileSync(
        path.join(repoRoot, "tools", "mcp-tool-discovery-runtime", "package-lock.json"),
        path.join(fixture, "package-lock.json"),
      );
      const retryHelper = path.join(fixture, "npm-ci-locked.sh");
      fs.copyFileSync(
        path.join(repoRoot, "tools", "mcp-tool-discovery-runtime", "npm-ci-locked.sh"),
        retryHelper,
      );
      fs.chmodSync(retryHelper, 0o755);
      fs.writeFileSync(counter, "0\n");
      fs.writeFileSync(
        path.join(mockBin, "npm"),
        `#!/bin/sh
set -eu
invocation=$(cat "$NEMOCLAW_TEST_NPM_COUNTER")
invocation=$((invocation + 1))
printf '%s\n' "$invocation" >"$NEMOCLAW_TEST_NPM_COUNTER"
printf '%s\n' "$*" >>"$NEMOCLAW_TEST_NPM_INVOCATIONS"
if [ "$invocation" -eq 1 ]; then
  echo 'npm error Exit handler never called!' >&2
  exit 1
fi
if [ "$invocation" -eq 2 ]; then
  echo 'npm error code ENOTCACHED' >&2
  echo 'npm error request to https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.30.0.tgz failed: cache mode is only-if-cached but no cached response is available.' >&2
  exit 1
fi
case "$invocation" in
  3|4)
    echo 'npm error code EAI_AGAIN' >&2
    echo 'npm error syscall getaddrinfo' >&2
    echo 'npm error request failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org' >&2
    exit 1
    ;;
esac
exit 0
`,
        { mode: 0o755 },
      );

      try {
        const result = spawnSync("/bin/sh", [script], {
          encoding: "utf8",
          env: {
            ...process.env,
            NEMOCLAW_TEST_NPM_COUNTER: counter,
            NEMOCLAW_TEST_NPM_INVOCATIONS: invocations,
            PATH: `${mockBin}:${process.env.PATH ?? ""}`,
          },
        });

        expect(result.status).toBe(0);
        expect(result.stderr).toContain("completing the locked install offline from cache");
        expect(result.stderr).toContain("fetching one missing lockfile archive for offline retry");
        expect(result.stderr).toContain(
          "retrying the missing lockfile archive after a transient network failure",
        );
        expect(fs.readFileSync(counter, "utf8").trim()).toBe("10");
        expect(fs.readFileSync(invocations, "utf8").trim().split("\n").slice(0, 6)).toEqual([
          "ci --ignore-scripts --no-audit --no-fund --no-progress",
          "ci --ignore-scripts --no-audit --no-fund --no-progress --offline",
          "cache add https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.30.0.tgz",
          "cache add https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.30.0.tgz",
          "cache add https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.30.0.tgz",
          "ci --ignore-scripts --no-audit --no-fund --no-progress --offline",
        ]);
      } finally {
        fs.rmSync(fixture, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not retry a non-internal locked-install failure",
    () => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-install-failure-"));
      const script = path.join(fixture, "install-reviewed-runtime.sh");
      const mockBin = path.join(fixture, "bin");
      const counter = path.join(fixture, "npm-counter");
      fs.mkdirSync(mockBin);
      fs.copyFileSync(
        path.join(repoRoot, "tools", "mcp-tool-discovery-runtime", "install-reviewed-runtime.sh"),
        script,
      );
      const retryHelper = path.join(fixture, "npm-ci-locked.sh");
      fs.copyFileSync(
        path.join(repoRoot, "tools", "mcp-tool-discovery-runtime", "npm-ci-locked.sh"),
        retryHelper,
      );
      fs.chmodSync(retryHelper, 0o755);
      fs.writeFileSync(counter, "0\n");
      fs.writeFileSync(
        path.join(mockBin, "npm"),
        `#!/bin/sh
set -eu
invocation=$(cat "$NEMOCLAW_TEST_NPM_COUNTER")
invocation=$((invocation + 1))
printf '%s\n' "$invocation" >"$NEMOCLAW_TEST_NPM_COUNTER"
echo 'npm error lock verification failed' >&2
exit 42
`,
        { mode: 0o755 },
      );

      try {
        const result = spawnSync("/bin/sh", [script], {
          encoding: "utf8",
          env: {
            ...process.env,
            NEMOCLAW_TEST_NPM_COUNTER: counter,
            PATH: `${mockBin}:${process.env.PATH ?? ""}`,
          },
        });

        expect(result.status).toBe(42);
        expect(result.stderr).not.toContain("retrying the locked install once");
        expect(fs.readFileSync(counter, "utf8").trim()).toBe("1");
      } finally {
        fs.rmSync(fixture, { force: true, recursive: true });
      }
    },
  );
});
