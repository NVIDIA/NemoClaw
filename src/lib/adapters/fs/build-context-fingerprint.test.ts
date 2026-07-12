// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fingerprintBuildContext } from "./build-context-fingerprint";

const FIXED_TIME = new Date("2026-01-01T00:00:00.000Z");

describe("fingerprintBuildContext", () => {
  it.runIf(process.platform !== "win32")(
    "rejects a symlink root even when its target changes or is retargeted",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fingerprint-root-"));
      const firstTarget = path.join(root, "first");
      const secondTarget = path.join(root, "second");
      const linkedRoot = path.join(root, "context");
      fs.mkdirSync(firstTarget);
      fs.mkdirSync(secondTarget);
      fs.writeFileSync(path.join(firstTarget, "Dockerfile"), "FROM first\n");
      fs.writeFileSync(path.join(secondTarget, "Dockerfile"), "FROM second\n");
      fs.symlinkSync(firstTarget, linkedRoot, "dir");

      try {
        expect(() => fingerprintBuildContext(linkedRoot)).toThrow(
          "build-context root must be a real directory",
        );
        fs.writeFileSync(path.join(firstTarget, "Dockerfile"), "FROM changed\n");
        expect(() => fingerprintBuildContext(linkedRoot)).toThrow(
          "build-context root must be a real directory",
        );
        fs.unlinkSync(linkedRoot);
        fs.symlinkSync(secondTarget, linkedRoot, "dir");
        expect(() => fingerprintBuildContext(linkedRoot)).toThrow(
          "build-context root must be a real directory",
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "distinguishes independent files from an otherwise identical hardlink pair",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fingerprint-hardlink-"));
      const first = path.join(root, "first.txt");
      const second = path.join(root, "second.txt");
      fs.writeFileSync(first, "identical\n");
      fs.writeFileSync(second, "identical\n");
      fs.utimesSync(first, FIXED_TIME, FIXED_TIME);
      fs.utimesSync(second, FIXED_TIME, FIXED_TIME);
      fs.utimesSync(root, FIXED_TIME, FIXED_TIME);

      try {
        const independentFingerprint = fingerprintBuildContext(root);
        fs.unlinkSync(second);
        fs.linkSync(first, second);
        fs.utimesSync(root, FIXED_TIME, FIXED_TIME);

        expect(fs.statSync(first).nlink).toBe(2);
        expect(fingerprintBuildContext(root)).not.toBe(independentFingerprint);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("fingerprints a file mtime when bytes and permissions do not change", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fingerprint-mtime-"));
    const dockerfile = path.join(root, "Dockerfile");
    fs.writeFileSync(dockerfile, "FROM scratch\n", { mode: 0o644 });
    fs.utimesSync(dockerfile, FIXED_TIME, FIXED_TIME);

    try {
      const originalFingerprint = fingerprintBuildContext(root);
      fs.utimesSync(dockerfile, FIXED_TIME, new Date(FIXED_TIME.getTime() + 1_000));

      expect(fs.readFileSync(dockerfile, "utf8")).toBe("FROM scratch\n");
      expect(fs.statSync(dockerfile).mode & 0o7777).toBe(0o644);
      expect(fingerprintBuildContext(root)).not.toBe(originalFingerprint);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
