// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

describe("nemoclaw CLI runtime recovery", () => {
  it("recovers sandbox status when openshell is only available via the resolved fallback path", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-recovery-"));
    const homeLocalBin = path.join(tmpDir, ".local", "bin");
    const stateDir = path.join(tmpDir, "state");
    const registryDir = path.join(tmpDir, ".nemoclaw");
    const openshellPath = path.join(homeLocalBin, "openshell");
    const stateFile = path.join(stateDir, "openshell-state.json");

    fs.mkdirSync(homeLocalBin, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: "my-assistant",
        sandboxes: {
          "my-assistant": {
            name: "my-assistant",
            model: "nvidia/nemotron-3-super-120b-a12b",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
      }),
      { mode: 0o600 }
    );
    fs.writeFileSync(stateFile, JSON.stringify({ statusCalls: 0, sandboxGetCalls: 0 }));
    fs.writeFileSync(
      openshellPath,
      `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const statePath = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

if (args[0] === "status") {
  state.statusCalls += 1;
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (state.statusCalls === 1) {
    process.stdout.write("Error:   × No active gateway\\n");
  } else {
    process.stdout.write("Gateway: nemoclaw\\nStatus: Connected\\n");
  }
  process.exit(0);
}

if (args[0] === "gateway" && (args[1] === "start" || args[1] === "select")) {
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "info") {
  process.stdout.write("Gateway: nemoclaw\\nGateway endpoint: https://127.0.0.1:8080\\n");
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "get" && args[2] === "my-assistant") {
  state.sandboxGetCalls += 1;
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (state.sandboxGetCalls === 1) {
    process.stdout.write("Error:   × transport error\\n  ╰─▶ Connection reset by peer (os error 104)\\n");
    process.exit(1);
  }
  process.stdout.write("Sandbox:\\n\\n  Id: abc\\n  Name: my-assistant\\n  Namespace: openshell\\n  Phase: Ready\\n");
  process.exit(0);
}

if (args[0] === "logs") {
  process.exit(0);
}

process.exit(0);
`,
      { mode: 0o755 }
    );

    const result = spawnSync(process.execPath, [path.join(repoRoot, "bin", "nemoclaw.js"), "my-assistant", "status"], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: "/usr/bin:/bin",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Recovered NemoClaw gateway runtime via (start|select)/);
    assert.match(result.stdout, /Phase: Ready/);
  });
});
