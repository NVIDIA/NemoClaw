// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sanitizeBackupDirectory } from "./sandbox.js";

const testDirectories: string[] = [];

function createBackup(): string {
  const backupPath = mkdtempSync(join(tmpdir(), "nemoclaw-sanitize-backup-"));
  testDirectories.push(backupPath);
  mkdirSync(join(backupPath, "state"), { recursive: true });
  return backupPath;
}

afterEach(() => {
  for (const testDirectory of testDirectories.splice(0)) {
    rmSync(testDirectory, { recursive: true, force: true });
  }
});

describe("rebuild backup credential sanitization", () => {
  it("omits unsanitizable config and env artifacts", () => {
    const backupPath = createBackup();
    const yamlPath = join(backupPath, "state", "config.yaml");
    const jsonPath = join(backupPath, "state", "config.json");
    const envPath = join(backupPath, "state", ".env");
    const safePath = join(backupPath, "state", "notes.txt");
    writeFileSync(yamlPath, "api_key: [unclosed\n");
    writeFileSync(jsonPath, '{"apiKey":');
    writeFileSync(envPath, "DB_PASS=raw-secret\n");
    writeFileSync(safePath, "safe");

    sanitizeBackupDirectory(backupPath, {
      sanitizeEnvFile: () => false,
    });

    expect(existsSync(yamlPath)).toBe(false);
    expect(existsSync(jsonPath)).toBe(false);
    expect(existsSync(envPath)).toBe(false);
    expect(readFileSync(safePath, "utf-8")).toBe("safe");
  });

  it("removes and rejects the whole backup when an unsafe artifact cannot be deleted", () => {
    const backupPath = createBackup();
    const yamlPath = join(backupPath, "state", "config.yaml");
    writeFileSync(yamlPath, "api_key: [unclosed\n");

    expect(() =>
      sanitizeBackupDirectory(backupPath, {
        unlinkFile: () => {
          throw new Error("injected unlink failure");
        },
      }),
    ).toThrow("Credential sanitization failed; removed the incomplete backup");
    expect(existsSync(backupPath)).toBe(false);
  });
});
