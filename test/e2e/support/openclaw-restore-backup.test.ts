// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  OPENCLAW_RESTORE_HOST_PROGRAM,
  openClawRestoreFixture,
} from "../fixtures/openclaw-restore-fixture.ts";

let home: string;
let backupPath: string;
let priorPath: string;
let archive: string;
let manifestPath: string;
let recoveryPath: string;
const sandboxName = "e2e-restore-owned";
const transactionId = "729e7460-4672-42ba-a6ba-7c9c0d11947e";
const fixture = openClawRestoreFixture("restore-backup-owned");
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restore-backup-test-"));
  backupPath = path.join(home, ".nemoclaw/rebuild-backups", sandboxName, "2026-10-28T04-10-00Z");
  priorPath = path.join(path.dirname(backupPath), "2026-10-27T04-10-00Z");
  const native = path.join(home, "native");
  fs.mkdirSync(path.join(native, ".openclaw/telegram"), { recursive: true });
  fs.writeFileSync(
    path.join(native, ".openclaw/telegram/thread-bindings-unmigrated.json"),
    fixture.refusedFiles["telegram/thread-bindings-unmigrated.json"],
  );
  fs.mkdirSync(backupPath, { recursive: true, mode: 0o700 });
  archive = path.join(backupPath, "native-home.tar");
  const tar = spawnSync("tar", ["-cf", archive, "-C", native, "."], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(tar.status, tar.stderr).toBe(0);
  const manifest = {
    version: 2,
    sandboxName,
    timestamp: path.basename(backupPath),
    agentType: "openclaw",
    agentVersion: "2026.10.5",
    expectedVersion: "2026.10.5",
    backupPath,
    blueprintDigest: null,
    backupComplete: true,
    nativeState: { root: "/sandbox", archive: "native-home.tar", sha256: digest(archive) },
  };
  manifestPath = path.join(backupPath, "rebuild-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  recoveryPath = path.join(backupPath, ".nemoclaw-rebuild-recovery.json");
  fs.writeFileSync(
    recoveryPath,
    JSON.stringify({
      schemaVersion: 3,
      transactionId,
      sandboxName,
      backupTimestamp: manifest.timestamp,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      phase: "restore",
    }),
    { mode: 0o600 },
  );
  fs.mkdirSync(priorPath, { mode: 0o700 });
  fs.copyFileSync(archive, path.join(priorPath, "native-home.tar"));
  fs.writeFileSync(
    path.join(priorPath, "rebuild-manifest.json"),
    JSON.stringify({
      ...manifest,
      timestamp: path.basename(priorPath),
      backupPath: priorPath,
    }),
    { mode: 0o600 },
  );
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function inspect(before = [priorPath]) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      OPENCLAW_RESTORE_HOST_PROGRAM,
      JSON.stringify({
        mode: "backup",
        sandboxName,
        gatewayName: "nemoclaw",
        before,
        refused: true,
        files: {
          ".openclaw/telegram/thread-bindings-unmigrated.json":
            fixture.refusedFiles["telegram/thread-bindings-unmigrated.json"],
        },
      }),
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR },
    },
  );
}

it("binds preserved native bytes to the exact new backup and retained recovery transaction", () => {
  const before = digest(archive);
  const result = inspect();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    backupPath,
    archiveSha256: before,
    fixturePreserved: true,
    transactionId,
  });
  expect(digest(archive)).toBe(before);
});

it("rejects an archive changed after the production manifest was written", () => {
  fs.appendFileSync(archive, "changed bytes");
  const result = inspect();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("rebuild changed the original backup");
});

it.each([
  {
    name: "wrong gateway",
    key: "gatewayName",
    value: "other-gateway",
    diagnostic: "other-gateway",
  },
  { name: "retired transaction", key: "phase", value: "cleanup", diagnostic: "cleanup" },
  {
    name: "different sandbox",
    key: "sandboxName",
    value: "other-sandbox",
    diagnostic: "undefined",
  },
])("rejects $name recovery authority", ({ key, value, diagnostic }) => {
  const record = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
  fs.writeFileSync(recoveryPath, JSON.stringify({ ...record, [key]: value }));
  const result = inspect();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(diagnostic);
  expect(fs.existsSync(archive)).toBe(true);
});

it("rejects an ambiguous backup inventory rather than choosing the latest timestamp", () => {
  const result = inspect([]);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("expected exactly the backup created by this rebuild");
});

it.each([
  {
    phase: "Stopped",
    refusal: true,
    status: 0,
    diagnostic: "",
    expectedStdout: JSON.stringify({
      refused: true,
      phase: "Stopped",
      logs: [
        "[migration] OpenClaw 2026.9.7 retired Telegram state inspection failed; retained state",
      ],
    }),
  },
  {
    phase: "Running",
    refusal: true,
    status: 1,
    diagnostic: "refused replacement is still active",
    expectedStdout: "",
  },
  {
    phase: "Stopped",
    refusal: false,
    status: 1,
    diagnostic: "missing actual retired-state refusal evidence",
    expectedStdout: "",
  },
])(
  "checks the refusal fixture with phase $phase and refusal evidence $refusal",
  ({ phase, refusal, status, diagnostic, expectedStdout }) => {
    const openshell = path.join(home, "openshell");
    const refusalLog =
      "[migration] OpenClaw 2026.9.7 retired Telegram state inspection failed; retained state";
    fs.writeFileSync(
      openshell,
      `#!${process.execPath}\n` +
        `const assert = require('node:assert/strict');\n` +
        `const args = process.argv.slice(2);\n` +
        `assert.deepEqual(args, ['sandbox', 'get', '-g', 'nemoclaw', '${sandboxName}']);\n` +
        `console.log('Phase: ${phase}');\n`,
      { mode: 0o700 },
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        OPENCLAW_RESTORE_HOST_PROGRAM,
        JSON.stringify({
          mode: "refusal",
          sandboxName,
          gatewayName: "nemoclaw",
          startupLog: refusal ? refusalLog : "unrelated log",
        }),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: process.env.TMPDIR,
          NEMOCLAW_OPENSHELL_BIN: openshell,
        },
      },
    );
    expect(result.status, result.stderr).toBe(status);
    expect(result.stdout.trim()).toBe(expectedStdout);
    expect(result.stderr).toContain(diagnostic);
    expect(fs.existsSync(archive)).toBe(true);
  },
);
