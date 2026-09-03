// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const BACKUP_SCRIPT = path.join(REPO_ROOT, "scripts", "backup-workspace.sh");

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o700 });
}

describe("backup-workspace.sh", () => {
  let root: string;
  let home: string;
  let bin: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-backup-workspace-"));
    home = path.join(root, "home");
    bin = path.join(root, "bin");
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports an incomplete backup when a directory is rejected (#10636)", () => {
    const calls = path.join(root, "nemoclaw-calls.txt");
    const openshellCalls = path.join(root, "openshell-calls.txt");
    const workspace = path.join(root, "workspace");
    const linked = path.join(workspace, "memory", "nested", "linked.txt");
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.writeFileSync(path.join(root, "outside.txt"), "outside");
    fs.symlinkSync(path.join(root, "outside.txt"), linked);

    const nemoclaw = path.join(bin, "nemoclaw");
    writeExecutable(
      nemoclaw,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\t%s\\t%s\\n' "$1" "$2" "$3" "$4" >> "$NEMOCLAW_TEST_CALLS"
if [[ "$3" == */memory/ ]]; then
  test -L "$NEMOCLAW_TEST_LINKED_MEMBER"
  printf 'NEMOCLAW_TEST_REJECTED_UNSAFE_DIRECTORY\n' >&2
  exit 1
fi
mkdir -p "$4"
printf 'saved\\n' > "\${4%/}/$(basename -- "$3")"
`,
    );
    writeExecutable(
      path.join(bin, "openshell"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NEMOCLAW_TEST_OPENSHELL_CALLS"
exit 99
`,
    );

    const env = {
      ...process.env,
      HOME: home,
      NEMOCLAW_CLI_BIN: nemoclaw,
      NEMOCLAW_TEST_CALLS: calls,
      NEMOCLAW_TEST_LINKED_MEMBER: linked,
      NEMOCLAW_TEST_OPENSHELL_CALLS: openshellCalls,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    const result = spawnSync("bash", [BACKUP_SCRIPT, "backup", "test-sandbox"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("NEMOCLAW_TEST_REJECTED_UNSAFE_DIRECTORY");
    expect(fs.existsSync(openshellCalls)).toBe(false);

    const invocations = fs.readFileSync(calls, "utf8").trim().split("\n");
    expect(invocations).toHaveLength(6);
    expect(invocations.at(-1)).toMatch(
      /^test-sandbox\tdownload\t\/sandbox\/\.openclaw\/workspace\/memory\/\t/,
    );

    const backupRoot = path.join(home, ".nemoclaw", "backups");
    expect(result.stderr).toContain("Removed incomplete backup at ");
    expect(result.stderr).toContain(" because memory/ was not downloaded.");
    expect(result.stderr).toContain(
      "Remove unsupported entries from /sandbox/.openclaw/workspace/memory/ and rerun the backup before restore.",
    );
    expect(fs.readdirSync(backupRoot)).toEqual([]);

    const restoreResult = spawnSync("bash", [BACKUP_SCRIPT, "restore", "test-sandbox"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
    });

    expect(restoreResult.status, restoreResult.stderr).toBe(1);
    expect(restoreResult.stderr).toContain(`No backups found in ${backupRoot}/`);
    expect(fs.existsSync(openshellCalls)).toBe(false);
  });

  it("preserves an existing backup when the timestamp collides (#10636)", () => {
    const timestamp = "20260903-010203";
    const backupRoot = path.join(home, ".nemoclaw", "backups");
    const existingBackup = path.join(backupRoot, timestamp);
    const marker = path.join(existingBackup, "preserved.txt");
    const calls = path.join(root, "nemoclaw-calls.txt");
    fs.mkdirSync(existingBackup, { recursive: true });
    fs.writeFileSync(marker, "existing backup\n");

    writeExecutable(
      path.join(bin, "date"),
      `#!/usr/bin/env bash
printf '%s\n' '${timestamp}'
`,
    );
    const nemoclaw = path.join(bin, "nemoclaw");
    writeExecutable(
      nemoclaw,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NEMOCLAW_TEST_CALLS"
exit 99
`,
    );

    const result = spawnSync("bash", [BACKUP_SCRIPT, "backup", "test-sandbox"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        NEMOCLAW_CLI_BIN: nemoclaw,
        NEMOCLAW_TEST_CALLS: calls,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`Failed to create a new backup at ${existingBackup}/.`);
    expect(fs.readFileSync(marker, "utf8")).toBe("existing backup\n");
    expect(fs.readdirSync(existingBackup)).toEqual(["preserved.txt"]);
    expect(fs.existsSync(calls)).toBe(false);
  });
});
