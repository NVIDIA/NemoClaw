// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { npmPackFilePaths, parseSingleNpmPackResult } from "../helpers/npm-pack-result";
import { createPackageFixture } from "./helpers/package-fixture";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const sdkName = "@nvidia/openshell-sdk";
const publicDependencies = [
  "@bufbuild/protobuf",
  "@connectrpc/connect",
  "@connectrpc/connect-node",
];
const roots: string[] = [];

function fixture() {
  const root = createPackageFixture({
    prefix: "nemoclaw-sdk-install-",
    entries: [
      "scripts/lib/openshell-sdk-install.mts",
      "scripts/lib/reviewed-npm-archive.mts",
      "scripts/lib/reviewed-npm-cache.mts",
      "scripts/vendor/openshell-sdk",
      "ci/reviewed-npm-audit.json",
      "dist/lib/adapters/openshell/sdk-import.mjs",
    ],
  });
  roots.push(root);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    NPM_CONFIG_CACHE: path.join(root, "cache"),
    NPM_CONFIG_USERCONFIG: path.join(root, "empty.npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(root, "empty-global.npmrc"),
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
  };
  writeFileSync(env.NPM_CONFIG_USERCONFIG, "");
  writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, "");
  const run = (command: string, args: string[], cwd = root) =>
    spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 30_000 });
  const probe = (mode: string) =>
    run(process.execPath, ["scripts/lib/openshell-sdk-install.mts", mode]);
  const lock = JSON.parse(readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));
  const sourceManifest = JSON.parse(
    readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const manifest = {
    name: "nemoclaw-sdk-install-contract",
    version: "1.0.0",
    exports: { "./*": "./*" },
    files: ["ci/", "dist/", "scripts/"],
    bundleDependencies: sourceManifest.bundleDependencies.filter(
      (name: string) => name === sdkName,
    ),
    optionalDependencies: Object.fromEntries(
      [sdkName, ...publicDependencies].map((name) => [
        name,
        sourceManifest.optionalDependencies[name],
      ]),
    ),
    scripts: { postinstall: "node -e \"require('fs').writeFileSync('lifecycle-ran', 'yes')\"" },
  };
  const packages: Record<string, unknown> = { "": manifest };
  for (const name of [sdkName, ...publicDependencies]) {
    packages[`node_modules/${name}`] = lock.packages[`node_modules/${name}`];
  }
  // Public packages come from the test runner's installed dependencies. Repack
  // them locally so this contract needs neither a warm cache nor network access.
  for (const name of publicDependencies) {
    const source = path.join(root, "public-packages", name);
    mkdirSync(path.dirname(source), { recursive: true });
    cpSync(path.join(repositoryRoot, "node_modules", name), source, { recursive: true });
    const result = run("npm", ["pack", source, "--ignore-scripts", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    const packed = parseSingleNpmPackResult(result.stdout);
    assert.ok(packed.filename && packed.integrity, "Incomplete npm pack result");
    packages[`node_modules/${name}`] = {
      ...lock.packages[`node_modules/${name}`],
      resolved: `file:${path.join(root, packed.filename)}`,
      integrity: packed.integrity,
    };
  }
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
  rmSync(env.NPM_CONFIG_CACHE, { recursive: true, force: true });
  return { root, probe, run };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("required OpenShell SDK installation", () => {
  it("loads the SDK dependency tree from the release-built CLI artifact", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-sdk-release-artifact-"));
    roots.push(root);
    const env = {
      ...process.env,
      HOME: root,
      NEMOCLAW_INSTALLING: "1",
      NPM_CONFIG_CACHE: path.join(root, "cache"),
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
    };
    const packed = spawnSync(
      "npm",
      ["pack", "--ignore-scripts", "--silent", "--json", "--pack-destination", root],
      { cwd: repositoryRoot, env, encoding: "utf8", timeout: 30_000 },
    );
    expect(packed.status, packed.stderr).toBe(0);
    const archives = readdirSync(root).filter((entry) => entry.endsWith(".tgz"));
    expect(archives).toHaveLength(1);
    const archivePath = path.join(root, archives[0]!);
    const listing = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout.split("\n")).toEqual(
      expect.arrayContaining([
        "package/ci/reviewed-npm-audit.json",
        ...[sdkName, ...publicDependencies].map(
          (name) => `package/node_modules/${name}/package.json`,
        ),
      ]),
    );

    const extracted = path.join(root, "extracted");
    mkdirSync(extracted);
    const extraction = spawnSync("tar", ["-xzf", archivePath, "-C", extracted], {
      encoding: "utf8",
    });
    expect(extraction.status, extraction.stderr).toBe(0);
    const packageRoot = path.join(extracted, "package");
    const sdkImportUrl = pathToFileURL(
      path.join(packageRoot, "dist/lib/adapters/openshell/sdk-import.mjs"),
    ).href;
    const loaded = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { importOpenShellSdk, importOpenShellRawSdk } = await import(${JSON.stringify(sdkImportUrl)});
const sdk = await importOpenShellSdk();
const raw = await importOpenShellRawSdk();
console.log(JSON.stringify([typeof sdk.OpenShellClient.connect, raw.SandboxPolicySchema.typeName]));`,
      ],
      { cwd: packageRoot, encoding: "utf8", timeout: 30_000 },
    );
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(JSON.parse(loaded.stdout)).toEqual(["function", "openshell.sandbox.v1.SandboxPolicy"]);
  }, 60_000);

  it("installs offline without credentials and loads both compiled CLI SDK imports", () => {
    const { root, probe, run } = fixture();
    const before = readFileSync(path.join(root, "package-lock.json"), "utf8");
    const args = [
      "ci",
      "--ignore-scripts",
      "--prefer-offline",
      "--omit=optional",
      "--include=optional",
      "--@nvidia:registry=https://npm.pkg.github.com",
    ];
    // npm may silently omit this optional package. The installer must still fail.
    run("npm", args);
    expect(probe("check").status).toBe(1);
    const prepared = probe("prepare");
    expect(prepared.status, prepared.stderr).toBe(0);
    const installed = run("npm", args);
    expect(installed.status, installed.stderr).toBe(0);
    const checked = probe("check");
    expect(checked.status, checked.stderr).toBe(0);
    expect(readFileSync(path.join(root, "package-lock.json"), "utf8")).toBe(before);
    rmSync(path.join(root, "node_modules"), { recursive: true });
    const setupInstall = run("npm", ["install", ...args.slice(1)]);
    expect(setupInstall.status, setupInstall.stderr).toBe(0);
    const setupCheck = probe("check");
    expect(setupCheck.status, setupCheck.stderr).toBe(0);
    expect(existsSync(path.join(root, "lifecycle-ran"))).toBe(false);
    const packed = run("npm", ["pack", "--ignore-scripts", "--json"]);
    expect(packed.status, packed.stderr).toBe(0);
    const packedResult = parseSingleNpmPackResult(packed.stdout);
    assert.ok(packedResult.filename, "npm pack did not report an archive filename");
    expect(npmPackFilePaths(packed.stdout)).toEqual(
      expect.arrayContaining(
        [sdkName, ...publicDependencies].map((name) => `node_modules/${name}/package.json`),
      ),
    );
    const consumer = path.join(root, "packed-consumer");
    mkdirSync(consumer);
    writeFileSync(
      path.join(consumer, "package.json"),
      JSON.stringify({
        name: "packed-consumer",
        private: true,
        dependencies: {
          "nemoclaw-sdk-install-contract": `file:${path.join(root, packedResult.filename)}`,
        },
      }),
    );
    const packageInstall = run(
      "npm",
      ["install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"],
      consumer,
    );
    expect(packageInstall.status, packageInstall.stderr).toBe(0);
    const loaded = run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { importOpenShellSdk, importOpenShellRawSdk } from 'nemoclaw-sdk-install-contract/dist/lib/adapters/openshell/sdk-import.mjs';
const sdk = await importOpenShellSdk();
const raw = await importOpenShellRawSdk();
console.log(JSON.stringify([typeof sdk.OpenShellClient.connect, raw.SandboxPolicySchema.typeName]));`,
      ],
      consumer,
    );
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(JSON.parse(loaded.stdout)).toEqual(["function", "openshell.sandbox.v1.SandboxPolicy"]);
    rmSync(path.join(root, "node_modules", "@connectrpc", "connect-node"), { recursive: true });
    const broken = probe("check");
    expect(broken.status).toBe(1);
    expect(broken.stderr).toContain("npm run dev:setup");
  }, 60_000);

  it("rejects a changed archive before creating an npm cache", () => {
    const { root, probe } = fixture();
    const archive = path.join(
      root,
      "scripts/vendor/openshell-sdk/nvidia-openshell-sdk-0.0.116.tgz",
    );
    writeFileSync(archive, "corrupted archive");
    const result = probe("prepare");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("integrity");
    expect(existsSync(path.join(root, "cache"))).toBe(false);
  });

  it("rejects SDK identity drift from the reviewed package before creating an npm cache", () => {
    const { root, probe } = fixture();
    const configPath = path.join(root, "ci", "reviewed-npm-audit.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.sourceRegistryPackage.integrity = "sha512-reviewed-identity-drift";
    writeFileSync(configPath, JSON.stringify(config));

    const result = probe("prepare");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "package.json, package-lock.json, and reviewed identity must agree",
    );
    expect(existsSync(path.join(root, "cache"))).toBe(false);
  });
});
