// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildStateFileRestoreCommand } from "./state-file-restore";

const STATE_FILE = { path: "openclaw.json", strategy: "copy" } as const;
const fixtures: string[] = [];

function runRestore(
  refreshOpenClawConfigHash: boolean,
  occupy: (stateDir: string) => void = () => undefined,
): { configPath: string; stateDir: string; status: number | null } {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-file-mode-"));
  fixtures.push(fixture);
  const stateDir = path.join(fixture, ".openclaw");
  fs.mkdirSync(stateDir);
  occupy(stateDir);
  const command = buildStateFileRestoreCommand(stateDir, STATE_FILE, refreshOpenClawConfigHash);
  const result = spawnSync("bash", ["-c", command], {
    input: Buffer.from('{"gateway":{"mode":"local"}}\n'),
  });
  return { configPath: path.join(stateDir, STATE_FILE.path), stateDir, status: result.status };
}

function mode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { force: true, recursive: true });
  }
});

describe("state-file restore modes", () => {
  it("restores an OpenClaw config with the mutable managed-guard mode", () => {
    const { configPath, stateDir, status } = runRestore(true);

    expect(status).toBe(0);
    expect(mode(configPath)).toBe(0o660);
    expect(mode(`${configPath}.last-good`)).toBe(0o660);
    expect(mode(path.join(stateDir, ".config-hash"))).toBe(0o660);

    // A sandbox that cannot publish the config hash must not report a restore.
    const blocked = runRestore(true, (dir) => fs.mkdirSync(path.join(dir, ".config-hash")));
    expect(blocked.status).not.toBe(0);
  });

  it("keeps the restricted mode for ordinary copied state files", () => {
    const { configPath, status } = runRestore(false);

    expect(status).toBe(0);
    expect(mode(configPath)).toBe(0o640);
  });
});
