// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "../../..");
const patcher = path.join(repoRoot, "agents", "hermes", "patch-discord-recovery-permissions.py");
const fixtures: string[] = [];

const exactUpstreamFixture = `\
import os

_DB_FILENAME = "discord_message_recovery.db"


class DiscordRecoveryStore:
    def path(self):
        directory = self._hermes_home / "gateway"
        directory.mkdir(parents=True, exist_ok=True)
        return directory / _DB_FILENAME

    def call(self, path):
        os.chmod(path, 0o600)
`;

function fixtureFile(source = exactUpstreamFixture): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-discord-recovery-patch-"));
  fixtures.push(fixture);
  const file = path.join(fixture, "recovery.py");
  fs.writeFileSync(file, source);
  return file;
}

function runPatcher(file: string) {
  return spawnSync("python3", ["-I", patcher, file], {
    encoding: "utf8",
    timeout: 5000,
  });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("Hermes Discord recovery permissions", () => {
  it("patches only the exact pinned upstream chmod shape", () => {
    const file = fixtureFile();
    const result = runPatcher(file);

    expect(result.status, result.stderr).toBe(0);
    const patched = fs.readFileSync(file, "utf8");
    expect(patched).toContain("os.chmod(path, 0o660)");
    expect(patched).not.toContain("os.chmod(path, 0o600)");
  });

  it.each([
    [
      "prepatched source",
      exactUpstreamFixture.replace("os.chmod(path, 0o600)", "os.chmod(path, 0o660)"),
      "prepatched 0660 chmods: 1",
    ],
    [
      "renamed parent",
      exactUpstreamFixture.replace(
        'directory = self._hermes_home / "gateway"',
        'directory = self._hermes_home / "discord"',
      ),
      "expected one gateway directory assignment, found 0",
    ],
    [
      "renamed database",
      exactUpstreamFixture.replace(
        '_DB_FILENAME = "discord_message_recovery.db"',
        '_DB_FILENAME = "recovery.db"',
      ),
      "expected one recovery database filename, found 0",
    ],
  ])("fails closed for %s", (_name, source, message) => {
    const file = fixtureFile(source);
    const result = runPatcher(file);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(fs.readFileSync(file, "utf8")).toBe(source);
  });

});
