// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for the same session/registry divergence that motivated
// the channels-add fix (see test/channels-add-preset.test.ts). The bug
// surfaced first via `nemoclaw <sb> channels add slack` → `rebuild`
// (registry got slack, session did not, rebuild's resume step narrowed
// it back away). The exact same divergence applies to the standalone
// preset-mutation CLIs:
//
//   - `nemoclaw <sb> policy-add <preset>`       (built-in preset)
//   - `nemoclaw <sb> policy-add --from-file …`  (custom preset YAML)
//   - `nemoclaw <sb> policy-remove <preset>`    (any preset)
//
// All three call `policies.applyPreset` / `policies.applyPresetContent` /
// `policies.removePreset` to mutate the registry; none of them previously
// touched `session.policyPresets`. These tests pin down the invariant
// that after the channels-add fix was generalised, all three paths now
// keep session in sync with registry, with the same best-effort error
// handling.

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");

function runScript(scriptBody: string, extraEnv: Record<string, string> = {}): SpawnSyncReturns<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-sync-"));
  const scriptPath = path.join(tmpDir, "script.js");
  fs.writeFileSync(scriptPath, scriptBody);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      NEMOCLAW_NON_INTERACTIVE: "1",
      ...extraEnv,
    },
    timeout: 15000,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

// Stub every module that addSandboxPolicy / removeSandboxPolicy touches.
// The only side effect we actually want to observe is on the onboardSession
// stub, so everything else is faked to a no-op success.
function buildPreamble({
  presetNamesAvailable = ["github", "npm", "pypi"],
  appliedPresets = [] as string[],
  applyPresetResult = true,
  sessionSandboxName = "test-sb" as string | null,
  sessionPolicyPresets = ["npm"] as string[] | null,
  sessionMissing = false,
}: {
  presetNamesAvailable?: string[];
  appliedPresets?: string[];
  applyPresetResult?: boolean;
  sessionSandboxName?: string | null;
  sessionPolicyPresets?: string[] | null;
  sessionMissing?: boolean;
} = {}): string {
  const j = (p: string) => JSON.stringify(path.join(repoRoot, "dist", "lib", p));
  return String.raw`
const onboard = require(${j("onboard.js")});
onboard.isNonInteractive = () => true;

const credentials = require(${j("credentials/store.js")});
credentials.prompt = async () => "y";

const policies = require(${j("policy/index.js")});
const calls = { apply: [], applyContent: [], remove: [] };
policies.listPresets = () => ${JSON.stringify(presetNamesAvailable.map((name) => ({ name })))};
policies.getAppliedPresets = () => ${JSON.stringify(appliedPresets)};
policies.loadPreset = (name) => ({ name, network_policies: {} });
policies.getPresetEndpoints = () => [];
policies.getMessagingPresetWarning = () => null;
policies.selectFromList = async (items) => items[0]?.name || null;
policies.applyPreset = (sandboxName, presetName) => {
  calls.apply.push({ sandboxName, presetName });
  return ${JSON.stringify(applyPresetResult)};
};
policies.applyPresetContent = (sandboxName, presetName) => {
  calls.applyContent.push({ sandboxName, presetName });
  return true;
};
policies.removePreset = (sandboxName, presetName) => {
  calls.remove.push({ sandboxName, presetName });
  return true;
};
// loadPresetFromFile is used by --from-file path.
policies.loadPresetFromFile = (filePath) => ({
  presetName: "custom-preset-from-file",
  content: { network_policies: {} },
});

const onboardSession = require(${j("state/onboard-session.js")});
const sessionUpdates = [];
let sessionState = ${
    sessionMissing
      ? "null"
      : `{
  sandboxName: ${JSON.stringify(sessionSandboxName)},
  policyPresets: ${JSON.stringify(sessionPolicyPresets)},
}`
  };
onboardSession.loadSession = () => sessionState;
onboardSession.updateSession = (mutator) => {
  if (!sessionState) sessionState = { sandboxName: null, policyPresets: null };
  const next = mutator(sessionState) || sessionState;
  sessionState = next;
  sessionUpdates.push({
    policyPresets: Array.isArray(next.policyPresets) ? [...next.policyPresets] : next.policyPresets,
  });
  return next;
};

const channelModule = require(${j("actions/sandbox/policy-channel.js")});

module.exports = { channelModule, calls, sessionUpdates, getSessionState: () => sessionState };
`;
}

describe("policy-add / policy-remove keep session.policyPresets in sync with registry", () => {
  it("appends the built-in preset to session.policyPresets after policy-add", () => {
    const script = `${buildPreamble({
      sessionSandboxName: "test-sb",
      sessionPolicyPresets: ["npm"],
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxPolicy("test-sb", { preset: "github", yes: true });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
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

    // Contract 1: applyPreset called exactly once with the chosen preset.
    assert.deepEqual(payload.calls.apply, [{ sandboxName: "test-sb", presetName: "github" }]);
    // Contract 2: session updated exactly once, github appended.
    assert.equal(payload.sessionUpdates.length, 1);
    assert.deepEqual(payload.sessionUpdates[0].policyPresets, ["npm", "github"]);
    assert.deepEqual(payload.finalSession.policyPresets, ["npm", "github"]);
  });

  it("does not sync session.policyPresets when built-in policy-add fails", () => {
    const script = `${buildPreamble({
      applyPresetResult: false,
      sessionSandboxName: "test-sb",
      sessionPolicyPresets: ["npm"],
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
    await ctx.channelModule.addSandboxPolicy("test-sb", { preset: "github", yes: true });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
      sessionUpdates: ctx.sessionUpdates,
      finalSession: ctx.getSessionState(),
      exitCodes,
    }) + "\\n");
  } catch (err) {
    if (!String(err && err.message).startsWith("__EXIT__")) {
      process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
      return;
    }
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
      sessionUpdates: ctx.sessionUpdates,
      finalSession: ctx.getSessionState(),
      exitCodes,
    }) + "\\n");
  } finally {
    process.exit = originalExit;
  }
})();
`;
    const result = runScript(script);
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    assert.deepEqual(payload.calls.apply, [{ sandboxName: "test-sb", presetName: "github" }]);
    assert.deepEqual(payload.exitCodes, [1]);
    assert.deepEqual(payload.sessionUpdates, []);
    assert.deepEqual(payload.finalSession.policyPresets, ["npm"]);
  });

  it("appends the custom preset (--from-file) to session.policyPresets", () => {
    // Write a tiny YAML file the stubbed loadPresetFromFile will pretend to parse.
    const presetFile = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preset-"));
    const yamlPath = path.join(presetFile, "custom.yaml");
    fs.writeFileSync(yamlPath, "name: custom-preset-from-file\nnetwork_policies: {}\n");

    const script = `${buildPreamble({
      sessionSandboxName: "test-sb",
      sessionPolicyPresets: ["npm"],
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxPolicy("test-sb", { fromFile: ${JSON.stringify(yamlPath)}, yes: true });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
      sessionUpdates: ctx.sessionUpdates,
      finalSession: ctx.getSessionState(),
    }) + "\\n");
  } catch (err) {
    process.stdout.write("\\n__RESULT__" + JSON.stringify({ error: err.message, stack: err.stack }) + "\\n");
  }
})();
`;
    const result = runScript(script);
    fs.rmSync(presetFile, { recursive: true, force: true });
    assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.lastIndexOf("__RESULT__");
    const payload = JSON.parse(result.stdout.slice(marker + "__RESULT__".length).trim());
    assert.ok(!payload.error, `unexpected error: ${payload.error}\n${payload.stack || ""}`);

    // The custom-preset path goes through applyPresetContent (NOT applyPreset).
    assert.deepEqual(payload.calls.applyContent, [
      { sandboxName: "test-sb", presetName: "custom-preset-from-file" },
    ]);
    assert.equal(payload.sessionUpdates.length, 1);
    assert.deepEqual(payload.sessionUpdates[0].policyPresets, ["npm", "custom-preset-from-file"]);
  });

  it("removes the preset from session.policyPresets after policy-remove", () => {
    const script = `${buildPreamble({
      appliedPresets: ["npm", "github"],
      sessionSandboxName: "test-sb",
      sessionPolicyPresets: ["npm", "github"],
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.removeSandboxPolicy("test-sb", { preset: "github", yes: true });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
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

    assert.deepEqual(payload.calls.remove, [{ sandboxName: "test-sb", presetName: "github" }]);
    assert.equal(payload.sessionUpdates.length, 1);
    assert.deepEqual(payload.sessionUpdates[0].policyPresets, ["npm"]);
  });

  it("does not touch a session belonging to a different sandbox", () => {
    const script = `${buildPreamble({
      sessionSandboxName: "other-sb",
      sessionPolicyPresets: ["pypi"],
    })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxPolicy("test-sb", { preset: "github", yes: true });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
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

    // Registry mutation still happens — that lives per-sandbox in the
    // OpenShell policy engine, not in the session file.
    assert.deepEqual(payload.calls.apply, [{ sandboxName: "test-sb", presetName: "github" }]);
    // But session for "other-sb" must be left alone.
    assert.deepEqual(payload.sessionUpdates, []);
    assert.deepEqual(payload.finalSession.policyPresets, ["pypi"]);
  });

  it("completes policy-add when no onboard session exists", () => {
    const script = `${buildPreamble({ sessionMissing: true })}
const ctx = module.exports;
(async () => {
  try {
    await ctx.channelModule.addSandboxPolicy("test-sb", { preset: "github", yes: true });
    process.stdout.write("\\n__RESULT__" + JSON.stringify({
      calls: ctx.calls,
      sessionUpdates: ctx.sessionUpdates,
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

    // Registry mutation succeeded; session-sync was a no-op (no session
    // to keep in sync). policy-add must NOT abort the operation in this case.
    assert.deepEqual(payload.calls.apply, [{ sandboxName: "test-sb", presetName: "github" }]);
    assert.deepEqual(payload.sessionUpdates, []);
  });
});
