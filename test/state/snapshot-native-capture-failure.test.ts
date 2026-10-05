// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-capture-failure-"));
process.env.HOME = TMP_HOME;

const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")).href
);
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");

function restoreEnv(name: string, value: string | undefined): void {
  value === undefined
    ? Reflect.deleteProperty(process.env, name)
    : Reflect.set(process.env, name, value);
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
      "a permission denial",
      "tar: ./.openclaw/credentials: Cannot open: Permission denied",
      { ".": "permission denied" },
    ],
    [
      "another read error",
      "tar: ./.openclaw/workspace/notes.md: Cannot read: Input/output error",
      { ".": "tar read error" },
    ],
    ["no tar diagnostic", "capture helper stopped", undefined],
  ] as const)(
    "records the capture failure reason when the capture reports %s",
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

        const backup = sandboxState.backupSandboxState("alpha", {
          nativeStateSource: {
            root: "/sandbox",
            directory: nativeRoot,
            assertCurrent: () => undefined,
          },
        });

        expect(backup).toMatchObject({ success: false, failedDirs: ["."] });
        expect(backup.failedDirReasons).toEqual(failedDirReasons);
        expect(backup.error).toContain(diagnostic);
        const sandboxBackups = path.join(BACKUPS_ROOT, "alpha");
        expect(fs.existsSync(sandboxBackups) ? fs.readdirSync(sandboxBackups) : []).toEqual([]);
      } finally {
        restoreEnv("NEMOCLAW_TEST_TAR_DIAGNOSTIC", oldDiagnostic);
        restoreEnv("PATH", oldPath);
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
