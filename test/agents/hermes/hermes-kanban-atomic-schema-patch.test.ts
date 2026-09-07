// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const patcher = path.join(root, "agents", "hermes", "patch-hermes-kanban-atomic-schema.py");
const dockerfile = fs.readFileSync(path.join(root, "agents", "hermes", "Dockerfile"), "utf8");
const imageProbe = fs.readFileSync(
  path.join(root, "agents", "hermes", "image-build-probes.py"),
  "utf8",
);
const fixtures: string[] = [];

function moduleSource(middle = ""): string {
  return `SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY);
${middle}
CREATE TABLE IF NOT EXISTS kanban_notify_subs (task_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_notify_task           ON kanban_notify_subs(task_id);
"""
`;
}

function fixtureFile(source: string): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-kanban-schema-"));
  fixtures.push(fixture);
  const module = path.join(fixture, "kanban_db.py");
  fs.writeFileSync(module, source);
  return module;
}

function runPatcher(module: string) {
  return spawnSync("python3", ["-I", patcher, module], {
    encoding: "utf8",
    timeout: 5000,
  });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("Hermes Kanban atomic schema patch", () => {
  it("wraps the base schema in one explicit transaction", () => {
    const module = fixtureFile(moduleSource());

    const result = runPatcher(module);

    expect(result.status, result.stderr).toBe(0);
    const patched = fs.readFileSync(module, "utf8");
    expect(patched).toContain('SCHEMA_SQL = """\nBEGIN IMMEDIATE;\nCREATE TABLE');
    expect(patched).toContain(
      "idx_notify_task           ON kanban_notify_subs(task_id);\nCOMMIT;\n",
    );
  });

  it("rolls back every base table when schema creation is interrupted", () => {
    const module = fixtureFile(moduleSource("CREATE TABLE first_step (id TEXT);\nINVALID SQL;"));
    expect(runPatcher(module).status).toBe(0);
    const database = path.join(path.dirname(module), "kanban.db");
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        `
import runpy
import sqlite3
import sys

schema = runpy.run_path(sys.argv[1])["SCHEMA_SQL"]
database = sys.argv[2]
connection = sqlite3.connect(database, isolation_level=None)
try:
    connection.executescript(schema)
except sqlite3.OperationalError:
    pass
else:
    raise SystemExit("invalid fixture schema unexpectedly succeeded")
finally:
    connection.close()
connection = sqlite3.connect(database)
tables = connection.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
).fetchall()
connection.close()
if tables:
    raise SystemExit(f"partial schema survived rollback: {tables}")
`,
        module,
        database,
      ],
      { encoding: "utf8", timeout: 5000 },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts an already-patched module without rewriting it", () => {
    const module = fixtureFile(moduleSource());
    expect(runPatcher(module).status).toBe(0);
    const patched = fs.readFileSync(module, "utf8");

    const result = runPatcher(module);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(module, "utf8")).toBe(patched);
  });

  it.each([
    ["missing close", moduleSource().replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX")],
    ["duplicate open", `${moduleSource()}\n${moduleSource()}`],
  ])("rejects a %s schema boundary without writing", (_case, source) => {
    const module = fixtureFile(source);

    const result = runPatcher(module);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Hermes Kanban SCHEMA_SQL shape changed");
    expect(fs.readFileSync(module, "utf8")).toBe(source);
  });

  it("binds the Hermes image to the reviewed atomic-schema patcher", () => {
    const digest = createHash("sha256").update(fs.readFileSync(patcher)).digest("hex");
    const imageProbeDigest = createHash("sha256").update(imageProbe).digest("hex");

    expect(dockerfile).toContain(
      `ARG NEMOCLAW_HERMES_KANBAN_ATOMIC_SCHEMA_PATCHER_SHA256=${digest}`,
    );
    expect(dockerfile).toContain(
      "/usr/bin/python3 -I /opt/nemoclaw-hermes-config/patch-hermes-kanban-atomic-schema.py",
    );
    expect(dockerfile).toContain("/opt/nemoclaw-hermes-config/image-build-probes.py kanban-init");
    expect(imageProbe).toContain('[str(hermes), "kanban", "init"]');
    expect(imageProbe).toContain('connection.execute("PRAGMA integrity_check")');
    expect(
      dockerfile.match(
        new RegExp(`ARG NEMOCLAW_HERMES_IMAGE_BUILD_PROBES_SHA256=${imageProbeDigest}`, "gu"),
      ),
    ).toHaveLength(2);
    expect(dockerfile).toContain(
      "check_absent /opt/nemoclaw-hermes-config/patch-hermes-kanban-atomic-schema.py",
    );
  });
});
