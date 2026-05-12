// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDir, secureTempFile } from "./temp-files";

const createdParents: string[] = [];

afterEach(() => {
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

  it("does not remove unrelated temp directories", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "other-prefix-"));
    createdParents.push(parent);
    const filePath = path.join(parent, "nemoclaw-cleanup.txt");
    fs.writeFileSync(filePath, "payload");

    cleanupTempDir(filePath, "nemoclaw-cleanup");

    expect(fs.existsSync(parent)).toBe(true);
  });

  it("does not remove matching-prefix directories outside os.tmpdir()", () => {
    const outsideParent = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-cleanup-"));
    createdParents.push(outsideParent);
    const filePath = path.join(outsideParent, "nemoclaw-cleanup.txt");
    fs.writeFileSync(filePath, "payload");

    cleanupTempDir(filePath, "nemoclaw-cleanup");

    expect(fs.existsSync(outsideParent)).toBe(true);
  });
});
