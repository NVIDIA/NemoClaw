// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for #2177 — when a user re-runs `nemoclaw onboard` on an
// existing sandbox and narrows the preset selection (e.g. Balanced default
// of [npm, pypi, huggingface, brew, brave] down to just [npm]), the policy
// setup step must honor the final selection: apply new presets AND remove
// previously-applied ones that are no longer selected.

import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";

import { parsePolicyPresetEnv } from "../src/lib/core/url-utils";
import {
  type SetupPolicySelectionDeps,
  type SetupPolicySelectionOptions,
  setupPoliciesWithSelection,
} from "../src/lib/onboard/policy-selection";
import * as policy from "../src/lib/policy";
import * as tiers from "../src/lib/policy/tiers";

vi.mock("../src/lib/onboard/policy-context-seed", () => ({
  seedInitialPolicyContext: vi.fn(),
}));

const builtInPresets = policy.listPresets();
const builtInPresetNames = new Set(builtInPresets.map((preset) => preset.name));

type PolicyScenarioOptions = {
  tierEnv?: string;
  policyMode?: string;
  policyPresets?: string;
  alreadyApplied?: string[];
  selectionOptions?: SetupPolicySelectionOptions;
};

type PolicyScenarioResult = {
  chosen: string[];
  appliedCalls: string[];
  removedCalls: string[];
  finalApplied: string[];
};

/**
 * Exercise the typed policy-selection seam with in-memory policy state. The
 * production selection, tier, support, clamping, and channel-merging logic stays
 * real; only sandbox readiness and gateway mutation are replaced with fakes.
 */
async function runPolicyScenario({
  tierEnv,
  policyMode,
  policyPresets,
  alreadyApplied,
  selectionOptions = {},
}: PolicyScenarioOptions = {}): Promise<PolicyScenarioResult> {
  const effectiveTier = tierEnv ?? "balanced";
  const effectiveApplied = alreadyApplied ?? ["npm", "pypi", "huggingface", "brew", "brave"];
  const customPresets = effectiveApplied
    .filter((name) => !builtInPresetNames.has(name))
    .map((name) => ({ name }));
  const appliedCalls: string[] = [];
  const removedCalls: string[] = [];
  let appliedState = [...effectiveApplied];
  const env: NodeJS.ProcessEnv = {
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_POLICY_TIER: effectiveTier,
    NEMOCLAW_POLICY_MODE: policyMode ?? "custom",
    NEMOCLAW_POLICY_PRESETS: policyPresets ?? "npm",
  };

  const deps: SetupPolicySelectionDeps = {
    policies: {
      setupPolicyPresetSupported: policy.setupPolicyPresetSupported,
      listSetupPolicyPresets: (_sandboxName, options = {}) => [
        ...policy.filterSetupPolicyPresets(builtInPresets, options),
        ...customPresets,
      ],
      listCustomPresets: () => customPresets,
      getAppliedPresets: () => [...appliedState],
      clampSetupPolicyPresetNames: policy.clampSetupPolicyPresetNames,
    },
    tiers,
    localInferenceProviders: ["ollama-local", "vllm-local"],
    step: () => undefined,
    note: () => undefined,
    isNonInteractive: () => true,
    waitForSandboxReady: () => true,
    syncPresetSelection: (_sandboxName, current, selected) => {
      const currentSet = new Set(current);
      const selectedSet = new Set(selected);
      removedCalls.push(...current.filter((name) => !selectedSet.has(name)));
      appliedCalls.push(...selected.filter((name) => !currentSet.has(name)));
      appliedState = [...selected];
    },
    selectPolicyTier: async () => effectiveTier,
    selectTierPresetsAndAccess: async () => {
      throw new Error("unexpected interactive policy selection");
    },
    parsePolicyPresetEnv,
    env,
  };

  const chosen = await setupPoliciesWithSelection(deps, "test-sb", selectionOptions);
  return { chosen, appliedCalls, removedCalls, finalApplied: appliedState };
}

describe("setupPoliciesWithSelection preset diff (#2177)", () => {
  // In non-interactive mode a user who runs onboard twice — first with Balanced
  // defaults (applies 5 presets), second with NEMOCLAW_POLICY_PRESETS=npm —
  // expects the final sandbox to have ONLY npm. Previously-applied presets
  // must be removed.
  it("non-interactive narrow selection removes previously-applied presets", async () => {
    const payload = await runPolicyScenario({ policyMode: "custom", policyPresets: "npm" });

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
  it("non-interactive suggested re-onboard preserves user-added presets", async () => {
    const payload = await runPolicyScenario({
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
  it("non-interactive suggested re-onboard preserves custom presets", async () => {
    const payload = await runPolicyScenario({
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

  it("non-interactive suggested re-onboard removes unsupported Brave preset", async () => {
    const payload = await runPolicyScenario({
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

  it("resume selection removes unsupported Brave preset", async () => {
    const payload = await runPolicyScenario({
      policyMode: "suggested",
      policyPresets: "",
      alreadyApplied: ["npm", "brave"],
      selectionOptions: { selectedPresets: ["npm", "brave"], webSearchSupported: false },
    });

    assert.deepEqual(payload.chosen, ["npm"]);
    assert.deepEqual(payload.removedCalls, ["brave"]);
    assert.deepEqual(payload.finalApplied, ["npm"]);
  });

  it("resume selection preserves the Slack policy required by a recorded Slack channel", async () => {
    const payload = await runPolicyScenario({
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

  it("custom non-interactive selection preserves the Slack policy required by Slack messaging", async () => {
    const payload = await runPolicyScenario({
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
  it("resume selection applies the Discord policy required by a configured Discord channel (#5967)", async () => {
    const payload = await runPolicyScenario({
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

  it("custom non-interactive selection applies the Discord policy required by Discord messaging (#5967)", async () => {
    const payload = await runPolicyScenario({
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

  it("custom non-interactive selection removes disabled Discord while honoring the explicit preset list (#5967)", async () => {
    const payload = await runPolicyScenario({
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
  it("resume selection applies the Telegram policy required by a configured Telegram channel (#5967)", async () => {
    const payload = await runPolicyScenario({
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

  it("custom non-interactive selection removes disabled Telegram while honoring the explicit preset list (#5967)", async () => {
    const payload = await runPolicyScenario({
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
    it(`resume selection applies the ${channel} policy required by a configured ${channel} channel (#5967)`, async () => {
      const payload = await runPolicyScenario({
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

    it(`custom non-interactive selection removes disabled ${channel} while honoring the explicit preset list (#5967)`, async () => {
      const payload = await runPolicyScenario({
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

  it("custom non-interactive selection removes disabled Slack while honoring the explicit preset list", async () => {
    const payload = await runPolicyScenario({
      policyMode: "custom",
      policyPresets: "npm",
      alreadyApplied: ["npm", "pypi", "slack"],
      selectionOptions: { disabledChannels: ["slack"] },
    });

    assert.deepEqual(payload.chosen, ["npm"]);
    assert.deepEqual(payload.removedCalls.slice().sort(), ["pypi", "slack"]);
    assert.deepEqual(payload.finalApplied, ["npm"]);
  });

  it("suggested non-interactive selection removes disabled Slack from tier defaults", async () => {
    const payload = await runPolicyScenario({
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
  it("non-interactive widen selection applies only new presets", async () => {
    const payload = await runPolicyScenario({
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
