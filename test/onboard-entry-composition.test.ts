// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectOnboardEntryDecisions,
  evaluateOnboardEntryComposition,
  parseOnboardEntryCompositionBudget,
  type OnboardEntryCompositionBudget,
} from "../scripts/checks/onboard-entry-composition.mts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const EMPTY_BUDGET: OnboardEntryCompositionBudget = {
  gateway: {},
  messaging: {},
  policy: {},
  provider: {},
};

describe("onboarding entry composition boundary", () => {
  it("accepts the recorded onboarding decision allowances", () => {
    const actual = collectOnboardEntryDecisions(
      fs.readFileSync(path.join(REPO_ROOT, "src/lib/onboard.ts"), "utf8"),
    );
    const budget = parseOnboardEntryCompositionBudget(
      fs.readFileSync(path.join(REPO_ROOT, "ci/onboard-entry-composition-budget.json"), "utf8"),
    );

    expect(evaluateOnboardEntryComposition(actual, budget)).toEqual([]);
    expect(actual).toEqual({
      gateway: {},
      messaging: { createSandboxWithBaseImageResolution: 9, runOnboard: 1 },
      policy: {
        "createOnboardPolicyApplication.getRecordedPolicyTier": 1,
        createSandboxWithBaseImageResolution: 6,
        runOnboard: 5,
        "sandboxCreateIntentResolver.getAgentPolicyPath": 1,
      },
      provider: {
        createSandboxWithBaseImageResolution: 15,
        handleNimLocalSelection: 32,
        handleRemoteProviderSelection: 76,
        handleRoutedSelection: 15,
        "handleVllmSelection.queryVllmModels": 1,
        runOnboard: 8,
        selectAndValidateOllamaModel: 18,
      },
    });
  });

  it("rejects a gateway action selected by a neutral condition", () => {
    const actual = collectOnboardEntryDecisions(
      "function choose(enabled: boolean) { if (enabled) startGateway(); }",
    );

    expect(actual.gateway).toEqual({ choose: 1 });
  });

  it("rejects a gateway condition inside the onboarding entry function", () => {
    const actual = collectOnboardEntryDecisions(
      "function runOnboard() { if (gatewayState === 'stale') return; }",
    );

    expect(actual.gateway).toEqual({ runOnboard: 1 });
  });

  it("checks every function in one variable statement", () => {
    const actual = collectOnboardEntryDecisions(
      "const first = () => undefined, second = () => { if (enabled) startGateway(); };",
    );

    expect(actual.gateway).toEqual({ second: 1 });
  });

  it.each([
    [
      "object method",
      "const entry = { choose() { if (enabled) startGateway(); } };",
      "entry.choose",
    ],
    [
      "object function property",
      "const entry = { choose: () => { if (enabled) startGateway(); } };",
      "entry.choose",
    ],
    ["class method", "class Entry { choose() { if (enabled) startGateway(); } }", "Entry.choose"],
    [
      "class expression method",
      "const Entry = class { choose() { if (enabled) startGateway(); } };",
      "Entry.choose",
    ],
  ])("checks a gateway decision in a top-level %s", (_form, source, declaration) => {
    const actual = collectOnboardEntryDecisions(source);

    expect(actual.gateway).toEqual({ [declaration]: 1 });
  });

  it.each([
    [
      "class field function",
      "class Entry { choose = () => { if (enabled) startGateway(); }; }",
      "Entry.choose",
    ],
    [
      "factory callback",
      "const entry = createEntry(() => { if (enabled) startGateway(); });",
      "entry",
    ],
    [
      "default export callback",
      "export default () => { if (enabled) startGateway(); };",
      "defaultExport",
    ],
    ["module statement", "if (enabled) startGateway();", "<module>"],
  ])("checks a gateway decision in a top-level %s", (_form, source, declaration) => {
    const actual = collectOnboardEntryDecisions(source);

    expect(actual.gateway).toEqual({ [declaration]: 1 });
  });

  it.each([
    [
      "function default parameter",
      "function choose(value = enabled ? startGateway() : undefined) {}",
      "choose",
    ],
    [
      "arrow default parameter",
      "const choose = (value = enabled ? startGateway() : undefined) => value;",
      "choose",
    ],
    [
      "exported variable initializer",
      "export const choice = enabled ? startGateway() : stopGateway();",
      "choice",
    ],
    [
      "object property initializer",
      "const entry = { choice: enabled ? startGateway() : stopGateway() };",
      "entry",
    ],
    [
      "class field initializer",
      "class Entry { choice = enabled ? startGateway() : stopGateway(); }",
      "Entry",
    ],
    [
      "class static block",
      "class Entry { static { if (enabled) startGateway(); } }",
      "Entry",
    ],
    [
      "computed method name",
      "class Entry { [enabled ? startGateway() : 'choose']() {} }",
      "Entry",
    ],
    [
      "decorator expression",
      "@(enabled ? startGateway() : decorate)\nclass Entry {}",
      "Entry",
    ],
    [
      "direct default export expression",
      "export default enabled ? startGateway() : stopGateway();",
      "defaultExport",
    ],
  ])("checks a gateway decision in a top-level %s", (_form, source, declaration) => {
    const actual = collectOnboardEntryDecisions(source);

    expect(actual.gateway).toEqual({ [declaration]: 1 });
  });

  it("rejects a messaging action selected by a neutral condition", () => {
    const actual = collectOnboardEntryDecisions(
      "function choose(enabled: boolean) { if (enabled) configureMessaging(); }",
    );

    expect(actual.messaging).toEqual({ choose: 1 });
  });

  it.each([
    ["if", "if (enabled) startGateway();"],
    ["switch", "switch (mode) { case 'start': startGateway(); }"],
    ["conditional", "enabled ? startGateway() : stopGateway();"],
    ["logical AND", "enabled && startGateway();"],
    ["logical OR", "enabled || startGateway();"],
    ["nullish coalescing", "enabled ?? startGateway();"],
    ["for loop", "for (; gatewayRunning(); ) poll();"],
    ["while loop", "while (gatewayRunning()) poll();"],
    ["do loop", "do poll(); while (gatewayRunning());"],
    ["try and catch", "try { startGateway(); } catch { reportFailure(); }"],
    ["recovery call", "recoverGateway();"],
  ])("counts a gateway decision expressed with %s", (_form, decision) => {
    const actual = collectOnboardEntryDecisions(
      `function choose(enabled: boolean, mode: string) { ${decision} }`,
    );

    expect(actual.gateway).toEqual({ choose: 1 });
  });

  it("does not let a provider function name hide a gateway action", () => {
    const actual = collectOnboardEntryDecisions(
      "function chooseProvider(enabled: boolean) { if (enabled) startGateway(); }",
    );

    expect(actual.gateway).toEqual({ chooseProvider: 1 });
    expect(actual.provider).toEqual({ chooseProvider: 1 });
  });

  it("does not let a provider condition hide a gateway action", () => {
    const actual = collectOnboardEntryDecisions(
      "function choose(providerEnabled: boolean) { if (providerEnabled) startGateway(); }",
    );

    expect(actual.gateway).toEqual({ choose: 1 });
    expect(actual.provider).toEqual({ choose: 1 });
  });

  it("retains body categories when a function name has a gateway category", () => {
    const actual = collectOnboardEntryDecisions(
      "function chooseGateway(enabled: boolean) { if (enabled) configureMessaging(); }",
    );

    expect(actual.gateway).toEqual({ chooseGateway: 1 });
    expect(actual.messaging).toEqual({ chooseGateway: 1 });
  });

  it("does not count a nested logical decision as part of its parent decision", () => {
    const actual = collectOnboardEntryDecisions(
      "function choose(enabled: boolean) { if (enabled && gatewayRunning()) poll(); }",
    );

    expect(actual.gateway).toEqual({ choose: 1 });
  });

  it("does not classify sequencing loops as decisions", () => {
    const actual = collectOnboardEntryDecisions(
      "function runSteps(items: string[]) { for (const item of items) startGateway(item); }",
    );

    expect(actual.gateway).toEqual({});
  });

  it("does not classify provider registry decisions as gateway lifecycle decisions", () => {
    const actual = collectOnboardEntryDecisions(
      "function choose(name: string) { if (providerExistsInGateway(name)) useProvider(name); }",
    );

    expect(actual.gateway).toEqual({});
    expect(actual.provider).toEqual({ choose: 1 });
  });

  it("does not classify Hermes tool selection as a gateway lifecycle decision", () => {
    const actual = collectOnboardEntryDecisions(
      "function choose(enabled: boolean) { if (enabled) normalizeHermesToolGatewaySelections(); }",
    );

    expect(actual.gateway).toEqual({});
  });

  it("does not classify recovery helper construction as a recovery decision", () => {
    const actual = collectOnboardEntryDecisions(
      "const gatewayRecovery = createGatewayRecoveryOrchestration({});",
    );

    expect(actual.gateway).toEqual({});
  });

  it.each([
    ["gateway", "gatewayRecovery.execute()"],
    ["messaging", "messagingRecovery.execute()"],
    ["policy", "policyRecovery.run()"],
    ["provider", "providerRecovery.execute()"],
  ] as const)("classifies a %s recovery action by its receiver", (category, call) => {
    const actual = collectOnboardEntryDecisions(`function choose() { ${call}; }`);

    expect(actual[category]).toEqual({ choose: 1 });
  });

  it("does not classify a recovery helper method as a recovery action", () => {
    const actual = collectOnboardEntryDecisions(
      "function choose() { providerRecovery.providerNameToOptionKey(); }",
    );

    expect(actual.provider).toEqual({});
  });

  it.each(["(gatewayRecovery.execute)()", 'gatewayRecovery["execute"]()'])(
    "classifies receiver recovery action form %s",
    (call) => {
      const actual = collectOnboardEntryDecisions(`function choose() { ${call}; }`);

      expect(actual.gateway).toEqual({ choose: 1 });
    },
  );

  it("rejects a decision added within an allowed declaration", () => {
    const actual = collectOnboardEntryDecisions(
      "function handleRemoteProviderSelection(enabled: boolean) { if (enabled) useProvider(); if (enabled) useProviderAgain(); }",
    );

    expect(
      evaluateOnboardEntryComposition(actual, {
        ...EMPTY_BUDGET,
        provider: { handleRemoteProviderSelection: 1 },
      }),
    ).toEqual([
      {
        kind: "new-decision",
        category: "provider",
        declaration: "handleRemoteProviderSelection",
        actualCount: 2,
        budgetCount: 1,
      },
    ]);
  });

  it("requires the budget to decrease when a decision leaves an allowed declaration", () => {
    const actual = collectOnboardEntryDecisions(
      "function handleRemoteProviderSelection(enabled: boolean) { if (enabled) useProvider(); }",
    );

    expect(
      evaluateOnboardEntryComposition(actual, {
        ...EMPTY_BUDGET,
        provider: { handleRemoteProviderSelection: 2 },
      }),
    ).toEqual([
      {
        kind: "decision-ratchet",
        category: "provider",
        declaration: "handleRemoteProviderSelection",
        actualCount: 1,
        budgetCount: 2,
      },
    ]);
  });
});
