// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  readJsonFile,
  readJsonFileOr,
  readJsonFileOrFallback,
  restoreFile,
  snapshotFile,
  writeJsonFile,
} from "../fixtures/file-state.ts";

function withTempDir(run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-file-state-"));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("E2E file state", () => {
  it("distinguishes absent, empty, and populated snapshots during restore", () => {
    withTempDir((root) => {
      const file = path.join(root, "nested", "state.txt");
      const absent = snapshotFile(file);
      expect(absent).toEqual({ exists: false });

      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "", "utf8");
      const empty = snapshotFile(file);
      expect(empty).toEqual({ exists: true, content: "" });

      fs.writeFileSync(file, "changed", "utf8");
      restoreFile(file, empty);
      expect(fs.readFileSync(file, "utf8")).toBe("");

      fs.writeFileSync(file, "created", "utf8");
      restoreFile(file, absent);
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  it("writes stable formatted JSON and creates nested parent directories", () => {
    withTempDir((root) => {
      const file = path.join(root, "nested", "deeper", "state.json");
      writeJsonFile(file, { enabled: true, count: 2 });

      expect(fs.readFileSync(file, "utf8")).toBe(
        `${JSON.stringify({ enabled: true, count: 2 }, null, 2)}\n`,
      );
      expect(readJsonFile<{ enabled: boolean; count: number }>(file)).toEqual({
        enabled: true,
        count: 2,
      });
    });
  });

  it("makes missing and malformed JSON fallback behavior explicit", () => {
    withTempDir((root) => {
      const missing = path.join(root, "missing.json");
      const malformed = path.join(root, "malformed.json");
      fs.writeFileSync(malformed, "{not-json", "utf8");

      expect(readJsonFileOr(missing, { source: "missing-fallback" })).toEqual({
        source: "missing-fallback",
      });
      expect(() => readJsonFileOr(malformed, { source: "unused" })).toThrow(SyntaxError);
      expect(readJsonFileOrFallback(malformed, { source: "parse-fallback" })).toEqual({
        source: "parse-fallback",
      });
    });
  });

  it("does not hide non-parse JSON read failures", () => {
    withTempDir((root) => {
      const directory = path.join(root, "state-directory.json");
      fs.mkdirSync(directory);

      expect(() => readJsonFileOrFallback(directory, { source: "unused" })).toThrow();
    });
  });
});
