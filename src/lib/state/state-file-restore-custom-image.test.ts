// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { StateFileKeyAllowlistRestoreOwnership } from "../agent/defs";
import { restoreStateFile } from "./state-file-restore";

type SpawnSyncCall = (
  command: string,
  args: readonly string[],
  options: { input?: Buffer },
) => { status: number; error?: Error; signal: NodeJS.Signals | null; stderr: Buffer };

const spawnSyncMock = vi.hoisted(() =>
  vi.fn<SpawnSyncCall>(() => ({ status: 0, signal: null, stderr: Buffer.alloc(0) })),
);

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

const fixtures: string[] = [];
const ownership: StateFileKeyAllowlistRestoreOwnership = {
  merge: "key-allowlist",
  userKeys: [{ key: "ui.show_scrollbar", type: "boolean" }],
  requireFreshTables: ["models"],
};

function createBackupFixture(): { backupPath: string; backupContents: Buffer } {
  const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-state-"));
  fixtures.push(backupPath);
  const backupContents = Buffer.from(
    '[models]\ndefault = "backup-owned"\n\n[ui]\nshow_scrollbar = true\n',
  );
  fs.writeFileSync(path.join(backupPath, "config.toml"), backupContents);
  return { backupPath, backupContents };
}

afterEach(() => {
  vi.clearAllMocks();
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("custom-image state-file restore capability (#6334)", () => {
  it("restores the complete backup without invoking the managed key allowlist", () => {
    const { backupPath, backupContents } = createBackupFixture();

    const restored = restoreStateFile(
      ["-F", "/tmp/ssh-config", "openshell-alpha"],
      "/sandbox/.deepagents",
      { path: "config.toml", strategy: "copy" },
      backupPath,
      ownership,
      true,
      vi.fn(),
    );

    expect(restored).toBe(true);
    const [binary, args, options] = spawnSyncMock.mock.calls[0] ?? [];
    expect(binary).toBe("ssh");
    const command = String(args?.at(-1));
    expect(command).toContain(".nemoclaw-restore.XXXXXX");
    expect(command).not.toContain("/opt/venv/bin/python3");
    expect(command).not.toContain("show_scrollbar");
    expect(options?.input).toEqual(backupContents);
  });

  it("requires the capability before bypassing the managed key allowlist", () => {
    const { backupPath, backupContents } = createBackupFixture();

    const restored = restoreStateFile(
      ["-F", "/tmp/ssh-config", "openshell-alpha"],
      "/sandbox/.deepagents",
      { path: "config.toml", strategy: "copy" },
      backupPath,
      ownership,
      false,
      vi.fn(),
    );

    expect(restored).toBe(true);
    const [binary, args, options] = spawnSyncMock.mock.calls[0] ?? [];
    expect(binary).toBe("ssh");
    const command = String(args?.at(-1));
    expect(command).toContain("/opt/venv/bin/python3 -I -c");
    expect(command).toContain("show_scrollbar");
    expect(command).toContain("require_fresh_tables");
    expect(command).not.toContain(".nemoclaw-restore.XXXXXX");
    expect(options?.input).toEqual(backupContents);
  });
});
