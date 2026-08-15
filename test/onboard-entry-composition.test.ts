// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  combineOnboardEntryCompositionCeiling,
  collectOnboardEntryDecisions,
  evaluateOnboardEntryComposition,
  evaluateOnboardEntryCompositionBudgetExpansion,
  mergeBaseCompositionCeiling,
  parseOnboardEntryCompositionBudget,
  resolveCompositionMergeBase,
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

  it("uses a stable neutral name for a computed method", () => {
    const compact = collectOnboardEntryDecisions(
      "class Entry { [gatewayKey]() { if (enabled) startGateway(); } }",
    );
    const spaced = collectOnboardEntryDecisions(
      "class Entry { [ gatewayKey ]() { if (enabled) startGateway(); } }",
    );

    expect(compact).toEqual(spaced);
    expect(compact.gateway).toEqual({ "Entry.[computed]": 1 });
  });

  it("uses a stable static owner for a destructured call initializer", () => {
    const actual = collectOnboardEntryDecisions(
      "const { choose } = factory.createEntry(() => { if (enabled) startGateway(); });",
    );

    expect(actual.gateway).toEqual({ createEntry: 1 });
  });

  it.each([
    ["return () => { if (enabled) startGateway(); };", "runOnboard"],
    ["schedule(() => { if (enabled) startGateway(); });", "runOnboard"],
    ["const nested = { choose() { if (enabled) startGateway(); } };", "runOnboard.choose"],
  ])("checks a gateway decision in a nested callable body: %s", (body, declaration) => {
    const actual = collectOnboardEntryDecisions(`function runOnboard() { ${body} }`);

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
    ["class static block", "class Entry { static { if (enabled) startGateway(); } }", "Entry"],
    ["computed method name", "class Entry { [enabled ? startGateway() : 'choose']() {} }", "Entry"],
    ["decorator expression", "@(enabled ? startGateway() : decorate)\nclass Entry {}", "Entry"],
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

  it.each([
    "restoreGateway",
    "retryGateway",
    "fallbackGateway",
    "rollbackGateway",
    "gatewayRestore",
    "gatewayRetry",
    "gatewayFallback",
    "gatewayRollback",
  ])("classifies the gateway recovery action %s", (action) => {
    const actual = collectOnboardEntryDecisions(`function choose() { ${action}(); }`);

    expect(actual.gateway).toEqual({ choose: 1 });
  });

  it.each([
    "if (enabled) schedule(startGateway);",
    "if (enabled) schedule(() => startGateway());",
    "if (enabled) schedule(startGateway());",
    "if (enabled) schedule(startGateway.bind(null));",
    "if (enabled) schedule([startGateway]);",
    "if (enabled) schedule({ run: startGateway });",
    "if (enabled) schedule({ ...{ run: startGateway } });",
    "if (enabled) scheduleNested(schedule(startGateway));",
  ])("checks a gateway action passed as an argument: %s", (decision) => {
    const actual = collectOnboardEntryDecisions(`function choose() { ${decision} }`);

    expect(actual.gateway).toEqual({ choose: 1 });
  });

  it.each(["&&=", "||=", "??="])(
    "checks a gateway action behind logical assignment %s",
    (operator) => {
      const actual = collectOnboardEntryDecisions(
        `function choose() { enabled ${operator} startGateway(); }`,
      );

      expect(actual.gateway).toEqual({ choose: 1 });
    },
  );

  it.each([
    "recoverGateway!()",
    "(recoverGateway as Callable)()",
    "(recoverGateway satisfies Callable)()",
    "(gatewayRecovery.execute as Callable)()",
    'if (enabled) gateway[("startGateway")]()',
    "(recoverGateway as Callable)`now`",
  ])("checks the wrapped static gateway invocation %s", (decision) => {
    const actual = collectOnboardEntryDecisions(`function choose() { ${decision}; }`);

    expect(actual.gateway).toEqual({ choose: 1 });
  });

  it.each([
    "gatewayRecovery[`execute`]()",
    'if (enabled) gateway["startGateway"]()',
    "recoverGateway`now`",
  ])("checks the static gateway invocation %s", (decision) => {
    const actual = collectOnboardEntryDecisions(`function choose() { ${decision}; }`);

    expect(actual.gateway).toEqual({ choose: 1 });
  });

  it("checks a private gateway recovery method", () => {
    const actual = collectOnboardEntryDecisions(
      "class Entry { #recoverGateway() {} choose() { this.#recoverGateway(); } }",
    );

    expect(actual.gateway).toEqual({ "Entry.choose": 1 });
  });

  it("checks a gateway action in a for-loop incrementor", () => {
    const actual = collectOnboardEntryDecisions(
      "function choose() { for (; enabled; startGateway()) {} }",
    );

    expect(actual.gateway).toEqual({ choose: 1 });
  });

  it.each(["createOrRecoverGateway", "buildOrRecoverGateway"])(
    "classifies the compound gateway action %s",
    (action) => {
      const actual = collectOnboardEntryDecisions(`function choose() { ${action}(); }`);

      expect(actual.gateway).toEqual({ choose: 1 });
    },
  );

  it("ignores a factory name with a lowercase compound-like sequence", () => {
    const actual = collectOnboardEntryDecisions(
      "function choose() { createProviderSupervisorRestoreHint(); }",
    );

    expect(actual.provider).toEqual({});
  });

  it.each([
    "createGatewayRecoveryAndStart",
    "buildGatewayRepairAndRun",
    "makeGatewayRollbackAndExecute",
  ])("classifies the reversed compound gateway action %s", (action) => {
    const actual = collectOnboardEntryDecisions(`function choose() { ${action}(); }`);

    expect(actual.gateway).toEqual({ choose: 1 });
  });

  it("checks a nested gateway action in a for-loop incrementor", () => {
    const actual = collectOnboardEntryDecisions(
      "function choose() { for (; enabled; schedule(startGateway())) {} }",
    );

    expect(actual.gateway).toEqual({ choose: 1 });
  });

  it.each([
    "if (enabled) schedule((value = startGateway()) => value);",
    "if (enabled) schedule({ [startGateway()]() {} });",
  ])("checks a gateway action in a nested callable header: %s", (decision) => {
    const actual = collectOnboardEntryDecisions(`function choose() { ${decision} }`);

    expect(actual.gateway).toEqual({ choose: 1 });
  });

  it.each(["for (startGateway(); enabled;) {}", "for (let value = startGateway(); enabled;) {}"])(
    "checks a gateway action in a for-loop initializer: %s",
    (decision) => {
      const actual = collectOnboardEntryDecisions(`function choose() { ${decision} }`);

      expect(actual.gateway).toEqual({ choose: 1 });
    },
  );

  it.each(["gateway.start()", "gateway.recover()"])(
    "combines a gateway receiver with lifecycle action %s",
    (call) => {
      const actual = collectOnboardEntryDecisions(`function choose() { if (enabled) ${call}; }`);

      expect(actual.gateway).toEqual({ choose: 1 });
    },
  );

  it.each(["recoverGateway.call(null)", "recoverGateway.bind(null)()"])(
    "checks the direct recovery invocation %s",
    (call) => {
      const actual = collectOnboardEntryDecisions(`function choose() { ${call}; }`);

      expect(actual.gateway).toEqual({ choose: 1 });
    },
  );

  it.each(["createRecoveryGatewayAndStart", "buildRepairGatewayAndRun"])(
    "classifies the gateway-interposed compound action %s",
    (action) => {
      const actual = collectOnboardEntryDecisions(`function choose() { ${action}(); }`);

      expect(actual.gateway).toEqual({ choose: 1 });
    },
  );

  it.each([
    "createRecoveryGatewayAndRestart",
    "createRecoveryGatewayAndStop",
    "buildRepairGatewayAndLaunch",
    "makeRollbackGatewayAndDestroy",
    "installRestoreGatewayAndWait",
  ])("classifies the compound lifecycle action %s", (action) => {
    const actual = collectOnboardEntryDecisions(`function choose() { ${action}(); }`);

    expect(actual.gateway).toEqual({ choose: 1 });
  });

  it.each([
    "if (gateway.running()) return;",
    'if (gateway["ready"]()) return;',
    "switch (gateway.state) { default: break; }",
  ])("combines gateway receiver and member in condition %s", (decision) => {
    const actual = collectOnboardEntryDecisions(`function choose() { ${decision} }`);

    expect(actual.gateway).toEqual({ choose: 1 });
  });

  it.each(["ensure", "attach", "register", "reuse"])(
    "classifies the gateway lifecycle condition member %s",
    (member) => {
      for (const expression of [`gateway.${member}()`, `gateway["${member}"]()`]) {
        const actual = collectOnboardEntryDecisions(
          `function choose() { if (${expression}) return; }`,
        );

        expect(actual.gateway).toEqual({ choose: 1 });
      }
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

  it("permits reassigned allowance up to the merge-base source", () => {
    const baseBudget = {
      ...EMPTY_BUDGET,
      gateway: { runOnboard: 1 },
    };
    const baseActual = {
      ...EMPTY_BUDGET,
      gateway: { runOnboard: 2 },
    };
    const baseline = combineOnboardEntryCompositionCeiling(baseBudget, baseActual);

    expect(
      evaluateOnboardEntryCompositionBudgetExpansion(
        { ...EMPTY_BUDGET, gateway: { runOnboard: 2 } },
        baseline,
      ),
    ).toEqual([]);
    expect(
      evaluateOnboardEntryCompositionBudgetExpansion(
        { ...EMPTY_BUDGET, gateway: { runOnboard: 3 } },
        baseline,
      ),
    ).toEqual([
      {
        kind: "category",
        category: "gateway",
        budgetCount: 3,
        baselineCount: 2,
      },
      {
        kind: "declaration",
        category: "gateway",
        declaration: "runOnboard",
        budgetCount: 3,
        baselineCount: 2,
      },
      {
        kind: "global",
        budgetCount: 3,
        baselineCount: 2,
      },
    ]);
  });

  it("rejects duplicated allowance after owner reassignment", () => {
    const baseline = combineOnboardEntryCompositionCeiling(
      { ...EMPTY_BUDGET, messaging: { oldOwner: 1 } },
      { ...EMPTY_BUDGET, messaging: { newOwner: 1 } },
    );

    expect(
      evaluateOnboardEntryCompositionBudgetExpansion(
        { ...EMPTY_BUDGET, messaging: { newOwner: 1, oldOwner: 1 } },
        baseline,
      ),
    ).toEqual([
      {
        kind: "category",
        category: "messaging",
        budgetCount: 2,
        baselineCount: 1,
      },
      {
        kind: "global",
        budgetCount: 2,
        baselineCount: 1,
      },
    ]);
  });

  it("rejects duplicated allowance after category reassignment", () => {
    const baseline = combineOnboardEntryCompositionCeiling(
      { ...EMPTY_BUDGET, provider: { oldOwner: 1 } },
      { ...EMPTY_BUDGET, messaging: { newOwner: 1 } },
    );

    expect(
      evaluateOnboardEntryCompositionBudgetExpansion(
        {
          ...EMPTY_BUDGET,
          messaging: { newOwner: 1 },
          provider: { oldOwner: 1 },
        },
        baseline,
      ),
    ).toEqual([
      {
        kind: "global",
        budgetCount: 2,
        baselineCount: 1,
      },
    ]);
  });

  it("reports a Git execution failure while resolving the composition merge base", () => {
    const calls: string[][] = [];

    expect(() =>
      resolveCompositionMergeBase((args) => {
        calls.push([...args]);
        return { status: 128, stdout: "", error: "spawn git ENOENT" };
      }, ""),
    ).toThrow(
      "could not run git to resolve the composition merge base against origin/main (spawn git ENOENT)",
    );
    expect(calls).toEqual([["merge-base", "HEAD", "origin/main"]]);
  });

  it("fails closed when the composition merge-base history is unavailable", () => {
    expect(() => resolveCompositionMergeBase(() => ({ status: 128, stdout: "" }), "")).toThrow(
      "could not resolve the composition merge base against origin/main; fetch the base ref with sufficient history",
    );
  });

  it.each([
    "ci/onboard-entry-composition-budget.json",
    "src/lib/onboard.ts",
  ])("fails closed when %s is unavailable at the composition merge base", (missingPath) => {
    const revision = "base-revision";
    const baseBudget = JSON.stringify(EMPTY_BUDGET);
    const git = (args: readonly string[]) => {
      if (args[0] === "merge-base") return { status: 0, stdout: revision };
      const relativePath = args[1]?.slice(`${revision}:`.length);
      if (relativePath === missingPath) return { status: 128, stdout: "" };
      if (relativePath === "ci/onboard-entry-composition-budget.json") {
        return { status: 0, stdout: baseBudget };
      }
      return { status: 0, stdout: "function runOnboard() {}" };
    };

    expect(() => mergeBaseCompositionCeiling(git, "")).toThrow(
      `could not read ${missingPath} from composition merge base ${revision}`,
    );
  });

  it("reports a Git execution failure while reading a composition merge-base file", () => {
    const revision = "base-revision";
    const relativePath = "ci/onboard-entry-composition-budget.json";
    const git = (args: readonly string[]) =>
      args[0] === "merge-base"
        ? { status: 0, stdout: revision }
        : { status: null, stdout: "", error: "spawnSync git ETIMEDOUT" };

    expect(() => mergeBaseCompositionCeiling(git, "")).toThrow(
      `could not run git to read ${relativePath} from composition merge base ${revision} (spawnSync git ETIMEDOUT)`,
    );
  });
});
