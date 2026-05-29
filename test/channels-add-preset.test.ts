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
      SLACK_BOT_TOKEN: "slack-bot-token-for-test",
      SLACK_APP_TOKEN: "slack-app-token-for-test",
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
  applyPresetResult = true,
  appliedPresets = [] as string[],
  sandboxAgent = "openclaw",
  sessionSandboxName = "test-sb",
  sessionPolicyPresets = ["npm", "pypi", "huggingface", "brew"] as string[] | null,
  sessionLoadThrows = false,
  sessionUpdateThrows = false,
  sessionMissing = false,
}: {
  presetNamesAvailable?: string[];
  applyPresetResult?: boolean;
  appliedPresets?: string[];
  sandboxAgent?: string;
  sessionSandboxName?: string | null;
  sessionPolicyPresets?: string[] | null;
  sessionLoadThrows?: boolean;
  sessionUpdateThrows?: boolean;
  sessionMissing?: boolean;
} = {}): string {
  const j = (p: string) => JSON.stringify(path.join(repoRoot, "dist", "lib", p));
  return String.raw`
const resolver = require(${j("adapters/openshell/resolve.js")});
resolver.resolveOpenshell = () => "/fake/openshell";

const openshellRuntime = require(${j("adapters/openshell/runtime.js")});
openshellRuntime.runOpenshell = () => ({ status: 0, stdout: "", stderr: "" });

const processRecovery = require(${j("actions/sandbox/process-recovery.js")});
processRecovery.executeSandboxExecCommand = () => ({ status: 0, stdout: "NEMOCLAW_CHANNEL_CLEAR_OK", stderr: "" });
processRecovery.executeSandboxCommand = () => null;

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
const providerCalls = [];
onboardProviders.upsertMessagingProviders = (defs) => { providerCalls.push(...defs); };

const registry = require(${j("state/registry.js")});
const registryUpdates = [];
registry.getSandbox = () => ({
  name: "test-sb",
  agent: ${JSON.stringify(sandboxAgent)},
  messagingChannels: [],
  disabledChannels: [],
  providerCredentialHashes: {},
});
registry.updateSandbox = (name, updates) => {
  registryUpdates.push({ name, updates });
  return true;
};

const policies = require(${j("policy/index.js")});
const appliedCalls = [];
const removedCalls = [];
const callOrder = [];
policies.listPresets = () => ${JSON.stringify(presetNamesAvailable.map((name) => ({ name })))};
policies.applyPreset = (sandboxName, presetName) => {
  appliedCalls.push({ sandboxName, presetName });
  callOrder.push("applyPreset:" + presetName);
  return ${JSON.stringify(applyPresetResult)};
};
policies.removePreset = (sandboxName, presetName) => {
  removedCalls.push({ sandboxName, presetName });
  callOrder.push("removePreset:" + presetName);
  return true;
};
policies.getAppliedPresets = () => ${JSON.stringify(appliedPresets)};

// Stub onboardSession so the new policyPresets-sync helper has something
// to read/write. The test asserts on sessionUpdates to verify the
// helper kept session.policyPresets aligned with the registry.
const onboardSession = require(${j("state/onboard-session.js")});
const sessionUpdates = [];
const sessionLoadConfig = ${JSON.stringify({
      sessionSandboxName,
      sessionPolicyPresets,
      sessionLoadThrows,
      sessionMissing,
    })};
const sessionUpdateThrows = ${JSON.stringify(sessionUpdateThrows)};
let sessionState = sessionLoadConfig.sessionMissing
  ? null
  : {
      sandboxName: sessionLoadConfig.sessionSandboxName,
      policyPresets: Array.isArray(sessionLoadConfig.sessionPolicyPresets)
        ? [...sessionLoadConfig.sessionPolicyPresets]
        : sessionLoadConfig.sessionPolicyPresets,
    };
onboardSession.loadSession = () => {
  if (sessionLoadConfig.sessionLoadThrows) throw new Error("simulated load failure");
  return sessionState;
};
onboardSession.updateSession = (mutator) => {
  if (sessionUpdateThrows) throw new Error("simulated save failure");
  // Mirror the real updateSession contract: load → mutate → save.
  if (!sessionState) sessionState = { sandboxName: null, policyPresets: null };
  const next = mutator(sessionState) || sessionState;
  sessionState = next;
  sessionUpdates.push({
    policyPresets: Array.isArray(next.policyPresets) ? [...next.policyPresets] : next.policyPresets,
  });
  return next;
};

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

module.exports = { channelModule, appliedCalls, removedCalls, callOrder, providerCalls, registryUpdates, sessionUpdates, getSessionState: () => sessionState };
`;
}

describe("channels add applies matching policy preset (issue #3437)", () => {
  for (const channel of ["telegram", "slack", "discord"]) {
    it(`applies the '${channel}' preset before triggering rebuild`, () => {
      const script = `${buildPreamble()}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: ${JSON.stringify(channel)} });
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

  it("applies the tokenless WhatsApp preset for Hermes before triggering rebuild", () => {
    const script = `${buildPreamble({
      presetNamesAvailable: ["telegram", "slack", "discord", "whatsapp", "npm", "github"],
      sandboxAgent: "hermes",
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "whatsapp" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      appliedCalls: ctx.appliedCalls,
      callOrder: ctx.callOrder,
      providerCalls: ctx.providerCalls,
      registryUpdates: ctx.registryUpdates,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runScript(script, {
      WHATSAPP_BOT_TOKEN: "must-not-be-used",
      WHATSAPP_TOKEN: "must-not-be-used",
      WHATSAPP_SESSION_SECRET: "must-not-be-used",
    });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    assert.ok(marker >= 0, `no __RESULT__ marker in stdout:\n${result.stdout}`);
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.providerCalls, [], "WhatsApp must not create host-side providers");
    assert.deepEqual(payload.registryUpdates, [
      {
        name: "test-sb",
        updates: { messagingChannels: ["whatsapp"], disabledChannels: [] },
      },
    ]);
    assert.deepEqual(
      payload.appliedCalls,
      [{ sandboxName: "test-sb", presetName: "whatsapp" }],
      `expected applyPreset("test-sb", "whatsapp") exactly once; got ${JSON.stringify(payload.appliedCalls)}`,
    );
    const applyIdx = payload.callOrder.indexOf("applyPreset:whatsapp");
    const rebuildIdx = payload.callOrder.indexOf("promptAndRebuild");
    assert.ok(applyIdx >= 0, `applyPreset was never called (order: ${JSON.stringify(payload.callOrder)})`);
    assert.ok(rebuildIdx >= 0, `promptAndRebuild was never called (order: ${JSON.stringify(payload.callOrder)})`);
    assert.ok(
      applyIdx < rebuildIdx,
      `applyPreset must run before promptAndRebuild; got order: ${JSON.stringify(payload.callOrder)}`,
    );
  });

  it("aborts tokenless WhatsApp before registry and rebuild when preset apply fails", () => {
    const script = `${buildPreamble({
      presetNamesAvailable: ["telegram", "slack", "discord", "whatsapp", "npm", "github"],
      applyPresetResult: false,
      sandboxAgent: "hermes",
    })}
const ctx = module.exports;
const exitCodes = [];
const originalExit = process.exit;
process.exit = (code) => {
  exitCodes.push(code ?? 0);
  throw new Error("__EXIT__" + (code ?? 0));
};
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "whatsapp" });
  } catch (err) {
    if (!String(err && err.message).startsWith("__EXIT__")) {
      process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
      return;
    }
  } finally {
    process.exit = originalExit;
  }
  process.stdout.write("\\n__RESULT__" + JSON.stringify({
    appliedCalls: ctx.appliedCalls,
    callOrder: ctx.callOrder,
    providerCalls: ctx.providerCalls,
    registryUpdates: ctx.registryUpdates,
    exitCodes,
  }) + "\\n");
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    assert.ok(marker >= 0, `no __RESULT__ marker in stdout:\n${result.stdout}`);
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.exitCodes, [1]);
    assert.deepEqual(payload.providerCalls, [], "WhatsApp must not create host-side providers");
    assert.deepEqual(
      payload.registryUpdates,
      [],
      `preset failure must not register whatsapp locally; got ${JSON.stringify(payload.registryUpdates)}`,
    );
    assert.deepEqual(
      payload.appliedCalls,
      [{ sandboxName: "test-sb", presetName: "whatsapp" }],
      `expected one failed applyPreset call; got ${JSON.stringify(payload.appliedCalls)}`,
    );
    assert.ok(
      !payload.callOrder.includes("promptAndRebuild"),
      `preset failure must not prompt for rebuild; got order: ${JSON.stringify(payload.callOrder)}`,
    );
  });

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
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram" });
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

// Regression: `channels add` was updating the registry but NOT
// session.policyPresets. A later `rebuild` re-entered onboard in resume
// mode, read the stale session, and the policy-selection step narrowed
// the channel's preset back away. The new sandbox booted with the
// channel auto-launched but no matching network policy active, so the
// bridge's Slack/Telegram/Discord WebClient hit 403s and stayed wedged
// even after Step 5.5 of rebuild reapplied the preset from the backup
// manifest.
//
// These tests pin down the invariant: after a successful preset apply
// via channels-add, session.policyPresets must contain the channel
// name; after a successful preset remove via channels-remove, it must
// not. Edge cases (no session, foreign sandbox, save failure) must not
// abort the operation.
describe("channels add/remove keeps session.policyPresets in sync with registry", () => {
  it("appends the channel preset to session.policyPresets after a successful add", () => {
    const script = `${buildPreamble({
      sessionSandboxName: "test-sb",
      sessionPolicyPresets: ["npm", "pypi", "huggingface", "brew"],
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "slack" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      sessionUpdates: ctx.sessionUpdates,
      finalSession: ctx.getSessionState(),
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    // Exactly one update — the helper short-circuits when the desired
    // membership already holds, so duplicate writes would be a bug.
    assert.equal(
      payload.sessionUpdates.length,
      1,
      `expected exactly one session update; got ${JSON.stringify(payload.sessionUpdates)}`,
    );
    assert.deepEqual(payload.sessionUpdates[0].policyPresets, [
      "npm",
      "pypi",
      "huggingface",
      "brew",
      "slack",
    ]);
    assert.deepEqual(payload.finalSession.policyPresets, [
      "npm",
      "pypi",
      "huggingface",
      "brew",
      "slack",
    ]);
  });

  it("does not touch the session when it tracks a different sandbox", () => {
    const script = `${buildPreamble({
      sessionSandboxName: "other-sb",
      sessionPolicyPresets: ["npm", "github"],
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "slack" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      sessionUpdates: ctx.sessionUpdates,
      finalSession: ctx.getSessionState(),
      appliedCalls: ctx.appliedCalls,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    // applyPreset still runs against the registry — the preset is the
    // channel's egress contract and lives in registry, not session.
    assert.deepEqual(payload.appliedCalls, [{ sandboxName: "test-sb", presetName: "slack" }]);
    // But the foreign session's policyPresets must be left untouched —
    // otherwise we corrupt the other sandbox's resume state.
    assert.deepEqual(
      payload.sessionUpdates,
      [],
      `session belonging to a different sandbox must not be mutated; got ${JSON.stringify(payload.sessionUpdates)}`,
    );
    assert.deepEqual(payload.finalSession.policyPresets, ["npm", "github"]);
  });

  it("succeeds even when no onboard session file exists", () => {
    const script = `${buildPreamble({ sessionMissing: true })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "slack" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      sessionUpdates: ctx.sessionUpdates,
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
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    // Registry mutation still happens; only the session-sync side-effect
    // is skipped (there is no intent record to keep aligned).
    assert.deepEqual(payload.appliedCalls, [{ sandboxName: "test-sb", presetName: "slack" }]);
    assert.deepEqual(payload.sessionUpdates, []);
    assert.ok(payload.callOrder.includes("promptAndRebuild"));
  });

  it("does not abort channels-add when session save fails", () => {
    const script = `${buildPreamble({
      sessionSandboxName: "test-sb",
      sessionPolicyPresets: ["npm", "pypi", "huggingface", "brew"],
      sessionUpdateThrows: true,
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "slack" });
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
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    // Even though session.updateSession threw, the channel add flow
    // still completed: preset applied to registry, rebuild prompted.
    // Session-sync is best-effort.
    assert.deepEqual(payload.appliedCalls, [{ sandboxName: "test-sb", presetName: "slack" }]);
    assert.ok(payload.callOrder.includes("promptAndRebuild"));
  });

  it("removes the channel preset from session.policyPresets after a successful remove", () => {
    const script = `${buildPreamble({
      appliedPresets: ["slack"],
      sessionSandboxName: "test-sb",
      sessionPolicyPresets: ["npm", "slack", "github"],
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "slack" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      removedCalls: ctx.removedCalls,
      sessionUpdates: ctx.sessionUpdates,
      finalSession: ctx.getSessionState(),
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
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.removedCalls, [{ sandboxName: "test-sb", presetName: "slack" }]);
    assert.equal(
      payload.sessionUpdates.length,
      1,
      `expected exactly one session update; got ${JSON.stringify(payload.sessionUpdates)}`,
    );
    assert.deepEqual(payload.sessionUpdates[0].policyPresets, ["npm", "github"]);
    assert.deepEqual(payload.finalSession.policyPresets, ["npm", "github"]);
    assert.ok(payload.callOrder.includes("promptAndRebuild"));
  });

  it("does not touch a foreign session during channels-remove", () => {
    const script = `${buildPreamble({
      appliedPresets: ["slack"],
      sessionSandboxName: "other-sb",
      sessionPolicyPresets: ["slack", "npm"],
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "slack" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      removedCalls: ctx.removedCalls,
      sessionUpdates: ctx.sessionUpdates,
      finalSession: ctx.getSessionState(),
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.removedCalls, [{ sandboxName: "test-sb", presetName: "slack" }]);
    assert.deepEqual(
      payload.sessionUpdates,
      [],
      `session belonging to a different sandbox must not be mutated; got ${JSON.stringify(payload.sessionUpdates)}`,
    );
    assert.deepEqual(payload.finalSession.policyPresets, ["slack", "npm"]);
  });

  it("succeeds during channels-remove when no onboard session file exists", () => {
    const script = `${buildPreamble({
      appliedPresets: ["slack"],
      sessionMissing: true,
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "slack" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      removedCalls: ctx.removedCalls,
      sessionUpdates: ctx.sessionUpdates,
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
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.removedCalls, [{ sandboxName: "test-sb", presetName: "slack" }]);
    assert.deepEqual(payload.sessionUpdates, []);
    assert.ok(payload.callOrder.includes("promptAndRebuild"));
  });

  it("does not abort channels-remove when session save fails", () => {
    const script = `${buildPreamble({
      appliedPresets: ["slack"],
      sessionSandboxName: "test-sb",
      sessionPolicyPresets: ["npm", "slack"],
      sessionUpdateThrows: true,
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "slack" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      removedCalls: ctx.removedCalls,
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
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.removedCalls, [{ sandboxName: "test-sb", presetName: "slack" }]);
    assert.ok(payload.callOrder.includes("promptAndRebuild"));
  });
});

// Regression: `nemoclaw <sandbox> channels add telegram` followed by a
// rebuild produced no Telegram process, no logs, and no errors — the
// command reported a successful rebuild but the bridge silently no-op'd
// (#4314, #4390). After the fix the channel block is baked enabled and
// addSandboxChannel runs a post-rebuild probe that reports either a
// startup breadcrumb confirmation or an actionable warning. These tests
// drive the verifier through stubbed sandbox-exec output so the contract
// is pinned regardless of OpenClaw/OpenShell runtime availability.
describe("channels add verifies bridge startup after rebuild (issue #4314, #4390)", () => {
  function buildInteractivePreamble(): string {
    const j = (p: string) => JSON.stringify(path.join(repoRoot, "dist", "lib", p));
    return String.raw`
const resolver = require(${j("adapters/openshell/resolve.js")});
resolver.resolveOpenshell = () => "/fake/openshell";

const openshellRuntime = require(${j("adapters/openshell/runtime.js")});
openshellRuntime.runOpenshell = () => ({ status: 0, stdout: "", stderr: "" });

const processRecovery = require(${j("actions/sandbox/process-recovery.js")});
const execCalls = [];
processRecovery.executeSandboxExecCommand = (name, command) => {
  execCalls.push({ name, command });
  if (typeof command === "string" && command.startsWith("cat /sandbox/.openclaw/openclaw.json")) {
    return { status: 0, stdout: JSON.stringify(global.__testConfig || {}), stderr: "" };
  }
  if (typeof command === "string" && command.indexOf("tail -n 400 /tmp/gateway.log") !== -1) {
    return { status: 0, stdout: global.__testLog || "", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
processRecovery.executeSandboxCommand = () => null;

const rebuild = require(${j("actions/sandbox/rebuild.js")});
let rebuildCount = 0;
rebuild.rebuildSandbox = async () => { rebuildCount += 1; };

const runner = require(${j("runner.js")});
runner.run = () => ({ status: 0, stdout: "", stderr: "" });
runner.runCapture = () => "";

const gatewayRuntime = require(${j("gateway-runtime-action.js")});
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({ recovered: true });

const credentials = require(${j("credentials/store.js")});
credentials.getCredential = (key) => process.env[key] || null;
credentials.saveCredential = () => true;
credentials.deleteCredential = () => true;
credentials.prompt = async () => "y";

const onboard = require(${j("onboard.js")});
onboard.isNonInteractive = () => false;

const onboardProviders = require(${j("onboard/providers.js")});
onboardProviders.upsertMessagingProviders = () => {};

const registry = require(${j("state/registry.js")});
registry.getSandbox = () => ({
  name: "test-sb",
  agent: global.__testAgent || "openclaw",
  messagingChannels: [],
  disabledChannels: [],
  providerCredentialHashes: {},
});
registry.updateSandbox = () => true;

const policies = require(${j("policy/index.js")});
policies.listPresets = () => [{ name: "telegram" }, { name: "slack" }, { name: "discord" }];
policies.applyPreset = () => true;
policies.getAppliedPresets = () => [];

const onboardSession = require(${j("state/onboard-session.js")});
onboardSession.loadSession = () => ({ sandboxName: "test-sb", policyPresets: [] });
onboardSession.updateSession = (mutator) => {
  const s = { sandboxName: "test-sb", policyPresets: [] };
  mutator(s);
  return s;
};

const logs = [];
const origLog = console.log;
console.log = (...args) => {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  logs.push(line);
};

const channelModule = require(${j("actions/sandbox/policy-channel.js")});

module.exports = { channelModule, execCalls, getRebuildCount: () => rebuildCount, logs };
`;
  }

  it("confirms the startup breadcrumb when the bridge logs the starting-provider line", () => {
    const preamble = buildInteractivePreamble();
    const script = `${preamble}
global.__testConfig = { channels: { telegram: { enabled: true, accounts: { default: {} } } } };
global.__testLog = [
  "[telegram] [default] starting provider",
  "[telegram] [default] provider ready (Bot API reachable; agent replies use inference.local)",
].join("\\n");
const ctx = module.exports;
(async () => {
  await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram" });
  process.stdout.write("\\n__RESULT__" + JSON.stringify({
    rebuildCount: ctx.getRebuildCount(),
    execCalls: ctx.execCalls.length,
    logs: ctx.logs,
  }) + "\\n");
})().catch((err) => process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message }) + "\\n"));
`;
    const result = runScript(script, { NEMOCLAW_NON_INTERACTIVE: "" });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    assert.ok(marker >= 0);
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, payload.error);
    assert.equal(payload.rebuildCount, 1);
    assert.ok(
      payload.logs.some((line: string) => line.includes("'telegram' bridge startup detected")),
      `expected startup confirmation in logs; got:\n${payload.logs.join("\n")}`,
    );
  });

  it("warns when the baked config does not mark the channel enabled", () => {
    const preamble = buildInteractivePreamble();
    const script = `${preamble}
global.__testConfig = { channels: { telegram: { accounts: { default: {} } } } };
global.__testLog = "";
const ctx = module.exports;
(async () => {
  await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram" });
  process.stdout.write("\\n__RESULT__" + JSON.stringify({ logs: ctx.logs }) + "\\n");
})().catch((err) => process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message }) + "\\n"));
`;
    const result = runScript(script, { NEMOCLAW_NON_INTERACTIVE: "" });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, payload.error);
    assert.ok(
      payload.logs.some((line: string) => line.includes("was not marked enabled in baked openclaw.json")),
      `expected enabled-flag warning; got:\n${payload.logs.join("\n")}`,
    );
  });

  it("warns when the gateway log shows no bridge breadcrumb yet", () => {
    const preamble = buildInteractivePreamble();
    const script = `${preamble}
global.__testConfig = { channels: { telegram: { enabled: true, accounts: { default: {} } } } };
global.__testLog = "";
const ctx = module.exports;
(async () => {
  await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram" });
  process.stdout.write("\\n__RESULT__" + JSON.stringify({ logs: ctx.logs }) + "\\n");
})().catch((err) => process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message }) + "\\n"));
`;
    const result = runScript(script, { NEMOCLAW_NON_INTERACTIVE: "" });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, payload.error);
    assert.ok(
      payload.logs.some((line: string) => line.includes("did not log a startup breadcrumb")),
      `expected missing-breadcrumb warning; got:\n${payload.logs.join("\n")}`,
    );
  });

  it("does NOT claim success when only the no-start breadcrumb is present", () => {
    // Regression: the original verifier matched any [<channel>] line and
    // fell through to "bridge startup detected" even when the only log line
    // was the preload's own "bridge did not start within Ns" diagnostic.
    // That handed users a false-green signal for the exact failure mode
    // #4314 reported.
    const preamble = buildInteractivePreamble();
    const script = `${preamble}
global.__testConfig = { channels: { telegram: { enabled: true, accounts: { default: {} } } } };
global.__testLog = "[telegram] [default] bridge did not start within 15s; check channels.telegram.enabled, plugin entries, and gateway log";
const ctx = module.exports;
(async () => {
  await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram" });
  process.stdout.write("\\n__RESULT__" + JSON.stringify({ logs: ctx.logs }) + "\\n");
})().catch((err) => process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message }) + "\\n"));
`;
    const result = runScript(script, { NEMOCLAW_NON_INTERACTIVE: "" });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, payload.error);
    assert.ok(
      !payload.logs.some((line: string) => line.includes("bridge startup detected")),
      `must not claim startup detected; got:\n${payload.logs.join("\n")}`,
    );
    assert.ok(
      payload.logs.some((line: string) =>
        line.includes("logged credential/startup warnings") || line.includes("did not start within"),
      ),
      `expected the no-start breadcrumb to be surfaced; got:\n${payload.logs.join("\n")}`,
    );
  });

  it("forwards credential-placeholder warnings surfaced by the bridge", () => {
    const preamble = buildInteractivePreamble();
    const script = `${preamble}
global.__testConfig = { channels: { telegram: { enabled: true, accounts: { default: {} } } } };
global.__testLog = "[telegram] [default] credential placeholder mismatch: openclaw.json botToken does not match runtime TELEGRAM_BOT_TOKEN placeholder";
const ctx = module.exports;
(async () => {
  await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram" });
  process.stdout.write("\\n__RESULT__" + JSON.stringify({ logs: ctx.logs }) + "\\n");
})().catch((err) => process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message }) + "\\n"));
`;
    const result = runScript(script, { NEMOCLAW_NON_INTERACTIVE: "" });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, payload.error);
    assert.ok(
      payload.logs.some((line: string) => line.includes("logged credential/startup warnings")),
      `expected credential warning summary; got:\n${payload.logs.join("\n")}`,
    );
  });

  it("skips the OpenClaw-shaped probe for Hermes sandboxes (avoids false negatives)", () => {
    const preamble = buildInteractivePreamble();
    const script = `${preamble}
global.__testAgent = "hermes";
// Hermes sandboxes do not use /sandbox/.openclaw/openclaw.json; if the
// verifier mistakenly ran it would read an empty config and warn about a
// missing enabled flag. We confirm the absence of that misleading guidance.
global.__testConfig = { channels: { telegram: {} } };
global.__testLog = "";
const ctx = module.exports;
(async () => {
  await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram" });
  process.stdout.write("\\n__RESULT__" + JSON.stringify({ logs: ctx.logs, execCalls: ctx.execCalls.length }) + "\\n");
})().catch((err) => process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message }) + "\\n"));
`;
    const result = runScript(script, { NEMOCLAW_NON_INTERACTIVE: "" });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, payload.error);
    assert.equal(payload.execCalls, 0, "verifier must not run any sandbox exec probes for Hermes");
    assert.ok(
      !payload.logs.some((line: string) => line.includes("was not marked enabled in baked openclaw.json")),
      `Hermes sandbox should not see OpenClaw-shaped warning; got:\n${payload.logs.join("\n")}`,
    );
    assert.ok(
      !payload.logs.some((line: string) => line.includes("bridge startup detected")),
      `Hermes sandbox should not claim OpenClaw-style startup confirmation; got:\n${payload.logs.join("\n")}`,
    );
  });

  it("skips the verifier for WhatsApp (QR-only) and WeChat (different runtime key)", () => {
    const preamble = buildInteractivePreamble();
    const script = `${preamble}
// WhatsApp uses the in-sandbox-qr path which short-circuits before the
// bridge probe. Extend the preset list (already stubbed in the preamble)
// so applyPreset can match the whatsapp name.
policies.listPresets = () => [{ name: "whatsapp" }, { name: "telegram" }, { name: "slack" }, { name: "discord" }];
const ctx = module.exports;
global.__testConfig = { channels: {} };
global.__testLog = "";
(async () => {
  await ctx.channelModule.addSandboxChannel("test-sb", { channel: "whatsapp" });
  process.stdout.write("\\n__RESULT__" + JSON.stringify({ logs: ctx.logs, execCalls: ctx.execCalls.length }) + "\\n");
})().catch((err) => process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message }) + "\\n"));
`;
    const result = runScript(script, { NEMOCLAW_NON_INTERACTIVE: "" });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, payload.error);
    assert.equal(payload.execCalls, 0, "verifier must not probe sandbox exec for QR-only WhatsApp");
    assert.ok(
      !payload.logs.some((line: string) => line.includes("was not marked enabled in baked openclaw.json")),
      `WhatsApp should not trigger OpenClaw-shaped warning; got:\n${payload.logs.join("\n")}`,
    );
  });
});
