// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveTrustedSnapshotSanitizerPythonPath,
  setSnapshotSanitizerPythonPathForTest,
} from "../../../nemoclaw/dist/shared/snapshot-sanitizer-boundary.cjs";
import { sanitizeBackupDirectory } from "./sandbox.js";

const testDirectories: string[] = [];

function createBackup(): string {
  const backupPath = mkdtempSync(join(tmpdir(), "nemoclaw-sanitize-backup-"));
  testDirectories.push(backupPath);
  mkdirSync(join(backupPath, "state"), { recursive: true });
  return backupPath;
}

afterEach(() => {
  setSnapshotSanitizerPythonPathForTest(undefined);
  vi.unstubAllEnvs();
  for (const testDirectory of testDirectories.splice(0)) {
    rmSync(testDirectory, { recursive: true, force: true });
  }
});

describe("rebuild backup credential sanitization", () => {
  it("sanitizes a real env file and restricts its mode", () => {
    const backupPath = createBackup();
    const envPath = join(backupPath, "state", ".env");
    writeFileSync(envPath, "CUSTOM=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nLOG_LEVEL=info\n", {
      mode: 0o644,
    });

    sanitizeBackupDirectory(backupPath);

    expect(readFileSync(envPath, "utf-8")).toBe("CUSTOM=[STRIPPED_BY_MIGRATION]\nLOG_LEVEL=info\n");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("restricts an already-safe config artifact without changing its content", () => {
    const backupPath = createBackup();
    const envPath = join(backupPath, "state", ".env");
    const contents = "LOG_LEVEL=info\n";
    writeFileSync(envPath, contents, { mode: 0o644 });

    sanitizeBackupDirectory(backupPath);

    expect(readFileSync(envPath, "utf-8")).toBe(contents);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("omits unsanitizable config and env artifacts", () => {
    const backupPath = createBackup();
    const yamlPath = join(backupPath, "state", "config.yaml");
    const jsonPath = join(backupPath, "state", "config.json");
    const envPath = join(backupPath, "state", ".env");
    const safePath = join(backupPath, "state", "notes.txt");
    writeFileSync(yamlPath, "api_key: [unclosed\n");
    writeFileSync(jsonPath, '{"apiKey":');
    writeFileSync(envPath, Buffer.from([0xff]));
    writeFileSync(safePath, "safe");

    sanitizeBackupDirectory(backupPath);

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
        sanitizeDirectory: () => {
          throw new Error("injected unlink failure");
        },
      }),
    ).toThrow("Credential sanitization failed; removed the incomplete backup");
    expect(existsSync(backupPath)).toBe(false);
  });

  it("reports when cleanup leaves an incomplete backup behind", () => {
    const backupPath = createBackup();
    const yamlPath = join(backupPath, "state", "config.yaml");
    writeFileSync(yamlPath, "api_key: [unclosed\n");

    expect(() =>
      sanitizeBackupDirectory(backupPath, {
        sanitizeDirectory: () => {
          throw new Error("injected unlink failure");
        },
        removeBackup: () => undefined,
        backupExists: () => true,
      }),
    ).toThrow("Credential sanitization failed and the incomplete backup remains");
    expect(existsSync(backupPath)).toBe(true);
  });

  it("fails closed when a scanned parent directory is swapped before apply", () => {
    const backupPath = createBackup();
    const nestedPath = join(backupPath, "state", "nested");
    const movedPath = join(backupPath, "state", "nested-original");
    mkdirSync(nestedPath);
    writeFileSync(join(nestedPath, "config.json"), '{"apiKey":"sk-inside-secret"}');

    const outsidePath = mkdtempSync(join(tmpdir(), "nemoclaw-sanitize-outside-"));
    const wrapperPath = mkdtempSync(join(tmpdir(), "nemoclaw-sanitize-python-"));
    testDirectories.push(outsidePath, wrapperPath);
    const outsideConfigPath = join(outsidePath, "config.json");
    const outsideContents = '{"apiKey":"sk-outside-secret"}';
    writeFileSync(outsideConfigPath, outsideContents);

    const realPython = resolveTrustedSnapshotSanitizerPythonPath();
    expect(realPython).toEqual(expect.any(String));
    const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
    const pythonWrapper = join(wrapperPath, "python3");
    writeFileSync(
      pythonWrapper,
      `#!/bin/sh\nif [ "$4" = "apply" ]; then\n  mv ${shellQuote(nestedPath)} ${shellQuote(movedPath)}\n  ln -s ${shellQuote(outsidePath)} ${shellQuote(nestedPath)}\nfi\nexec ${shellQuote(realPython as string)} "$@"\n`,
    );
    chmodSync(pythonWrapper, 0o755);
    setSnapshotSanitizerPythonPathForTest(pythonWrapper);

    expect(() => sanitizeBackupDirectory(backupPath)).toThrow(
      "Credential sanitization failed; removed the incomplete backup",
    );
    expect(existsSync(backupPath)).toBe(false);
    expect(readFileSync(outsideConfigPath, "utf-8")).toBe(outsideContents);
  });
});
