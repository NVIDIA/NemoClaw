// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  nodeTarImageScanErrors,
  scanNodeTarImage,
} from "../scripts/checks/node-tar-image-scan.mts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-node-tar-scan-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeTar(root: string, location: string, version: string): string {
  const packageRoot = path.join(root, location, "node_modules", "tar");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "tar", version })}\n`,
  );
  return packageRoot;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("completed-image node-tar scan", () => {
  it("enumerates fixed and affected physical installations", () => {
    const root = temporaryDirectory();
    writeTar(root, "opt/nemoclaw", "7.5.20");
    writeTar(root, "usr/local/lib/node_modules/npm", "7.5.13");

    const scan = scanNodeTarImage(root, "fixture");
    expect(scan.packages.map(({ status, version }) => ({ status, version }))).toEqual([
      { status: "fixed", version: "7.5.20" },
      { status: "affected", version: "7.5.13" },
    ]);
    expect(nodeTarImageScanErrors(scan)).toEqual([expect.stringContaining("tar@7.5.13")]);
  });

  it("groups symlink aliases by physical package directory", () => {
    const root = temporaryDirectory();
    const physical = writeTar(root, "opt/physical", "7.5.19");
    fs.mkdirSync(path.join(root, "opt/alias", "node_modules"), { recursive: true });
    fs.symlinkSync(physical, path.join(root, "opt/alias", "node_modules", "tar"));

    const scan = scanNodeTarImage(root, "fixture");
    expect(scan.packageCount).toBe(1);
    expect(scan.packages[0]?.aliases).toHaveLength(2);
    expect(nodeTarImageScanErrors(scan)).toEqual([]);
  });

  it("keeps distinct package directories separate when manifests are hardlinked", () => {
    const root = temporaryDirectory();
    const first = writeTar(root, "opt/first", "7.5.20");
    const second = path.join(root, "opt/second", "node_modules", "tar");
    fs.mkdirSync(second, { recursive: true });
    fs.linkSync(path.join(first, "package.json"), path.join(second, "package.json"));

    const scan = scanNodeTarImage(root, "fixture");
    expect(scan.packageCount).toBe(2);
    expect(scan.packages.map((entry) => entry.physicalPath)).toEqual([
      fs.realpathSync(first),
      fs.realpathSync(second),
    ]);
  });

  it("fails closed for invalid metadata and an empty inventory", () => {
    const invalidRoot = temporaryDirectory();
    writeTar(invalidRoot, "opt/invalid", "latest");
    const invalid = scanNodeTarImage(invalidRoot, "invalid");
    expect(invalid.packages[0]).toMatchObject({ status: "invalid", version: "latest" });
    expect(nodeTarImageScanErrors(invalid)).toHaveLength(1);

    const empty = scanNodeTarImage(temporaryDirectory(), "empty");
    expect(nodeTarImageScanErrors(empty)).toEqual([
      "completed image contains no discoverable node-tar copy",
    ]);
  });
});
