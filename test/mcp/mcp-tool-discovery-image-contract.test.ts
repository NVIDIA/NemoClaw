// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "../..");
const runtimeRoot = "/usr/local/lib/nemoclaw/mcp-tool-discovery-runtime";
const dockerfiles = [
  "Dockerfile",
  "agents/hermes/Dockerfile",
  "agents/langchain-deepagents-code/Dockerfile",
] as const;

function createCacheSeedFixture(): {
  cache: string;
  fixture: string;
  retryHelper: string;
  seed: string;
} {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-npm-cache-seed-"));
  const cache = path.join(fixture, "cache");
  const retryHelper = path.join(fixture, "npm-ci-locked.sh");
  const seedDirectory = path.join(fixture, "npm-cache-seed");
  const seedNames = ["yallist-5.0.0.tgz", "yaml-2.8.3.tgz", "yoctocolors-2.1.2.tgz"];
  const seed = path.join(seedDirectory, seedNames[0]);
  fs.mkdirSync(seedDirectory);
  fs.copyFileSync(
    path.join(repoRoot, "tools", "mcp-tool-discovery-runtime", "npm-ci-locked.sh"),
    retryHelper,
  );
  fs.chmodSync(retryHelper, 0o755);
  for (const seedName of seedNames) {
    fs.copyFileSync(
      path.join(repoRoot, "tools", "mcp-tool-discovery-runtime", "npm-cache-seed", seedName),
      path.join(seedDirectory, seedName),
    );
  }
  const splitSeed = path.join(seedDirectory, "yaml-2.8.3.tgz");
  const splitSeedBytes = fs.readFileSync(splitSeed);
  const splitOffset = Math.ceil(splitSeedBytes.length / 2);
  fs.unlinkSync(splitSeed);
  fs.writeFileSync(`${splitSeed}.part-000`, splitSeedBytes.subarray(0, splitOffset));
  fs.writeFileSync(`${splitSeed}.part-001`, splitSeedBytes.subarray(splitOffset));
  fs.writeFileSync(
    path.join(fixture, "package.json"),
    `${JSON.stringify(
      {
        name: "cache-seed-contract",
        private: true,
        dependencies: { yallist: "5.0.0", yaml: "2.8.3", yoctocolors: "2.1.2" },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(fixture, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "cache-seed-contract",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "cache-seed-contract",
            dependencies: {
              yallist: "5.0.0",
              yaml: "2.8.3",
              yoctocolors: "2.1.2",
            },
          },
          "node_modules/yallist": {
            version: "5.0.0",
            resolved: "https://registry.npmjs.org/yallist/-/yallist-5.0.0.tgz",
            integrity:
              "sha512-YgvUTfwqyc7UXVMrB+SImsVYSmTS8X/tSrtdNZMImM+n7+QTriRXyXim0mBrTXNeqzVF0KWGgHPeiyViFFrNDw==",
          },
          "node_modules/yaml": {
            version: "2.8.3",
            resolved: "https://registry.npmjs.org/yaml/-/yaml-2.8.3.tgz",
            integrity:
              "sha512-AvbaCLOO2Otw/lW5bmh9d/WEdcDFdQp2Z2ZUH3pX9U2ihyUY0nvLv7J6TrWowklRGPYbB/IuIMfYgxaCPg5Bpg==",
          },
          "node_modules/yoctocolors": {
            version: "2.1.2",
            resolved: "https://registry.npmjs.org/yoctocolors/-/yoctocolors-2.1.2.tgz",
            integrity:
              "sha512-CzhO+pFNo8ajLM2d2IW/R93ipy99LWjtwblvC1RsoSUMZgyLbYFr221TnSNT7GjGdYui6P459mw9JH/g/zW2ug==",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return { cache, fixture, retryHelper, seed };
}

describe("MCP tool discovery image contract", () => {
  it.skipIf(process.platform === "win32")(
    "installs the complete pinned cache seed offline before registry access",
    async () => {
      const { cache, fixture, retryHelper } = createCacheSeedFixture();

      try {
        const installResult = spawnSync("/bin/sh", [retryHelper, "--ignore-scripts"], {
          encoding: "utf8",
          cwd: fixture,
          env: { ...process.env, NPM_CONFIG_CACHE: cache },
        });

        expect(installResult).toMatchObject({ status: 0 });
        const installedModule = await import(
          pathToFileURL(path.join(fixture, "node_modules", "yoctocolors", "index.js")).href
        );
        const installedYaml = await import(
          pathToFileURL(path.join(fixture, "node_modules", "yaml", "dist", "index.js")).href
        );
        expect(stripVTControlCharacters(installedModule.default.red("offline cache seed"))).toBe(
          "offline cache seed",
        );
        expect(installedYaml.parse("enabled: true")).toEqual({ enabled: true });
        expect(fs.existsSync(path.join(fixture, "node_modules", "yallist", "dist"))).toBe(true);
      } finally {
        fs.rmSync(fixture, { force: true, recursive: true });
      }
    },
  );

  it.each([
    {
      archiveCount: 85,
      label: "NemoClaw CLI",
      lockfile: "nemoclaw/package-lock.json",
      seedDirectory: "tools/mcp-tool-discovery-runtime/npm-cache-seed",
    },
  ])("pins every reachable $label lockfile archive for protected Linux x64 builds", (fixture) => {
    const seedDirectory = path.join(repoRoot, fixture.seedDirectory);
    const manifest = JSON.parse(fs.readFileSync(path.join(seedDirectory, "manifest.json"), "utf8"));
    const seedNames = fs
      .readdirSync(seedDirectory)
      .filter((seedName) => seedName !== "manifest.json")
      .sort();
    const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, fixture.lockfile), "utf8"));

    expect(manifest).toMatchObject({
      archiveCount: fixture.archiveCount,
      kind: "nemoclaw-locked-npm-cache-seed-v1",
      target: { cpu: "x64", libc: "glibc", os: "linux" },
    });
    expect(manifest.archives).toHaveLength(manifest.archiveCount);
    expect(
      seedNames
        .map((seedName) => fs.statSync(path.join(seedDirectory, seedName)).size)
        .every((size) => size <= 2_000_000),
    ).toBe(true);
    manifest.archives.forEach(
      (archive: { archive: string; integrity: string; size: number }) => {
      const archiveParts = seedNames.filter(
        (seedName) =>
          seedName === archive.archive || seedName.startsWith(`${archive.archive}.part-`),
      );
      const expectedParts =
        archiveParts.length === 1 && archiveParts[0] === archive.archive
          ? [archive.archive]
          : archiveParts.map(
              (_seedName, index) => `${archive.archive}.part-${String(index).padStart(3, "0")}`,
            );
      const seed = Buffer.concat(
        archiveParts.map((seedName) => fs.readFileSync(path.join(seedDirectory, seedName))),
      );
      const integrity = `sha512-${crypto.createHash("sha512").update(seed).digest("base64")}`;
      const matches = (
        Object.values(lock.packages) as Array<{ integrity?: string; resolved?: string }>
      ).filter(
        (entry) =>
          entry.integrity === integrity &&
          path.basename(new URL(entry.resolved ?? "https://invalid.invalid/").pathname) ===
            archive.archive,
      );

      expect(archiveParts).toEqual(expectedParts);
      expect(seed).toHaveLength(archive.size);
      expect(integrity).toBe(archive.integrity);
      expect(matches.length).toBeGreaterThan(0);
      },
    );
  });

  it("does not commit MCP runtime registry archives", () => {
    const seedDirectory = path.join(
      repoRoot,
      "tools/mcp-tool-discovery-runtime/mcp-runtime-npm-cache-seed",
    );
    const trackedSeedFiles = fs.readdirSync(seedDirectory).filter((name) => name !== ".gitkeep");

    expect(trackedSeedFiles).toEqual([]);
  });

  // source-shape-contract: security -- Exact reviewed runtime digests reject substituted executable and license artifacts before managed image construction.
  it.each([
    {
      expectedHash: "7d6882c3eac815f503e7ec318249ae369e142ff97e42ddc65ac1986dc3f06605",
      relativePath: "managed-startup-image-runtime.bundle",
    },
    {
      expectedHash: "df5dc8f167101085a8e73c444aa56854b2a4716a0bb7de9886fec4e50f402601",
      relativePath: "mcp-tool-discovery/BUNDLED_PACKAGES.json",
    },
    {
      expectedHash: "ae0820debd0e33a10baa3a9c6c7ea831e8ad32a43f8500d52c7dc961ba5513a5",
      relativePath: "mcp-tool-discovery/THIRD_PARTY_LICENSES.txt",
    },
    {
      expectedHash: "5622323afbace37445582fa889da4cfbae31bf8ecb2a5bab571026f9cc479fdb",
      relativePath: "mcp-tool-discovery/mcp-tool-discovery.bundle",
    },
  ])("pins the reviewed image runtime artifacts exactly", ({ expectedHash, relativePath }) => {
    const bundleRoot = path.join(
      repoRoot,
      "tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle",
    );
    const actualHash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(bundleRoot, relativePath)))
      .digest("hex");
    expect(actualHash, relativePath).toBe(expectedHash);
  });

  it("executes the reviewed MCP discovery runtime artifact", () => {
    const bundleRoot = path.join(
      repoRoot,
      "tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle",
    );
    const executableFixture = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-reviewed-mcp-runtime-"),
    );
    try {
      const executablePath = path.join(executableFixture, "mcp-tool-discovery.mjs");
      fs.copyFileSync(
        path.join(bundleRoot, "mcp-tool-discovery/mcp-tool-discovery.bundle"),
        executablePath,
      );
      const discoveryResult = spawnSync(process.execPath, [executablePath], { encoding: "utf8" });
      expect(discoveryResult).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(discoveryResult.stdout)).toEqual({
        protocol: 1,
        ok: false,
        count: 0,
        tools: [],
        truncated: false,
        detail: "tool discovery received invalid runtime arguments",
      });
    } finally {
      fs.rmSync(executableFixture, { force: true, recursive: true });
    }
  });

  it("accepts Pi only in the refreshed reviewed managed startup runtime", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-startup-runtime-"));
    const bundlePath = path.join(
      repoRoot,
      "tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/managed-startup-image-runtime.bundle",
    );
    const staleBundlePath = path.join(fixture, "stale-managed-startup-image-runtime.cjs");
    const completionFile = path.join(fixture, "managed-bootstrap-completion.json");
    const startupCompletionFile = path.join(fixture, "managed-startup-complete.json");
    const runtimeEnvironmentFile = path.join(fixture, "managed-startup-runtime.env");
    const bootstrapIdentity = "a".repeat(64);
    const profileFingerprint = "b".repeat(64);
    const runtimeEnvironment = "export NEMOCLAW_MODEL='nvidia/test'\n";
    const runtimeEnvironmentSha256 = crypto
      .createHash("sha256")
      .update(runtimeEnvironment, "utf8")
      .digest("hex");
    const verificationScript = `
      const fs = require("node:fs");
      const originalFstatSync = fs.fstatSync;
      fs.fstatSync = (descriptor, options) => {
        const stat = originalFstatSync(descriptor, options);
        return new Proxy(stat, {
          get(target, property) {
            if (property === "uid" || property === "gid") return 0n;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };
      const [bundle, completion, startupCompletion, runtimeEnvironment, expected] =
        process.argv.slice(1);
      try {
        const runtime = require(bundle);
        const receipt = runtime.verifyManagedBootstrapImageCompletion(
          JSON.parse(expected),
          completion,
          startupCompletion,
          runtimeEnvironment,
        );
        process.stdout.write(JSON.stringify(receipt));
      } catch (error) {
        process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n");
        process.exitCode = 1;
      }
    `;

    try {
      fs.writeFileSync(
        completionFile,
        `${JSON.stringify({
          agent: "pi",
          bootstrapIdentity,
          profileFingerprint,
          schemaVersion: 1,
          transactionPending: false,
        })}\n`,
        { mode: 0o444 },
      );
      fs.writeFileSync(
        startupCompletionFile,
        `${JSON.stringify({
          agent: "pi",
          corporateCaMerged: false,
          profileFingerprint,
          runtimeEnvironmentSha256,
          schemaVersion: 1,
        })}\n`,
        { mode: 0o444 },
      );
      fs.writeFileSync(runtimeEnvironmentFile, runtimeEnvironment, { mode: 0o444 });
      const reviewedAgentRegistry = '["openclaw","hermes","langchain-deepagents-code","pi"]';
      const staleAgentRegistry = '["openclaw","hermes","langchain-deepagents-code"]';
      const reviewedBundle = fs.readFileSync(bundlePath, "utf8");
      fs.writeFileSync(
        staleBundlePath,
        reviewedBundle.replace(reviewedAgentRegistry, staleAgentRegistry),
      );
      const expectedReceipt = JSON.stringify({
        agent: "pi",
        bootstrapIdentity,
        profileFingerprint,
      });
      const verifyBundle = (candidateBundlePath: string) =>
        spawnSync(
          process.execPath,
          [
            "-e",
            verificationScript,
            candidateBundlePath,
            completionFile,
            startupCompletionFile,
            runtimeEnvironmentFile,
            expectedReceipt,
          ],
          { encoding: "utf8" },
        );
      const result = verifyBundle(bundlePath);

      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 1,
        bootstrapIdentity,
        agent: "pi",
        profileFingerprint,
        transactionPending: false,
      });
      expect(verifyBundle(staleBundlePath)).toMatchObject({
        status: 1,
        stdout: "",
        stderr: "Managed bootstrap envelope is invalid: image completion schema is invalid\n",
      });
    } finally {
      fs.rmSync(fixture, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a cache seed that does not match the lockfile integrity",
    () => {
      const { cache, fixture, retryHelper, seed } = createCacheSeedFixture();
      fs.chmodSync(seed, 0o644);
      fs.appendFileSync(seed, "tampered");

      try {
        const installResult = spawnSync("/bin/sh", [retryHelper, "--offline"], {
          encoding: "utf8",
          cwd: fixture,
          env: { ...process.env, NPM_CONFIG_CACHE: cache },
        });

        expect(installResult).toMatchObject({ status: 1 });
        expect(installResult.stderr).toContain(
          "refusing an npm cache seed not pinned by package-lock.json",
        );
      } finally {
        fs.rmSync(fixture, { force: true, recursive: true });
      }
    },
  );

  it.each(
    dockerfiles,
  )("%s copies and probes the bundled runtime at its canonical path (#6901)", (relativePath) => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

    expect(dockerfile).toContain(
      "COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/mcp-tool-discovery.bundle /opt/mcp-tool-discovery-runtime/dist/mcp-tool-discovery.mjs",
    );
    expect(dockerfile).toContain(
      "COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/managed-startup-image-runtime.bundle /out/managed-startup-image-runtime.cjs",
    );
    expect(dockerfile).toContain(
      `COPY --from=mcp-tool-discovery-runtime /opt/mcp-tool-discovery-runtime/dist/ ${runtimeRoot}/`,
    );
    expect(dockerfile).not.toContain("mcp-runtime-npm-cache-seed/");
    expect(dockerfile).not.toContain("install-reviewed-runtime.sh");
    expect(dockerfile).toContain(`node ${runtimeRoot}/mcp-tool-discovery.mjs`);
    expect(dockerfile).not.toContain(`${runtimeRoot}/mcp-tool-discovery.ts`);
  });

  it.skipIf(process.platform === "win32")(
    "accepts a complete locked tree after npm's exact internal exit-handler failure",
    () => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-npm-complete-tree-"));
      const retryHelper = path.join(fixture, "npm-ci-locked.sh");
      const mockBin = path.join(fixture, "bin");
      const invocations = path.join(fixture, "npm-invocations");
      fs.mkdirSync(mockBin);
      fs.copyFileSync(
        path.join(repoRoot, "tools", "mcp-tool-discovery-runtime", "npm-ci-locked.sh"),
        retryHelper,
      );
      fs.chmodSync(retryHelper, 0o755);
      fs.writeFileSync(
        path.join(mockBin, "npm"),
        `#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$NEMOCLAW_TEST_NPM_INVOCATIONS"
case "$1" in
  ci)
    echo 'npm error Exit handler never called!' >&2
    exit 1
    ;;
  ls)
    exit 0
    ;;
  *)
    exit 99
    ;;
esac
`,
        { mode: 0o755 },
      );

      try {
        const result = spawnSync("/bin/sh", [retryHelper, "--omit=dev"], {
          encoding: "utf8",
          cwd: fixture,
          env: {
            ...process.env,
            NEMOCLAW_TEST_NPM_INVOCATIONS: invocations,
            PATH: `${mockBin}:${process.env.PATH ?? ""}`,
          },
        });

        expect(result.status).toBe(0);
        expect(result.stderr).toContain(
          "internal exit-handler failure after completing the locked dependency tree",
        );
        expect(fs.readFileSync(invocations, "utf8").trim().split("\n")).toEqual([
          "ci --omit=dev",
          "ls --all --json --omit=dev",
        ]);
      } finally {
        fs.rmSync(fixture, { force: true, recursive: true });
      }
    },
  );

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
case "$invocation" in
  1)
    echo 'npm error Exit handler never called!' >&2
    exit 1
    ;;
  2)
    echo 'npm error code ELSPROBLEMS' >&2
    echo 'npm error missing: reviewed dependency tree is incomplete' >&2
    exit 1
    ;;
  3)
    echo 'npm error code ENOTCACHED' >&2
    echo 'npm error request to https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.30.0.tgz failed: cache mode is only-if-cached but no cached response is available.' >&2
    exit 1
    ;;
  4|5)
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
        expect(result.stderr).toContain(
          "before completing the locked dependency tree; completing it offline from cache",
        );
        expect(result.stderr).toContain("fetching one missing lockfile archive for offline retry");
        expect(result.stderr).toContain(
          "retrying the missing lockfile archive after a transient network failure",
        );
        expect(fs.readFileSync(counter, "utf8").trim()).toBe("10");
        expect(fs.readFileSync(invocations, "utf8").trim().split("\n").slice(0, 7)).toEqual([
          "ci --ignore-scripts --no-audit --no-fund --no-progress",
          "ls --all --json --ignore-scripts --no-audit --no-fund --no-progress",
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
