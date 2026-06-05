// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");

function runScript(scriptBody: string): SpawnSyncReturns<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-sync-"));
  const scriptPath = path.join(tmpDir, "script.js");
  fs.writeFileSync(scriptPath, scriptBody);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
    },
    timeout: 15000,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

describe("policy preset sync", () => {
  it("batches only all-built-in additions and preserves mixed preset order", () => {
    const policiesPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "policy", "index.js"));
    const syncPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "onboard", "policy-preset-sync.js"),
    );
    const script = String.raw`
const policies = require(${policiesPath});
const calls = [];
policies.listPresets = () => [{ name: "npm" }, { name: "pypi" }];
policies.applyPreset = (_sandbox, name) => { calls.push("single:" + name); return true; };
policies.applyPresets = (_sandbox, names) => { calls.push("batch:" + names.join(",")); return true; };
policies.removePreset = (_sandbox, name) => { calls.push("remove:" + name); return true; };

const { syncPresetSelection } = require(${syncPath});
syncPresetSelection("test-sb", [], ["npm", "pypi"]);
syncPresetSelection("test-sb", [], ["npm", "custom", "pypi"]);
process.stdout.write(JSON.stringify(calls) + "\n");
`;

    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), [
      "batch:npm,pypi",
      "single:npm",
      "single:custom",
      "single:pypi",
    ]);
  });
});
