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

function moduleSource(): string {
  return `import os
import sqlite3
import stat
from pathlib import Path

def get_hermes_home():
    return Path("/fixture")

DEFAULT_DB_PATH = _IMPORT_DEFAULT_DB_PATH = get_hermes_home() / "state.db"

# Back off from read-only opens after one fails.

def _connect_tracked_db(*args, **kwargs):
    return sqlite3.connect(*args, **kwargs)

def apply_database_pragmas(_connection, *, db_label):
    return db_label

def _secure_state_db_files(_path, *, create_main=False):
    return create_main

class SessionDB:
    def _init_schema(self):
        pass

    def _open_writer_conn(self):
        conn = _connect_tracked_db(":memory:")
        try:
            _secure_state_db_files(self.db_path)
            apply_database_pragmas(conn, db_label="state.db")
            conn.execute("PRAGMA foreign_keys=ON")
        except BaseException:
            raise
        return conn

    def _connect_and_init(self):
        _secure_state_db_files(self.db_path, create_main=True)
        self._conn = self._open_writer_conn()
        self._init_schema()
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
describe("Hermes shared-state permission patch", () => {
  it("inserts the fixed-layout descriptor normalizer after native hardening", () => {
    const stateModule = fixtureFile(moduleSource());

    const result = runPatcher(stateModule);

    expect(result.status, result.stderr).toBe(0);
    const patched = fs.readFileSync(stateModule, "utf8");
    expect(patched).toContain("def _nemoclaw_normalize_shared_state_permissions(");
    expect(patched).toContain("os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW");
    expect(patched).toContain("os.open(name, file_flags, dir_fd=directory_fd)");
    expect(patched).toContain("os.fchmod(descriptor, 0o660)");
    expect(
      patched.match(/_nemoclaw_normalize_shared_state_permissions\(self[.]db_path\)/gu),
    ).toHaveLength(2);
    expect(patched).not.toContain("PRAGMA temp_store=MEMORY");
    expect(patched.indexOf("_secure_state_db_files(self.db_path)\n")).toBeLessThan(
      patched.indexOf("_nemoclaw_normalize_shared_state_permissions(self.db_path)\n"),
    );
  });

  it("accepts one already-patched state module without rewriting it", () => {
    const stateModule = fixtureFile(moduleSource());
    expect(runPatcher(stateModule).status).toBe(0);
    const patched = fs.readFileSync(stateModule, "utf8");

    const result = runPatcher(stateModule);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(stateModule, "utf8")).toBe(patched);
  });

  it("normalizes only the fixed state ledger and its sidecars through pinned descriptors", () => {
    const stateModule = fixtureFile(moduleSource());
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
    expect(result.stdout).toBe("state.db=660 state.db-wal=660 state.db-shm=660\nunrelated=640\n");
  });

  it.each([
    [
      "missing writer hardening",
      moduleSource().replace("            _secure_state_db_files(self.db_path)\n", ""),
    ],
    [
      "missing initialization hardening",
      moduleSource().replace(
        "        _secure_state_db_files(self.db_path, create_main=True)\n",
        "",
      ),
    ],
    [
      "duplicate writer hardening",
      moduleSource().replace(
        "            _secure_state_db_files(self.db_path)\n",
        "            _secure_state_db_files(self.db_path)\n            _secure_state_db_files(self.db_path)\n",
      ),
    ],
  ])("rejects a %s source shape", (_case, source) => {
    const stateModule = fixtureFile(source);

    const result = runPatcher(stateModule);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Hermes shared state hardening shape changed");
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

  it("wraps the Hermes 0.21.3 kanban schema in one write transaction", () => {
    expect(dockerfile).toContain(
      "grep -Fc 'conn.executescript(_kb.SCHEMA_SQL)' /opt/hermes/hermes_cli/kanban_db_connect.py",
    );
    expect(dockerfile).toContain(
      'conn.executescript("BEGIN IMMEDIATE;\\\\n" + _kb.SCHEMA_SQL + "\\\\nCOMMIT;")',
    );
    expect(dockerfile).toContain(
      "/opt/hermes/.venv/bin/python3 -m py_compile /opt/hermes/hermes_cli/kanban_db_connect.py",
    );
    expect(dockerfile).not.toContain("conn.executescript(SCHEMA_SQL)");
  });
});
