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
      NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION: "",
      TELEGRAM_BOT_TOKEN: "test-telegram-token",
      SLACK_BOT_TOKEN: "xoxb-slack-bot-token-for-test",
      SLACK_APP_TOKEN: "xapp-slack-app-token-for-test",
      DISCORD_BOT_TOKEN: "test-discord-token",
      NEMOCLAW_SKIP_TELEGRAM_REACHABILITY: "1",
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
  presetFileMissing = false,
  presetMissingNetworkPolicies = false,
  presetMalformedYaml = false,
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
  presetFileMissing?: boolean;
  presetMissingNetworkPolicies?: boolean;
  presetMalformedYaml?: boolean;
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
const savedCredentialKeys = [];
const deletedCredentialKeys = [];
const credentialSaveCalls = [];
credentials.getCredential = (key) => process.env[key] || null;
credentials.saveCredential = (key, value) => {
  savedCredentialKeys.push(key);
  credentialSaveCalls.push({ key, value });
  callOrder.push("saveCredential:" + key);
  return true;
};
credentials.deleteCredential = (key) => {
  deletedCredentialKeys.push(key);
  return true;
};
credentials.prompt = async (msg) => { throw new Error("unexpected prompt: " + msg); };

const onboard = require(${j("onboard.js")});
onboard.isNonInteractive = () => true;

const onboardProviders = require(${j("onboard/providers.js")});
const providerCalls = [];
onboardProviders.upsertMessagingProviders = (defs) => {
  providerCalls.push(...defs);
  callOrder.push("upsertMessagingProviders");
};

const workflowPlanner = require(${j("messaging/compiler/workflow-planner.js")});
const originalBuildPlan = workflowPlanner.MessagingWorkflowPlanner.prototype.buildPlan;
const buildPlanCalls = [];
workflowPlanner.MessagingWorkflowPlanner.prototype.buildPlan = async function(context) {
  if (context.workflow === "add-channel") buildPlanCalls.push({
    sandboxName: context.sandboxName,
    agent: context.agent,
    workflow: context.workflow,
    isInteractive: context.isInteractive,
    configuredChannels: context.configuredChannels,
    disabledChannels: context.disabledChannels,
    supportedChannelIds: context.supportedChannelIds,
  });
  return originalBuildPlan.call(this, context);
};

const registry = require(${j("state/registry.js")});
const registryUpdates = [];
registry.getSandbox = () => ({
  name: "test-sb",
  agent: ${JSON.stringify(sandboxAgent)},
  messagingChannels: [],
  disabledChannels: [],
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
policies.loadPreset = (name) => {
  if (${JSON.stringify(presetFileMissing)}) return null;
  if (${JSON.stringify(presetMissingNetworkPolicies)}) return "name: " + name + "\ndescription: \"stub preset without network_policies\"\n";
  if (${JSON.stringify(presetMalformedYaml)}) return "network_policies:\n  - [unclosed\n";
  return "network_policies:\n  " + name + ":\n    egress:\n      - host: example.com";
};
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

const httpProbe = require(${j("adapters/http/probe.js")});
const slackProbeCalls = [];
const slackProbeOk = (body = '{"ok":true}') => ({
  ok: true,
  httpStatus: 200,
  curlStatus: 0,
  body,
  stderr: "",
  message: "",
});
httpProbe.runCurlProbe = (argv) => {
  const url = argv[argv.length - 1];
  if (typeof url === "string" && url.includes("slack.com/api/")) {
    slackProbeCalls.push(argv);
    callOrder.push(url.includes("auth.test") ? "slackProbe:bot" : "slackProbe:app");
    if (url.includes("auth.test")) return global.__slackBotProbe || slackProbeOk();
    if (url.includes("apps.connections.open")) return global.__slackAppProbe || slackProbeOk('{"ok":true,"url":"wss://wss-primary.slack.com/link"}');
  }
  return slackProbeOk();
};

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

module.exports = {
  channelModule,
  appliedCalls,
  removedCalls,
  callOrder,
  providerCalls,
  registryUpdates,
  sessionUpdates,
  buildPlanCalls,
  savedCredentialKeys,
  deletedCredentialKeys,
  credentialSaveCalls,
  slackProbeCalls,
  getSessionState: () => sessionState,
};
`;
}

describe("channels add applies matching policy preset (issue #3437)", () => {
  it("plans channel enrollment through the messaging manifest workflow", () => {
    const script = `${buildPreamble()}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "slack" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      buildPlanCalls: ctx.buildPlanCalls,
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

    assert.deepEqual(payload.buildPlanCalls, [
      {
        sandboxName: "test-sb",
        agent: "openclaw",
        workflow: "add-channel",
        isInteractive: false,
        configuredChannels: ["slack"],
        disabledChannels: [],
        supportedChannelIds: ["telegram", "discord", "wechat", "slack", "whatsapp"],
      },
    ]);
  });

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
    assert.deepEqual(payload.registryUpdates[0], {
      name: "test-sb",
      updates: { messagingChannels: ["whatsapp"], disabledChannels: [] },
    });
    const messagingStateUpdate = payload.registryUpdates.find(
      (entry: { updates?: { messaging?: { plan?: { channels?: Array<{ channelId?: string }> } } } }) =>
        entry.updates?.messaging?.plan,
    );
    assert.ok(
      messagingStateUpdate,
      `expected a registry update that stores durable messaging state; got ${JSON.stringify(payload.registryUpdates)}`,
    );
    assert.deepEqual(
      messagingStateUpdate.updates.messaging.plan.channels.map(
        (channel: { channelId: string }) => channel.channelId,
      ),
      ["whatsapp"],
    );
    assert.equal(messagingStateUpdate.updates.messaging.plan.agent, "hermes");
    assert.deepEqual(messagingStateUpdate.updates.messaging.plan.credentialBindings, []);
    assert.deepEqual(
      payload.registryUpdates.map((entry: { name: string }) => entry.name),
      ["test-sb", "test-sb"],
    );
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

  it("aborts non-QR channel when policy preset YAML is missing", () => {
    const script = `${buildPreamble({ presetFileMissing: true })}
const ctx = module.exports;
const exitCodes = [];
const originalExit = process.exit;
process.exit = (code) => {
  exitCodes.push(code ?? 0);
  throw new Error("__EXIT__" + (code ?? 0));
};
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram" });
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
    assert.deepEqual(
      payload.appliedCalls,
      [],
      `missing preset YAML must abort before applyPreset; got ${JSON.stringify(payload.appliedCalls)}`,
    );
    assert.deepEqual(
      payload.providerCalls,
      [],
      `missing preset YAML must not register host-side providers; got ${JSON.stringify(payload.providerCalls)}`,
    );
    assert.deepEqual(
      payload.registryUpdates,
      [],
      `missing preset YAML must not register telegram in messagingChannels; got ${JSON.stringify(payload.registryUpdates)}`,
    );
    assert.ok(
      !payload.callOrder.includes("promptAndRebuild"),
      `missing preset YAML must not prompt for rebuild; got order: ${JSON.stringify(payload.callOrder)}`,
    );
    assert.ok(
      result.stderr.includes(`Restore the preset YAML and re-run: nemoclaw test-sb channels add telegram`),
      `expected restore-and-re-run hint on stderr; got:\n${result.stderr}`,
    );
  });

  it("aborts non-QR channel when policy preset YAML has no network_policies section", () => {
    const script = `${buildPreamble({ presetMissingNetworkPolicies: true })}
const ctx = module.exports;
const exitCodes = [];
const originalExit = process.exit;
process.exit = (code) => {
  exitCodes.push(code ?? 0);
  throw new Error("__EXIT__" + (code ?? 0));
};
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram" });
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
    savedCredentialKeys: ctx.savedCredentialKeys,
    deletedCredentialKeys: ctx.deletedCredentialKeys,
    exitCodes,
  }) + "\\n");
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.exitCodes, [1]);
    assert.deepEqual(payload.appliedCalls, []);
    assert.deepEqual(payload.providerCalls, []);
    assert.deepEqual(payload.registryUpdates, []);
    assert.deepEqual(payload.savedCredentialKeys, []);
    assert.deepEqual(payload.deletedCredentialKeys, []);
    assert.ok(
      !payload.callOrder.includes("promptAndRebuild"),
      `invalid preset must not prompt for rebuild; got order: ${JSON.stringify(payload.callOrder)}`,
    );
    assert.ok(
      result.stderr.includes("has no parseable entries under 'network_policies:'"),
      `expected diagnostic about unparseable network_policies section; got:\n${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes("Restore the preset YAML and re-run: nemoclaw test-sb channels add telegram"),
      `expected restore-and-re-run hint on stderr; got:\n${result.stderr}`,
    );
  });

  it("aborts non-QR channel when policy preset YAML body is malformed", () => {
    const script = `${buildPreamble({ presetMalformedYaml: true })}
const ctx = module.exports;
const exitCodes = [];
const originalExit = process.exit;
process.exit = (code) => {
  exitCodes.push(code ?? 0);
  throw new Error("__EXIT__" + (code ?? 0));
};
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram" });
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
    savedCredentialKeys: ctx.savedCredentialKeys,
    exitCodes,
  }) + "\\n");
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.exitCodes, [1]);
    assert.deepEqual(payload.appliedCalls, []);
    assert.deepEqual(payload.providerCalls, []);
    assert.deepEqual(payload.registryUpdates, []);
    assert.deepEqual(payload.savedCredentialKeys, []);
    assert.ok(
      !payload.callOrder.includes("promptAndRebuild"),
      `malformed preset must not prompt for rebuild; got order: ${JSON.stringify(payload.callOrder)}`,
    );
    assert.ok(
      result.stderr.includes("has no parseable entries under 'network_policies:'"),
      `expected parse-failure diagnostic; got:\n${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes("Restore the preset YAML and re-run: nemoclaw test-sb channels add telegram"),
      `expected restore-and-re-run hint on stderr; got:\n${result.stderr}`,
    );
  });

  it("dry-run validates the channel preset and avoids gateway, registry, and rebuild side effects", () => {
    const script = `${buildPreamble()}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram", dryRun: true });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      appliedCalls: ctx.appliedCalls,
      callOrder: ctx.callOrder,
      providerCalls: ctx.providerCalls,
      registryUpdates: ctx.registryUpdates,
      savedCredentialKeys: ctx.savedCredentialKeys,
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

    assert.deepEqual(payload.appliedCalls, []);
    assert.deepEqual(payload.providerCalls, []);
    assert.deepEqual(payload.registryUpdates, []);
    assert.deepEqual(payload.savedCredentialKeys, []);
    assert.ok(
      !payload.callOrder.includes("promptAndRebuild"),
      `dry-run must not prompt for rebuild; got order: ${JSON.stringify(payload.callOrder)}`,
    );
    assert.ok(
      result.stdout.includes("--dry-run: would enable channel 'telegram' for 'test-sb'"),
      `expected dry-run preview; got:\n${result.stdout}`,
    );
  });

  it("dry-run fails when the matching policy preset YAML is missing", () => {
    const script = `${buildPreamble({ presetFileMissing: true })}
const ctx = module.exports;
const exitCodes = [];
const originalExit = process.exit;
process.exit = (code) => {
  exitCodes.push(code ?? 0);
  throw new Error("__EXIT__" + (code ?? 0));
};
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram", dryRun: true });
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
    savedCredentialKeys: ctx.savedCredentialKeys,
    exitCodes,
  }) + "\\n");
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.exitCodes, [1]);
    assert.deepEqual(payload.appliedCalls, []);
    assert.deepEqual(payload.providerCalls, []);
    assert.deepEqual(payload.registryUpdates, []);
    assert.deepEqual(payload.savedCredentialKeys, []);
    assert.ok(
      !payload.callOrder.includes("promptAndRebuild"),
      `dry-run preset failure must not prompt for rebuild; got order: ${JSON.stringify(payload.callOrder)}`,
    );
    assert.ok(
      result.stderr.includes("Restore the preset YAML and re-run: nemoclaw test-sb channels add telegram"),
      `expected restore-and-re-run hint on stderr; got:\n${result.stderr}`,
    );
  });

  it("aborts QR-paired WhatsApp before registry write when its preset YAML is missing", () => {
    const script = `${buildPreamble({ presetFileMissing: true })}
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
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.exitCodes, [1]);
    assert.deepEqual(payload.appliedCalls, []);
    assert.deepEqual(payload.providerCalls, []);
    assert.deepEqual(
      payload.registryUpdates,
      [],
      `missing whatsapp.yaml must not flip messagingChannels; got ${JSON.stringify(payload.registryUpdates)}`,
    );
    assert.ok(
      !payload.callOrder.includes("promptAndRebuild"),
      `missing whatsapp preset must not prompt for rebuild; got order: ${JSON.stringify(payload.callOrder)}`,
    );
    assert.ok(
      result.stderr.includes("Restore the preset YAML and re-run: nemoclaw test-sb channels add whatsapp"),
      `expected restore-and-re-run hint on stderr; got:\n${result.stderr}`,
    );
  });

  it("rolls back providers, registry, and credentials when applyPreset fails after a successful loadPreset", () => {
    const script = `${buildPreamble({ applyPresetResult: false })}
const ctx = module.exports;
const exitCodes = [];
const originalExit = process.exit;
process.exit = (code) => {
  exitCodes.push(code ?? 0);
  throw new Error("__EXIT__" + (code ?? 0));
};
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram" });
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
    savedCredentialKeys: ctx.savedCredentialKeys,
    deletedCredentialKeys: ctx.deletedCredentialKeys,
    sessionUpdates: ctx.sessionUpdates,
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
    assert.deepEqual(
      payload.appliedCalls,
      [{ sandboxName: "test-sb", presetName: "telegram" }],
      `expected one failed applyPreset call; got ${JSON.stringify(payload.appliedCalls)}`,
    );
    assert.ok(
      payload.registryUpdates.length === 2,
      `expected one add update and one rollback update; got ${JSON.stringify(payload.registryUpdates)}`,
    );
    assert.deepEqual(payload.registryUpdates[0].updates.messagingChannels, ["telegram"]);
    assert.deepEqual(payload.registryUpdates[1].updates.messagingChannels, []);
    assert.deepEqual(
      payload.deletedCredentialKeys,
      ["TELEGRAM_BOT_TOKEN"],
      `expected rollback to clear persisted credentials; got ${JSON.stringify(payload.deletedCredentialKeys)}`,
    );
    assert.deepEqual(
      payload.sessionUpdates,
      [],
      `applyPreset returned false before syncSessionPolicyPresetsWithRegistry; session must stay untouched; got ${JSON.stringify(payload.sessionUpdates)}`,
    );
    assert.ok(
      !payload.callOrder.includes("promptAndRebuild"),
      `apply failure must not prompt for rebuild; got order: ${JSON.stringify(payload.callOrder)}`,
    );
  });

  it("completes rollback registry update and reports residual gateway state when openshell detach fails", () => {
    const script = `${buildPreamble({ applyPresetResult: false })}
openshellRuntime.runOpenshell = (args) => {
  if (Array.isArray(args) && args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach") {
    return { status: 1, stdout: "", stderr: "permission denied" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
const ctx = module.exports;
const exitCodes = [];
const originalExit = process.exit;
const stderrChunks = [];
const originalConsoleError = console.error;
console.error = (...args) => {
  stderrChunks.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\\n");
  originalConsoleError.apply(console, args);
};
process.exit = (code) => {
  exitCodes.push(code ?? 0);
  throw new Error("__EXIT__" + (code ?? 0));
};
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram" });
  } catch (err) {
    if (!String(err && err.message).startsWith("__EXIT__")) {
      process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
      return;
    }
  } finally {
    process.exit = originalExit;
    console.error = originalConsoleError;
  }
  process.stdout.write("\\n__RESULT__" + JSON.stringify({
    appliedCalls: ctx.appliedCalls,
    callOrder: ctx.callOrder,
    providerCalls: ctx.providerCalls,
    registryUpdates: ctx.registryUpdates,
    deletedCredentialKeys: ctx.deletedCredentialKeys,
    exitCodes,
    stderrCombined: stderrChunks.join(""),
  }) + "\\n");
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.exitCodes, [1]);
    assert.deepEqual(payload.appliedCalls, [{ sandboxName: "test-sb", presetName: "telegram" }]);
    assert.ok(
      payload.registryUpdates.length === 2,
      `expected registry add + rollback even when openshell detach fails; got ${JSON.stringify(payload.registryUpdates)}`,
    );
    assert.deepEqual(payload.registryUpdates[1].updates.messagingChannels, []);
    assert.deepEqual(
      payload.deletedCredentialKeys,
      ["TELEGRAM_BOT_TOKEN"],
      `expected local credentials cleared before gateway rollback; got ${JSON.stringify(payload.deletedCredentialKeys)}`,
    );
    assert.ok(
      payload.stderrCombined.includes("Rollback could not fully clean gateway-providers"),
      `expected residual-state warning on stderr; got:\n${payload.stderrCombined}`,
    );
    assert.ok(
      payload.stderrCombined.includes(`'nemoclaw test-sb channels remove telegram'`),
      `expected manual cleanup hint on stderr; got:\n${payload.stderrCombined}`,
    );
    assert.ok(
      !payload.callOrder.includes("promptAndRebuild"),
      `rollback path must not prompt for rebuild; got order: ${JSON.stringify(payload.callOrder)}`,
    );
  });

  it("restores prior channel config when re-add applyPreset fails on an already-enabled channel", () => {
    const script = `${buildPreamble({ applyPresetResult: false })}
registry.getSandbox = () => ({
  name: "test-sb",
  agent: "openclaw",
  messagingChannels: ["telegram"],
  disabledChannels: [],
});
credentials.getCredential = (key) => key === "TELEGRAM_BOT_TOKEN" ? "prior-telegram-token" : null;
const ctx = module.exports;
const exitCodes = [];
const originalExit = process.exit;
process.exit = (code) => {
  exitCodes.push(code ?? 0);
  throw new Error("__EXIT__" + (code ?? 0));
};
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram" });
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
    deletedCredentialKeys: ctx.deletedCredentialKeys,
    savedCredentialKeys: ctx.savedCredentialKeys,
    exitCodes,
  }) + "\\n");
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.exitCodes, [1]);
    assert.deepEqual(payload.appliedCalls, [{ sandboxName: "test-sb", presetName: "telegram" }]);
    const lastRegistry = payload.registryUpdates[payload.registryUpdates.length - 1];
    assert.deepEqual(
      lastRegistry.updates.messagingChannels,
      ["telegram"],
      `re-add failure must keep prior 'telegram' in messagingChannels; got ${JSON.stringify(payload.registryUpdates)}`,
    );
    assert.ok(
      payload.savedCredentialKeys.includes("TELEGRAM_BOT_TOKEN"),
      `re-add failure must restore prior credentials via saveCredential; got ${JSON.stringify(payload.savedCredentialKeys)}`,
    );
    const upsertNames = (payload.providerCalls as Array<{ name: string }>).map((d) => d.name);
    assert.ok(
      upsertNames.length >= 2,
      `expected initial and restorative upsertMessagingProviders calls; got ${JSON.stringify(payload.providerCalls)}`,
    );
    assert.ok(
      !payload.callOrder.includes("promptAndRebuild"),
      `re-add failure must not prompt for rebuild; got order: ${JSON.stringify(payload.callOrder)}`,
    );
    assert.ok(
      result.stderr.includes("Rollback could not fully clean gateway-providers"),
      `expected residual-state warning on stderr; got:\n${result.stderr}`,
    );
  });

  it("restores prior registry state even when re-upsert during re-add rollback throws", () => {
    const script = `${buildPreamble({ applyPresetResult: false })}
registry.getSandbox = () => ({
  name: "test-sb",
  agent: "openclaw",
  messagingChannels: ["telegram"],
  disabledChannels: [],
});
credentials.getCredential = (key) => key === "TELEGRAM_BOT_TOKEN" ? "prior-telegram-token" : null;
let upsertCalls = 0;
onboardProviders.upsertMessagingProviders = (defs) => {
  upsertCalls += 1;
  providerCalls.push(...defs);
  if (upsertCalls >= 2) throw new Error("simulated gateway upsert failure during restore");
};
const ctx = module.exports;
const exitCodes = [];
const originalExit = process.exit;
process.exit = (code) => {
  exitCodes.push(code ?? 0);
  throw new Error("__EXIT__" + (code ?? 0));
};
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "telegram" });
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
    registryUpdates: ctx.registryUpdates,
    savedCredentialKeys: ctx.savedCredentialKeys,
    exitCodes,
  }) + "\\n");
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.exitCodes, [1]);
    const lastRegistry = payload.registryUpdates[payload.registryUpdates.length - 1];
    assert.deepEqual(
      lastRegistry.updates.messagingChannels,
      ["telegram"],
      `registry restoration must precede gateway re-upsert so an upsert failure cannot orphan the channel; got ${JSON.stringify(payload.registryUpdates)}`,
    );
    assert.ok(
      payload.savedCredentialKeys.includes("TELEGRAM_BOT_TOKEN"),
      `re-add failure must restore staged environment credentials; got ${JSON.stringify(payload.savedCredentialKeys)}`,
    );
    assert.ok(
      result.stderr.includes("Failed to restore gateway providers for 'telegram'"),
      `expected gateway-provider restoration warning on stderr; got:\n${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes("Rollback could not fully clean gateway-providers"),
      `expected residual-state warning on stderr; got:\n${result.stderr}`,
    );
  });

  it("validates Slack credentials before registering providers", () => {
    const script = `${buildPreamble()}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "slack" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      slackProbeCalls: ctx.slackProbeCalls,
      credentialSaveCalls: ctx.credentialSaveCalls,
      providerCalls: ctx.providerCalls,
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

    assert.equal(payload.slackProbeCalls.length, 2, "expected bot and app Slack probes");
    assert.ok(
      payload.slackProbeCalls[0].includes("https://slack.com/api/auth.test"),
      `expected auth.test first; got ${JSON.stringify(payload.slackProbeCalls)}`,
    );
    assert.ok(
      payload.slackProbeCalls[1].includes("https://slack.com/api/apps.connections.open"),
      `expected apps.connections.open second; got ${JSON.stringify(payload.slackProbeCalls)}`,
    );
    assert.deepEqual(
      payload.credentialSaveCalls.map((call: { key: string }) => call.key),
      ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    );
    assert.deepEqual(
      payload.providerCalls.map((call: { envKey: string }) => call.envKey),
      ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    );
    assert.ok(
      payload.callOrder.indexOf("slackProbe:app") <
        payload.callOrder.indexOf("saveCredential:SLACK_BOT_TOKEN"),
      `Slack validation must complete before token persistence; got ${JSON.stringify(payload.callOrder)}`,
    );
    assert.ok(
      payload.callOrder.indexOf("slackProbe:app") <
        payload.callOrder.indexOf("upsertMessagingProviders"),
      `Slack validation must complete before provider registration; got ${JSON.stringify(payload.callOrder)}`,
    );
    assert.ok(
      payload.callOrder.indexOf("saveCredential:SLACK_APP_TOKEN") <
        payload.callOrder.indexOf("upsertMessagingProviders"),
      `token persistence should happen before provider registration; got ${JSON.stringify(payload.callOrder)}`,
    );
  });

  it("can explicitly skip live Slack validation for offline channel add", () => {
    const script = `${buildPreamble()}
const ctx = module.exports;
global.__slackBotProbe = {
  ok: true,
  httpStatus: 200,
  curlStatus: 0,
  body: '{"ok":false,"error":"invalid_auth"}',
  stderr: "",
  message: "",
};
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "slack" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      slackProbeCalls: ctx.slackProbeCalls,
      credentialSaveCalls: ctx.credentialSaveCalls,
      providerCalls: ctx.providerCalls,
      callOrder: ctx.callOrder,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runScript(script, { NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION: "1" });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    assert.ok(marker >= 0, `no __RESULT__ marker in stdout:\n${result.stdout}`);
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.slackProbeCalls, []);
    assert.deepEqual(
      payload.credentialSaveCalls.map((call: { key: string }) => call.key),
      ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    );
    assert.deepEqual(
      payload.providerCalls.map((call: { envKey: string }) => call.envKey),
      ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    );
    assert.ok(
      !payload.callOrder.some((entry: string) => entry.startsWith("slackProbe:")),
      `offline skip mode must not probe Slack; got ${JSON.stringify(payload.callOrder)}`,
    );
    assert.ok(
      payload.callOrder.indexOf("saveCredential:SLACK_APP_TOKEN") <
        payload.callOrder.indexOf("upsertMessagingProviders"),
      `token persistence should happen before provider registration; got ${JSON.stringify(payload.callOrder)}`,
    );
  });

  it("aborts Slack channel add on rejected Slack API validation before provider registration", () => {
    const script = `${buildPreamble()}
const ctx = module.exports;
global.__slackBotProbe = {
  ok: true,
  httpStatus: 200,
  curlStatus: 0,
  body: '{"ok":false,"error":"invalid_auth"}',
  stderr: "",
  message: "",
};
const exitCodes = [];
const originalExit = process.exit;
process.exit = (code) => {
  exitCodes.push(code ?? 0);
  throw new Error("__EXIT__" + (code ?? 0));
};
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "slack" });
  } catch (err) {
    if (!String(err && err.message).startsWith("__EXIT__")) {
      process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
      return;
    }
  } finally {
    process.exit = originalExit;
  }
  process.stdout.write("\\n__RESULT__" + JSON.stringify({
    exitCodes,
    credentialSaveCalls: ctx.credentialSaveCalls,
    providerCalls: ctx.providerCalls,
    registryUpdates: ctx.registryUpdates,
    appliedCalls: ctx.appliedCalls,
    callOrder: ctx.callOrder,
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
    assert.deepEqual(payload.credentialSaveCalls, []);
    assert.deepEqual(payload.providerCalls, []);
    assert.deepEqual(payload.registryUpdates, []);
    assert.deepEqual(payload.appliedCalls, []);
    assert.ok(
      !payload.callOrder.some((entry: string) => entry.startsWith("saveCredential:")),
      `rejected Slack credentials must not be persisted; got ${JSON.stringify(payload.callOrder)}`,
    );
    assert.ok(
      !payload.callOrder.includes("upsertMessagingProviders"),
      `rejected Slack credentials must not register providers; got ${JSON.stringify(payload.callOrder)}`,
    );
  });

  it("aborts Slack channel add on indeterminate Slack API validation before provider registration", () => {
    const script = `${buildPreamble()}
const ctx = module.exports;
global.__slackBotProbe = {
  ok: false,
  httpStatus: 0,
  curlStatus: 28,
  body: "",
  stderr: "operation timed out",
  message: "curl failed (exit 28): operation timed out",
};
const exitCodes = [];
const originalExit = process.exit;
process.exit = (code) => {
  exitCodes.push(code ?? 0);
  throw new Error("__EXIT__" + (code ?? 0));
};
(async () => {
  try {
    await ctx.channelModule.addSandboxChannel("test-sb", { channel: "slack" });
  } catch (err) {
    if (!String(err && err.message).startsWith("__EXIT__")) {
      process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
      return;
    }
  } finally {
    process.exit = originalExit;
  }
  process.stdout.write("\\n__RESULT__" + JSON.stringify({
    exitCodes,
    credentialSaveCalls: ctx.credentialSaveCalls,
    providerCalls: ctx.providerCalls,
    registryUpdates: ctx.registryUpdates,
    appliedCalls: ctx.appliedCalls,
    callOrder: ctx.callOrder,
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
    assert.deepEqual(payload.credentialSaveCalls, []);
    assert.deepEqual(payload.providerCalls, []);
    assert.deepEqual(payload.registryUpdates, []);
    assert.deepEqual(payload.appliedCalls, []);
    assert.ok(
      !payload.callOrder.some((entry: string) => entry.startsWith("saveCredential:")),
      `indeterminate Slack credentials must not be persisted; got ${JSON.stringify(payload.callOrder)}`,
    );
    assert.ok(
      !payload.callOrder.includes("upsertMessagingProviders"),
      `indeterminate Slack credentials must not register providers; got ${JSON.stringify(payload.callOrder)}`,
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

describe("channel preset source-of-truth", () => {
  it("every channel registered in KNOWN_CHANNELS ships a preset YAML that parsePresetPolicyKeys() accepts", () => {
    const { knownChannelNames } = require(path.join(repoRoot, "dist", "lib", "sandbox", "channels.js")) as {
      knownChannelNames: () => string[];
    };
    const { loadPreset, parsePresetPolicyKeys } = require(path.join(repoRoot, "dist", "lib", "policy", "index.js")) as {
      loadPreset: (name: string) => string | null;
      parsePresetPolicyKeys: (content: string | null | undefined) => string[];
    };
    const failures: string[] = [];
    for (const name of knownChannelNames()) {
      const content = loadPreset(name);
      if (content === null) {
        failures.push(`${name}: preset YAML not found on disk`);
        continue;
      }
      const keys = parsePresetPolicyKeys(content);
      if (keys.length === 0) {
        failures.push(`${name}: parsePresetPolicyKeys returned no entries`);
      }
    }
    assert.deepEqual(
      failures,
      [],
      `every channel in KNOWN_CHANNELS must ship a parseable preset YAML; failures: ${failures.join("; ")}`,
    );
  });
});
