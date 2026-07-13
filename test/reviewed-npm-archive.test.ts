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
  verifyReviewedNpmMetadata,
} from "../scripts/lib/reviewed-npm-archive.mts";

const INTEGRITY = `sha512-${"a".repeat(88)}`;
const PACKAGE_SPEC = "@example/reviewed@1.2.3";
const TARBALL_URL = "https://registry.npmjs.org/@example/reviewed/-/reviewed-1.2.3.tgz";
const WECHAT_LOCK = path.join(
  import.meta.dirname,
  "..",
  "agents/openclaw/wechat-runtime/package-lock.json",
);
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
  return {
    cacheDirectory,
    lockfilePath: WECHAT_LOCK,
    registryOrigin: "https://registry.npmjs.org/",
    tempDirectory,
  };
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

  it("fails before packing when registry integrity or tarball metadata drifts", () => {
    for (const [field, actual] of [
      ["dist.integrity", "sha512-drift"],
      ["dist.tarball", "https://unexpected.invalid/reviewed.tgz"],
    ] as const) {
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
    }
  });

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
    "../reviewed.tgz",
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
      "@tencent-weixin/openclaw-weixin@2.4.3",
      "qrcode-terminal@0.12.0",
      "zod@4.4.3",
    ]);

    expect(calls.filter(({ args }) => args[0] === "pack")).toHaveLength(3);
    for (const { request: archiveRequest } of calls) {
      expect(archiveRequest.env).toMatchObject({
        NPM_CONFIG_CACHE: reviewed.cacheDirectory,
        NPM_CONFIG_OFFLINE: "true",
        NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
        NPM_CONFIG_USERCONFIG: "/dev/null",
      });
    }
  });

  it("rejects an off-origin locked archive before npm can read the cache", () => {
    const reviewed = cacheRequest();
    const lock = JSON.parse(fs.readFileSync(WECHAT_LOCK, "utf-8"));
    lock.packages["node_modules/qrcode-terminal"].resolved =
      "https://registry.example.test/qrcode-terminal-0.12.0.tgz";
    const lockfilePath = path.join(reviewed.tempDirectory as string, "off-origin-lock.json");
    fs.writeFileSync(lockfilePath, `${JSON.stringify(lock, null, 2)}\n`);
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
      mutation: { integrity: "sha512-drift", packageSpec: "qrcode-terminal@0.12.0" },
      name: "packed SRI drift",
    },
    {
      expected: "reported unsafe archive filename",
      mutation: { filename: "../qrcode-terminal.tgz", packageSpec: "qrcode-terminal@0.12.0" },
      name: "an unsafe packed filename",
    },
  ])("rejects $name in the final cache", ({ expected, mutation }) => {
    const calls: Array<{ args: readonly string[]; request: ReviewedNpmArchiveRequest }> = [];
    expect(() =>
      verifyReviewedNpmCache(cacheRequest(), cachedArchiveRunner(calls, mutation)),
    ).toThrow(expected);
  });
});
