// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-capture-failure-"));
process.env.HOME = TMP_HOME;

const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")).href
);
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");
const DATABASE_COPY_FAILURE = "OpenClaw database copy failed for ./.openclaw/state/openclaw.sqlite";

function restoreEnv(name: string, value: string | undefined): void {
  value === undefined
    ? Reflect.deleteProperty(process.env, name)
    : Reflect.set(process.env, name, value);
}

function backupPreparedRoot(nativeRoot: string) {
  return sandboxState.backupSandboxState("alpha", {
    nativeStateSource: {
      root: "/sandbox",
      directory: nativeRoot,
      assertCurrent: () => undefined,
    },
  });
}

function publishedBackups(): string[] {
  const sandboxBackups = path.join(BACKUPS_ROOT, "alpha");
  return fs.existsSync(sandboxBackups) ? fs.readdirSync(sandboxBackups) : [];
}

afterAll(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: { name: "alpha", model: "m", provider: "p", gpuEnabled: false, agent: null },
      },
    }),
  );
});

describe("complete native-home capture failures", () => {
  it.each([
    [
      "a permission-denied reason for a denied tar read",
      "tar: ./.openclaw/credentials: Cannot open: Permission denied",
      { ".": "permission denied" },
    ],
    [
      "a tar-read-error reason for another tar read error",
      "tar: ./.openclaw/workspace/notes.md: Cannot read: Input/output error",
      { ".": "tar read error" },
    ],
    ["no reason when tar prints no diagnostic", "capture helper stopped", undefined],
  ] as const)(
    "records %s when the stopped-sandbox capture fails",
    (_condition, diagnostic, failedDirReasons) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-capture-source-"));
      const oldPath = process.env.PATH;
      const oldDiagnostic = process.env.NEMOCLAW_TEST_TAR_DIAGNOSTIC;
      try {
        const binDir = path.join(fixture, "bin");
        const nativeRoot = path.join(fixture, "native-home");
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(nativeRoot, { recursive: true });
        fs.writeFileSync(
          path.join(binDir, "tar"),
          [
            "#!/bin/sh",
            'if [ "$1" = "--hard-dereference" ]; then exit 0; fi',
            "printf '%s\\n' \"$NEMOCLAW_TEST_TAR_DIAGNOSTIC\" >&2",
            "exit 2",
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        process.env.NEMOCLAW_TEST_TAR_DIAGNOSTIC = diagnostic;
        process.env.PATH = `${binDir}:${oldPath ?? ""}`;

        const backup = backupPreparedRoot(nativeRoot);

        expect(backup).toMatchObject({ success: false, failedDirs: ["."] });
        expect(backup.failedDirReasons).toEqual(failedDirReasons);
        expect(backup.error).toContain(diagnostic);
        expect(publishedBackups()).toEqual([]);
      } finally {
        restoreEnv("NEMOCLAW_TEST_TAR_DIAGNOSTIC", oldDiagnostic);
        restoreEnv("PATH", oldPath);
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "records a permission denial when the stopped-sandbox copy cannot read the OpenClaw database",
    () => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-capture-source-"));
      try {
        const nativeRoot = path.join(fixture, "native-home");
        const databasePath = path.join(nativeRoot, ".openclaw", "state", "openclaw.sqlite");
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        const database = new DatabaseSync(databasePath);
        database.exec("CREATE TABLE session_state (session_id TEXT PRIMARY KEY)");
        database.close();
        fs.chmodSync(databasePath, 0o000);

        const backup = backupPreparedRoot(nativeRoot);

        expect(backup).toMatchObject({
          success: false,
          failedDirs: ["."],
          failedDirReasons: { ".": "permission denied" },
        });
        expect(backup.error).toContain(`${DATABASE_COPY_FAILURE}: Permission denied`);
        expect(publishedBackups()).toEqual([]);
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it("reports the stopped-sandbox copy error without a reason when the OpenClaw database path is unsafe", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-capture-source-"));
    try {
      const nativeRoot = path.join(fixture, "native-home");
      fs.mkdirSync(path.join(nativeRoot, ".openclaw", "state", "openclaw.sqlite"), {
        recursive: true,
      });

      const backup = backupPreparedRoot(nativeRoot);

      expect(backup).toMatchObject({ success: false, failedDirs: ["."] });
      expect(backup.failedDirReasons).toBeUndefined();
      expect(backup.error).toContain(`${DATABASE_COPY_FAILURE}: unsafe OpenClaw database path`);
      expect(publishedBackups()).toEqual([]);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("records a permission denial when the live capture reports a denied OpenClaw database read", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-capture-live-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    try {
      const binDir = path.join(fixture, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(
        path.join(binDir, "openshell"),
        [
          "#!/bin/sh",
          'if [ "$1" = sandbox ] && [ "$2" = ssh-config ]; then',
          "  printf 'Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n'",
          "fi",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(binDir, "ssh"),
        [
          "#!/bin/sh",
          "for last; do :; done",
          'case "$last" in',
          `  *"tar -C"*) printf '%s\\n' '${DATABASE_COPY_FAILURE}: Permission denied' >&2; exit 22 ;;`,
          `  *"pwd -P"*) printf '%s\\0%s\\0' /sandbox /sandbox ;;`,
          "  *) exit 90 ;;",
          "esac",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;

      const backup = sandboxState.backupSandboxState("alpha");

      expect(backup).toMatchObject({
        success: false,
        failedDirs: ["."],
        failedDirReasons: { ".": "permission denied" },
      });
      expect(backup.unreachable).toBeUndefined();
      expect(backup.error).toContain(`${DATABASE_COPY_FAILURE}: Permission denied`);
      expect(publishedBackups()).toEqual([]);
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
