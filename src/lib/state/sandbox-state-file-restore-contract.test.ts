// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { restoreRecreatedSandboxState, type StateFileSpec } from "./sandbox";

const fixtures: string[] = [];

function writeBackup(options: {
  agentType?: string;
  dir?: string;
  stateFiles: StateFileSpec[];
}): string {
  const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-contract-"));
  fixtures.push(backupPath);
  for (const stateFile of options.stateFiles) {
    const target = path.join(backupPath, stateFile.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "backed-up state\n");
  }
  fs.writeFileSync(
    path.join(backupPath, "rebuild-manifest.json"),
    JSON.stringify({
      version: 1,
      sandboxName: "alpha",
      timestamp: "2026-07-09T00:00:00.000Z",
      agentType: options.agentType ?? "langchain-deepagents-code",
      agentVersion: null,
      expectedVersion: null,
      stateDirs: [],
      backedUpDirs: [],
      stateFiles: options.stateFiles,
      dir: options.dir ?? "/sandbox/.deepagents",
      backupPath,
      blueprintDigest: null,
    }),
  );
  return backupPath;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("state-file restore target contract", () => {
  it.each([
    {
      description: "identical paths",
      stateFiles: [
        { path: "config.toml", strategy: "copy" as const },
        { path: "config.toml", strategy: "copy" as const },
      ],
    },
    {
      description: "normalized path aliases",
      stateFiles: [
        { path: "config.toml", strategy: "copy" as const },
        { path: "./config.toml", strategy: "copy" as const },
      ],
    },
  ])("rejects repeated backup state-file $description", ({ stateFiles }) => {
    const backupPath = writeBackup({ stateFiles });

    const result = restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "langchain-deepagents-code",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Backup manifest repeats state file 'config.toml'");
    expect(result.failedFiles).toContain("config.toml");
  });

  it("rejects a backup agent that does not match the recreated target", () => {
    const backupPath = writeBackup({
      stateFiles: [{ path: "config.toml", strategy: "copy" }],
    });

    const result = restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "openclaw",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not match target agent");
    expect(result.failedFiles).toEqual(["config.toml"]);
  });

  it("rejects a stale backup file that the target manifest does not declare", () => {
    const backupPath = writeBackup({
      stateFiles: [{ path: "stale.toml", strategy: "copy" }],
    });

    const result = restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "langchain-deepagents-code",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("is not declared by target agent");
    expect(result.failedFiles).toEqual(["stale.toml"]);
  });

  it("rejects a backup state-file strategy that differs from the target manifest", () => {
    const backupPath = writeBackup({
      stateFiles: [{ path: "config.toml", strategy: "sqlite_backup" }],
    });

    const result = restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "langchain-deepagents-code",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not match target strategy 'copy'");
    expect(result.failedFiles).toEqual(["config.toml"]);
  });

  it("rejects a backup state directory that differs from the current target manifest", () => {
    const backupPath = writeBackup({
      dir: "/sandbox/.unexpected",
      stateFiles: [{ path: "config.toml", strategy: "copy" }],
    });

    const result = restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "langchain-deepagents-code",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not match target directory");
    expect(result.failedFiles).toEqual(["config.toml"]);
  });
});
