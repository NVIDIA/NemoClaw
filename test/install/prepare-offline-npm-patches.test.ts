// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareOfflineNpmPatches } from "../../scripts/lib/prepare-offline-npm-patches.mts";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offline-npm-test-"));
  roots.push(root);
  const npmRoot = path.join(root, "npm");
  fs.mkdirSync(npmRoot);
  fs.writeFileSync(path.join(npmRoot, "sentinel"), "unchanged");
  return { root, npmRoot };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("rejects a corrupt archive before changing npm", () => {
  const { root, npmRoot } = fixture();
  fs.writeFileSync(path.join(root, "tar.tgz"), "corrupt");
  expect(() => prepareOfflineNpmPatches(npmRoot, root, path.join(root, "npm.tgz"))).toThrow(
    "integrity mismatch",
  );
  expect(fs.readdirSync(npmRoot)).toEqual(["sentinel"]);
});

it("rejects an archive symlink before changing npm", () => {
  const { root, npmRoot } = fixture();
  fs.writeFileSync(path.join(root, "target"), "corrupt");
  fs.symlinkSync("target", path.join(root, "tar.tgz"));
  expect(() => prepareOfflineNpmPatches(npmRoot, root, path.join(root, "npm.tgz"))).toThrow(
    "non-symlink regular file",
  );
  expect(fs.readdirSync(npmRoot)).toEqual(["sentinel"]);
});

it("verifies later archives before applying an earlier verified patch", () => {
  const { root, npmRoot } = fixture();
  fs.copyFileSync(
    path.resolve(
      import.meta.dirname,
      "../../tools/mcp-tool-discovery-runtime/npm-cache-seed/tar-7.5.21.tgz",
    ),
    path.join(root, "tar.tgz"),
  );
  fs.writeFileSync(path.join(root, "brace-expansion.tgz"), "corrupt");
  expect(() => prepareOfflineNpmPatches(npmRoot, root, path.join(root, "npm.tgz"))).toThrow(
    "brace-expansion archive integrity mismatch",
  );
  expect(fs.readdirSync(npmRoot)).toEqual(["sentinel"]);
});
