// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-reviewed-sdk-artifact-"));
  temporaryRoots.push(root);
  const artifactDirectory = join(root, "artifact");
  const cacheDirectory = join(root, "cache");
  mkdirSync(artifactDirectory);
  mkdirSync(cacheDirectory);
  writeFileSync(join(artifactDirectory, artifactName), archiveBytes);
  return { artifactDirectory, cacheDirectory, root };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("trusted OpenShell SDK archive preparation", () => {
  it("seeds only the exact reviewed tarball request and package identity", async () => {
    const source = fixture();
    const calls: Array<readonly [string, string, Buffer, unknown?]> = [];
    const put = vi.fn(async (cache: string, key: string, data: Buffer, options?: unknown) => {
      calls.push([cache, key, data, options]);
    });

    await seedReviewedSourceRegistryArtifact(
      {
        artifactDirectory: source.artifactDirectory,
        cacheDirectory: source.cacheDirectory,
        reviewed,
      },
      put,
    );

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

    await expect(
      seedReviewedSourceRegistryArtifact(
        {
          artifactDirectory: source.artifactDirectory,
          cacheDirectory: source.cacheDirectory,
          reviewed,
        },
        put,
      ),
    ).rejects.toThrow("integrity does not match");
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects symlinked or additional artifact content before writing the npm cache", async () => {
    const source = fixture();
    const put = vi.fn(async () => undefined);
    writeFileSync(join(source.root, "outside.tgz"), archiveBytes);
    rmSync(join(source.artifactDirectory, artifactName));
    symlinkSync(join(source.root, "outside.tgz"), join(source.artifactDirectory, artifactName));

    await expect(
      seedReviewedSourceRegistryArtifact(
        {
          artifactDirectory: source.artifactDirectory,
          cacheDirectory: source.cacheDirectory,
          reviewed,
        },
        put,
      ),
    ).rejects.toThrow("non-symlink regular file");
    expect(put).not.toHaveBeenCalled();

    rmSync(join(source.artifactDirectory, artifactName));
    writeFileSync(join(source.artifactDirectory, artifactName), archiveBytes);
    writeFileSync(join(source.artifactDirectory, "unexpected.tgz"), archiveBytes);
    await expect(
      seedReviewedSourceRegistryArtifact(
        {
          artifactDirectory: source.artifactDirectory,
          cacheDirectory: source.cacheDirectory,
          reviewed,
        },
        put,
      ),
    ).rejects.toThrow("unexpected contents");
    expect(put).not.toHaveBeenCalled();
  });
});
