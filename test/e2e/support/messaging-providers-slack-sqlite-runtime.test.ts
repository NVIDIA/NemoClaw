// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { SLACK_SQLITE_TMPDIR_SETUP_SOURCE } from "../live/messaging-providers-slack-runtime-proof.ts";

function runSqliteTmpdirSetup(stateDir: string) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      String.raw`
        import fs from "node:fs";
        import path from "node:path";
        function invariant(condition, message) {
          if (!condition) throw new Error(message);
        }
        ${SLACK_SQLITE_TMPDIR_SETUP_SOURCE}
        const sqliteTmpdir = prepareSqliteTmpdir(process.argv[1]);
        const metadata = fs.lstatSync(sqliteTmpdir);
        process.stdout.write(JSON.stringify({
          sqliteTmpdir,
          effectiveSqliteTmpdir: process.env.SQLITE_TMPDIR,
          isDirectory: metadata.isDirectory(),
          isSymbolicLink: metadata.isSymbolicLink(),
          uid: metadata.uid,
          mode: metadata.mode & 0o777,
        }));
      `,
      stateDir,
    ],
    { encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL" },
  );
}

it("confines installed Slack runtime SQLite temporary files to the OpenClaw state tree", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-sqlite-tmpdir-"));
  try {
    const result = runSqliteTmpdirSetup(stateDir);
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      sqliteTmpdir: string;
      effectiveSqliteTmpdir: string;
      isDirectory: boolean;
      isSymbolicLink: boolean;
      uid: number;
      mode: number;
    };
    expect(receipt).toEqual({
      sqliteTmpdir: path.join(stateDir, "tmp"),
      effectiveSqliteTmpdir: path.join(stateDir, "tmp"),
      isDirectory: true,
      isSymbolicLink: false,
      uid: typeof process.getuid === "function" ? process.getuid() : receipt.uid,
      mode: 0o700,
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

it.runIf(process.platform !== "win32")(
  "rejects a symlink at the installed Slack runtime SQLite temporary path",
  () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-sqlite-symlink-"));
    const symlinkTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-sqlite-target-"));
    try {
      fs.symlinkSync(symlinkTarget, path.join(stateDir, "tmp"), "dir");
      const result = runSqliteTmpdirSetup(stateDir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unsafe OpenClaw SQLite temporary directory");
      expect(result.stdout).toBe("");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(symlinkTarget, { recursive: true, force: true });
    }
  },
);
