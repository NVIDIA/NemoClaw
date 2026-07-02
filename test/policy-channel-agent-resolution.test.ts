// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const ACTION_PATH = JSON.stringify(
  path.join(REPO_ROOT, "src", "lib", "actions", "sandbox", "policy-channel.ts"),
);
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
    expect(result.stderr).not.toContain("Preset not found");
  });

  it("gateway preset matching skips unsupported Deep Agents messaging policies without lookup noise (#6185)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-gateway-agent-"));
    const openshellPath = path.join(tmpDir, "openshell");
    fs.writeFileSync(
      openshellPath,
      [
        "#!/usr/bin/env bash",
        "cat <<'EOF'",
        "Version: 1",
        "---",
        "version: 1",
        "network_policies:",
        "  npm_yarn:",
        "    endpoints: []",
        "EOF",
        "",
      ].join("\n"),
    );
    fs.chmodSync(openshellPath, 0o755);
    const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
registry.registerSandbox({
  name: "deepagents-sandbox",
  agent: "langchain-deepagents-code",
  policies: [],
});
const gatewayPresets = policies.getGatewayPresets("deepagents-sandbox");
process.stdout.write("__RESULT__" + JSON.stringify({ gatewayPresets }));
`;
    const result = spawnSync(process.execPath, [...SOURCE_NODE_ARGS, "-e", script], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir, NEMOCLAW_OPENSHELL_BIN: openshellPath },
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Preset not found");
    const payload = JSON.parse(result.stdout.split("__RESULT__")[1].trim());
    expect(payload.gatewayPresets).toEqual(["npm"]);
  });
  it("setup policy preset catalog omits unsupported Deep Agents messaging policies (#6185)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-setup-agent-"));
    const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
registry.registerSandbox({
  name: "deepagents-sandbox",
  agent: "langchain-deepagents-code",
  policies: [],
});
const names = policies.listSetupPolicyPresets("deepagents-sandbox").map((preset) => preset.name);
process.stdout.write("__RESULT__" + JSON.stringify({ names }));
`;
    const result = spawnSync(process.execPath, [...SOURCE_NODE_ARGS, "-e", script], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir },
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.split("__RESULT__")[1].trim());
    expect(payload.names).toContain("npm");
    expect(payload.names).not.toContain("telegram");
    expect(payload.names).not.toContain("discord");
    expect(payload.names).not.toContain("slack");
    expect(payload.names).not.toContain("teams");
    expect(payload.names).not.toContain("whatsapp");
    expect(payload.names).not.toContain("wechat");
  });

  it("policy-add treats unsupported Deep Agents messaging policy as unknown before preview or prompt (#6185)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-agent-gate-"));
    const script = String.raw`
const registry = require(${REGISTRY_PATH});
const { addSandboxPolicy } = require(${ACTION_PATH});
const output = [];
const errors = [];
console.log = (...args) => output.push(args.join(" "));
console.error = (...args) => errors.push(args.join(" "));
process.exit = (code) => { throw new Error("EXIT:" + String(code)); };
registry.registerSandbox({
  name: "deepagents-sandbox",
  agent: "langchain-deepagents-code",
  policies: [],
});
(async () => {
  let exitCode = null;
  try {
    await addSandboxPolicy("deepagents-sandbox", { preset: "telegram", yes: true });
  } catch (error) {
    exitCode = String(error && error.message) === "EXIT:1" ? 1 : "unexpected";
    errors.push(String(error && (error.stack || error.message || error)));
  }
  process.stdout.write("__RESULT__" + JSON.stringify({ exitCode, output, errors }));
})();
`;
    const result = spawnSync(process.execPath, [...SOURCE_NODE_ARGS, "-e", script], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir },
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.split("__RESULT__")[1].trim());
    const text = [...payload.output, ...payload.errors].join("\n");
    expect(payload.exitCode).toBe(1);
    expect(text).toContain("Unknown preset 'telegram'.");
    expect(text).toContain("Valid presets:");
    expect(text).not.toContain("telegram,");
    expect(text).not.toContain("not supported for agent");
    expect(text).not.toContain("Terminal-runtime agents do not run inbound messaging bridges.");
    expect(text).not.toContain("Preset not found");
    expect(text).not.toContain("Endpoints that would be opened");
    expect(text).not.toContain("Apply 'telegram'");
  });
});
