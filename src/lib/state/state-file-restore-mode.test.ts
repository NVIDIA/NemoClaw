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

function runRestore(occupy: (stateDir: string) => void = () => undefined): {
  configPath: string;
  stateDir: string;
  status: number | null;
} {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-file-mode-"));
  fixtures.push(fixture);
  const stateDir = path.join(fixture, ".openclaw");
  fs.mkdirSync(stateDir);
  occupy(stateDir);
  const command = buildStateFileRestoreCommand(stateDir, STATE_FILE);
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
  it("restores OpenClaw config as an ordinary native state file (#11764)", () => {
    const { configPath, stateDir, status } = runRestore();

    expect(status).toBe(0);
    expect(mode(configPath)).toBe(0o640);
    expect(fs.existsSync(`${configPath}.last-good`)).toBe(false);
    expect(fs.existsSync(path.join(stateDir, ".config-hash"))).toBe(false);
  });

  it("preserves private native mode for the sandbox-user runtime topology (#11764)", () => {
    const { configPath, status } = runRestore((stateDir) => {
      const existingConfig = path.join(stateDir, STATE_FILE.path);
      fs.writeFileSync(existingConfig, "{}\n");
      fs.chmodSync(existingConfig, 0o600);
    });

    expect(status).toBe(0);
    expect(mode(configPath)).toBe(0o600);
  });

  it("preserves group-write mode for the separate gateway runtime topology (#11764)", () => {
    const { configPath, status } = runRestore((stateDir) => {
      const existingConfig = path.join(stateDir, STATE_FILE.path);
      fs.writeFileSync(existingConfig, "{}\n");
      fs.chmodSync(existingConfig, 0o660);
    });

    expect(status).toBe(0);
    expect(mode(configPath)).toBe(0o660);
  });
});
