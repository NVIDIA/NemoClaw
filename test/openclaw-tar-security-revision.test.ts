// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FIXED_TAR_VERSION,
  patchOpenClawTar,
  planHistoricalRelease,
  verifyOpenClawTarRevision,
} from "../scripts/openclaw-tar-security-revision.mts";

const tempDirs: string[] = [];

function fixture(
  openClawVersion = "2026.6.10",
  tarVersion = "7.5.16",
  fsSafeTarVersion: string | null = "7.5.13",
  shrinkwrap = true,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-tar-revision-"));
  tempDirs.push(root);
  const openClawRoot = path.join(root, "openclaw");
  const replacementRoot = path.join(root, "replacement");
  const installedTarRoot = path.join(openClawRoot, "node_modules", "tar");
  fs.mkdirSync(installedTarRoot, { recursive: true });
  fs.mkdirSync(replacementRoot);
  fs.writeFileSync(
    path.join(openClawRoot, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: openClawVersion,
      dependencies: { tar: tarVersion },
    }),
  );
  shrinkwrap &&
    fs.writeFileSync(
      path.join(openClawRoot, "npm-shrinkwrap.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { tar: tarVersion } },
          "node_modules/tar": {
            version: tarVersion,
            resolved: `https://registry.npmjs.org/tar/-/tar-${tarVersion}.tgz`,
            integrity: "old-integrity",
          },
        },
      }),
    );
  fs.writeFileSync(
    path.join(installedTarRoot, "package.json"),
    JSON.stringify({ name: "tar", version: tarVersion }),
  );
  fs.writeFileSync(path.join(installedTarRoot, "old.js"), "vulnerable\n");
  fsSafeTarVersion &&
    (() => {
      const fsSafeRoot = path.join(openClawRoot, "node_modules", "@openclaw", "fs-safe");
      const fsSafeTarRoot = path.join(fsSafeRoot, "node_modules", "tar");
      fs.mkdirSync(fsSafeTarRoot, { recursive: true });
      fs.writeFileSync(
        path.join(fsSafeRoot, "package.json"),
        JSON.stringify({
          name: "@openclaw/fs-safe",
          version: "0.3.0",
          optionalDependencies: { tar: fsSafeTarVersion },
        }),
      );
      fs.writeFileSync(
        path.join(fsSafeTarRoot, "package.json"),
        JSON.stringify({ name: "tar", version: fsSafeTarVersion }),
      );
      fs.writeFileSync(path.join(fsSafeTarRoot, "old.js"), "vulnerable nested tar\n");
    })();
  fs.writeFileSync(
    path.join(replacementRoot, "package.json"),
    JSON.stringify({ name: "tar", version: FIXED_TAR_VERSION }),
  );
  fs.writeFileSync(path.join(replacementRoot, "new.js"), "fixed\n");
  return { openClawRoot, replacementRoot };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("historical OpenClaw tar security revisions (#7272)", () => {
  it("maps only reviewed historical release tags to new immutable revision tags", () => {
    expect(planHistoricalRelease("v0.0.50")).toMatchObject({
      openClawVersion: "2026.5.18",
      vulnerableTarVersion: "7.5.15",
      revisionTag: "v0.0.50-cve-2026-59873.1",
    });
    expect(planHistoricalRelease("v0.0.74").openClawVersion).toBe("2026.5.27");
    expect(planHistoricalRelease("v0.0.89")).toMatchObject({
      openClawVersion: "2026.6.10",
      vulnerableTarVersion: "7.5.16",
      revisionTag: "v0.0.89-cve-2026-59873.1",
    });
    expect(() => planHistoricalRelease("v0.0.49")).toThrow("outside the reviewed");
    expect(() => planHistoricalRelease("latest")).toThrow("v0.0.N");
  });

  it("replaces only the vulnerable nested package and synchronizes package metadata", () => {
    const target = fixture();
    patchOpenClawTar({ ...target, expectedOpenClawVersion: "2026.6.10" });

    expect(() =>
      verifyOpenClawTarRevision({
        openClawRoot: target.openClawRoot,
        expectedOpenClawVersion: "2026.6.10",
      }),
    ).not.toThrow();
    expect(fs.existsSync(path.join(target.openClawRoot, "node_modules", "tar", "new.js"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(target.openClawRoot, "node_modules", "tar", "old.js"))).toBe(
      false,
    );
  });

  it("fails closed when the historical dependency graph differs from the review", () => {
    const wrongOpenClaw = fixture("2026.6.11", "7.5.16");
    expect(() =>
      patchOpenClawTar({ ...wrongOpenClaw, expectedOpenClawVersion: "2026.6.10" }),
    ).toThrow("does not match the reviewed target");

    const wrongTar = fixture("2026.6.10", "7.5.15");
    expect(() => patchOpenClawTar({ ...wrongTar, expectedOpenClawVersion: "2026.6.10" })).toThrow(
      "does not match the reviewed target",
    );
  });

  it("accepts releases whose reviewed graph contains only the direct tar package", () => {
    const target = fixture("2026.5.27", "7.5.15", null);
    patchOpenClawTar({ ...target, expectedOpenClawVersion: "2026.5.27" });
    expect(() =>
      verifyOpenClawTarRevision({
        openClawRoot: target.openClawRoot,
        expectedOpenClawVersion: "2026.5.27",
      }),
    ).not.toThrow();
  });

  it("accepts the reviewed oldest image without inventing a shrinkwrap", () => {
    const target = fixture("2026.5.18", "7.5.15", "7.5.13", false);
    patchOpenClawTar({ ...target, expectedOpenClawVersion: "2026.5.18" });
    expect(fs.existsSync(path.join(target.openClawRoot, "npm-shrinkwrap.json"))).toBe(false);
  });

  it("rejects symbolic links in the reviewed replacement package", () => {
    const target = fixture();
    fs.symlinkSync("package.json", path.join(target.replacementRoot, "unsafe-link"));
    expect(() => patchOpenClawTar({ ...target, expectedOpenClawVersion: "2026.6.10" })).toThrow(
      "unsafe member",
    );
  });
});
