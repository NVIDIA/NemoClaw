// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { BACK_TO_SELECTION, isBackToSelection, type BackToSelection } from "../navigation";
import {
  assertGatedModelAccess,
  modelsForPlatform,
  selectVllmModelFromEnv,
  type VllmModelDef,
  type VllmPlatform,
} from "./vllm-models";

export interface VllmModelPromptOptions {
  /**
   * Reader for the wizard prompt. Caller must supply one — the picker is only
   * invoked from `installVllm`, which threads the shared `prompt` helper from
   * `credentials/store` through the `InstallVllmOptions.promptFn` parameter,
   * and tests supply their own queue-backed stub. Lazy-loading the default
   * here would drag `credentials/store` into `vllm.ts`'s import graph, which
   * test harnesses for `vllm.ts` and `nim.ts` deliberately keep slim.
   */
  promptFn: (question: string) => Promise<string>;
  errorLine?: (message: string) => void;
  writeLine?: (message: string) => void;
  exitFn?: () => never;
  getNavigationChoiceFn?: (value?: string) => "back" | "exit" | null;
  env?: NodeJS.ProcessEnv;
}

function getNavigationChoice(value = ""): "back" | "exit" | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "back") return "back";
  if (normalized === "exit" || normalized === "quit") return "exit";
  return null;
}

function exitOnboardFromPrompt(): never {
  console.log("  Exiting onboarding.");
  process.exit(1);
}

export async function promptVllmModel(
  profileLabel: string,
  availableModels: readonly VllmModelDef[],
  defaultModel: VllmModelDef,
  options: VllmModelPromptOptions,
): Promise<VllmModelDef | BackToSelection> {
  const promptFn = options.promptFn;
  const errorLine = options.errorLine ?? console.error;
  const writeLine = options.writeLine ?? console.log;
  const exitFn = options.exitFn ?? exitOnboardFromPrompt;
  const getNavigationChoiceFn = options.getNavigationChoiceFn ?? getNavigationChoice;
  const env = options.env ?? process.env;

  const ordered = orderWithDefaultFirst(availableModels, defaultModel);

  while (true) {
    writeLine("");
    writeLine(`  vLLM models for ${profileLabel}:`);
    ordered.forEach((model, index) => {
      const annotations: string[] = [];
      if (model.id === defaultModel.id) annotations.push("recommended, default");
      if (model.gated) annotations.push("gated; requires HF token");
      const suffix = annotations.length > 0 ? ` (${annotations.join("; ")})` : "";
      writeLine(`    ${index + 1}) ${model.label}${suffix}`);
      writeLine(`       ${model.id}`);
    });
    writeLine("");

    const choice = await promptFn("  Choose model [1]: ");
    const navigation = getNavigationChoiceFn(choice);
    if (navigation === "back") return BACK_TO_SELECTION;
    if (navigation === "exit") exitFn();

    const trimmed = String(choice || "").trim();
    if (trimmed !== "" && !/^\d+$/.test(trimmed)) {
      errorLine(`  Pick a number between 1 and ${String(ordered.length)}.`);
      continue;
    }
    const index = trimmed === "" ? 0 : parseInt(trimmed, 10) - 1;
    if (!Number.isFinite(index) || index < 0 || index >= ordered.length) {
      errorLine(`  Pick a number between 1 and ${String(ordered.length)}.`);
      continue;
    }

    const selected = ordered[index];
    try {
      assertGatedModelAccess(selected, env);
    } catch (err) {
      errorLine(`  ${(err as Error).message}`);
      continue;
    }
    return selected;
  }
}

function orderWithDefaultFirst(
  models: readonly VllmModelDef[],
  defaultModel: VllmModelDef,
): VllmModelDef[] {
  const others = models.filter((model) => model.id !== defaultModel.id);
  return [defaultModel, ...others];
}

export type VllmModelSource = "env" | "default" | "picker";

export interface VllmModelResolutionContext {
  /** Human label printed in picker/summary, e.g. `"DGX Spark"`. */
  name: string;
  /** Picker filters the registry by this platform tag. */
  platform: VllmPlatform;
  /** Selected when the env var is unset and the run is non-interactive. */
  defaultModel: VllmModelDef;
}

export interface ResolveVllmInstallModelOptions {
  nonInteractive: boolean;
  promptFn: (question: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve which vLLM model the installer should serve, applying the same
 * precedence used by `installVllm`:
 *
 *   1. `NEMOCLAW_VLLM_MODEL=<envValue-or-HF-id>` — automation override.
 *   2. Non-interactive runs fall back to the profile default without prompting.
 *   3. Interactive runs offer a platform-filtered picker; the picker also
 *      re-runs `assertGatedModelAccess` on the selection.
 *
 * Returns `null` when the env override fails the gated-token check, when the
 * picker is dismissed via `back`, or when any other resolution error fires —
 * the failure is logged through `console.error` so the install summary stays
 * out of the resolved-model path.
 */
export async function resolveVllmInstallModel(
  profile: VllmModelResolutionContext,
  opts: ResolveVllmInstallModelOptions,
): Promise<{ model: VllmModelDef; source: VllmModelSource } | null> {
  try {
    const envOverride = selectVllmModelFromEnv(opts.env);
    if (envOverride) {
      assertGatedModelAccess(envOverride, opts.env);
      return { model: envOverride, source: "env" };
    }
    if (opts.nonInteractive) {
      assertGatedModelAccess(profile.defaultModel, opts.env);
      return { model: profile.defaultModel, source: "default" };
    }
    const pick = await promptVllmModel(
      profile.name,
      modelsForPlatform(profile.platform),
      profile.defaultModel,
      { promptFn: opts.promptFn, env: opts.env },
    );
    if (isBackToSelection(pick)) return null;
    return { model: pick, source: "picker" };
  } catch (err) {
    console.error(`  vLLM install failed: ${(err as Error).message}`);
    return null;
  }
}
