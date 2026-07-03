// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");

const MESSAGING_CHANNELS = ["telegram", "discord", "slack", "wechat", "whatsapp"] as const;

function runScript(
  scriptBody: string,
  extraFiles: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-6185-"));
  const scriptPath = path.join(tmpDir, "script.js");
  fs.writeFileSync(scriptPath, scriptBody);
  for (const [name, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(tmpDir, name), content);
  }
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      NEMOCLAW_NON_INTERACTIVE: "1",
    },
    timeout: 15000,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

function parseResultPayload<T extends Record<string, unknown>>(
  result: SpawnSyncReturns<string>,
): T {
  const marker = result.stdout.lastIndexOf("__RESULT__");
  assert.ok(
    marker >= 0,
    `no __RESULT__ marker in stdout:\n${result.stdout}\n---stderr---\n${result.stderr}`,
  );
  return JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim()) as T;
}

function buildPreamble(agentName: string): string {
  const d = (p: string) =>
    JSON.stringify(path.join(repoRoot, "src", "lib", p.replace(/\.js$/, ".ts")));
  return String.raw`
const onboard = require(${d("onboard.js")});
onboard.isNonInteractive = () => true;

const credentials = require(${d("credentials/store.js")});
const promptCalls = [];
credentials.prompt = async (msg) => { promptCalls.push(msg); return ""; };

const registry = require(${d("state/registry.js")});
registry.getSandbox = () => ({ name: "test-sb", agent: ${JSON.stringify(agentName)} });

const agentDefs = require(${d("agent/defs.js")});
agentDefs.loadAgent = () => ({ name: ${JSON.stringify(agentName)} });

const policies = require(${d("policy/index.js")});
const policyCalls = { loadPreset: [], applyPreset: [] };
policies.listPresets = () => [
  { name: "pypi", description: "Python Package Index access" },
  { name: "telegram", description: "Telegram API access" },
  { name: "discord", description: "Discord API access" },
  { name: "slack", description: "Slack API access" },
  { name: "wechat", description: "WeChat API access" },
  { name: "whatsapp", description: "WhatsApp API access" },
];
policies.getAppliedPresets = () => [];
policies.loadPreset = (name) => { policyCalls.loadPreset.push(name); return "network_policies:\n  stub: {}\n"; };
policies.getPresetEndpoints = () => ["api.telegram.org"];
policies.getPresetValidationWarning = () => null;
policies.applyPreset = (name, preset) => { policyCalls.applyPreset.push({ name, preset }); return true; };
policies.selectFromList = async () => null;

const policyModule = require(${d("actions/sandbox/policy-channel.js")});

let exitCode = null;
process.exit = (code) => { exitCode = code; throw new Error("__INTERCEPTED_EXIT__:" + code); };

const logs = [];
console.log = (...args) => { logs.push(args.map(String).join(" ")); };
const errors = [];
console.error = (...args) => { errors.push(args.map(String).join(" ")); };

module.exports = {
  policyModule,
  policyCalls,
  promptCalls,
  logs,
  errors,
  getExitCode: () => exitCode,
};
`;
}

function runPolicyAdd(agentName: string, preset: string) {
  const script = `${buildPreamble(agentName)}
const ctx = module.exports;
(async () => {
  let caught = null;
  try {
    await ctx.policyModule.addSandboxPolicy("test-sb", { preset: ${JSON.stringify(preset)}, yes: true });
  } catch (err) {
    if (!String(err && err.message).startsWith("__INTERCEPTED_EXIT__")) {
      caught = { message: String(err && err.message), stack: err && err.stack };
    }
  }
  process.stdout.write("\\n__RESULT__" + JSON.stringify({
    exitCode: ctx.getExitCode(),
    logs: ctx.logs,
    errors: ctx.errors,
    policyCalls: ctx.policyCalls,
    promptCalls: ctx.promptCalls,
    unexpectedError: caught,
  }) + "\\n");
})();
`;
  const result = runScript(script);
  assert.equal(result.status, 0, `script crashed: ${result.stderr}\n${result.stdout}`);
  return parseResultPayload<{
    exitCode: number;
    logs: string[];
    errors: string[];
    policyCalls: { loadPreset: string[]; applyPreset: unknown[] };
    promptCalls: string[];
    unexpectedError: { message: string; stack: string } | null;
  }>(result);
}

const MESSAGING_POLICY_KEYS = [
  ["telegram_bot", "api.telegram.org"],
  ["discord", "discord.com"],
  ["slack", "api.slack.com"],
  ["wechat_bridge", "api.weixin.qq.com"],
  ["whatsapp", "graph.facebook.com"],
  ["teams", "graph.microsoft.com"],
] as const;

function runPolicyAddFromFile(agentName: string, presetYamlContent: string) {
  const script = `${buildPreamble(agentName)}
const path = require("node:path");
const ctx = module.exports;
(async () => {
  let caught = null;
  try {
    const filePath = path.join(process.env.HOME, "custom-preset.yaml");
    await ctx.policyModule.addSandboxPolicy("test-sb", { fromFile: filePath, yes: true });
  } catch (err) {
    if (!String(err && err.message).startsWith("__INTERCEPTED_EXIT__")) {
      caught = { message: String(err && err.message), stack: err && err.stack };
    }
  }
  process.stdout.write("\\n__RESULT__" + JSON.stringify({
    exitCode: ctx.getExitCode(),
    logs: ctx.logs,
    errors: ctx.errors,
    policyCalls: ctx.policyCalls,
    promptCalls: ctx.promptCalls,
    unexpectedError: caught,
  }) + "\\n");
})();
`;
  const result = runScript(script, { "custom-preset.yaml": presetYamlContent });
  assert.equal(result.status, 0, `script crashed: ${result.stderr}\n${result.stdout}`);
  return parseResultPayload<{
    exitCode: number;
    logs: string[];
    errors: string[];
    policyCalls: { loadPreset: string[]; applyPreset: unknown[] };
    promptCalls: string[];
    unexpectedError: { message: string; stack: string } | null;
  }>(result);
}

describe("addSandboxPolicy custom preset (--from-file) channel/agent gate (behaviour)", () => {
  it.each(
    MESSAGING_POLICY_KEYS,
  )("DeepAgents policy-add --from-file with a '%s' policy key exits nonzero before any disclosure, prompt, or apply", (policyKey, host) => {
    const presetYaml = `preset:\n  name: my-custom-${policyKey.replace(/_/g, "-")}\nnetwork_policies:\n  ${policyKey}:\n    host: ${host}\n`;
    const payload = runPolicyAddFromFile("langchain-deepagents-code", presetYaml);

    assert.equal(
      payload.unexpectedError,
      null,
      `unexpected exception: ${payload.unexpectedError?.stack}`,
    );
    assert.equal(payload.exitCode, 1, "expected addSandboxPolicy to exit with code 1");
    assert.ok(
      payload.errors.some((msg) => /does not support agent 'langchain-deepagents-code'/.test(msg)),
      `missing unsupported channel-agent error in stderr: ${JSON.stringify(payload.errors)}`,
    );
    assert.ok(
      payload.logs.every((msg) => !/Endpoints that would be opened/.test(msg)),
      `endpoint disclosure must not print before the gate: ${JSON.stringify(payload.logs)}`,
    );
    assert.deepEqual(payload.promptCalls, [], "prompt must not run before the gate");
  });
});

describe("addSandboxPolicy channel/agent gate (behaviour)", () => {
  it.each(
    MESSAGING_CHANNELS,
  )("DeepAgents policy-add %s exits nonzero before any disclosure, prompt, or apply", (channel) => {
    const payload = runPolicyAdd("langchain-deepagents-code", channel);

    assert.equal(
      payload.unexpectedError,
      null,
      `unexpected exception: ${payload.unexpectedError?.stack}`,
    );
    assert.equal(payload.exitCode, 1, "expected addSandboxPolicy to exit with code 1");
    assert.ok(
      payload.errors.some((msg) =>
        new RegExp(`Channel '${channel}' does not support agent 'langchain-deepagents-code'`).test(
          msg,
        ),
      ),
      `missing unsupported channel-agent error in stderr: ${JSON.stringify(payload.errors)}`,
    );
    assert.ok(
      payload.logs.every((msg) => !/Endpoints that would be opened/.test(msg)),
      `endpoint disclosure must not print before the gate: ${JSON.stringify(payload.logs)}`,
    );
    assert.deepEqual(payload.promptCalls, [], "prompt must not run before the gate");
    assert.deepEqual(
      payload.policyCalls.applyPreset,
      [],
      "applyPreset must not run before the gate",
    );
    assert.deepEqual(payload.policyCalls.loadPreset, [], "loadPreset must not run before the gate");
  });
});
