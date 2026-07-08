// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Policy-tier behavior is exercised directly through the typed selection
// seams. Only the two adapter contracts whose behavior includes real process
// exit ordering remain isolated in child processes.

import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, type MockInstance, vi } from "vitest";

import { parsePolicyPresetEnv } from "../src/lib/core/url-utils";
import {
  type SetupPolicySelectionDeps,
  type SetupPolicySelectionOptions,
  setupPoliciesWithSelection,
} from "../src/lib/onboard/policy-selection";
import {
  createPolicySelectionPromptHelpers,
  type PolicySelectionPromptDeps,
} from "../src/lib/onboard/policy-selection-prompts";
import { resolvePolicyTierFromEnv } from "../src/lib/onboard/policy-tier-env";
import * as policy from "../src/lib/policy";
import * as tiers from "../src/lib/policy/tiers";

vi.mock("../src/lib/onboard/policy-context-seed", () => ({
  seedInitialPolicyContext: vi.fn(),
}));

const repoRoot = path.join(import.meta.dirname, "..");

function runAdapterScript(
  scriptBody: string,
  envOverrides: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tier-onboard-"));
  const scriptPath = path.join(tmpDir, "script.js");
  fs.writeFileSync(scriptPath, scriptBody);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tmpDir,
    NEMOCLAW_NON_INTERACTIVE: "1",
    ...envOverrides,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
    timeout: 15000,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

function createPromptHarness({
  notes = [],
  nonInteractive = true,
}: {
  notes?: string[];
  nonInteractive?: boolean;
} = {}) {
  const deps: PolicySelectionPromptDeps = {
    tiers,
    policyTierEnv: { resolvePolicyTierFromEnv },
    isNonInteractive: () => nonInteractive,
    note: (message) => notes.push(message),
    prompt: async (question) => {
      throw new Error(`unexpected prompt: ${question}`);
    },
    selectFromNumberedMenuOrExit: (_rawChoice, defaultIdx, options) => {
      const selected = options[defaultIdx - 1];
      assert.ok(selected !== undefined, "numbered menu default is out of range");
      return selected;
    },
    makeOnboardCancelExit: (_rollback, cleanup) => () => cleanup(),
    sandboxCancelRollback: { markCancelled: () => undefined },
    useColor: false,
  };
  return { helpers: createPolicySelectionPromptHelpers(deps), notes };
}

type TestPreset = { name: string; description?: string; access?: string };

type SetupHarnessOptions = {
  tierName?: string;
  policyMode?: string;
  policyPresets?: string;
  currentApplied?: string[];
  customPresets?: TestPreset[];
  customOwnsObservability?: boolean;
  recordedPolicyTier?: string | null;
  env?: NodeJS.ProcessEnv;
};

function createSetupHarness({
  tierName = "balanced",
  policyMode = "suggested",
  policyPresets = "",
  currentApplied = [],
  customPresets = [],
  customOwnsObservability = false,
  recordedPolicyTier = null,
  env = {},
}: SetupHarnessOptions = {}) {
  const notes: string[] = [];
  const syncCalls: Array<{
    sandboxName: string;
    current: string[];
    selected: string[];
    accessByName?: Record<string, string>;
  }> = [];
  const appliedCalls: string[] = [];
  const removedCalls: string[] = [];
  const tierUpdates: Array<{ sandboxName: string; policyTier: string }> = [];
  const removedBuiltinAttributions: string[] = [];

  const deps: SetupPolicySelectionDeps = {
    policies: {
      setupPolicyPresetSupported: policy.setupPolicyPresetSupported,
      listSetupPolicyPresets: (_sandboxName, options = {}) => [
        ...policy.filterSetupPolicyPresets(
          policy.listPresets({ agent: options.agent ?? null }),
          options,
        ),
        ...customPresets,
      ],
      listCustomPresets: () => customPresets,
      customPresetOwnsNetworkPolicyKey: () => customOwnsObservability,
      removeBuiltinPresetAttribution: (_sandboxName, presetName) => {
        removedBuiltinAttributions.push(presetName);
      },
      getAppliedPresets: () => [...currentApplied],
      clampSetupPolicyPresetNames: policy.clampSetupPolicyPresetNames,
    },
    tiers,
    localInferenceProviders: ["ollama-local", "vllm-local"],
    step: () => undefined,
    note: (message) => notes.push(message),
    isNonInteractive: () => true,
    waitForSandboxReady: () => true,
    syncPresetSelection: (sandboxName, current, selected, accessByName) => {
      syncCalls.push({
        sandboxName,
        current: [...current],
        selected: [...selected],
        ...(accessByName ? { accessByName: { ...accessByName } } : {}),
      });
      const selectedSet = new Set(selected);
      const currentSet = new Set(current);
      removedCalls.push(...current.filter((name) => !selectedSet.has(name)));
      appliedCalls.push(...selected.filter((name) => !currentSet.has(name)));
    },
    selectPolicyTier: async () => tierName,
    setPolicyTier: (sandboxName, policyTier) => {
      tierUpdates.push({ sandboxName, policyTier });
    },
    getRecordedPolicyTier: () => recordedPolicyTier,
    selectTierPresetsAndAccess: async (selectedTier, presets, extraSelected) => {
      const promptHarness = createPromptHarness();
      return promptHarness.helpers.selectTierPresetsAndAccess(selectedTier, presets, extraSelected);
    },
    parsePolicyPresetEnv,
    env: {
      NEMOCLAW_POLICY_MODE: policyMode,
      NEMOCLAW_POLICY_PRESETS: policyPresets,
      ...env,
    },
  };

  return {
    appliedCalls,
    deps,
    notes,
    removedBuiltinAttributions,
    removedCalls,
    syncCalls,
    tierUpdates,
  };
}

async function runPolicySetup(
  harnessOptions: SetupHarnessOptions = {},
  selectionOptions: SetupPolicySelectionOptions = {},
) {
  const harness = createSetupHarness(harnessOptions);
  const applied = await setupPoliciesWithSelection(harness.deps, "test-sb", selectionOptions);
  return { ...harness, applied };
}

function warningText(spy: MockInstance): string {
  return spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("policy tier onboarding adapter contracts", () => {
  it("rejects unknown NEMOCLAW_POLICY_TIER before usage notice or preflight (#3741)", () => {
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
process.env.NEMOCLAW_NON_INTERACTIVE = "1";
process.env.NEMOCLAW_POLICY_TIER = "invalid_tier";
const { onboard } = require(${onboardPath});
const exitMarker = "__NEMOCLAW_TEST_PROCESS_EXIT__";
process.exit = (code = 0) => {
  const err = new Error(exitMarker);
  err.code = Number(code);
  throw err;
};
(async () => {
  try {
    await onboard({
      nonInteractive: true,
      acceptThirdPartySoftware: true,
      sandboxName: "tier-test",
    });
    process.stdout.write("UNEXPECTED_SUCCESS\n");
    process.exitCode = 0;
  } catch (err) {
    if (!err || err.message !== exitMarker) {
      process.stderr.write((err && err.stack) || String(err));
      process.exitCode = 99;
      return;
    }
    const stateDir = path.join(process.env.HOME, ".nemoclaw");
    process.stdout.write(JSON.stringify({
      exitCode: err.code,
      usageNoticeExists: fs.existsSync(path.join(stateDir, "usage-notice.json")),
      lockExists: fs.existsSync(path.join(stateDir, "onboard.lock")),
      sessionExists: fs.existsSync(path.join(stateDir, "onboard-session.json")),
    }) + "\n");
    process.exitCode = err.code;
  }
})();
`;
    const result = runAdapterScript(script);
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split(/\n/).at(-1) || "{}");
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.usageNoticeExists, false, "usage notice must not be accepted/written");
    assert.equal(payload.lockExists, false, "onboard lock must not be created");
    assert.equal(payload.sessionExists, false, "onboard session must not be created");
    assert.match(
      result.stderr,
      /Unknown policy tier: invalid_tier\. Valid: restricted, balanced, open/,
    );
    assert.doesNotMatch(result.stderr, /Third-Party Software Notice/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\[1\/8\] Preflight checks/);
    assert.ok(!result.stdout.includes("UNEXPECTED_SUCCESS"));
  });

  it("ignores invalid NEMOCLAW_POLICY_TIER during interactive onboarding", () => {
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const script = String.raw`
process.env.NEMOCLAW_POLICY_TIER = "invalid_tier";
delete process.env.NEMOCLAW_NON_INTERACTIVE;
const { onboard } = require(${onboardPath});
const exitMarker = "__NEMOCLAW_TEST_PROCESS_EXIT__";
process.exit = (code = 0) => {
  const err = new Error(exitMarker);
  err.code = Number(code);
  throw err;
};
(async () => {
  try {
    await onboard({
      acceptThirdPartySoftware: true,
      sandboxName: "tier-test",
    });
    process.stdout.write("UNEXPECTED_SUCCESS\n");
    process.exitCode = 0;
  } catch (err) {
    if (!err || err.message !== exitMarker) {
      process.stderr.write((err && err.stack) || String(err));
      process.exitCode = 99;
      return;
    }
    process.stdout.write(JSON.stringify({ exitCode: err.code }) + "\n");
    process.exitCode = err.code;
  }
})();
`;
    const result = runAdapterScript(script, { NEMOCLAW_NON_INTERACTIVE: undefined });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr, /Unknown policy tier: invalid_tier/);
    assert.match(result.stderr, /Interactive onboarding requires a TTY/);
    assert.ok(!result.stdout.includes("UNEXPECTED_SUCCESS"));
  });

  it("persists the selected tier through the onboard registry adapter", () => {
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const policyPath = JSON.stringify(path.join(repoRoot, "src", "lib", "policy", "index.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const refreshPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "actions", "sandbox", "policy-context-refresh.ts"),
    );
    const script = String.raw`
const registry = require(${registryPath});
const updates = [];
registry.getSandbox = () => ({ name: "test-sb", model: null, provider: null });
registry.updateSandbox = (_name, fields) => { updates.push(fields); return true; };

process.env.NEMOCLAW_NON_INTERACTIVE = "1";
process.env.NEMOCLAW_POLICY_TIER = "open";
process.env.NEMOCLAW_POLICY_MODE = "skip";
process.env.NEMOCLAW_POLICY_PRESETS = "";

const { setupPoliciesWithSelection } = require(${onboardPath});
const policies = require(${policyPath});
policies.getAppliedPresets = () => [];
require(${refreshPath}).refreshSandboxPolicyContextFile = () => ({ status: "ok" });
console.log = () => {};

(async () => {
  try {
    const applied = await setupPoliciesWithSelection("test-sb", {});
    process.stdout.write(JSON.stringify({ applied, updates }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message, stack: err.stack, updates }) + "\n");
  }
})();
`;
    const result = runAdapterScript(script);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split(/\n/).at(-1) || "{}");
    assert.ok(!payload.error, `unexpected error: ${payload.error}`);
    assert.deepEqual(payload.applied, []);
    assert.equal(
      payload.updates.find((update: { policyTier?: string }) => update.policyTier !== undefined)
        ?.policyTier,
      "open",
    );
  });
});

describe("policy tier selection", () => {
  it("returns the selected tier name in non-interactive mode", async () => {
    vi.stubEnv("NEMOCLAW_POLICY_TIER", "balanced");
    const { helpers } = createPromptHarness();

    assert.equal(await helpers.selectPolicyTier(), "balanced");
  });

  it("rejects unknown NEMOCLAW_POLICY_TIER with a clear error and exit code 1 (#3741)", () => {
    vi.stubEnv("NEMOCLAW_POLICY_TIER", "invalid_tier");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)})`);
    }) as never);

    assert.throws(() => resolvePolicyTierFromEnv(), /process\.exit\(1\)/);
    assert.equal(exit.mock.calls[0]?.[0], 1);
    assert.match(
      errors.join("\n"),
      /Unknown policy tier: invalid_tier\. Valid: restricted, balanced, open/,
    );
  });

  it("treats whitespace-only NEMOCLAW_POLICY_TIER as the balanced default", async () => {
    vi.stubEnv("NEMOCLAW_POLICY_TIER", "   ");
    const { helpers } = createPromptHarness();

    assert.equal(await helpers.selectPolicyTier(), "balanced");
  });

  it("restricted tier produces an empty preset list", () => {
    assert.deepEqual(tiers.resolveTierPresets("restricted"), []);
  });

  it("balanced tier resolves exactly the five dev presets read-write without weather", () => {
    const presets = tiers.resolveTierPresets("balanced");
    const names = presets.map((preset) => preset.name);
    assert.deepEqual(
      [...names].sort(),
      ["brave", "brew", "huggingface", "npm", "pypi"],
      "balanced tier must resolve exactly brave, brew, huggingface, npm, pypi",
    );
    const accessByName = new Map(presets.map((preset) => [preset.name, preset.access]));
    for (const name of ["npm", "pypi", "huggingface", "brew", "brave"]) {
      assert.equal(accessByName.get(name), "read-write", `${name} should be read-write`);
    }
  });

  it("open tier resolves presets including at least one social or messaging preset", () => {
    const names = tiers.resolveTierPresets("open").map((preset) => preset.name);
    const social = ["slack", "discord", "telegram", "whatsapp"];
    assert.ok(
      social.some((name) => names.includes(name)),
      `open tier must include at least one social preset, got: ${names.join(", ")}`,
    );
  });

  it("allows a preset to be deselected through the selected option", () => {
    const withoutNpm = tiers
      .resolveTierPresets("balanced")
      .filter((preset) => preset.name !== "npm")
      .map((preset) => preset.name);
    const resolved = tiers.resolveTierPresets("balanced", { selected: withoutNpm });

    assert.ok(!resolved.map((preset) => preset.name).includes("npm"), "npm should be deselected");
  });

  it("allows access to be restricted from read-write to read through an override", () => {
    const resolved = tiers.resolveTierPresets("balanced", { overrides: { npm: "read" } });
    assert.equal(resolved.find((preset) => preset.name === "npm")?.access, "read");
    assert.equal(resolved.find((preset) => preset.name === "pypi")?.access, "read-write");
  });

  it("emits a note containing the selected tier name", async () => {
    vi.stubEnv("NEMOCLAW_POLICY_TIER", "balanced");
    const { helpers, notes } = createPromptHarness();

    const selected = await helpers.selectPolicyTier();

    assert.equal(selected, "balanced");
    assert.ok(
      notes.some((line) => line.includes("balanced")),
      `summary must mention balanced tier, got: ${JSON.stringify(notes)}`,
    );
  });
});

describe("policy tier setup", () => {
  it("persists the selected tier through setPolicyTier", async () => {
    const result = await runPolicySetup({ tierName: "open", policyMode: "skip" });

    assert.deepEqual(result.tierUpdates, [{ sandboxName: "test-sb", policyTier: "open" }]);
    assert.deepEqual(result.applied, []);
  });

  it("omits Brave from policy preset selection when web search is unsupported", async () => {
    const result = await runPolicySetup({ tierName: "balanced" }, { webSearchSupported: false });

    assert.ok(!result.applied.includes("brave"));
    assert.ok(!result.appliedCalls.includes("brave"));
    assert.ok(result.applied.includes("pypi"), "normal dev presets should still be included");
  });

  it("removes a previously-applied Brave preset when web search is unsupported", async () => {
    const result = await runPolicySetup(
      { tierName: "balanced", currentApplied: ["brave", "npm"] },
      { webSearchSupported: false },
    );

    assert.ok(!result.applied.includes("brave"));
    assert.ok(result.removedCalls.includes("brave"));
    assert.ok(!result.appliedCalls.includes("brave"));
  });

  it("removes a previously-applied built-in Brave preset when Brave search is declined", async () => {
    const result = await runPolicySetup(
      { tierName: "balanced", currentApplied: ["brave", "npm"] },
      { webSearchConfig: null, webSearchSupported: true },
    );

    assert.ok(!result.applied.includes("brave"));
    assert.ok(result.removedCalls.includes("brave"));
    assert.ok(!result.appliedCalls.includes("brave"));
  });

  it("keeps explicitly requested built-in Brave when web search is supported", async () => {
    const result = await runPolicySetup(
      {
        tierName: "balanced",
        policyMode: "custom",
        policyPresets: "brave,npm",
      },
      { webSearchConfig: null, webSearchSupported: true },
    );

    assert.deepEqual(result.applied, ["brave", "npm"]);
    assert.deepEqual(result.appliedCalls, ["brave", "npm"]);
  });

  it("clamps resumed policy presets to web-search-supported presets", async () => {
    const result = await runPolicySetup(
      {
        tierName: "balanced",
        currentApplied: ["brave"],
      },
      { webSearchSupported: false, selectedPresets: ["brave", "npm"] },
    );

    assert.deepEqual(result.applied, ["npm"]);
    assert.deepEqual(result.appliedCalls, ["npm"]);
    assert.deepEqual(result.removedCalls, ["brave"]);
  });

  it("clamps an unsupported-only resumed policy preset list to empty", async () => {
    const result = await runPolicySetup(
      {
        tierName: "balanced",
        currentApplied: ["brave"],
      },
      { webSearchSupported: false, selectedPresets: ["brave"] },
    );

    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.appliedCalls, []);
    assert.deepEqual(result.removedCalls, ["brave"]);
  });

  it("removes OpenClaw-only policy presets when resuming Hermes policy selection", async () => {
    const result = await runPolicySetup(
      { currentApplied: ["openclaw-pricing"] },
      {
        agent: "hermes",
        selectedPresets: ["openclaw-pricing", "weather", "nous-web"],
      },
    );

    assert.deepEqual(result.applied, ["weather", "nous-web"]);
    assert.deepEqual(result.appliedCalls, ["weather", "nous-web"]);
    assert.deepEqual(result.removedCalls, ["openclaw-pricing"]);
  });

  it("removes Hermes Nous policy presets when resuming OpenClaw policy selection", async () => {
    const result = await runPolicySetup(
      { currentApplied: ["nous-web"] },
      {
        agent: "openclaw",
        selectedPresets: ["nous-web", "weather", "openclaw-pricing"],
      },
    );

    assert.deepEqual(result.applied, ["weather", "openclaw-pricing"]);
    assert.deepEqual(result.appliedCalls, ["weather", "openclaw-pricing"]);
    assert.deepEqual(result.removedCalls, ["nous-web"]);
  });

  it("preserves a resumed custom preset whose name matches an unsupported built-in", async () => {
    const result = await runPolicySetup(
      {
        currentApplied: ["brave"],
        customPresets: [{ name: "brave", description: "custom preset" }],
      },
      { webSearchSupported: false, selectedPresets: ["brave", "npm"] },
    );

    assert.deepEqual(result.applied, ["brave", "npm"]);
    assert.deepEqual(result.appliedCalls, ["npm"]);
    assert.deepEqual(result.removedCalls, []);
  });

  it("preserves a non-interactive custom preset whose name matches an unsupported built-in", async () => {
    const result = await runPolicySetup(
      {
        currentApplied: ["brave"],
        customPresets: [{ name: "brave", description: "custom preset" }],
      },
      { webSearchSupported: false },
    );

    assert.ok(result.applied.includes("brave"));
    assert.ok(!result.appliedCalls.includes("brave"));
    assert.deepEqual(result.removedCalls, []);
  });

  it("treats exact custom OTLP ownership as attribution-only during non-interactive re-onboard", async () => {
    const result = await runPolicySetup(
      {
        currentApplied: ["observability-otlp-local", "corp-otel"],
        customPresets: [{ name: "corp-otel", description: "custom preset" }],
        customOwnsObservability: true,
      },
      { agent: "langchain-deepagents-code", observabilityEnabled: true },
    );

    assert.ok(result.applied.includes("corp-otel"));
    assert.ok(!result.applied.includes("observability-otlp-local"));
    assert.ok(!result.removedCalls.includes("observability-otlp-local"));
    assert.deepEqual(result.removedBuiltinAttributions, ["observability-otlp-local"]);
  });

  it("keeps exact custom OTLP ownership during selected resume without live built-in removal", async () => {
    const result = await runPolicySetup(
      {
        currentApplied: ["observability-otlp-local", "corp-otel"],
        customPresets: [{ name: "corp-otel", description: "custom preset" }],
        customOwnsObservability: true,
      },
      {
        agent: "langchain-deepagents-code",
        observabilityEnabled: true,
        selectedPresets: ["observability-otlp-local", "corp-otel"],
      },
    );

    assert.deepEqual(result.applied, ["corp-otel"]);
    assert.deepEqual(result.removedCalls, []);
    assert.deepEqual(result.removedBuiltinAttributions, ["observability-otlp-local"]);
  });

  it("does not let stale declared custom OTLP content suppress the required built-in", async () => {
    const result = await runPolicySetup(
      {
        currentApplied: ["corp-otel"],
        customPresets: [{ name: "corp-otel", description: "custom preset" }],
        customOwnsObservability: false,
      },
      { agent: "langchain-deepagents-code", observabilityEnabled: true },
    );

    assert.ok(result.applied.includes("corp-otel"));
    assert.ok(result.applied.includes("observability-otlp-local"));
    assert.ok(result.appliedCalls.includes("observability-otlp-local"));
    assert.deepEqual(result.removedBuiltinAttributions, []);
  });

  it("falls back to tier suggestions when NEMOCLAW_POLICY_MODE is unknown (#2429)", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await runPolicySetup({ tierName: "balanced", policyMode: "restricted" });
    const text = warningText(warnings);

    assert.ok(result.applied.length > 0);
    assert.match(text, /Unsupported NEMOCLAW_POLICY_MODE: restricted/);
    assert.match(text, /NEMOCLAW_POLICY_TIER=restricted/);
    assert.match(text, /Falling back to suggested presets/);
  });

  it("omits the tier-name hint for a non-tier invalid policy mode (#2429)", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runPolicySetup({ tierName: "balanced", policyMode: "garbage" });
    const text = warningText(warnings);

    assert.match(text, /Unsupported NEMOCLAW_POLICY_MODE: garbage/);
    assert.doesNotMatch(text, /did you mean NEMOCLAW_POLICY_TIER/);
  });

  it("applies zero presets for restricted OpenClaw in non-interactive suggested mode", async () => {
    const result = await runPolicySetup({ tierName: "restricted" }, { agent: "openclaw" });

    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.appliedCalls, []);
  });

  it("does not re-add OpenClaw OTEL presets for the restricted tier", async () => {
    const result = await runPolicySetup(
      {
        tierName: "restricted",
        env: {
          NEMOCLAW_OPENCLAW_OTEL: "1",
          NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: undefined,
        },
      },
      { agent: "openclaw" },
    );

    for (const name of ["openclaw-pricing", "openclaw-diagnostics-otel-local"]) {
      assert.ok(!result.applied.includes(name));
      assert.ok(!result.appliedCalls.includes(name));
    }
  });

  it("reports the final restricted preset suppression in its note", async () => {
    const result = await runPolicySetup(
      {
        tierName: "restricted",
        env: {
          NEMOCLAW_OPENCLAW_OTEL: "1",
          NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: undefined,
        },
      },
      { agent: "openclaw" },
    );
    const noteLine = result.notes.find((line) =>
      line.includes("Restricted tier suppresses agent-required preset"),
    );

    assert.ok(noteLine, `suppression note must be printed, lines: ${JSON.stringify(result.notes)}`);
    for (const name of ["openclaw-pricing", "openclaw-diagnostics-otel-local"]) {
      assert.ok(noteLine.includes(name), `note must mention ${name}, got: ${noteLine}`);
      assert.ok(!result.applied.includes(name));
      assert.ok(!result.appliedCalls.includes(name));
    }
  });

  it("removes previously-applied OpenClaw pricing for the restricted tier", async () => {
    const result = await runPolicySetup(
      { tierName: "restricted", currentApplied: ["openclaw-pricing"] },
      { agent: "openclaw" },
    );

    assert.ok(!result.applied.includes("openclaw-pricing"));
    assert.ok(result.removedCalls.includes("openclaw-pricing"));
  });

  it("removes previously-applied OpenClaw OTEL diagnostics for the restricted tier", async () => {
    const result = await runPolicySetup(
      {
        tierName: "restricted",
        currentApplied: ["openclaw-diagnostics-otel-local", "openclaw-pricing"],
        env: {
          NEMOCLAW_OPENCLAW_OTEL: "1",
          NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: undefined,
        },
      },
      { agent: "openclaw" },
    );

    for (const name of ["openclaw-pricing", "openclaw-diagnostics-otel-local"]) {
      assert.ok(!result.applied.includes(name));
      assert.ok(result.removedCalls.includes(name));
    }
  });

  it("keeps an empty restricted resume target empty", async () => {
    const result = await runPolicySetup(
      { recordedPolicyTier: "restricted" },
      { agent: "openclaw", selectedPresets: [] },
    );

    assert.ok(!result.applied.includes("openclaw-pricing"));
    assert.ok(!result.appliedCalls.includes("openclaw-pricing"));
  });

  it("never applies DCode observability while an authoritative restricted rebuild tier is pending registration", async () => {
    const result = await runPolicySetup(
      { recordedPolicyTier: null },
      {
        agent: "langchain-deepagents-code",
        observabilityEnabled: true,
        selectedPresets: ["observability-otlp-local"],
        tierName: " Restricted ",
      },
    );

    assert.deepEqual(result.applied, []);
    assert.ok(!result.appliedCalls.includes("observability-otlp-local"));
    assert.deepEqual(result.syncCalls[0]?.selected, []);
  });

  it("removes previously-applied OpenClaw pricing during a restricted resume", async () => {
    const result = await runPolicySetup(
      { recordedPolicyTier: "restricted", currentApplied: ["openclaw-pricing"] },
      { agent: "openclaw", selectedPresets: [] },
    );

    assert.ok(!result.applied.includes("openclaw-pricing"));
    assert.ok(result.removedCalls.includes("openclaw-pricing"));
  });

  it("excludes OpenClaw OTEL diagnostics during a restricted resume", async () => {
    const result = await runPolicySetup(
      {
        recordedPolicyTier: "restricted",
        currentApplied: ["openclaw-diagnostics-otel-local"],
        env: {
          NEMOCLAW_OPENCLAW_OTEL: "1",
          NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: undefined,
        },
      },
      { agent: "openclaw", selectedPresets: [] },
    );

    assert.ok(!result.applied.includes("openclaw-diagnostics-otel-local"));
    assert.ok(result.removedCalls.includes("openclaw-diagnostics-otel-local"));
  });
});

describe("selectTierPresetsAndAccess", () => {
  async function resolve(
    tierName: string,
    extraSelected: string[] = [],
  ): Promise<Array<{ name: string; access: string }>> {
    const { helpers } = createPromptHarness();
    return helpers.selectTierPresetsAndAccess(tierName, policy.listPresets(), extraSelected);
  }

  it("returns tier presets with their default access levels", async () => {
    const resolved = await resolve("balanced");
    const names = resolved.map((preset) => preset.name);
    assert.ok(names.includes("npm"), "npm should be included");
    assert.ok(names.includes("brave"), "brave should be included");
    assert.ok(!names.includes("weather"), "weather should not be a balanced tier default");
    assert.ok(!names.includes("slack"), "slack should not be included in balanced");
    for (const preset of resolved) {
      assert.equal(preset.access, "read-write", `${preset.name} should default to read-write`);
    }
  });

  it("returns an empty array for the restricted tier", async () => {
    assert.deepEqual(await resolve("restricted"), []);
  });

  it("adds a non-tier preset to the initial checked set through extraSelected", async () => {
    const names = (await resolve("balanced", ["slack"])).map((preset) => preset.name);
    assert.ok(names.includes("slack"), "slack should be included via extraSelected");
    assert.ok(names.includes("npm"), "npm (tier default) should still be included");
  });

  it("silently filters an invalid extraSelected preset name", async () => {
    const names = (await resolve("balanced", ["nonexistent-preset"])).map((preset) => preset.name);
    assert.ok(!names.includes("nonexistent-preset"), "invalid preset should be dropped");
  });

  it("returns tier presets before non-tier presets", async () => {
    const names = (await resolve("balanced", ["slack"])).map((preset) => preset.name);
    const tierNames = ["npm", "pypi", "huggingface", "brew", "brave"];
    const lastTierIdx = Math.max(...tierNames.map((name) => names.indexOf(name)));
    const slackIdx = names.indexOf("slack");
    assert.ok(slackIdx > lastTierIdx, "non-tier preset (slack) should appear after tier presets");
  });

  it("returns name and access fields for every resolved preset", async () => {
    const resolved = await resolve("open");
    assert.ok(resolved.length > 0, "open tier should have presets");
    for (const preset of resolved) {
      assert.equal(typeof preset.name, "string");
      assert.ok(
        preset.access === "read" || preset.access === "read-write",
        `unexpected access: ${preset.access}`,
      );
    }
  });
});
