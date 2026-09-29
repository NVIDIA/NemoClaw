// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { collectExternalRoots, type MigrationExternalRoot } from "./migration-state.js";

let fixture = "";

afterEach(() => {
  fs.rmSync(fixture, { force: true, recursive: true });
});

it("collects canonical keyed-agent workspace and agent-directory bindings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-entries-"));
  fixture = root;
  const stateDir = path.join(root, ".openclaw");
  const workspace = path.join(root, "workspace-researcher");
  const agentDir = path.join(root, "agents", "researcher");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(workspace);
  fs.mkdirSync(agentDir, { recursive: true });

  const result = collectExternalRoots(
    {
      agents: {
        entries: {
          researcher: { workspace, agentDir },
        },
      },
    },
    stateDir,
    { HOME: root },
  );

  expect(result.errors).toEqual([]);
  expect(
    result.roots.map((entry: MigrationExternalRoot) => entry.bindings[0]?.configPath).sort(),
  ).toEqual(["agents.entries.researcher.agentDir", "agents.entries.researcher.workspace"]);
});
