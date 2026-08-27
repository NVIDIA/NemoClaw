// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  packReviewedNpmArchive,
  type ReviewedNpmArchiveRequest,
  type ReviewedNpmCacheRequest,
  removeReviewedNpmArchive,
  resolveReviewedNpmArchivePath,
  verifyReviewedNpmCache,
  verifyReviewedNpmLockPackages,
  verifyReviewedNpmMetadata,
} from "../../scripts/lib/reviewed-npm-archive.mts";

const INTEGRITY = `sha512-${"a".repeat(88)}`;
const PACKAGE_SPEC = "@example/reviewed@1.2.3";
const TARBALL_URL = "https://registry.npmjs.org/@example/reviewed/-/reviewed-1.2.3.tgz";
const CACHE_PACKAGE_SPEC = "@example/cache-one@1.0.0";
const CACHE_PACKAGE_TWO_SPEC = "cache-two@2.0.0";
const roots: string[] = [];

function request(): ReviewedNpmArchiveRequest {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-npm-archive-test-"));
  roots.push(tempDirectory);
  return {
    expectedIntegrity: INTEGRITY,
    label: `reviewed package ${PACKAGE_SPEC}`,
    packageSpec: PACKAGE_SPEC,
    tarballUrl: TARBALL_URL,
    tempDirectory,
  };
}

function cacheRequest(): ReviewedNpmCacheRequest {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-npm-cache-test-"));
  roots.push(tempDirectory);
  const cacheDirectory = path.join(tempDirectory, "cache");
  fs.mkdirSync(cacheDirectory);
  const lockfilePath = path.join(tempDirectory, "package-lock.json");
  fs.writeFileSync(
    lockfilePath,
    `${JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/@example/cache-one": {
          integrity: INTEGRITY,
          resolved: "https://registry.npmjs.org/@example/cache-one/-/cache-one-1.0.0.tgz",
          version: "1.0.0",
        },
        "node_modules/cache-two": {
          integrity: INTEGRITY,
          resolved: "https://registry.npmjs.org/cache-two/-/cache-two-2.0.0.tgz",
          version: "2.0.0",
        },
      },
    })}\n`,
  );
  return {
    cacheDirectory,
    lockfilePath,
    registryOrigin: "https://registry.npmjs.org/",
    tempDirectory,
  };
}

function writeSyntheticLock(
  reviewed: ReviewedNpmCacheRequest,
  filename: string,
  packageRecord: Readonly<Record<string, unknown>>,
): string {
  const lockfilePath = path.join(reviewed.tempDirectory as string, filename);
  fs.writeFileSync(
    lockfilePath,
    `${JSON.stringify({
      lockfileVersion: 3,
      packages: { "": {}, "node_modules/@example/reviewed": packageRecord },
    })}\n`,
  );
  return lockfilePath;
}

function cachedArchiveRunner(
  calls: Array<{ args: readonly string[]; request: ReviewedNpmArchiveRequest }>,
  mutation?: Readonly<{ filename?: string; integrity?: string; packageSpec: string }>,
) {
  return (args: readonly string[], reviewed: ReviewedNpmArchiveRequest): string => {
    calls.push({ args: [...args], request: reviewed });
    return args[0] === "view"
      ? args[2] === "dist.integrity"
        ? reviewed.expectedIntegrity
        : reviewed.tarballUrl
      : cachedArchivePackResponse(args, reviewed, mutation);
  };
}

function cachedArchivePackResponse(
  args: readonly string[],
  reviewed: ReviewedNpmArchiveRequest,
  mutation?: Readonly<{ filename?: string; integrity?: string; packageSpec: string }>,
): string {
  const destination = args[3] as string;
  const filename =
    mutation?.packageSpec === reviewed.packageSpec && mutation.filename
      ? mutation.filename
      : `${reviewed.packageSpec.replaceAll(/[^0-9A-Za-z.-]/g, "-")}.tgz`;
  !filename.includes("/") && !filename.includes("\\")
    ? fs.writeFileSync(path.join(destination, filename), "reviewed cache bytes")
    : undefined;
  return JSON.stringify([
    {
      filename,
      integrity:
        mutation?.packageSpec === reviewed.packageSpec && mutation.integrity
          ? mutation.integrity
          : reviewed.expectedIntegrity,
    },
  ]);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("reviewed npm archive", () => {
  it("verifies exact registry metadata and returns only a contained local archive", () => {
    const calls: string[][] = [];
    const archive = packReviewedNpmArchive(request(), (args, reviewed) => {
      calls.push([...args]);
      const metadata = new Map([
        ["view|dist.integrity", `${INTEGRITY}\n`],
        ["view|dist.tarball", `${TARBALL_URL}\n`],
      ]).get(`${args[0]}|${args[2]}`);
      return (
        metadata ??
        (() => {
          const destination = args[3] as string;
          fs.writeFileSync(path.join(destination, "reviewed-1.2.3.tgz"), "reviewed bytes");
          return JSON.stringify([
            { filename: "reviewed-1.2.3.tgz", integrity: reviewed.expectedIntegrity },
          ]);
        })()
      );
    });

    expect(calls).toEqual([
      ["view", PACKAGE_SPEC, "dist.integrity"],
      ["view", PACKAGE_SPEC, "dist.tarball"],
      ["pack", TARBALL_URL, "--pack-destination", archive.rootDirectory, "--json"],
    ]);
    expect(archive.archivePath).toBe(path.join(archive.rootDirectory, "reviewed-1.2.3.tgz"));
    expect(fs.existsSync(archive.archivePath)).toBe(true);
    removeReviewedNpmArchive(archive);
    expect(fs.existsSync(archive.rootDirectory)).toBe(false);
  });

  it.each([
    ["dist.integrity", "sha512-drift"],
    ["dist.tarball", "https://unexpected.invalid/reviewed.tgz"],
  ] as const)(
    "fails before packing when registry integrity or tarball metadata drifts [case %#]",
    (field, actual) => {
      const calls: string[][] = [];
      expect(() =>
        verifyReviewedNpmMetadata(request(), (args) => {
          calls.push([...args]);
          return args[2] === field
            ? actual
            : (new Map([
                ["dist.integrity", INTEGRITY],
                ["dist.tarball", TARBALL_URL],
              ]).get(args[2] as string) ?? "");
        }),
      ).toThrow(field === "dist.integrity" ? "npm integrity mismatch" : "npm tarball URL mismatch");
      expect(calls.some((args) => args[0] === "pack")).toBe(false);
    },
  );

  it("removes the fresh directory when packed SRI drifts", () => {
    const reviewed = request();
    let packDirectory = "";
    expect(() =>
      packReviewedNpmArchive(reviewed, (args) => {
        return args[0] === "view"
          ? args[2] === "dist.integrity"
            ? INTEGRITY
            : TARBALL_URL
          : (() => {
              packDirectory = args[3] as string;
              fs.writeFileSync(path.join(packDirectory, "reviewed-1.2.3.tgz"), "drifted bytes");
              return JSON.stringify([
                { filename: "reviewed-1.2.3.tgz", integrity: "sha512-drift" },
              ]);
            })();
      }),
    ).toThrow("downloaded tarball integrity mismatch");
    expect(fs.existsSync(packDirectory)).toBe(false);
  });

  it.each([
    "../../reviewed.tgz",
    "/tmp/reviewed.tgz",
    "nested/reviewed.tgz",
    "nested\\reviewed.tgz",
    ".",
    "..",
  ])("rejects malicious npm pack filename %s", (filename) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-npm-path-test-"));
    roots.push(root);
    expect(() => resolveReviewedNpmArchivePath(PACKAGE_SPEC, root, filename)).toThrow(
      `reported unsafe archive filename: ${filename}`,
    );
  });

  it("re-packs every locked cache archive offline through the shared verifier", () => {
    const calls: Array<{ args: readonly string[]; request: ReviewedNpmArchiveRequest }> = [];
    const reviewed = cacheRequest();
    expect(verifyReviewedNpmCache(reviewed, cachedArchiveRunner(calls))).toEqual([
      CACHE_PACKAGE_SPEC,
      CACHE_PACKAGE_TWO_SPEC,
    ]);

    expect(calls.filter(({ args }) => args[0] === "pack")).toHaveLength(2);
    calls.forEach(({ request: archiveRequest }) => {
      expect(archiveRequest.env).toMatchObject({
        NPM_CONFIG_CACHE: reviewed.cacheDirectory,
        NPM_CONFIG_OFFLINE: "true",
        NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
        NPM_CONFIG_USERCONFIG: "/dev/null",
      });
    });
  });

  it("uses a lock alias's canonical package identity for cache verification", () => {
    const reviewed = cacheRequest();
    const lockfilePath = path.join(reviewed.tempDirectory as string, "alias-lock.json");
    fs.writeFileSync(
      lockfilePath,
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "": {},
            "node_modules/legacy-name": {
              integrity: INTEGRITY,
              name: "@example/reviewed",
              resolved: TARBALL_URL,
              version: "1.2.3",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const calls: Array<{ args: readonly string[]; request: ReviewedNpmArchiveRequest }> = [];

    expect(
      verifyReviewedNpmCache({ ...reviewed, lockfilePath }, cachedArchiveRunner(calls)),
    ).toEqual([PACKAGE_SPEC]);
    expect(calls.map(({ request }) => request.packageSpec)).toEqual([
      PACKAGE_SPEC,
      PACKAGE_SPEC,
      PACKAGE_SPEC,
    ]);
  });

  it("allows nested shrinkwrap metadata only for explicit cache-seed inspection", () => {
    const reviewed = cacheRequest();
    const lockfilePath = writeSyntheticLock(reviewed, "shrinkwrap-seed-lock.json", {
      hasShrinkwrap: true,
      integrity: INTEGRITY,
      resolved: TARBALL_URL,
      version: "1.2.3",
    });
    const request = { lockfilePath, registryOrigin: "https://registry.npmjs.org/" };

    expect(() => verifyReviewedNpmLockPackages(request)).toThrow(
      "must not delegate to nested shrinkwrap",
    );
    expect(verifyReviewedNpmLockPackages({ ...request, allowNestedShrinkwrap: true })).toEqual([
      PACKAGE_SPEC,
    ]);
  });

  it("validates but does not archive an approved package without integrity", () => {
    const reviewed = cacheRequest();
    const lockfilePath = path.join(
      reviewed.tempDirectory as string,
      "package-without-integrity-lock.json",
    );
    const packageWithoutIntegrity = {
      label: "reviewed package without integrity",
      packageSpec: "fixture-without-integrity@1.0.0",
      tarballUrl:
        "https://registry.npmjs.org/fixture-without-integrity/-/fixture-without-integrity-1.0.0.tgz",
    };
    fs.writeFileSync(
      lockfilePath,
      `${JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/@example/reviewed": {
            integrity: INTEGRITY,
            resolved: TARBALL_URL,
            version: "1.2.3",
          },
          "node_modules/fixture-without-integrity": {
            resolved: packageWithoutIntegrity.tarballUrl,
            version: "1.0.0",
          },
        },
      })}\n`,
    );

    expect(
      verifyReviewedNpmLockPackages({
        lockfilePath,
        registryOrigin: "https://registry.npmjs.org/",
        reviewedPackagesWithoutIntegrity: [packageWithoutIntegrity],
      }),
    ).toEqual([PACKAGE_SPEC]);
  });

  it("rejects an off-origin locked archive before npm can read the cache", () => {
    const reviewed = cacheRequest();
    const lockfilePath = writeSyntheticLock(reviewed, "off-origin-lock.json", {
      integrity: INTEGRITY,
      resolved: "https://registry.example.test/reviewed-1.2.3.tgz",
      version: "1.2.3",
    });
    let npmCalled = false;

    expect(() =>
      verifyReviewedNpmCache({ ...reviewed, lockfilePath }, () => {
        npmCalled = true;
        return "";
      }),
    ).toThrow("reviewed npm lock package must use the reviewed registry");
    expect(npmCalled).toBe(false);
  });

  it.each([
    {
      expected: "downloaded tarball integrity mismatch",
      mutation: { integrity: "sha512-drift", packageSpec: CACHE_PACKAGE_TWO_SPEC },
      name: "packed SRI drift",
    },
    {
      expected: "reported unsafe archive filename",
      mutation: { filename: "../../cache-two.tgz", packageSpec: CACHE_PACKAGE_TWO_SPEC },
      name: "an unsafe packed filename",
    },
  ])("rejects $name in the final cache", ({ expected, mutation }) => {
    const calls: Array<{ args: readonly string[]; request: ReviewedNpmArchiveRequest }> = [];
    expect(() =>
      verifyReviewedNpmCache(cacheRequest(), cachedArchiveRunner(calls, mutation)),
    ).toThrow(expected);
  });
});
