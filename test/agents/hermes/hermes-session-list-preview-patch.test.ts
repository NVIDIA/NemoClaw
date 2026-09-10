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
const oldRenderer = `                if has_titles:
                    title = (s.get("title") or "—")[:26]
                    print(f"{title:<28} {ws:<18} {last_active:<13} {s['id']}")`;

const stateFixture = `\
def _preview(connection, query):
    return connection.execute(query).fetchone()[0]

${Array.from(
  { length: 5 },
  (_, index) => `QUERY_${index} = "SELECT content FROM messages m ${oldQuery}"`,
).join("\n")}

def previews(connection):
    return [_preview(connection, query) for query in (
        QUERY_0, QUERY_1, QUERY_2, QUERY_3, QUERY_4,
    )]
`;

const commandFixture = `\
def render(session):
    has_titles = True
    s = session
    ws = "workspace"
    last_active = "now"
    for _row in (session,):
        if _row:
${oldRenderer}
`;

function fixtureFiles() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-session-preview-"));
  fixtures.push(fixture);
  const stateModule = path.join(fixture, "hermes_state.py");
  const commandModule = path.join(fixture, "sessions_cmd.py");
  fs.writeFileSync(stateModule, stateFixture);
  fs.writeFileSync(commandModule, commandFixture);
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
  it("shows the latest message while preserving explicit titles", () => {
    const { commandModule, stateModule } = fixtureFiles();

    const result = runPatcher(stateModule, commandModule);

    expect(result.status, result.stderr).toBe(0);
    const probe = `\
import contextlib
import importlib.util
import io
import json
import sqlite3
import sys

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

state = load("patched_state", sys.argv[1])
command = load("patched_command", sys.argv[2])
connection = sqlite3.connect(":memory:")
connection.execute("CREATE TABLE messages (content TEXT, timestamp INTEGER, id INTEGER)")
connection.executemany(
    "INSERT INTO messages VALUES (?, ?, ?)",
    [("first turn", 1, 1), ("latest turn", 2, 2)],
)
output = []
for session in (
    {"title": "seed title", "title_source": "derived", "preview": "latest turn", "id": "derived"},
    {"title": "chosen title", "title_source": "user", "preview": "latest turn", "id": "user"},
):
    stream = io.StringIO()
    with contextlib.redirect_stdout(stream):
        command.render(session)
    output.append(stream.getvalue().strip())
print(json.dumps({"previews": state.previews(connection), "output": output}))
`;
    const probeResult = spawnSync("python3", ["-I", "-c", probe, stateModule, commandModule], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(probeResult.status, probeResult.stderr).toBe(0);
    const observed = JSON.parse(probeResult.stdout) as {
      previews: string[];
      output: string[];
    };
    expect(observed.previews).toEqual(Array.from({ length: 5 }, () => "latest turn"));
    expect(observed.output[0]).toContain("latest turn");
    expect(observed.output[0]).not.toContain("seed title");
    expect(observed.output[1]).toContain("chosen title");
  });
});
