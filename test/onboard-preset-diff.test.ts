// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for #2177 — when a user re-runs `nemoclaw onboard` on an
// existing sandbox and narrows the preset selection (e.g. Balanced default
// of [npm, pypi, huggingface, brew, brave] down to just [npm]), the policy
// setup step must honor the final selection: apply new presets AND remove
// previously-applied ones that are no longer selected.

import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");

function runScript(scriptBody: string): SpawnSyncReturns<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preset-diff-"));
  const scriptPath = path.join(tmpDir, "script.js");
  fs.writeFileSync(scriptPath, scriptBody);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("DISCORD_") ||
      key.startsWith("SLACK_") ||
      key.startsWith("TELEGRAM_") ||
      // Teams credentials span both prefixes: the core bot credentials use
      // `MSTEAMS_*` (MSTEAMS_APP_ID/APP_PASSWORD/TENANT_ID/PORT) while a couple
      // of config keys use `TEAMS_*` (TEAMS_ALLOWED_USERS/REQUIRE_MENTION).
      // Scrub both so a real `MSTEAMS_*` token can't activate Teams in the child.
      key.startsWith("TEAMS_") ||
      key.startsWith("MSTEAMS_") ||
      key.startsWith("WECHAT_") ||
      key.startsWith("WHATSAPP_")
    ) {
      delete env[key];
    }
  }
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...env,
      HOME: tmpDir,
      NEMOCLAW_NON_INTERACTIVE: "1",
    },
    timeout: 15000,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

/**
 * Build a preamble that:
 *   - seeds `applied` to simulate the user's prior onboard (Balanced defaults)
 *   - tracks every applyPreset / removePreset call so the test can assert
 *     exactly what the preset-diff logic did
 *   - stubs the heavy I/O surfaces the same way policy-tiers-onboard.test.ts does
 */
function buildPreamble({
  tierEnv = "balanced",
  policyMode = "custom",
  policyPresets = "npm",
  alreadyApplied = ["npm", "pypi", "huggingface", "brew", "brave"],
} = {}): string {
  const credPath = JSON.stringify(path.join(repoRoot, "src", "lib", "credentials", "store.ts"));
  const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
  const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
  const policiesPath = JSON.stringify(path.join(repoRoot, "src", "lib", "policy", "index.ts"));
  const resolveOpenshellPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "adapters", "openshell", "resolve.ts"),
  );
  const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));

  return String.raw`
// All stubs MUST be installed before requiring onboard so its module-level
// destructuring picks up the patched functions.
Object.defineProperty(process, "platform", { value: "darwin" });

const resolver = require(${resolveOpenshellPath});
resolver.resolveOpenshell = () => "/fake/openshell";

const runner = require(${runnerPath});
runner.run = () => {};
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : String(command);
  if (text.includes("sandbox list")) return "test-sb Ready";
  return "Running";
};

const credentials = require(${credPath});
credentials.prompt = async (msg) => { throw new Error("unexpected prompt: " + msg); };
credentials.ensureApiKey = async () => {};
credentials.getCredential = () => null;

const registry = require(${registryPath});
const updates = [];
registry.registerSandbox = () => true;
registry.updateSandbox = (_name, fields) => { updates.push(fields); return true; };
registry.getSandbox = () => ({ name: "test-sb", model: null, provider: null, policies: ${JSON.stringify(alreadyApplied)} });

const policies = require(${policiesPath});
const appliedCalls = [];
const removedCalls = [];
let appliedState = ${JSON.stringify(alreadyApplied)}.slice();
policies.getAppliedPresets = () => appliedState.slice();
policies.applyPreset = (_name, preset) => {
  appliedCalls.push(preset);
  if (!appliedState.includes(preset)) appliedState.push(preset);
  // Mirror production contract: real applyPreset returns true on success
  // and false on recoverable errors (unknown preset, malformed YAML, etc).
  return true;
};
policies.applyPresets = (_name, presets) => {
  for (const preset of presets) {
    appliedCalls.push(preset);
    if (!appliedState.includes(preset)) appliedState.push(preset);
  }
  return true;
};
policies.removePreset = (_name, preset) => {
  removedCalls.push(preset);
  appliedState = appliedState.filter((p) => p !== preset);
  return true;
};

process.env.NEMOCLAW_POLICY_TIER = ${JSON.stringify(tierEnv)};
process.env.NEMOCLAW_POLICY_MODE = ${JSON.stringify(policyMode)};
process.env.NEMOCLAW_POLICY_PRESETS = ${JSON.stringify(policyPresets)};

const { setupPoliciesWithSelection } = require(${onboardPath});
`;
}

/**
 * Run one `setupPoliciesWithSelection` scenario end-to-end in a child process:
 * build the stub preamble, drive the call with `selectionOptions`, and return
 * the parsed `{ chosen, appliedCalls, removedCalls, finalApplied }` payload after
 * asserting the script ran cleanly. Collapses the identical preamble + IIFE +
 * run/parse boilerplate each scenario would otherwise repeat; callers keep only
 * their scenario-specific assertions.
 */
function runPolicyScenario({
  tierEnv,
  policyMode,
  policyPresets,
  alreadyApplied,
  selectionOptions = {},
}: {
  tierEnv?: string;
  policyMode?: string;
  policyPresets?: string;
  alreadyApplied?: string[];
  selectionOptions?: Record<string, unknown>;
} = {}): {
  chosen: string[];
  appliedCalls: string[];
  removedCalls: string[];
  finalApplied: string[];
} {
  const script =
    buildPreamble({ tierEnv, policyMode, policyPresets, alreadyApplied }) +
    String.raw`
console.log = () => {};
(async () => {
  try {
    const chosen = await setupPoliciesWithSelection("test-sb", ${JSON.stringify(selectionOptions)});
    process.stdout.write(JSON.stringify({ chosen, appliedCalls, removedCalls, finalApplied: appliedState }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
  }
})();
`;
  const result = runScript(script);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(!payload.error, `unexpected error: ${payload.error}`);
  return payload;
}

describe("setupPoliciesWithSelection preset diff (#2177)", () => {
  // In non-interactive mode a user who runs onboard twice — first with Balanced
  // defaults (applies 5 presets), second with NEMOCLAW_POLICY_PRESETS=npm —
  // expects the final sandbox to have ONLY npm. Previously-applied presets
  // must be removed.
  it("non-interactive narrow selection removes previously-applied presets", () => {
    const payload = runPolicyScenario({ policyMode: "custom", policyPresets: "npm" });

    // User asked for only npm.
    assert.deepEqual(payload.chosen, ["npm"]);

    // The 4 defaults from Balanced that the user did NOT re-select must be
    // removed. This is the regression guard for #2177.
    const expectedRemoved = ["pypi", "huggingface", "brew", "brave"].sort();
    assert.deepEqual(
      payload.removedCalls.slice().sort(),
      expectedRemoved,
      `expected to remove ${JSON.stringify(expectedRemoved)}, got ${JSON.stringify(payload.removedCalls)}`,
    );

    // Final applied set must equal the user's narrowed selection.
    assert.deepEqual(
      payload.finalApplied.slice().sort(),
      ["npm"],
      `final applied presets should be exactly [npm], got ${JSON.stringify(payload.finalApplied)}`,
    );
  });

  // Re-onboarding in the default `suggested` mode must not silently remove
  // presets the user added via `nemoclaw <name> policy-add` after the original
  // onboard. Tier defaults are recomputed against the current provider, so a
  // user-added preset such as `local-inference` is not in `suggestions` on a
  // cloud-provider sandbox — without the additive guard it would be removed.
  it("non-interactive suggested re-onboard preserves user-added presets", () => {
    const payload = runPolicyScenario({
      policyMode: "suggested",
      policyPresets: "",
      // Balanced defaults plus a manually-added preset.
      alreadyApplied: ["npm", "pypi", "huggingface", "brew", "brave", "local-inference"],
      selectionOptions: { provider: "openai" },
    });

    // The user-added preset must still be in the chosen list.
    assert.ok(
      payload.chosen.includes("local-inference"),
      `expected chosen to preserve local-inference, got ${JSON.stringify(payload.chosen)}`,
    );

    // User-added extras stay additive, but built-in Brave is no longer
    // preserved after Brave search was declined.
    assert.deepEqual(
      payload.removedCalls,
      ["brave"],
      `expected only stale built-in Brave to be removed, got ${JSON.stringify(payload.removedCalls)}`,
    );

    // Final state should still contain every non-Brave previously-applied preset.
    const finalSorted = payload.finalApplied.slice().sort();
    assert.deepEqual(finalSorted, [
      "brew",
      "huggingface",
      "local-inference",
      "npm",
      "openclaw-pricing",
      "pypi",
    ]);
  });

  // Custom presets loaded via `policy-add --from-file` / `--from-dir` are
  // recorded on the sandbox alongside built-in presets. They must survive a
  // non-interactive re-onboard the same way named built-ins do — even though
  // they do not appear in `policies.listPresets()`.
  it("non-interactive suggested re-onboard preserves custom presets", () => {
    const payload = runPolicyScenario({
      policyMode: "suggested",
      policyPresets: "",
      alreadyApplied: ["npm", "pypi", "huggingface", "brew", "brave", "my-internal-api"],
      selectionOptions: { provider: "openai" },
    });

    assert.ok(
      payload.chosen.includes("my-internal-api"),
      `expected chosen to preserve my-internal-api, got ${JSON.stringify(payload.chosen)}`,
    );
    assert.deepEqual(
      payload.removedCalls,
      ["brave"],
      `expected only stale built-in Brave to be removed, got ${JSON.stringify(payload.removedCalls)}`,
    );
  });

  it("non-interactive suggested re-onboard removes unsupported Brave preset", () => {
    const payload = runPolicyScenario({
      policyMode: "suggested",
      policyPresets: "",
      alreadyApplied: ["npm", "pypi", "huggingface", "brew", "brave", "my-internal-api"],
      selectionOptions: { provider: "openai", webSearchSupported: false },
    });

    assert.ok(
      !payload.chosen.includes("brave"),
      `expected chosen to drop brave, got ${JSON.stringify(payload.chosen)}`,
    );
    assert.ok(
      payload.chosen.includes("my-internal-api"),
      `expected chosen to preserve my-internal-api, got ${JSON.stringify(payload.chosen)}`,
    );
    assert.deepEqual(payload.removedCalls, ["brave"]);
    assert.deepEqual(payload.finalApplied.slice().sort(), [
      "brew",
      "huggingface",
      "my-internal-api",
      "npm",
      "openclaw-pricing",
      "pypi",
    ]);
  });

  it("resume selection removes unsupported Brave preset", () => {
    const payload = runPolicyScenario({
      policyMode: "suggested",
      policyPresets: "",
      alreadyApplied: ["npm", "brave"],
      selectionOptions: { selectedPresets: ["npm", "brave"], webSearchSupported: false },
    });

    assert.deepEqual(payload.chosen, ["npm"]);
    assert.deepEqual(payload.removedCalls, ["brave"]);
    assert.deepEqual(payload.finalApplied, ["npm"]);
  });

  it("resume selection preserves the Slack policy required by a recorded Slack channel", () => {
    const payload = runPolicyScenario({
      policyMode: "suggested",
      policyPresets: "",
      alreadyApplied: ["slack"],
      selectionOptions: { selectedPresets: ["npm", "pypi"], enabledChannels: ["slack"] },
    });

    assert.deepEqual(payload.chosen.slice().sort(), ["npm", "pypi", "slack"]);
    assert.deepEqual(
      payload.removedCalls,
      [],
      `Slack must remain targeted while the slack channel is enabled; got removals ${JSON.stringify(payload.removedCalls)}`,
    );
    assert.deepEqual(payload.finalApplied.slice().sort(), ["npm", "pypi", "slack"]);
  });

  it("custom non-interactive selection preserves the Slack policy required by Slack messaging", () => {
    const payload = runPolicyScenario({
      policyMode: "custom",
      policyPresets: "npm,pypi",
      alreadyApplied: ["slack"],
      selectionOptions: { enabledChannels: ["slack"] },
    });

    assert.deepEqual(payload.chosen.slice().sort(), ["npm", "pypi", "slack"]);
    assert.deepEqual(
      payload.removedCalls,
      [],
      `Slack must not be removed while Slack messaging is enabled; got removals ${JSON.stringify(payload.removedCalls)}`,
    );
    assert.deepEqual(payload.finalApplied.slice().sort(), ["npm", "pypi", "slack"]);
  });

  // Regression for #5967: Discord (and every messaging channel other than
  // Slack) is not flagged `requiredAtCreate`, so its policy preset is never
  // injected into the create-time boot policy. The policy finalization step
  // must still merge the enabled channel's preset into the effective selection
  // so it is applied to the gateway and persisted to the registry — otherwise
  // `policy-list` shows `○ discord` even though Discord was configured during
  // onboard. The Slack tests above pass purely because Slack happens to be
  // requiredAtCreate; these tests guard the channels that are not.
  it("resume selection applies the Discord policy required by a configured Discord channel (#5967)", () => {
    const payload = runPolicyScenario({
      policyMode: "suggested",
      policyPresets: "",
      // Discord is not injected at create time, so it is absent from the
      // already-applied boot presets — unlike Slack.
      alreadyApplied: [],
      selectionOptions: { selectedPresets: ["npm", "pypi"], enabledChannels: ["discord"] },
    });

    assert.deepEqual(payload.chosen.slice().sort(), ["discord", "npm", "pypi"]);
    assert.ok(
      payload.appliedCalls.includes("discord"),
      `Discord must be applied to the gateway when the channel is enabled; got applied ${JSON.stringify(payload.appliedCalls)}`,
    );
    assert.deepEqual(payload.finalApplied.slice().sort(), ["discord", "npm", "pypi"]);
  });

  it("custom non-interactive selection applies the Discord policy required by Discord messaging (#5967)", () => {
    const payload = runPolicyScenario({
      policyMode: "custom",
      policyPresets: "npm,pypi",
      alreadyApplied: [],
      selectionOptions: { enabledChannels: ["discord"] },
    });

    assert.deepEqual(payload.chosen.slice().sort(), ["discord", "npm", "pypi"]);
    assert.ok(
      payload.appliedCalls.includes("discord"),
      `Discord must be applied while Discord messaging is enabled; got applied ${JSON.stringify(payload.appliedCalls)}`,
    );
    assert.deepEqual(payload.finalApplied.slice().sort(), ["discord", "npm", "pypi"]);
  });

  it("custom non-interactive selection removes disabled Discord while honoring the explicit preset list (#5967)", () => {
    const payload = runPolicyScenario({
      policyMode: "custom",
      policyPresets: "npm",
      alreadyApplied: ["npm", "pypi", "discord"],
      selectionOptions: { disabledChannels: ["discord"] },
    });

    assert.deepEqual(payload.chosen, ["npm"]);
    assert.deepEqual(payload.removedCalls.slice().sort(), ["discord", "pypi"]);
    assert.deepEqual(payload.finalApplied, ["npm"]);
  });

  // The #5967 fix is channel-agnostic — it iterates the channel→preset registry
  // rather than special-casing Slack/Discord. Telegram is another channel that is
  // not `requiredAtCreate`, so its egress preset is never injected at create time;
  // exercising it end-to-end through the real `setupPoliciesWithSelection` path
  // guards the security-critical egress-policy application for a second, distinct
  // non-required channel (not just Discord).
  it("resume selection applies the Telegram policy required by a configured Telegram channel (#5967)", () => {
    const payload = runPolicyScenario({
      policyMode: "suggested",
      policyPresets: "",
      alreadyApplied: [],
      selectionOptions: { selectedPresets: ["npm", "pypi"], enabledChannels: ["telegram"] },
    });

    assert.deepEqual(payload.chosen.slice().sort(), ["npm", "pypi", "telegram"]);
    assert.ok(
      payload.appliedCalls.includes("telegram"),
      `Telegram must be applied to the gateway when the channel is enabled; got applied ${JSON.stringify(payload.appliedCalls)}`,
    );
    assert.deepEqual(payload.finalApplied.slice().sort(), ["npm", "pypi", "telegram"]);
  });

  it("custom non-interactive selection removes disabled Telegram while honoring the explicit preset list (#5967)", () => {
    const payload = runPolicyScenario({
      policyMode: "custom",
      policyPresets: "npm",
      alreadyApplied: ["npm", "pypi", "telegram"],
      selectionOptions: { disabledChannels: ["telegram"] },
    });

    assert.deepEqual(payload.chosen, ["npm"]);
    assert.deepEqual(payload.removedCalls.slice().sort(), ["pypi", "telegram"]);
    assert.deepEqual(payload.finalApplied, ["npm"]);
  });

  // Cover the remaining non-`requiredAtCreate` channels end-to-end through the
  // real `setupPoliciesWithSelection` path. They flow through the same
  // channel→preset registry iteration as Discord/Telegram, so each apply/remove
  // case guards the egress-policy application for every shipped channel — not
  // only the two already covered above (#5967).
  for (const channel of ["teams", "whatsapp", "wechat"]) {
    it(`resume selection applies the ${channel} policy required by a configured ${channel} channel (#5967)`, () => {
      const payload = runPolicyScenario({
        policyMode: "suggested",
        policyPresets: "",
        alreadyApplied: [],
        selectionOptions: { selectedPresets: ["npm", "pypi"], enabledChannels: [channel] },
      });

      assert.deepEqual(payload.chosen.slice().sort(), ["npm", "pypi", channel].sort());
      assert.ok(
        payload.appliedCalls.includes(channel),
        `${channel} must be applied to the gateway when the channel is enabled; got applied ${JSON.stringify(payload.appliedCalls)}`,
      );
      assert.deepEqual(payload.finalApplied.slice().sort(), ["npm", "pypi", channel].sort());
    });

    it(`custom non-interactive selection removes disabled ${channel} while honoring the explicit preset list (#5967)`, () => {
      const payload = runPolicyScenario({
        policyMode: "custom",
        policyPresets: "npm",
        alreadyApplied: ["npm", "pypi", channel],
        selectionOptions: { disabledChannels: [channel] },
      });

      assert.deepEqual(payload.chosen, ["npm"]);
      assert.deepEqual(payload.removedCalls.slice().sort(), ["pypi", channel].sort());
      assert.deepEqual(payload.finalApplied, ["npm"]);
    });
  }

  it("custom non-interactive selection removes disabled Slack while honoring the explicit preset list", () => {
    const payload = runPolicyScenario({
      policyMode: "custom",
      policyPresets: "npm",
      alreadyApplied: ["npm", "pypi", "slack"],
      selectionOptions: { disabledChannels: ["slack"] },
    });

    assert.deepEqual(payload.chosen, ["npm"]);
    assert.deepEqual(payload.removedCalls.slice().sort(), ["pypi", "slack"]);
    assert.deepEqual(payload.finalApplied, ["npm"]);
  });

  it("suggested non-interactive selection removes disabled Slack from tier defaults", () => {
    const payload = runPolicyScenario({
      tierEnv: "open",
      policyMode: "suggested",
      policyPresets: "",
      alreadyApplied: ["slack"],
      selectionOptions: { disabledChannels: ["slack"] },
    });

    assert.ok(
      !payload.chosen.includes("slack"),
      `expected chosen to drop disabled Slack, got ${JSON.stringify(payload.chosen)}`,
    );
    assert.deepEqual(payload.removedCalls, ["slack"]);
    assert.ok(
      !payload.finalApplied.includes("slack"),
      `final applied presets should not include Slack, got ${JSON.stringify(payload.finalApplied)}`,
    );
  });

  // Widening the selection (user re-enables a preset they'd previously dropped)
  // must apply the new one and not re-apply things that are already applied.
  it("non-interactive widen selection applies only new presets", () => {
    const payload = runPolicyScenario({
      policyMode: "custom",
      policyPresets: "npm,pypi",
      alreadyApplied: ["npm"],
    });

    assert.deepEqual(payload.chosen.sort(), ["npm", "pypi"]);
    // Only pypi should be newly applied (npm was already there).
    assert.deepEqual(payload.appliedCalls, ["pypi"]);
    assert.deepEqual(payload.removedCalls, []);
    assert.deepEqual(payload.finalApplied.sort(), ["npm", "pypi"]);
  });
});
