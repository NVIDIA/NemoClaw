// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

function isStrictChildPath(root: string, candidate: string): boolean {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

describe("managed package path containment", () => {
  it("rejects managed package paths redirected outside node_modules", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-plugin-"));
    try {
      const nodeModulesRoot = path.join(fixtureRoot, "project", "node_modules");
      const outsideScope = path.join(fixtureRoot, "outside-scope");
      const installedPackageRoot = path.join(nodeModulesRoot, "direct-package");
      const escapedPackageRoot = path.join(nodeModulesRoot, "@scope", "plugin");
      fs.mkdirSync(installedPackageRoot, { recursive: true });
      fs.mkdirSync(path.join(outsideScope, "plugin"), { recursive: true });
      fs.symlinkSync(outsideScope, path.join(nodeModulesRoot, "@scope"));
      expect(isStrictChildPath(nodeModulesRoot, installedPackageRoot)).toBe(true);
      expect(isStrictChildPath(nodeModulesRoot, escapedPackageRoot)).toBe(false);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
