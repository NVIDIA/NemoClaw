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

const repoRoot = path.join(import.meta.dirname, "..");
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
    expect(installer).not.toContain("npm audit signatures");
    const reviewedAuditDriver = fs.readFileSync(
      path.join(repoRoot, "scripts", "audit-reviewed-npm-graph.mts"),
      "utf8",
    );
    expect(reviewedAuditDriver).toContain('["audit", "signatures", "--omit=dev"]');
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
    expect(openClawDockerfile).toContain("FROM scratch AS mcp-tool-discovery-runtime");
    expect(openClawDockerfile).toContain(
      "COPY tools/mcp-tool-discovery-runtime/npm-cache-seed/ /opt/nemoclaw-build-tools/npm-cache-seed/",
    );
    expect(openClawDockerfile).toContain(
      "COPY tools/mcp-tool-discovery-runtime/npm-cache-seed/ /usr/local/lib/nemoclaw-build-tools/npm-cache-seed/",
    );
    expect(openClawDockerfile).toContain(
      "COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/mcp-tool-discovery.bundle /opt/mcp-tool-discovery-runtime/dist/mcp-tool-discovery.mjs",
    );
    expect(openClawDockerfile).not.toContain("mcp-runtime-npm-cache-seed/");
    expect(openClawDockerfile).not.toContain("install-reviewed-runtime.sh");
  });

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
      archiveCount: 81,
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
    for (const archive of manifest.archives) {
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
    }
  });

  it("does not commit MCP runtime registry archives", () => {
    const seedDirectory = path.join(
      repoRoot,
      "tools/mcp-tool-discovery-runtime/mcp-runtime-npm-cache-seed",
    );
    const trackedSeedFiles = fs.readdirSync(seedDirectory).filter((name) => name !== ".gitkeep");

    expect(trackedSeedFiles).toEqual([]);
  });

  it("pins the reviewed image runtime artifacts exactly", () => {
    const bundleRoot = path.join(
      repoRoot,
      "tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle",
    );
    const expectedHashes = {
      "managed-startup-image-runtime.bundle":
        "8522801ee753f87723ea5181ca52edbe5810e6d4aeeba9e678a6b28bddfbb51e",
      "mcp-tool-discovery/BUNDLED_PACKAGES.json":
        "df5dc8f167101085a8e73c444aa56854b2a4716a0bb7de9886fec4e50f402601",
      "mcp-tool-discovery/THIRD_PARTY_LICENSES.txt":
        "ae0820debd0e33a10baa3a9c6c7ea831e8ad32a43f8500d52c7dc961ba5513a5",
      "mcp-tool-discovery/mcp-tool-discovery.bundle":
        "defdba693829bfdfad16ce2edaad6b0a454388a32f15113854850e652a950012",
    } as const;

    for (const [relativePath, expectedHash] of Object.entries(expectedHashes)) {
      const actualHash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(bundleRoot, relativePath)))
        .digest("hex");
      expect(actualHash, relativePath).toBe(expectedHash);
    }

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

  // source-shape-contract: compatibility -- Protected rebuilds must materialize mutable dependency graphs in explicit offline stages
  it("pins dependency-materialization RUN cache identity", () => {
    const openClawDockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    const managedMessagingRuntimePackage = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "agents/openclaw/managed-image-messaging-runtime/package.json"),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    const hermesDockerfile = fs.readFileSync(
      path.join(repoRoot, "agents/hermes/Dockerfile"),
      "utf8",
    );
    const dcodeDockerfile = fs.readFileSync(
      path.join(repoRoot, "agents/langchain-deepagents-code/Dockerfile"),
      "utf8",
    );

    expect(openClawDockerfile.match(/--network=default\b/gu)).toHaveLength(3);
    expect(openClawDockerfile.match(/^RUN --network=none\b/gmu)).toHaveLength(4);
    expect(openClawDockerfile).toContain(
      "RUN --network=none --mount=from=openclaw-optional-plugin-archives,target=/opt/nemoclaw-reviewed-npm-archives,ro",
    );
    expect(openClawDockerfile).toContain("AS wechat-npm-cache");
    expect(openClawDockerfile).toContain("AS codex-acp-runtime");
    expect(managedMessagingRuntimePackage.dependencies).toEqual({
      "@openclaw/discord": "2026.7.1",
      "@openclaw/googlechat": "2026.7.1",
      "@openclaw/msteams": "2026.7.1",
      "@openclaw/slack": "2026.7.1",
      "@openclaw/whatsapp": "2026.7.1",
      "@tencent-weixin/openclaw-weixin": "2.4.3",
      "agent-base": "6.0.2",
      axios: "1.18.0",
      "https-proxy-agent": "5.0.1",
      undici: "8.10.0",
    });
    expect(openClawDockerfile).toContain("AS openclaw-managed-messaging-npm-cache-0");
    expect(openClawDockerfile).toContain("AS openclaw-managed-messaging-npm-cache-1");
    expect(openClawDockerfile).toContain(
      "FROM openclaw-managed-messaging-npm-cache-${NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION} AS openclaw-managed-messaging-npm-cache",
    );
    expect(openClawDockerfile).toContain(
      "--archive-directory /opt/nemoclaw-build-tools/npm-cache-seed",
    );
    expect(openClawDockerfile).toContain('--os linux --cpu "$npm_target_cpu" --libc glibc');
    expect(openClawDockerfile).toContain("--packuments-only");
    expect(openClawDockerfile).toContain('export NPM_CONFIG_CACHE="$install_cache"');
    expect(openClawDockerfile).toContain("export NPM_CONFIG_OFFLINE=true");
    expect(hermesDockerfile.match(/^RUN --network=default\b/gmu) ?? []).toHaveLength(0);
    expect(dcodeDockerfile.match(/^RUN --network=default\b/gmu) ?? []).toHaveLength(0);
  });

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
