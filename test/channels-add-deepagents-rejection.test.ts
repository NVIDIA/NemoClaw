// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Behaviour-level regression: `nemoclaw <sandbox> channels add <channel>` on
// DeepAgents must exit nonzero before any preset load, policy mutation,
// provider upsert, registry write, credential save, prompt, rebuild call, or
// openshell invocation while DeepAgents has only artifact-level messaging
// render and no inbound channel bridge.
//
// Spawns the assembled `addSandboxChannel` action in a real Node process so
// the entire module graph loads, then asserts the no-mutation invariant from
// the public action boundary rather than from a unit-mocked seam.

import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");

function runScript(scriptBody: string): SpawnSyncReturns<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-5729-"));
  const scriptPath = path.join(tmpDir, "script.js");
  fs.writeFileSync(scriptPath, scriptBody);
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
const resolver = require(${d("adapters/openshell/resolve.js")});
resolver.resolveOpenshell = () => "/fake/openshell";

const openshellRuntime = require(${d("adapters/openshell/runtime.js")});
const runOpenshellCalls = [];
openshellRuntime.runOpenshell = (...args) => {
  runOpenshellCalls.push(args);
  return { status: 0, stdout: "", stderr: "" };
};

const processRecovery = require(${d("actions/sandbox/process-recovery.js")});
processRecovery.executeSandboxExecCommand = () => null;
processRecovery.executeSandboxCommand = () => null;

const gatewayRuntime = require(${d("gateway-runtime-action.js")});
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({ recovered: true });

const credentials = require(${d("credentials/store.js")});
const credentialCalls = { get: [], save: [], delete: [], prompt: [] };
credentials.getCredential = (key) => { credentialCalls.get.push(key); return null; };
credentials.saveCredential = (key, value) => { credentialCalls.save.push({ key, value }); return true; };
credentials.deleteCredential = (key) => { credentialCalls.delete.push(key); return true; };
credentials.prompt = async (msg) => { credentialCalls.prompt.push(msg); return ""; };

const onboard = require(${d("onboard.js")});
onboard.isNonInteractive = () => true;

const onboardProviders = require(${d("onboard/providers.js")});
const providerCalls = [];
onboardProviders.upsertMessagingProviders = (defs) => { providerCalls.push(...defs); };

const registry = require(${d("state/registry.js")});
const registryUpdates = [];
registry.getSandbox = () => ({ name: "test-sb", agent: ${JSON.stringify(agentName)} });
registry.updateSandbox = (name, updates) => { registryUpdates.push({ name, updates }); return true; };

const policies = require(${d("policy/index.js")});
const policyCalls = { loadPreset: [], applyPreset: [] };
policies.listPresets = () => [];
policies.loadPreset = (name) => { policyCalls.loadPreset.push(name); return "network_policies:\n  stub: {}\n"; };
policies.parsePresetPolicyKeys = () => ["stub"];
policies.applyPreset = (name, preset) => { policyCalls.applyPreset.push({ name, preset }); return true; };
policies.getAppliedPresets = () => [];

const rebuild = require(${d("actions/sandbox/rebuild.js")});
const rebuildCalls = [];
rebuild.rebuildSandbox = async (name, args, opts) => { rebuildCalls.push({ name, args, opts }); };

const agentDefs = require(${d("agent/defs.js")});
agentDefs.loadAgent = () => ({
  name: ${JSON.stringify(agentName)},
});

const channelModule = require(${d("actions/sandbox/policy-channel.js")});

let exitCode = null;
const originalExit = process.exit;
process.exit = (code) => { exitCode = code; throw new Error("__INTERCEPTED_EXIT__:" + code); };

const errors = [];
const origErr = console.error;
console.error = (...args) => { errors.push(args.map(String).join(" ")); };

module.exports = {
  channelModule,
  policyCalls,
  providerCalls,
  registryUpdates,
  rebuildCalls,
  credentialCalls,
  runOpenshellCalls,
  errors,
  getExitCode: () => exitCode,
};
`;
}

describe("addSandboxChannel channel/agent gate (behaviour)", () => {
  it("DeepAgents channels add discord exits non-mutatingly with the unsupported channel-agent message", () => {
    const script = `${buildPreamble("langchain-deepagents-code")}
const ctx = module.exports;
(async () => {
  let caught = null;
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "discord" });
  } catch (err) {
    if (!String(err && err.message).startsWith("__INTERCEPTED_EXIT__")) {
      caught = { message: String(err && err.message), stack: err && err.stack };
    }
  }
  process.stdout.write("\\n__RESULT__" + JSON.stringify({
    exitCode: ctx.getExitCode(),
    errors: ctx.errors,
    policyCalls: ctx.policyCalls,
    providerCalls: ctx.providerCalls,
    registryUpdates: ctx.registryUpdates,
    rebuildCalls: ctx.rebuildCalls,
    credentialCalls: ctx.credentialCalls,
    runOpenshellCalls: ctx.runOpenshellCalls,
    unexpectedError: caught,
  }) + "\\n");
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script crashed: ${result.stderr}\n${result.stdout}`);
    const payload = parseResultPayload<{
      exitCode: number;
      errors: string[];
      policyCalls: { loadPreset: string[]; applyPreset: unknown[] };
      providerCalls: unknown[];
      registryUpdates: unknown[];
      rebuildCalls: unknown[];
      credentialCalls: { get: string[]; save: unknown[]; delete: string[]; prompt: string[] };
      runOpenshellCalls: unknown[];
      unexpectedError: { message: string; stack: string } | null;
    }>(result);

    assert.equal(
      payload.unexpectedError,
      null,
      `unexpected exception: ${payload.unexpectedError?.stack}`,
    );
    assert.equal(payload.exitCode, 1, "expected addSandboxChannel to exit with code 1");
    assert.ok(
      payload.errors.some((msg) =>
        /Channel 'discord' does not support agent 'langchain-deepagents-code'/.test(msg),
      ),
      `missing unsupported channel-agent error in stderr: ${JSON.stringify(payload.errors)}`,
    );
    assert.ok(
      payload.errors.some((msg) => /Channel-supported agents: openclaw, hermes/.test(msg)),
      `missing channel-supported agents hint in stderr: ${JSON.stringify(payload.errors)}`,
    );
    assert.ok(
      payload.errors.some((msg) =>
        /Channels supported by agent 'langchain-deepagents-code': \(none\)/.test(msg),
      ),
      `missing agent-supported channels hint in stderr: ${JSON.stringify(payload.errors)}`,
    );

    assert.deepEqual(payload.policyCalls.loadPreset, [], "loadPreset must not run before the gate");
    assert.deepEqual(
      payload.policyCalls.applyPreset,
      [],
      "applyPreset must not run before the gate",
    );
    assert.deepEqual(
      payload.providerCalls,
      [],
      "upsertMessagingProviders must not run before the gate",
    );
    assert.deepEqual(payload.registryUpdates, [], "updateSandbox must not run before the gate");
    assert.deepEqual(payload.rebuildCalls, [], "rebuildSandbox must not run before the gate");
    assert.deepEqual(
      payload.credentialCalls.save,
      [],
      "saveCredential must not run before the gate",
    );
    assert.deepEqual(
      payload.credentialCalls.delete,
      [],
      "deleteCredential must not run before the gate",
    );
    assert.deepEqual(payload.credentialCalls.prompt, [], "prompt must not run before the gate");
    assert.deepEqual(
      payload.runOpenshellCalls,
      [],
      "openshell must not be invoked before the gate",
    );
  });
});
