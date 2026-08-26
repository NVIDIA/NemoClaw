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
const unpatchedSource = `${walSetup}\n${foreignKeys}\n`;
const patchedSource = `${walSetup}\n${tempStore}\n${foreignKeys}\n`;

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
  it("inserts in-memory temp storage before foreign-key enforcement (#8301)", () => {
    const stateModule = fixtureFile(unpatchedSource);

    const result = runPatcher(stateModule);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(stateModule, "utf8")).toBe(patchedSource);
  });

  it("accepts one already-patched connection block (#8301)", () => {
    const stateModule = fixtureFile(patchedSource);

    const result = runPatcher(stateModule);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(stateModule, "utf8")).toBe(patchedSource);
  });

  it.each([
    ["duplicate", `${patchedSource}${tempStore}\n`],
    ["partial", `${walSetup}\n${tempStore}\n`],
    ["misplaced", `${tempStore}\n${unpatchedSource}`],
  ])("rejects a %s temp-store patch (#8301)", (_case, source) => {
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
