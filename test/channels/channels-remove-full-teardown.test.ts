// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for #3998 — `nemoclaw <sandbox> channels remove <channel>`
// must (1) remove the channel preset from the live OpenShell policy, (2) wipe the channel's durable
// state inside the sandbox so the rebuild's state_dirs backup does not
// restore stale auth files, and (3) refuse to proceed to rebuild when the
// in-sandbox cleanup for a QR-paired channel fails — otherwise the backup
// would re-capture the auth blob and the channel would reconnect after
// the rebuild.

import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import type { MessagingAgentId } from "../../src/lib/messaging";
import { makeMessagingPlan } from "../helpers/messaging-plan-fixtures";

const repoRoot = path.join(import.meta.dirname, "../..");

// Strip messaging-channel env vars from the parent process before spawning
// the test subprocess so local/CI ambient values (e.g. TELEGRAM_BOT_TOKEN
// in a developer shell) cannot perturb the channel cleanup paths the test
// is asserting against.
const MESSAGING_ENV_PREFIXES = [
  "TELEGRAM_",
  "DISCORD_",
  "SLACK_",
  "WECHAT_",
  "WEIXIN_",
  "WHATSAPP_",
];

function buildCleanEnv(extraEnv: Record<string, string>, home: string): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (MESSAGING_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    filtered[key] = value;
  }
  return {
    ...filtered,
    HOME: home,
    NEMOCLAW_NON_INTERACTIVE: "1",
    ...extraEnv,
  };
}

function runScript(
  scriptBody: string,
  extraEnv: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-3998-"));
  const scriptPath = path.join(tmpDir, "script.js");
  fs.writeFileSync(scriptPath, scriptBody);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: buildCleanEnv(extraEnv, tmpDir),
    timeout: 15000,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

function buildPreamble({
  presetNamesApplied = ["npm", "pypi", "huggingface", "brew", "whatsapp"],
  sandboxAgent = "openclaw",
  channelInRegistry = "whatsapp",
  sandboxExecResult = { status: 0, stdout: "NEMOCLAW_CHANNEL_CLEAR_OK", stderr: "" },
  sshFallbackResult = null as { status: number; stdout: string; stderr: string } | null,
}: {
  presetNamesApplied?: string[];
  sandboxAgent?: MessagingAgentId;
  channelInRegistry?: string;
  sandboxExecResult?: { status: number; stdout: string; stderr: string } | null;
  sshFallbackResult?: { status: number; stdout: string; stderr: string } | null;
} = {}): string {
  const j = (p: string) =>
    JSON.stringify(path.join(repoRoot, "src", "lib", p.replace(/\.js$/, ".ts")));
  const messagingPlanLiteral = () =>
    JSON.stringify(
      makeMessagingPlan({
        sandboxName: "test-sb",
        agent: sandboxAgent,
        channels: channelInRegistry ? [channelInRegistry] : [],
      }),
    );
  return String.raw`
const resolver = require(${j("adapters/openshell/resolve.js")});
resolver.resolveOpenshell = () => "/fake/openshell";

const runner = require(${j("runner.js")});
runner.run = () => ({ status: 0, stdout: "", stderr: "" });
runner.runCapture = () => "";

const adapterRuntime = require(${j("adapters/openshell/runtime.js")});
adapterRuntime.runOpenshell = () => ({ status: 0, stdout: "", stderr: "" });

const processRecovery = require(${j("actions/sandbox/process-recovery.js")});
const sandboxExecCalls = [];
const sandboxSshCalls = [];
processRecovery.executeSandboxExecCommand = (sandboxName, command) => {
  sandboxExecCalls.push({ sandboxName, command });
  return ${JSON.stringify(sandboxExecResult)};
};
processRecovery.executeSandboxCommand = (sandboxName, command) => {
  sandboxSshCalls.push({ sandboxName, command });
  return ${JSON.stringify(sshFallbackResult)};
};

const gatewayRuntime = require(${j("gateway-runtime-action.js")});
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({ recovered: true });

const credentials = require(${j("credentials/store.js")});
credentials.getCredential = () => null;
credentials.saveCredential = () => true;
credentials.deleteCredential = () => true;
credentials.prompt = async (msg) => { throw new Error("unexpected prompt: " + msg); };

const onboard = require(${j("onboard.js")});
onboard.isNonInteractive = () => true;

const onboardSession = require(${j("state/onboard-session.js")});
const sessionStore = {
  sandboxName: "test-sb",
  resumable: false,
  status: "complete",
  agent: ${JSON.stringify(sandboxAgent)},
  provider: null,
  model: null,
  endpointUrl: null,
  credentialEnv: null,
  hermesAuthMethod: null,
  preferredInferenceApi: null,
  nimContainer: null,
  routerPid: null,
  routerCredentialHash: null,
  messagingPlan: ${messagingPlanLiteral()},
  hermesToolGateways: [],
  wechatConfig: null,
};
onboardSession.loadSession = () => sessionStore;
onboardSession.updateSession = (mutate) => { mutate(sessionStore); };

const registry = require(${j("state/registry.js")});
const registryUpdates = [];
registry.getSandbox = () => ({
  name: "test-sb",
  agent: ${JSON.stringify(sandboxAgent)},
  messaging: { schemaVersion: 1, plan: ${messagingPlanLiteral()} },
});
registry.updateSandbox = (name, updates) => {
  registryUpdates.push({ name, updates });
  return true;
};

const policies = require(${j("policy/index.js")});
const removedPresets = [];
policies.listPresets = () => ${JSON.stringify(presetNamesApplied.map((name) => ({ name })))};
policies.getAppliedPresets = () => ${JSON.stringify(presetNamesApplied)};
policies.removePreset = (sandboxName, presetName) => {
  removedPresets.push({ sandboxName, presetName });
  return true;
};

const callOrder = [];
const origLog = console.log;
console.log = (...args) => {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (line.includes("Change queued")) callOrder.push("promptAndRebuild");
  if (line.includes("Cleared in-sandbox")) callOrder.push("clearedSandboxState");
  origLog.call(console, ...args);
};
const origExit = process.exit;
let exitCode = null;
process.exit = (code) => {
  if (exitCode === null) exitCode = code;
  throw new Error("__PROCESS_EXIT__:" + code);
};

const channelModule = require(${j("actions/sandbox/policy-channel.js")});

module.exports = {
  channelModule,
  sandboxExecCalls,
  sandboxSshCalls,
  removedPresets,
  registryUpdates,
  sessionStore,
  callOrder,
  getExitCode: () => exitCode,
};
`;
}

describe("channels remove full teardown (#3998)", () => {
  it.each(["openclaw", "hermes"] as const)(
    "removes the live '%s' channel policy and clears the in-sandbox whatsapp state dir",
    (sandboxAgent) => {
      const script = `${buildPreamble({ sandboxAgent })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "whatsapp" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      sandboxExecCalls: ctx.sandboxExecCalls,
      removedPresets: ctx.removedPresets,
      callOrder: ctx.callOrder,
      exitCode: ctx.getExitCode(),
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
      const result = runScript(script);
      assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
      const marker = result.stdout.lastIndexOf("__RESULT__");
      assert.ok(marker >= 0, `no __RESULT__ marker:\n${result.stdout}`);
      const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
      assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);
      assert.equal(
        payload.exitCode,
        null,
        `must not exit on success path; got exitCode=${payload.exitCode}`,
      );

      assert.deepEqual(
        payload.removedPresets,
        [{ sandboxName: "test-sb", presetName: "whatsapp" }],
        `expected one removePreset('whatsapp') call; got ${JSON.stringify(payload.removedPresets)}`,
      );

      const cleanupCalls = payload.sandboxExecCalls.filter((c: { command: string }) =>
        c.command.startsWith("rm -rf"),
      );
      assert.equal(
        cleanupCalls.length,
        1,
        `expected one rm -rf sandbox-exec call; got ${cleanupCalls.length}`,
      );
      const expectedPath =
        sandboxAgent === "openclaw"
          ? "/sandbox/.openclaw/whatsapp"
          : "/sandbox/.hermes/platforms/whatsapp";
      assert.ok(
        cleanupCalls[0].command.includes(expectedPath),
        `expected cleanup to target '${expectedPath}'; got ${cleanupCalls[0].command}`,
      );
      const dashboardPath = `/sandbox/.${sandboxAgent}/profiles/dashboard-home`;
      assert.equal(
        cleanupCalls[0].command.includes(dashboardPath),
        sandboxAgent === "hermes",
        `${sandboxAgent} Dashboard cleanup selection was incorrect; got ${cleanupCalls[0].command}`,
      );

      const rebuildIdx = payload.callOrder.indexOf("promptAndRebuild");
      const clearIdx = payload.callOrder.indexOf("clearedSandboxState");
      assert.ok(
        rebuildIdx >= 0,
        `promptAndRebuild was never called: ${JSON.stringify(payload.callOrder)}`,
      );
      assert.ok(
        clearIdx >= 0,
        `clearedSandboxState marker was never logged: ${JSON.stringify(payload.callOrder)}`,
      );
      assert.ok(
        clearIdx < rebuildIdx,
        `sandbox state must be cleared before rebuild so the backup excludes the auth files: ${JSON.stringify(payload.callOrder)}`,
      );
    },
  );

  it("falls back to SSH when sandbox-exec wrapper does not return the sentinel", () => {
    const script = `${buildPreamble({
      sandboxAgent: "openclaw",
      sandboxExecResult: null,
      sshFallbackResult: { status: 0, stdout: "NEMOCLAW_CHANNEL_CLEAR_OK", stderr: "" },
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "whatsapp" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      sandboxExecCalls: ctx.sandboxExecCalls,
      sandboxSshCalls: ctx.sandboxSshCalls,
      removedPresets: ctx.removedPresets,
      callOrder: ctx.callOrder,
      exitCode: ctx.getExitCode(),
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    assert.ok(marker >= 0, `no __RESULT__ marker:\n${result.stdout}`);
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.equal(
      payload.exitCode,
      null,
      `must not exit when SSH fallback recovers; got exitCode=${payload.exitCode}`,
    );
    assert.equal(payload.sandboxExecCalls.length, 1, "exec attempt must run first");
    assert.equal(
      payload.sandboxSshCalls.length,
      1,
      "SSH fallback must run once when exec returns null",
    );
    assert.deepEqual(
      payload.removedPresets,
      [{ sandboxName: "test-sb", presetName: "whatsapp" }],
      "remove flow must continue after SSH-recovered cleanup",
    );
    assert.ok(
      payload.callOrder.includes("promptAndRebuild"),
      `rebuild must be queued after SSH-recovered cleanup; callOrder=${JSON.stringify(payload.callOrder)}`,
    );
  });

  it("aborts before rebuild when both exec and SSH cleanup fail for a QR channel", () => {
    const script = `${buildPreamble({
      sandboxAgent: "openclaw",
      sandboxExecResult: { status: 1, stdout: "", stderr: "sandbox is not running" },
      sshFallbackResult: { status: 255, stdout: "", stderr: "ssh: connect to host ... failed" },
    })}
const ctx = module.exports;
(async () => {
  const dumpState = () => ({
    sandboxExecCalls: ctx.sandboxExecCalls,
    sandboxSshCalls: ctx.sandboxSshCalls,
    removedPresets: ctx.removedPresets,
    registryUpdates: ctx.registryUpdates,
    callOrder: ctx.callOrder,
    exitCode: ctx.getExitCode(),
  });
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "whatsapp" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify(dumpState()) + "\\n");
  } catch (err) {
    if (typeof err.message === "string" && err.message.startsWith("__PROCESS_EXIT__")) {
      process.stdout.write("\\n__RESULT__" + JSON.stringify(dumpState()) + "\\n");
      return;
    }
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    assert.ok(marker >= 0, `no __RESULT__ marker:\n${result.stdout}`);
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.equal(payload.exitCode, 1, "QR channel cleanup failure must exit non-zero");
    assert.ok(
      !payload.callOrder.includes("promptAndRebuild"),
      `rebuild must NOT be queued on cleanup failure; callOrder=${JSON.stringify(payload.callOrder)}`,
    );
    assert.deepEqual(
      payload.removedPresets,
      [],
      "policy preset must NOT be un-applied when we bail early on cleanup failure",
    );
    assert.deepEqual(
      payload.registryUpdates,
      [],
      "registry must NOT be mutated when we bail early on cleanup failure",
    );
    const cleanupCalls = payload.sandboxExecCalls.filter((c: { command: string }) =>
      c.command.startsWith("rm -rf"),
    );
    assert.equal(cleanupCalls.length, 1, "expected the rm -rf attempt that failed");
    assert.equal(
      payload.sandboxSshCalls.length,
      1,
      `SSH fallback must be attempted before aborting; sandboxSshCalls=${JSON.stringify(payload.sandboxSshCalls)}`,
    );
    assert.ok(
      payload.sandboxSshCalls[0].command.startsWith("rm -rf"),
      `SSH fallback must invoke the rm -rf cleanup; got ${payload.sandboxSshCalls[0].command}`,
    );
  });

  it("does not abort when removing a never-configured QR channel even if sandbox is unreachable", () => {
    const script = `${buildPreamble({
      presetNamesApplied: ["npm", "pypi"],
      sandboxAgent: "openclaw",
      channelInRegistry: "telegram",
      sandboxExecResult: { status: 1, stdout: "", stderr: "sandbox is not running" },
      sshFallbackResult: { status: 255, stdout: "", stderr: "ssh: connect to host ... failed" },
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "whatsapp" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      sandboxExecCalls: ctx.sandboxExecCalls,
      sandboxSshCalls: ctx.sandboxSshCalls,
      callOrder: ctx.callOrder,
      exitCode: ctx.getExitCode(),
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    assert.ok(marker >= 0, `no __RESULT__ marker:\n${result.stdout}`);
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.equal(
      payload.exitCode,
      null,
      "must remain a no-op when registry shows no channel residue",
    );
    assert.equal(
      payload.sandboxExecCalls.length,
      0,
      `sandbox-exec cleanup must NOT run when channel was never configured; got ${JSON.stringify(payload.sandboxExecCalls)}`,
    );
    assert.equal(
      payload.sandboxSshCalls.length,
      0,
      "SSH fallback must NOT run when channel was never configured",
    );
    assert.ok(
      payload.callOrder.includes("promptAndRebuild"),
      `rebuild prompt must still fire on the no-op remove path; callOrder=${JSON.stringify(payload.callOrder)}`,
    );
  });

  it("removes the live preset and messaging plan entry for a token-based channel", () => {
    const script = `${buildPreamble({
      presetNamesApplied: ["npm", "pypi", "telegram", "brew"],
      sandboxAgent: "openclaw",
      channelInRegistry: "telegram",
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.removeSandboxChannel("test-sb", { channel: "telegram" });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      removedPresets: ctx.removedPresets,
      registryUpdates: ctx.registryUpdates,
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runScript(script, { TELEGRAM_BOT_TOKEN: "stub" });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    assert.ok(marker >= 0, `no __RESULT__ marker:\n${result.stdout}`);
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(
      payload.removedPresets,
      [{ sandboxName: "test-sb", presetName: "telegram" }],
      "the command must remove the channel preset from the live OpenShell policy",
    );

    const messagingPlanUpdate = payload.registryUpdates.findLast(
      (u: { updates: { messaging?: { plan?: { channels?: Array<{ channelId: string }> } } } }) =>
        u.updates.messaging?.plan,
    );
    assert.ok(
      messagingPlanUpdate,
      `expected an updateSandbox call that writes messaging.plan; got ${JSON.stringify(payload.registryUpdates)}`,
    );
    assert.deepEqual(
      messagingPlanUpdate.updates.messaging.plan.channels.map(
        (channel: {
          channelId: string;
          active: boolean;
          selected: boolean;
          configured: boolean;
          disabled: boolean;
        }) => ({
          channelId: channel.channelId,
          active: channel.active,
          selected: channel.selected,
          configured: channel.configured,
          disabled: channel.disabled,
        }),
      ),
      [
        {
          channelId: "telegram",
          active: false,
          selected: false,
          configured: false,
          disabled: true,
        },
      ],
      "messaging.plan must retain only the pending Telegram config tombstone until rebuild",
    );
  });
});
