// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const patcher = path.join(root, "agents", "hermes", "patch-hermes-sqlite-temp-store.py");
const fixtures: string[] = [];

const pragmaSetup = 'apply_database_pragmas(self._conn, db_label="state.db")';
const tempStore = '                self._conn.execute("PRAGMA temp_store=MEMORY")';
const foreignKeys = '                self._conn.execute("PRAGMA foreign_keys=ON")';
const unpatchedBlock = `${pragmaSetup}\n${foreignKeys}`;
const patchedBlock = `${pragmaSetup}\n${tempStore}\n${foreignKeys}`;

function sessionDbSource(connectionBlock: string): string {
  return `import sqlite3

def apply_database_pragmas(connection, *, db_label):
    del connection, db_label

class SessionDB:
    def __init__(self):
        self._conn = sqlite3.connect(":memory:")
        with self._conn:
                ${connectionBlock}
`;
}

const unpatchedSource = sessionDbSource(unpatchedBlock);
const patchedSource = sessionDbSource(patchedBlock);

function fixtureFile(source: string): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-sqlite-temp-store-"));
  fixtures.push(fixture);
  const stateModule = path.join(fixture, "hermes_state.py");
  fs.writeFileSync(stateModule, source);
  return stateModule;
}

function runPatcher(stateModule: string) {
  return spawnSync("python3", ["-I", patcher, stateModule], {
    encoding: "utf8",
    timeout: 5000,
  });
}

function readPragmas(stateModule: string): { foreignKeys: number; tempStore: number } {
  const probe = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      `import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("hermes_state", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
database = module.SessionDB()._conn
print(json.dumps({
    "foreignKeys": database.execute("PRAGMA foreign_keys").fetchone()[0],
    "tempStore": database.execute("PRAGMA temp_store").fetchone()[0],
}))`,
      stateModule,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(probe.status, probe.stderr).toBe(0);
  return JSON.parse(probe.stdout) as { foreignKeys: number; tempStore: number };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("Hermes SQLite temp-store patch", () => {
  it("enables in-memory temp storage with foreign-key enforcement (#8301)", () => {
    const stateModule = fixtureFile(unpatchedSource);

    const result = runPatcher(stateModule);

    expect(result.status, result.stderr).toBe(0);
    expect(readPragmas(stateModule)).toEqual({ foreignKeys: 1, tempStore: 2 });
  });

  it("preserves in-memory temp storage and foreign-key enforcement for an already-patched connection (#8301)", () => {
    const stateModule = fixtureFile(patchedSource);

    const result = runPatcher(stateModule);

    expect(result.status, result.stderr).toBe(0);
    expect(readPragmas(stateModule)).toEqual({ foreignKeys: 1, tempStore: 2 });
  });

  it.each([
    ["duplicate", sessionDbSource(`${patchedBlock}\n${tempStore}`)],
    ["partial", sessionDbSource(`${pragmaSetup}\n${tempStore}`)],
    ["misplaced", `${tempStore}\n${unpatchedSource}`],
  ])("rejects a %s temp-store patch (#8301)", (_case, source) => {
    const stateModule = fixtureFile(source);

    const result = runPatcher(stateModule);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Hermes SessionDB.__init__ connection setup shape changed");
    expect(fs.readFileSync(stateModule, "utf8")).toBe(source);
  });
});
