// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const patcher = path.join(root, "agents", "hermes", "patch-hermes-sqlite-temp-store.py");
const dockerfile = fs.readFileSync(path.join(root, "agents", "hermes", "Dockerfile"), "utf8");
const fixtures: string[] = [];

const walSetup = 'apply_wal_with_fallback(self._conn, db_label="state.db")';
const tempStore = '                self._conn.execute("PRAGMA temp_store=MEMORY")';
const foreignKeys = '                self._conn.execute("PRAGMA foreign_keys=ON")';
const unpatchedConnection = `${walSetup}\n${foreignKeys}`;
const legacyTempStoreConnection = `${walSetup}\n${tempStore}\n${foreignKeys}`;
const unpatchedImports = [
  "import logging",
  "import random",
  "import re",
  "import sqlite3",
  "import sys",
].join("\n");

function moduleSource(connection: string): string {
  return `${unpatchedImports}
from pathlib import Path

def get_hermes_home():
    return Path("/fixture")

DEFAULT_DB_PATH = get_hermes_home() / "state.db"

SCHEMA_VERSION = 22

def apply_wal_with_fallback(_connection, *, db_label):
    return db_label

class SessionDB:
    def _init_schema(self):
        pass

    def connect(self):
            def _connect_and_init():
                self._conn = sqlite3.connect(":memory:")
                ${connection}
                self._init_schema()
            _connect_and_init()
`;
}

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

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("Hermes SQLite temp-store patch", () => {
  it("inserts the temp store and fixed-layout descriptor normalizer", () => {
    const stateModule = fixtureFile(moduleSource(unpatchedConnection));

    const result = runPatcher(stateModule);

    expect(result.status, result.stderr).toBe(0);
    const patched = fs.readFileSync(stateModule, "utf8");
    expect(patched).toContain("def _nemoclaw_normalize_shared_state_permissions(");
    expect(patched).toContain("os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW");
    expect(patched).toContain("os.open(name, file_flags, dir_fd=directory_fd)");
    expect(patched).toContain("os.fchmod(descriptor, 0o660)");
    expect(patched.match(/_nemoclaw_normalize_shared_state_permissions\(self[.]db_path\)/gu)).toHaveLength(
      2,
    );
    expect(patched.indexOf("PRAGMA temp_store=MEMORY")).toBeLessThan(
      patched.indexOf("PRAGMA foreign_keys=ON"),
    );
  });

  it("accepts one already-patched state module without rewriting it", () => {
    const stateModule = fixtureFile(moduleSource(unpatchedConnection));
    expect(runPatcher(stateModule).status).toBe(0);
    const patched = fs.readFileSync(stateModule, "utf8");

    const result = runPatcher(stateModule);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(stateModule, "utf8")).toBe(patched);
  });

  it("upgrades the legacy temp-store-only patch to the shared-state contract", () => {
    const stateModule = fixtureFile(moduleSource(legacyTempStoreConnection));

    const result = runPatcher(stateModule);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(stateModule, "utf8")).toContain(
      "def _nemoclaw_normalize_shared_state_permissions(",
    );
  });

  it("normalizes only the fixed state ledger and its sidecars through pinned descriptors", () => {
    const stateModule = fixtureFile(moduleSource(unpatchedConnection));
    expect(runPatcher(stateModule).status).toBe(0);
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-shared-state-"));
    fixtures.push(fixture);
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        `
import os
from pathlib import Path
import runpy
import stat
import sys

module = runpy.run_path(sys.argv[1])
root = Path(sys.argv[2])
runtime = root / "runtime"
runtime.mkdir(mode=0o2770)
runtime.chmod(0o2770)
link = root / "state.db"
link.symlink_to("runtime/state.db")
names = module["_NEMOCLAW_SHARED_STATE_NAMES"]
for name in names:
    target = runtime / name
    target.write_bytes(b"fixture")
    target.chmod(0o640)
unrelated = root / "unrelated.db"
unrelated.write_bytes(b"unrelated")
unrelated.chmod(0o640)
normalize = module["_nemoclaw_normalize_shared_state_permissions"]
normalize.__globals__["_NEMOCLAW_SHARED_STATE_LINK"] = link
normalize.__globals__["_NEMOCLAW_SHARED_STATE_DIRECTORY"] = runtime
normalize(link)
normalize(unrelated)
print(" ".join(f"{name}={stat.S_IMODE((runtime / name).stat().st_mode):03o}" for name in names))
print(f"unrelated={stat.S_IMODE(unrelated.stat().st_mode):03o}")
`,
        stateModule,
        fixture,
      ],
      { encoding: "utf8", timeout: 5000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "state.db=660 state.db-wal=660 state.db-shm=660\nunrelated=640\n",
    );
  });

  it.each([
    ["duplicate", moduleSource(`${legacyTempStoreConnection}\n${tempStore}`)],
    ["partial", moduleSource(`${walSetup}\n${tempStore}`)],
    ["misplaced", moduleSource(`${tempStore}\n${unpatchedConnection}`)],
  ])("rejects a %s connection patch", (_case, source) => {
    const stateModule = fixtureFile(source);

    const result = runPatcher(stateModule);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Hermes SessionDB.__init__ connection setup shape changed");
    expect(fs.readFileSync(stateModule, "utf8")).toBe(source);
  });

  it("binds the Hermes image to the reviewed patcher (#8301)", () => {
    const digest = createHash("sha256").update(fs.readFileSync(patcher)).digest("hex");

    expect(dockerfile).toContain(`ARG NEMOCLAW_HERMES_SQLITE_TEMP_STORE_PATCHER_SHA256=${digest}`);
    expect(dockerfile).toContain(
      "COPY agents/hermes/patch-hermes-sqlite-temp-store.py " +
        "/usr/local/lib/nemoclaw/patch-hermes-sqlite-temp-store.py",
    );
    expect(dockerfile).toContain(
      "RUN /usr/bin/python3 -I /usr/local/lib/nemoclaw/patch-hermes-sqlite-temp-store.py",
    );
  });
});
