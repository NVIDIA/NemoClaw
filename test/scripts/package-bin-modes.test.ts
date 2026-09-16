// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { normalizePackageBinModes } from "../../scripts/lib/normalize-package-bin-modes.mts";

function createRepositoryFixture(bin: Record<string, string>): {
  repositoryRoot: string;
  temporaryRoot: string;
} {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-package-bin-modes-"));
  const repositoryRoot = path.join(temporaryRoot, "repository");
  fs.mkdirSync(repositoryRoot);
  fs.writeFileSync(path.join(repositoryRoot, "package.json"), JSON.stringify({ bin }));
  return { repositoryRoot, temporaryRoot };
}

describe("package bin build permissions", () => {
  it("sets every manifest-declared regular file to mode 0755 (#11799)", () => {
    const fixture = createRepositoryFixture({ first: "./dist/first.js", second: "bin/second.js" });
    const targets = [
      path.join(fixture.repositoryRoot, "dist", "first.js"),
      path.join(fixture.repositoryRoot, "bin", "second.js"),
    ];
    try {
      fs.mkdirSync(path.dirname(targets[0]!), { recursive: true });
      fs.mkdirSync(path.dirname(targets[1]!), { recursive: true });
      fs.writeFileSync(targets[0]!, "#!/usr/bin/env node\n");
      fs.writeFileSync(targets[1]!, "#!/usr/bin/env node\n");
      fs.chmodSync(targets[0]!, 0o600);
      fs.chmodSync(targets[1]!, 0o600);

      expect(() => normalizePackageBinModes(fixture.repositoryRoot)).not.toThrow();

      expect(
        process.platform === "win32" ||
          targets.every((target) => (fs.statSync(target).mode & 0o777) === 0o755),
      ).toBe(true);
    } finally {
      fs.rmSync(fixture.temporaryRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ["missing", "./dist/missing.js", "missing or unreadable"],
    ["outside the repository", "../outside.js", "escapes its repository root"],
    ["a directory", "./dist", "regular non-symbolic-link file"],
  ])("rejects %s manifest targets (#11799)", (_case, declaredTarget, message) => {
    const fixture = createRepositoryFixture({ invalid: declaredTarget });
    try {
      fs.mkdirSync(path.join(fixture.repositoryRoot, "dist"));
      fs.writeFileSync(path.join(fixture.temporaryRoot, "outside.js"), "outside\n");

      expect(() => normalizePackageBinModes(fixture.repositoryRoot)).toThrow(message);
    } finally {
      fs.rmSync(fixture.temporaryRoot, { force: true, recursive: true });
    }
  });

  it("rejects a symbolic-link target before changing any validated file (#11799)", () => {
    const fixture = createRepositoryFixture({ valid: "./dist/valid.js", linked: "./dist/linked" });
    const validTarget = path.join(fixture.repositoryRoot, "dist", "valid.js");
    const linkedSource = path.join(fixture.repositoryRoot, "linked-source");
    const linkedTarget = path.join(fixture.repositoryRoot, "dist", "linked");
    try {
      fs.mkdirSync(path.dirname(validTarget));
      fs.writeFileSync(validTarget, "#!/usr/bin/env node\n");
      fs.chmodSync(validTarget, 0o600);
      fs.mkdirSync(linkedSource);
      fs.symlinkSync(linkedSource, linkedTarget, "junction");

      expect(() => normalizePackageBinModes(fixture.repositoryRoot)).toThrow(
        "contains a symbolic-link component",
      );
      expect(
        process.platform === "win32" || (fs.statSync(validTarget).mode & 0o777) === 0o600,
      ).toBe(true);
    } finally {
      fs.rmSync(fixture.temporaryRoot, { force: true, recursive: true });
    }
  });
});
