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
