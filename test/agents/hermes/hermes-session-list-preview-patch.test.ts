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
const oldRenderer = `                if has_titles:
                    title = (s.get("title") or "—")[:26]
                    print(f"{title:<28} {ws:<18} {last_active:<13} {s['id']}")`;
const newRenderer = `                if has_titles:
                    title = (
                        s.get("preview")
                        if s.get("title_source") in ("derived", "llm")
                        else s.get("title")
                    ) or s.get("preview") or "—"
                    title = title[:26]
                    print(f"{title:<28} {ws:<18} {last_active:<13} {s['id']}")`;

function fixtureFiles(stateSource: string, commandSource = oldRenderer) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-session-preview-"));
  fixtures.push(fixture);
  const stateModule = path.join(fixture, "hermes_state.py");
  const commandModule = path.join(fixture, "sessions_cmd.py");
  fs.writeFileSync(stateModule, stateSource);
  fs.writeFileSync(commandModule, commandSource);
  return { commandModule, stateModule };
}

function runPatcher(stateModule: string, commandModule: string) {
  return spawnSync(
    "python3",
    ["-I", patcher, stateModule, "--sessions-command-path", commandModule],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("Hermes session-list preview patch", () => {
  it("replaces every reviewed preview query", () => {
    const source = Array.from({ length: 5 }, () => oldQuery).join("\n");
    const { commandModule, stateModule } = fixtureFiles(source);

    const result = runPatcher(stateModule, commandModule);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(stateModule, "utf8")).toBe(
      Array.from({ length: 5 }, () => newQuery).join("\n"),
    );
    expect(fs.readFileSync(commandModule, "utf8")).toBe(newRenderer);
  });

  it("accepts an exactly patched source", () => {
    const source = Array.from({ length: 5 }, () => newQuery).join("\n");
    const { commandModule, stateModule } = fixtureFiles(source, newRenderer);

    const result = runPatcher(stateModule, commandModule);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(stateModule, "utf8")).toBe(source);
    expect(fs.readFileSync(commandModule, "utf8")).toBe(newRenderer);
  });

  it("rejects a mixed source without modifying it", () => {
    const source = [...Array.from({ length: 5 }, () => oldQuery), newQuery].join("\n");
    const { commandModule, stateModule } = fixtureFiles(source);

    const result = runPatcher(stateModule, commandModule);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Hermes session preview query shape changed");
    expect(fs.readFileSync(stateModule, "utf8")).toBe(source);
    expect(fs.readFileSync(commandModule, "utf8")).toBe(oldRenderer);
  });

  it("rejects a changed workspace renderer without modifying either source", () => {
    const source = Array.from({ length: 5 }, () => oldQuery).join("\n");
    const changedRenderer = oldRenderer.replace('s.get("title")', 's.get("display_name")');
    const { commandModule, stateModule } = fixtureFiles(source, changedRenderer);

    const result = runPatcher(stateModule, commandModule);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Hermes session list renderer shape changed");
    expect(fs.readFileSync(stateModule, "utf8")).toBe(source);
    expect(fs.readFileSync(commandModule, "utf8")).toBe(changedRenderer);
  });
});
