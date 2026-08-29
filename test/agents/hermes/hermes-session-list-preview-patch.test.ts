// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const patcher = path.join(root, "agents", "hermes", "patch-session-list-preview.py");
const fixtures: string[] = [];
const oldQuery = "ORDER BY m.timestamp, m.id LIMIT 1";
const newQuery = "ORDER BY m.timestamp DESC, m.id DESC LIMIT 1";

function fixtureFile(source: string): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-session-preview-"));
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

describe("Hermes session-list preview patch", () => {
  it("replaces every reviewed preview query", () => {
    const source = Array.from({ length: 5 }, () => oldQuery).join("\n");
    const stateModule = fixtureFile(source);

    const result = runPatcher(stateModule);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(stateModule, "utf8")).toBe(
      Array.from({ length: 5 }, () => newQuery).join("\n"),
    );
  });

  it("accepts an exactly patched source", () => {
    const source = Array.from({ length: 5 }, () => newQuery).join("\n");
    const stateModule = fixtureFile(source);

    const result = runPatcher(stateModule);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(stateModule, "utf8")).toBe(source);
  });

  it("rejects a mixed source without modifying it", () => {
    const source = [...Array.from({ length: 5 }, () => oldQuery), newQuery].join("\n");
    const stateModule = fixtureFile(source);

    const result = runPatcher(stateModule);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Hermes session preview query shape changed");
    expect(fs.readFileSync(stateModule, "utf8")).toBe(source);
  });
});
