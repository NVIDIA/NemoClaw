// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
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

function reviewedLock() {
  return {
    lockfileVersion: 3,
    name: "reviewed-sdk-artifact-fixture",
    packages: {
      "": { dependencies: { "@nvidia/openshell-sdk": "0.0.106" } },
      "node_modules/@nvidia/openshell-sdk": {
        integrity: reviewed.integrity,
        resolved: reviewed.tarballUrl,
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

function reviewedConfigSource() {
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
    sourceRegistryPackage: reviewed,
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

function installFixture(reviewedLocation: "root" | "nemoclaw") {
  const source = fixture();
  const nestedRoot = join(source.root, "nemoclaw");
  mkdirSync(nestedRoot);
  writeFileSync(
    source.lockfilePath,
    JSON.stringify(reviewedLocation === "root" ? reviewedLock() : publicLock()),
  );
  writeFileSync(
    join(nestedRoot, "package-lock.json"),
    JSON.stringify(reviewedLocation === "nemoclaw" ? reviewedLock() : publicLock()),
  );
  return source;
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
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("trusted OpenShell SDK archive preparation", () => {
  it("requires the reviewed archive when the root lock uses the SDK", async () => {
    const source = installFixture("root");
    const put = vi.fn(async () => undefined);
    rmSync(source.artifactDirectory, { force: true, recursive: true });

    await expect(
      prepareCiNpmInstallWithReviewedConfig(
        installRequest(source, "artifact"),
        reviewedConfigSource(),
        put,
      ),
    ).rejects.toThrow("reviewed OpenShell SDK artifact is required");
    expect(put).not.toHaveBeenCalled();
  });

  it("requires the reviewed archive when the plugin lock uses the SDK", async () => {
    const source = installFixture("nemoclaw");
    const put = vi.fn(async () => undefined);
    rmSync(source.artifactDirectory, { force: true, recursive: true });

    await expect(
      prepareCiNpmInstallWithReviewedConfig(
        installRequest(source, "artifact"),
        reviewedConfigSource(),
        put,
      ),
    ).rejects.toThrow("reviewed OpenShell SDK artifact is required");
    expect(put).not.toHaveBeenCalled();
  });

  it("passes the verified archive from the root lock to npm cache preparation", async () => {
    const source = installFixture("root");
    const put = vi.fn(async () => undefined);

    await prepareCiNpmInstallWithReviewedConfig(
      installRequest(source, "artifact"),
      reviewedConfigSource(),
      put,
    );

    expect(put).toHaveBeenCalledTimes(2);
  });

  it("passes the verified archive from the plugin lock to npm cache preparation", async () => {
    const source = installFixture("nemoclaw");
    const put = vi.fn(async () => undefined);

    await prepareCiNpmInstallWithReviewedConfig(
      installRequest(source, "artifact"),
      reviewedConfigSource(),
      put,
    );

    expect(put).toHaveBeenCalledTimes(2);
  });

  it("uses registry mode without requiring or caching an archive", async () => {
    const source = installFixture("root");
    const put = vi.fn(async () => undefined);
    rmSync(source.artifactDirectory, { force: true, recursive: true });

    await prepareCiNpmInstallWithReviewedConfig(
      installRequest(source, "registry"),
      reviewedConfigSource(),
      put,
    );

    expect(put).not.toHaveBeenCalled();
  });

  it("seeds only the exact reviewed tarball request and package identity", async () => {
    const source = fixture();
    const calls: Array<readonly [string, string, Buffer, unknown?]> = [];
    const put = vi.fn(async (cache: string, key: string, data: Buffer, options?: unknown) => {
      calls.push([cache, key, data, options]);
    });

    await seedReviewedSourceRegistryArtifact(request(source), put);

    expect(put).toHaveBeenCalledTimes(2);
    expect(calls.map((call) => call[1])).toEqual([
      `make-fetch-happen:request-cache:${reviewed.tarballUrl}`,
      `pacote:tarball:${reviewed.packageSpec}`,
    ]);
    expect(calls.every((call) => call[2].equals(archiveBytes))).toBe(true);
  });

  it("rejects changed bytes before writing the npm cache", async () => {
    const source = fixture();
    const put = vi.fn(async () => undefined);
    writeFileSync(join(source.artifactDirectory, artifactName), "changed archive");

    await expect(seedReviewedSourceRegistryArtifact(request(source), put)).rejects.toThrow(
      "integrity mismatch",
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects symlinked or additional artifact content before writing the npm cache", async () => {
    const source = fixture();
    const put = vi.fn(async () => undefined);
    writeFileSync(join(source.root, "outside.tgz"), archiveBytes);
    rmSync(join(source.artifactDirectory, artifactName));
    symlinkSync(join(source.root, "outside.tgz"), join(source.artifactDirectory, artifactName));

    await expect(seedReviewedSourceRegistryArtifact(request(source), put)).rejects.toThrow(
      "non-symlink regular file",
    );
    expect(put).not.toHaveBeenCalled();

    rmSync(join(source.artifactDirectory, artifactName));
    writeFileSync(join(source.artifactDirectory, artifactName), archiveBytes);
    writeFileSync(join(source.artifactDirectory, "unexpected.tgz"), archiveBytes);
    await expect(seedReviewedSourceRegistryArtifact(request(source), put)).rejects.toThrow(
      "unexpected contents",
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects an oversized artifact before writing the npm cache", async () => {
    const source = fixture();
    const put = vi.fn(async () => undefined);
    truncateSync(join(source.artifactDirectory, artifactName), 32 * 1024 * 1024 + 1);

    await expect(seedReviewedSourceRegistryArtifact(request(source), put)).rejects.toThrow(
      "bounded regular file",
    );
    expect(put).not.toHaveBeenCalled();
  });
});
