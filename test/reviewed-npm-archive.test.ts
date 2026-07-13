// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  packReviewedNpmArchive,
  removeReviewedNpmArchive,
  type ReviewedNpmArchiveRequest,
  resolveReviewedNpmArchivePath,
  verifyReviewedNpmMetadata,
} from "../scripts/lib/reviewed-npm-archive.mts";

const INTEGRITY = `sha512-${"a".repeat(88)}`;
const PACKAGE_SPEC = "@example/reviewed@1.2.3";
const TARBALL_URL = "https://registry.npmjs.org/@example/reviewed/-/reviewed-1.2.3.tgz";
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
});
