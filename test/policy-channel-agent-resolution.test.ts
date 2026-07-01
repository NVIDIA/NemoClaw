// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"));
const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "state", "registry.ts"));
const SOURCE_NODE_ARGS = ["--import", "tsx"];

describe("sandbox-aware messaging policy resolution", () => {
  it("loadPresetForSandbox fails closed for unknown messaging agents without blocking central presets", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-agent-resolution-"));
    const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
registry.registerSandbox({
  name: "deepagents-sandbox",
  agent: "langchain-deepagents-code",
  policies: [],
});
const channelPreset = policies.loadPresetForSandbox("deepagents-sandbox", "telegram");
const centralPreset = policies.loadPresetForSandbox("deepagents-sandbox", "npm");
process.stdout.write("__RESULT__" + JSON.stringify({
  channelPreset,
  centralPresetHasNpmPolicy: String(centralPreset).includes("npm_yarn:"),
}));
`;
    const result = spawnSync(process.execPath, [...SOURCE_NODE_ARGS, "-e", script], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir },
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.split("__RESULT__")[1].trim());
    expect(payload.channelPreset).toBeNull();
    expect(payload.centralPresetHasNpmPolicy).toBe(true);
  });
});
