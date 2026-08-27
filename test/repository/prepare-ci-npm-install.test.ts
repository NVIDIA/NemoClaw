// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  prepareCiNpmInstallWithReviewedConfig,
  seedReviewedSourceRegistryArtifact,
  type ReviewedSourceRegistryPackage,
} from "../../scripts/checks/prepare-ci-npm-install.mts";

const temporaryRoots: string[] = [];
const archiveBytes = Buffer.from("reviewed OpenShell SDK fixture");
const artifactName = "nvidia-openshell-sdk-0.0.106.tgz";
const reviewed: ReviewedSourceRegistryPackage = {
  artifactName,
  integrity: `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`,
  label: "OpenShell TypeScript SDK 0.0.106",
  packageSpec: "@nvidia/openshell-sdk@0.0.106",
  tarballUrl: "https://npm.pkg.github.com/download/@nvidia/openshell-sdk/0.0.106/reviewed-fixture",
};

type CacheStageRequest = Readonly<{
  archive: Buffer;
  artifactName: string;
  cacheDirectory: string;
}>;

function cacheStageMock() {
  return vi.fn((_request: CacheStageRequest) => undefined);
}

function reviewedLock(packageIdentity: ReviewedSourceRegistryPackage = reviewed) {
  return {
    lockfileVersion: 3,
    name: "reviewed-sdk-artifact-fixture",
    packages: {
      "": { dependencies: { "@nvidia/openshell-sdk": "0.0.106" } },
      "node_modules/@nvidia/openshell-sdk": {
        integrity: packageIdentity.integrity,
        resolved: packageIdentity.tarballUrl,
        version: "0.0.106",
      },
    },
    version: "1.0.0",
  };
}

function publicLock() {
  return {
    lockfileVersion: 3,
    name: "public-lock-fixture",
    packages: { "": {} },
    version: "1.0.0",
  };
}

function reviewedConfigSource(packageIdentity: ReviewedSourceRegistryPackage = reviewed) {
  return JSON.stringify({
    archiveGraphId: "reviewed-archive-graph",
    archivePackages: [],
    archiveTarVersion: "7.5.21",
    artifactDirectory: "artifacts/reviewed-npm-audit",
    exceptionFile: "ci/npm-audit-exceptions.json",
    lockedGraphs: [],
    nodeVersion: "22.23.2",
    registryOrigin: "https://registry.npmjs.org/",
    schemaVersion: 2,
    severityThreshold: "high",
    sourceNestedShrinkwrapPackages: [],
    sourceRegistryPackage: packageIdentity,
    sourceRegistryPackagesWithoutIntegrity: [],
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-reviewed-sdk-artifact-"));
  temporaryRoots.push(root);
  const artifactDirectory = join(root, "artifact");
  const cacheDirectory = join(root, "cache");
  const lockfilePath = join(root, "package-lock.json");
  mkdirSync(artifactDirectory);
  mkdirSync(cacheDirectory);
  writeFileSync(join(artifactDirectory, artifactName), archiveBytes);
  writeFileSync(lockfilePath, JSON.stringify(reviewedLock()));
  return { artifactDirectory, cacheDirectory, lockfilePath, root };
}

function installFixture(
  reviewedLocation: "root" | "nemoclaw",
  packageIdentity: ReviewedSourceRegistryPackage = reviewed,
) {
  const source = fixture();
  const nestedRoot = join(source.root, "nemoclaw");
  mkdirSync(nestedRoot);
  writeFileSync(
    source.lockfilePath,
    JSON.stringify(reviewedLocation === "root" ? reviewedLock(packageIdentity) : publicLock()),
  );
  writeFileSync(
    join(nestedRoot, "package-lock.json"),
    JSON.stringify(reviewedLocation === "nemoclaw" ? reviewedLock(packageIdentity) : publicLock()),
  );
  return source;
}

function packedInstallFixture() {
  const source = installFixture("root");
  const packageRoot = join(source.root, "sdk-package");
  mkdirSync(packageRoot);
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@nvidia/openshell-sdk", version: "0.0.106" }),
  );
  writeFileSync(join(packageRoot, "index.js"), "export {};\n");
  rmSync(join(source.artifactDirectory, artifactName));
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", packageRoot, "--pack-destination", source.artifactDirectory, "--json"],
      { encoding: "utf8" },
    ),
  ) as Array<{ filename?: string; integrity?: string }>;
  expect(packed).toHaveLength(1);
  const entry = packed[0]!;
  expect(entry.filename).toBe(artifactName);
  expect(entry.integrity).toMatch(/^sha512-/);
  const packageIdentity = { ...reviewed, integrity: entry.integrity! };
  writeFileSync(source.lockfilePath, JSON.stringify(reviewedLock(packageIdentity)));
  writeFileSync(
    join(source.root, "package.json"),
    JSON.stringify({
      dependencies: { "@nvidia/openshell-sdk": "0.0.106" },
      name: "reviewed-sdk-install-fixture",
      private: true,
      version: "1.0.0",
    }),
  );
  return { packageIdentity, source };
}

function installRequest(source: ReturnType<typeof installFixture>, mode: "artifact" | "registry") {
  return {
    artifactDirectory: source.artifactDirectory,
    cacheDirectory: source.cacheDirectory,
    mode,
    targetRoot: source.root,
  } as const;
}

function request(source: ReturnType<typeof fixture>) {
  return {
    allowedNestedShrinkwrapPackages: [],
    artifactDirectory: source.artifactDirectory,
    cacheDirectory: source.cacheDirectory,
    lockfilePath: source.lockfilePath,
    registryOrigin: "https://registry.npmjs.org/",
    reviewed,
    reviewedPackagesWithoutIntegrity: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("trusted OpenShell SDK archive preparation", () => {
  it("reports a bounded redacted npm cache-stage failure", async () => {
    const source = fixture();
    const executableDirectory = join(source.root, "bin");
    const npmPath = join(executableDirectory, "npm");
    const longDetail = "x".repeat(700);
    mkdirSync(executableDirectory);
    writeFileSync(
      npmPath,
      `#!/bin/sh\nprintf '%s\\n' 'NPM_TOKEN=private-diagnostic-value https://user:private-password@example.test/path?token=private-query Authorization: Bearer private-bearer-value ${longDetail}' >&2\nexit 23\n`,
    );
    chmodSync(npmPath, 0o700);
    vi.stubEnv("PATH", `${executableDirectory}:${process.env.PATH ?? ""}`);

    const failure = await seedReviewedSourceRegistryArtifact(request(source)).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("npm could not stage the reviewed OpenShell SDK archive (exit 23)");
    expect(message).toContain("NPM_TOKEN=<REDACTED>");
    expect(message).toContain("<REDACTED_URL>");
    expect(message).not.toContain("private-diagnostic-value");
    expect(message).not.toContain("private-bearer-value");
    expect(message).not.toContain("private-password");
    expect(message).not.toContain("private-query");
    expect(message).not.toContain(longDetail);
    expect(message.length).toBeLessThan(650);
  });

  it("requires the reviewed archive when the root lock uses the SDK", async () => {
    const source = installFixture("root");
    const stage = cacheStageMock();
    rmSync(source.artifactDirectory, { force: true, recursive: true });

    await expect(
      prepareCiNpmInstallWithReviewedConfig(
        installRequest(source, "artifact"),
        reviewedConfigSource(),
        stage,
      ),
    ).rejects.toThrow("reviewed OpenShell SDK artifact is required");
    expect(stage).not.toHaveBeenCalled();
  });

  it("requires the reviewed archive when the plugin lock uses the SDK", async () => {
    const source = installFixture("nemoclaw");
    const stage = cacheStageMock();
    rmSync(source.artifactDirectory, { force: true, recursive: true });

    await expect(
      prepareCiNpmInstallWithReviewedConfig(
        installRequest(source, "artifact"),
        reviewedConfigSource(),
        stage,
      ),
    ).rejects.toThrow("reviewed OpenShell SDK artifact is required");
    expect(stage).not.toHaveBeenCalled();
  });

  it("passes the verified archive from the root lock to npm cache preparation", async () => {
    const source = installFixture("root");
    const stage = cacheStageMock();

    await prepareCiNpmInstallWithReviewedConfig(
      installRequest(source, "artifact"),
      reviewedConfigSource(),
      stage,
    );

    expect(stage).toHaveBeenCalledOnce();
    expect(stage.mock.calls[0]?.[0].archive.equals(archiveBytes)).toBe(true);
  });

  it("passes the verified archive from the plugin lock to npm cache preparation", async () => {
    const source = installFixture("nemoclaw");
    const stage = cacheStageMock();

    await prepareCiNpmInstallWithReviewedConfig(
      installRequest(source, "artifact"),
      reviewedConfigSource(),
      stage,
    );

    expect(stage).toHaveBeenCalledOnce();
  });

  it("uses registry mode without requiring or caching an archive", async () => {
    const source = installFixture("root");
    const stage = cacheStageMock();
    rmSync(source.artifactDirectory, { force: true, recursive: true });

    await prepareCiNpmInstallWithReviewedConfig(
      installRequest(source, "registry"),
      reviewedConfigSource(),
      stage,
    );

    expect(stage).not.toHaveBeenCalled();
  });

  it("stages only the exact reviewed tarball request and package identity", async () => {
    const source = fixture();
    const stage = cacheStageMock();

    await seedReviewedSourceRegistryArtifact(request(source), stage);

    expect(stage).toHaveBeenCalledOnce();
    expect(stage.mock.calls[0]?.[0]).toMatchObject({
      artifactName,
      cacheDirectory: source.cacheDirectory,
    });
    expect(stage.mock.calls[0]?.[0].archive.equals(archiveBytes)).toBe(true);
  });

  it("installs the reviewed archive offline after npm stages it", async () => {
    const { packageIdentity, source } = packedInstallFixture();

    await prepareCiNpmInstallWithReviewedConfig(
      installRequest(source, "artifact"),
      reviewedConfigSource(packageIdentity),
    );
    execFileSync(
      "npm",
      [
        "ci",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        source.cacheDirectory,
      ],
      { cwd: source.root, encoding: "utf8" },
    );

    const installed = JSON.parse(
      readFileSync(join(source.root, "node_modules/@nvidia/openshell-sdk/package.json"), "utf8"),
    ) as { version?: string };
    expect(installed.version).toBe("0.0.106");
  });

  it("rejects changed bytes before writing the npm cache", async () => {
    const source = fixture();
    const stage = cacheStageMock();
    writeFileSync(join(source.artifactDirectory, artifactName), "changed archive");

    await expect(seedReviewedSourceRegistryArtifact(request(source), stage)).rejects.toThrow(
      "integrity mismatch",
    );
    expect(stage).not.toHaveBeenCalled();
  });

  it("rejects symlinked or additional artifact content before writing the npm cache", async () => {
    const source = fixture();
    const stage = cacheStageMock();
    writeFileSync(join(source.root, "outside.tgz"), archiveBytes);
    rmSync(join(source.artifactDirectory, artifactName));
    symlinkSync(join(source.root, "outside.tgz"), join(source.artifactDirectory, artifactName));

    await expect(seedReviewedSourceRegistryArtifact(request(source), stage)).rejects.toThrow(
      "non-symlink regular file",
    );
    expect(stage).not.toHaveBeenCalled();

    rmSync(join(source.artifactDirectory, artifactName));
    writeFileSync(join(source.artifactDirectory, artifactName), archiveBytes);
    writeFileSync(join(source.artifactDirectory, "unexpected.tgz"), archiveBytes);
    await expect(seedReviewedSourceRegistryArtifact(request(source), stage)).rejects.toThrow(
      "unexpected contents",
    );
    expect(stage).not.toHaveBeenCalled();
  });

  it("rejects an oversized artifact before writing the npm cache", async () => {
    const source = fixture();
    const stage = cacheStageMock();
    truncateSync(join(source.artifactDirectory, artifactName), 32 * 1024 * 1024 + 1);

    await expect(seedReviewedSourceRegistryArtifact(request(source), stage)).rejects.toThrow(
      "bounded regular file",
    );
    expect(stage).not.toHaveBeenCalled();
  });
});
