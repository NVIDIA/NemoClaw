// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupTempDir, createExactTempFileCleanup, secureTempFile } from "./temp-files";

const createdParents: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const parent of createdParents.splice(0)) {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

describe("onboard temp file helpers", () => {
  it("creates a file path under a unique prefixed temp directory", () => {
    const filePath = secureTempFile("nemoclaw-test", ".txt");
    const parent = path.dirname(filePath);
    createdParents.push(parent);

    expect(path.basename(parent).startsWith("nemoclaw-test-")).toBe(true);
    expect(path.basename(filePath)).toBe("nemoclaw-test.txt");
  });

  it.skipIf(process.platform === "win32")(
    "creates an owner-only real parent and rejects a planted target with exclusive creation",
    () => {
      const filePath = secureTempFile("nemoclaw-exclusive", ".txt");
      const parent = path.dirname(filePath);
      createdParents.push(parent);
      const parentStat = fs.lstatSync(parent);
      const plantedTarget = path.join(parent, "planted-target.txt");
      fs.writeFileSync(plantedTarget, "untouched\n", { mode: 0o600 });

      expect(parentStat.isDirectory()).toBe(true);
      expect(parentStat.isSymbolicLink()).toBe(false);
      expect(parentStat.mode & 0o777).toBe(0o700);
      expect(fs.existsSync(filePath)).toBe(false);

      fs.symlinkSync(plantedTarget, filePath);
      expect(() =>
        fs.writeFileSync(filePath, "replacement\n", { flag: "wx", mode: 0o400 }),
      ).toThrowError(expect.objectContaining({ code: "EEXIST" }));
      expect(fs.readFileSync(plantedTarget, "utf8")).toBe("untouched\n");
    },
  );

  it("rejects temp prefixes with path separators", () => {
    expect(() => secureTempFile("../nemoclaw-test", ".txt")).toThrow("Invalid temp file prefix");
    expect(() => secureTempFile("nested/nemoclaw-test", ".txt")).toThrow(
      "Invalid temp file prefix",
    );
    expect(() => secureTempFile("nested\\nemoclaw-test", ".txt")).toThrow(
      "Invalid temp file prefix",
    );
  });

  it("removes only the matching mkdtemp-created parent directory", () => {
    const filePath = secureTempFile("nemoclaw-cleanup", ".txt");
    const parent = path.dirname(filePath);
    fs.writeFileSync(filePath, "payload");

    cleanupTempDir(filePath, "nemoclaw-cleanup");

    expect(fs.existsSync(parent)).toBe(false);
  });

  it("removes only the captured private file generation and is idempotent (#9203)", () => {
    const filePath = secureTempFile("nemoclaw-cleanup", ".txt");
    const parent = path.dirname(filePath);
    fs.writeFileSync(filePath, "captured", { mode: 0o600 });
    const cleanup = createExactTempFileCleanup(filePath, "nemoclaw-cleanup");

    expect(cleanup()).toBe(true);
    expect(cleanup()).toBe(true);
    expect(fs.existsSync(parent)).toBe(false);
  });

  it("preserves a replacement file generation and fails closed (#9203)", () => {
    const filePath = secureTempFile("nemoclaw-cleanup", ".txt");
    const parent = path.dirname(filePath);
    const original = path.join(parent, "original.txt");
    createdParents.push(parent);
    fs.writeFileSync(filePath, "captured", { mode: 0o600 });
    const cleanup = createExactTempFileCleanup(filePath, "nemoclaw-cleanup");
    fs.renameSync(filePath, original);
    fs.writeFileSync(filePath, "replacement", { mode: 0o600 });

    expect(cleanup()).toBe(false);
    expect(fs.readFileSync(filePath, "utf8")).toBe("replacement");
    expect(fs.readFileSync(original, "utf8")).toBe("captured");
  });

  it("preserves a replaced task directory and fails closed (#9203)", () => {
    const filePath = secureTempFile("nemoclaw-cleanup", ".txt");
    const parent = path.dirname(filePath);
    const originalParent = `${parent}-original`;
    createdParents.push(parent, originalParent);
    fs.writeFileSync(filePath, "captured", { mode: 0o600 });
    const cleanup = createExactTempFileCleanup(filePath, "nemoclaw-cleanup");
    fs.renameSync(parent, originalParent);
    fs.mkdirSync(parent, { mode: 0o700 });
    fs.writeFileSync(filePath, "replacement", { mode: 0o600 });

    expect(cleanup()).toBe(false);
    expect(fs.readFileSync(filePath, "utf8")).toBe("replacement");
    expect(fs.readFileSync(path.join(originalParent, path.basename(filePath)), "utf8")).toBe(
      "captured",
    );
  });

  it("fails closed when current-user ownership cannot be established (#9203)", () => {
    const filePath = secureTempFile("nemoclaw-cleanup", ".txt");
    const parent = path.dirname(filePath);
    createdParents.push(parent);
    fs.writeFileSync(filePath, "captured", { mode: 0o600 });
    vi.spyOn(process, "getuid").mockReturnValue(undefined as never);

    expect(() => createExactTempFileCleanup(filePath, "nemoclaw-cleanup")).toThrow(
      "Current-user temporary file authority is unavailable",
    );
  });

  it("does not remove unrelated temp directories", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "other-prefix-"));
    createdParents.push(parent);
    const filePath = path.join(parent, "nemoclaw-cleanup.txt");
    fs.writeFileSync(filePath, "payload");

    cleanupTempDir(filePath, "nemoclaw-cleanup");

    expect(fs.existsSync(parent)).toBe(true);
  });

  it("does not remove matching-prefix directories outside os.tmpdir()", () => {
    const outsideParent = fs.mkdtempSync(path.join(os.homedir(), "nemoclaw-cleanup-"));
    createdParents.push(outsideParent);
    const filePath = path.join(outsideParent, "nemoclaw-cleanup.txt");
    fs.writeFileSync(filePath, "payload");

    cleanupTempDir(filePath, "nemoclaw-cleanup");

    expect(fs.existsSync(outsideParent)).toBe(true);
  });
});
