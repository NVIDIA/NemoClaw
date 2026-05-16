// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for #3437 — `nemoclaw <sandbox> channels add <channel>`
// must apply the channel's matching network policy preset BEFORE triggering
// the rebuild, so the rebuild's backup manifest captures the preset and
// the bridge has egress to its upstream API after the new sandbox boots.

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");

function runScript(scriptBody: string, extraEnv: Record<string, string> = {}): SpawnSyncReturns<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-3437-"));
  const scriptPath = path.join(tmpDir, "script.js");
  fs.writeFileSync(scriptPath, scriptBody);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      NEMOCLAW_NON_INTERACTIVE: "1",
      TELEGRAM_BOT_TOKEN: "test-telegram-token",
      SLACK_BOT_TOKEN: "xoxb-test-1234-5678",
      SLACK_APP_TOKEN: "xapp-1-test-1234-5678",
      DISCORD_BOT_TOKEN: "test-discord-token",
      ...extraEnv,
    },
    timeout: 15000,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

// Build a preamble that:
//   - stubs every module touched by addSandboxChannel so no real openshell,
//     gateway, or filesystem credential write happens
//   - records every policies.applyPreset call in `appliedCalls`
//   - records the relative order of applyPreset vs promptAndRebuild via
//     a console.log marker, so the test can assert the ordering invariant
//     (apply MUST precede rebuild)
function buildPreamble({
  presetNamesAvailable = ["telegram", "slack", "discord", "npm", "github"],
}: { presetNamesAvailable?: string[] } = {}): string {
  const j = (p: string) => JSON.stringify(path.join(repoRoot, "dist", "lib", p));
  return String.raw`
const resolver = require(${j("adapters/openshell/resolve.js")});
resolver.resolveOpenshell = () => "/fake/openshell";

const runner = require(${j("runner.js")});
runner.run = () => ({ status: 0, stdout: "", stderr: "" });
runner.runCapture = () => "";

const gatewayRuntime = require(${j("gateway-runtime-action.js")});
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({ recovered: true });

const credentials = require(${j("credentials/store.js")});
credentials.getCredential = (key) => process.env[key] || null;
credentials.saveCredential = () => true;
credentials.deleteCredential = () => true;
credentials.prompt = async (msg) => { throw new Error("unexpected prompt: " + msg); };

const onboard = require(${j("onboard.js")});
onboard.isNonInteractive = () => true;

const onboardProviders = require(${j("onboard/providers.js")});
onboardProviders.upsertMessagingProviders = () => {};

const registry = require(${j("state/registry.js")});
registry.getSandbox = () => ({
  name: "test-sb",
  messagingChannels: [],
  disabledChannels: [],
  providerCredentialHashes: {},
});
registry.updateSandbox = () => true;

const policies = require(${j("policy/index.js")});
const appliedCalls = [];
const callOrder = [];
policies.listPresets = () => ${JSON.stringify(presetNamesAvailable.map((name) => ({ name })))};
policies.applyPreset = (sandboxName, presetName) => {
  appliedCalls.push({ sandboxName, presetName });
  callOrder.push("applyPreset:" + presetName);
  return true;
};
policies.getAppliedPresets = () => [];

// Tag the rebuild-prompt branch via stdout so we can compare ordering.
// In NEMOCLAW_NON_INTERACTIVE mode, promptAndRebuild logs "Change queued."
// and returns immediately without invoking rebuildSandbox.
const origLog = console.log;
console.log = (...args) => {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (line.includes("Change queued")) callOrder.push("promptAndRebuild");
  origLog.call(console, ...args);
};

const channelModule = require(${j("actions/sandbox/policy-channel.js")});

module.exports = { channelModule, appliedCalls, callOrder };
`;
}

describe("channels add applies matching policy preset (issue #3437)", () => {
  for (const channel of ["telegram", "slack", "discord"]) {
    it(`applies the '${channel}' preset before triggering rebuild`, () => {
      const script = `${buildPreamble()}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", [${JSON.stringify(channel)}]);
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      appliedCalls: ctx.appliedCalls,
      callOrder: ctx.callOrder,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
      const result = runScript(script);
      assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
      const marker = result.stdout.lastIndexOf("__RESULT__");
      assert.ok(marker >= 0, `no __RESULT__ marker in stdout:\n${result.stdout}`);
      const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
      assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

      // Contract 1: applyPreset is called exactly once with the channel's name.
      assert.deepEqual(
        payload.appliedCalls,
        [{ sandboxName: "test-sb", presetName: channel }],
        `expected applyPreset("test-sb", "${channel}") exactly once; got ${JSON.stringify(payload.appliedCalls)}`,
      );

      // Contract 2: ordering invariant — preset apply must precede rebuild,
      // otherwise the rebuild's backup manifest will not capture it and
      // Step 5.5 of rebuild.ts has nothing to restore.
      const applyIdx = payload.callOrder.indexOf(`applyPreset:${channel}`);
      const rebuildIdx = payload.callOrder.indexOf("promptAndRebuild");
      assert.ok(applyIdx >= 0, `applyPreset was never called (order: ${JSON.stringify(payload.callOrder)})`);
      assert.ok(rebuildIdx >= 0, `promptAndRebuild was never called (order: ${JSON.stringify(payload.callOrder)})`);
      assert.ok(
        applyIdx < rebuildIdx,
        `applyPreset must run before promptAndRebuild; got order: ${JSON.stringify(payload.callOrder)}`,
      );
    });
  }

  // Negative: when the channel name does not match any built-in preset,
  // the helper short-circuits via listPresets() and applyPreset is not
  // invoked at all. This guards against a future channel name that happens
  // to collide with no preset (or a typo) from spamming "Cannot load preset"
  // errors out of policies.applyPreset.
  it("skips applyPreset when no matching built-in preset exists", () => {
    const script = `${buildPreamble({ presetNamesAvailable: ["npm", "github"] })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", ["telegram"]);
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      appliedCalls: ctx.appliedCalls,
      callOrder: ctx.callOrder,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    assert.ok(marker >= 0, `no __RESULT__ marker in stdout:\n${result.stdout}`);
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(
      payload.appliedCalls,
      [],
      `expected applyPreset NOT to be called when no built-in preset matches; got ${JSON.stringify(payload.appliedCalls)}`,
    );
    // Rebuild should still be triggered — channel registration succeeded,
    // only the preset path was skipped.
    assert.ok(
      payload.callOrder.includes("promptAndRebuild"),
      `expected promptAndRebuild to still run; got order: ${JSON.stringify(payload.callOrder)}`,
    );
  });
});
