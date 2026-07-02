// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parsePolicyPresetEnv } from "../core/url-utils";
import * as policies from "../policy";
import * as tiers from "../policy/tiers";
import * as registry from "../state/registry";
import type { SandboxCancelRollback } from "./cancel-rollback";
import { syncPresetSelection } from "./policy-preset-sync";
import {
  computeSetupPresetSuggestions as computeSetupPresetSuggestionsImpl,
  type SetupPolicySelectionOptions,
  type SetupPresetSuggestionOptions,
  setupPoliciesWithSelection as setupPoliciesWithSelectionImpl,
} from "./policy-selection";
import { createPolicySelectionPromptHelpers } from "./policy-selection-prompts";
import * as policyTierEnv from "./policy-tier-env";

const { LOCAL_INFERENCE_PROVIDERS } = require("./providers") as {
  LOCAL_INFERENCE_PROVIDERS: string[];
};

export type PolicySelectionRuntimeDeps = {
  isNonInteractive(): boolean;
  note(message: string): void;
  prompt(question: string): Promise<string>;
  selectFromNumberedMenuOrExit<T>(rawChoice: string, defaultIdx: number, options: T[]): T;
  makeOnboardCancelExit(
    rollback: Pick<SandboxCancelRollback, "markCancelled">,
    cleanup: () => void,
  ): () => void;
  sandboxCancelRollback: Pick<SandboxCancelRollback, "markCancelled">;
  useColor: boolean;
  step(current: number, total: number, message: string): void;
  waitForSandboxReady(sandboxName: string, attempts?: number, delaySeconds?: number): boolean;
};

export function createPolicySelectionRuntime(deps: PolicySelectionRuntimeDeps) {
  function promptHelpers() {
    return createPolicySelectionPromptHelpers({
      tiers,
      policyTierEnv,
      isNonInteractive: deps.isNonInteractive,
      note: deps.note,
      prompt: deps.prompt,
      selectFromNumberedMenuOrExit: deps.selectFromNumberedMenuOrExit,
      makeOnboardCancelExit: deps.makeOnboardCancelExit,
      sandboxCancelRollback: deps.sandboxCancelRollback,
      useColor: deps.useColor,
    });
  }

  async function selectPolicyTier(): Promise<string> {
    return promptHelpers().selectPolicyTier();
  }

  async function selectTierPresetsAndAccess(
    tierName: string,
    allPresets: Array<{ name: string; description?: string }>,
    extraSelected: string[] = [],
  ): Promise<Array<{ name: string; access: string }>> {
    return promptHelpers().selectTierPresetsAndAccess(tierName, allPresets, extraSelected);
  }

  async function presetsCheckboxSelector(
    allPresets: Array<{ name: string; description: string }>,
    initialSelected: string[],
  ): Promise<string[]> {
    return promptHelpers().presetsCheckboxSelector(allPresets, initialSelected);
  }

  const computeSetupPresetSuggestions = (
    tierName: string,
    options: SetupPresetSuggestionOptions = {},
  ): string[] =>
    computeSetupPresetSuggestionsImpl(
      { policies, tiers, localInferenceProviders: LOCAL_INFERENCE_PROVIDERS },
      tierName,
      options,
    );

  async function setupPoliciesWithSelection(
    sandboxName: string,
    options: SetupPolicySelectionOptions = {},
  ) {
    return setupPoliciesWithSelectionImpl(
      {
        policies,
        tiers,
        localInferenceProviders: LOCAL_INFERENCE_PROVIDERS,
        step: deps.step,
        note: deps.note,
        isNonInteractive: deps.isNonInteractive,
        waitForSandboxReady: deps.waitForSandboxReady,
        syncPresetSelection,
        selectPolicyTier,
        setPolicyTier: (name, tier) => registry.updateSandbox(name, { policyTier: tier }),
        getRecordedPolicyTier: (name) => registry.getSandbox(name)?.policyTier ?? null,
        selectTierPresetsAndAccess,
        parsePolicyPresetEnv,
        env: process.env,
      },
      sandboxName,
      options,
    );
  }

  return {
    computeSetupPresetSuggestions,
    presetsCheckboxSelector,
    selectPolicyTier,
    selectTierPresetsAndAccess,
    setupPoliciesWithSelection,
  };
}
