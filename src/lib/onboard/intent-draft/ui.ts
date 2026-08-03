// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { collectIntentDraft, type DraftPromptResult, type DraftStep } from "./controller";
import {
  createOnboardIntentDraft,
  type OnboardInferenceIntent,
  type OnboardIntentCompatibility,
  type OnboardIntentDraft,
  type OnboardIntentStepId,
  type OnboardResourceIntent,
  type OnboardToolIntent,
  reconcileOnboardIntentDraft,
  validateOnboardIntentEndpointUrl,
} from "./schema";

export interface OnboardIntentChoice {
  readonly value: string;
  readonly label: string;
}

export interface OnboardInferenceIntentChoice extends OnboardIntentChoice {
  readonly defaultModel: string | null;
  readonly endpointRequired?: boolean;
  readonly authMethods?: readonly OnboardIntentChoice[];
}

export interface OnboardIntentDraftUiDeps {
  prompt(question: string): Promise<string>;
  log(message?: string): void;
  agentChoices(): readonly OnboardIntentChoice[];
  inferenceChoices(agent: string): Promise<readonly OnboardInferenceIntentChoice[]>;
  webSearchChoices(agent: string): readonly OnboardIntentChoice[];
  messagingChoices(agent: string): readonly OnboardIntentChoice[];
  managedToolChoices(
    agent: string,
    inference: OnboardInferenceIntent,
  ): readonly OnboardIntentChoice[];
  defaultManagedTools(agent: string, inference: OnboardInferenceIntent): readonly string[];
  resourceProfileChoices(): readonly OnboardIntentChoice[];
  policyChoices(): readonly OnboardIntentChoice[];
  defaultSandboxName(agent: string): string;
  validateSandboxName(value: string): string;
  validateModel(value: string): string;
  compatibility: OnboardIntentCompatibility;
  checkpoint(draft: OnboardIntentDraft): Promise<void> | void;
}

type NavigationIntent = "back" | "exit" | null;

const STEP_LABELS: Record<OnboardIntentStepId, string> = {
  agent: "Agent",
  inference: "Inference provider and model",
  sandbox: "Sandbox name",
  web_search: "Web search",
  messaging: "Messaging channels",
  tools: "Managed tools",
  resources: "Resource profile and GPU",
  policy: "Policy tier",
};

function navigationIntent(value: string): NavigationIntent {
  const normalized = value.trim().toLowerCase();
  if (normalized === "b" || normalized === "back") return "back";
  if (normalized === "exit" || normalized === "quit") return "exit";
  return null;
}

function navigationResult<Value>(intent: NavigationIntent): DraftPromptResult<Value> | null {
  if (intent === "back") return { kind: "back" };
  if (intent === "exit") return { kind: "exit" };
  return null;
}

function writeNavigationHint(log: OnboardIntentDraftUiDeps["log"]): void {
  log("  [b] Back  [exit] Exit onboarding");
}

function findChoice(
  raw: string,
  choices: readonly OnboardIntentChoice[],
): OnboardIntentChoice | null {
  const normalized = raw.trim().toLowerCase();
  const numeric = /^\d+$/.test(normalized) ? Number.parseInt(normalized, 10) - 1 : -1;
  if (numeric >= 0 && numeric < choices.length) return choices[numeric];
  return choices.find((choice) => choice.value.toLowerCase() === normalized) ?? null;
}

async function promptChoice<Value extends string>(options: {
  readonly title: string;
  readonly choices: readonly OnboardIntentChoice[];
  readonly previous?: string | null;
  readonly deps: Pick<OnboardIntentDraftUiDeps, "prompt" | "log">;
}): Promise<DraftPromptResult<Value>> {
  const { choices, deps } = options;
  if (choices.length === 0) throw new Error(`${options.title} has no available choices.`);
  deps.log("");
  deps.log(`  ${options.title}:`);
  choices.forEach((choice, index) => deps.log(`    ${index + 1}) ${choice.label}`));
  writeNavigationHint(deps.log);
  const previous = choices.find((choice) => choice.value === options.previous);
  const defaultChoice = previous ?? choices[0];

  while (true) {
    const raw = await deps.prompt(`  Choose [${defaultChoice.value}]: `);
    const navigation = navigationResult<Value>(navigationIntent(raw));
    if (navigation) return navigation;
    if (!raw.trim()) return { kind: "answer", value: defaultChoice.value as Value };
    const selected = findChoice(raw, choices);
    if (selected) return { kind: "answer", value: selected.value as Value };
    deps.log(`  Enter a number from 1 to ${choices.length}, b, or exit.`);
  }
}

async function promptText(options: {
  readonly label: string;
  readonly previous?: string | null;
  readonly allowDefault?: boolean;
  readonly deps: Pick<OnboardIntentDraftUiDeps, "prompt" | "log">;
}): Promise<DraftPromptResult<string | null>> {
  writeNavigationHint(options.deps.log);
  while (true) {
    const suffix = options.previous
      ? ` [${options.previous}]`
      : options.allowDefault
        ? " [default]"
        : "";
    const raw = await options.deps.prompt(`  ${options.label}${suffix}: `);
    const navigation = navigationResult<string | null>(navigationIntent(raw));
    if (navigation) return navigation;
    const value = raw.trim();
    if (value) return { kind: "answer", value };
    if (options.previous) return { kind: "answer", value: options.previous };
    if (options.allowDefault) return { kind: "answer", value: null };
    options.deps.log(`  ${options.label} cannot be empty.`);
  }
}

function replaceAnswer<Key extends keyof OnboardIntentDraft["answers"]>(
  draft: OnboardIntentDraft,
  key: Key,
  value: NonNullable<OnboardIntentDraft["answers"][Key]>,
): OnboardIntentDraft {
  return { ...draft, answers: { ...draft.answers, [key]: value } };
}

function withoutDraftAnswers(
  answers: OnboardIntentDraft["answers"],
  fields: readonly (keyof OnboardIntentDraft["answers"])[],
): OnboardIntentDraft["answers"] {
  const next = { ...answers };
  for (const field of fields) delete next[field];
  return next;
}

/** Revalidate seeded and resumed choices against the currently available menus. */
async function prepareDraftForReview(
  deps: OnboardIntentDraftUiDeps,
  draft: OnboardIntentDraft,
): Promise<OnboardIntentDraft> {
  if (draft.phase === "accepted") return draft;
  const original = draft.answers;
  let answers = { ...original };
  const agent = answers.agent;
  if (!agent) return draft;
  if (!deps.agentChoices().some((choice) => choice.value === agent)) {
    return { ...draft, answers: {} };
  }

  const inference = answers.inference;
  if (inference) {
    const choice = (await deps.inferenceChoices(agent)).find(
      (candidate) => candidate.value === inference.provider,
    );
    const authMethods = choice?.authMethods ?? [];
    const authMethodAvailable =
      authMethods.length === 0 ||
      (inference.authMethod !== null &&
        authMethods.some((method) => method.value === inference.authMethod));
    let normalizedModel = inference.model;
    let modelAvailable = true;
    try {
      normalizedModel = inference.model === null ? null : deps.validateModel(inference.model);
    } catch {
      modelAvailable = false;
    }
    if (
      !choice ||
      !modelAvailable ||
      (choice.endpointRequired && !inference.endpointUrl) ||
      !authMethodAvailable
    ) {
      answers = withoutDraftAnswers(answers, ["inference", "tools", "policy"]);
    } else {
      const normalizedInference = {
        ...inference,
        model: normalizedModel,
        endpointUrl: choice.endpointRequired ? inference.endpointUrl : null,
        authMethod: authMethods.length > 0 ? inference.authMethod : null,
      };
      if (JSON.stringify(normalizedInference) !== JSON.stringify(inference)) {
        answers = {
          ...withoutDraftAnswers(answers, ["tools", "policy"]),
          inference: normalizedInference,
        };
      }
    }
  }

  const webSearch = answers.web_search;
  if (webSearch && !deps.webSearchChoices(agent).some((choice) => choice.value === webSearch)) {
    answers = withoutDraftAnswers(answers, ["web_search", "policy"]);
  }

  if (answers.messaging) {
    const available = new Set(deps.messagingChoices(agent).map((choice) => choice.value));
    const supported = answers.messaging.filter((channel) => available.has(channel));
    if (supported.length !== answers.messaging.length) {
      answers = { ...withoutDraftAnswers(answers, ["policy"]), messaging: supported };
    }
  }

  if (answers.tools && answers.inference) {
    const available = new Set(
      deps.managedToolChoices(agent, answers.inference).map((choice) => choice.value),
    );
    const supported = answers.tools.hermesGateways.filter((gateway) => available.has(gateway));
    if (supported.length !== answers.tools.hermesGateways.length) {
      answers = {
        ...withoutDraftAnswers(answers, ["policy"]),
        tools: { hermesGateways: supported },
      };
    }
  }

  if (
    answers.resources &&
    !deps.resourceProfileChoices().some((choice) => choice.value === answers.resources!.profile)
  ) {
    answers = withoutDraftAnswers(answers, ["resources"]);
  }

  if (answers.sandbox) {
    try {
      const sandbox = deps.validateSandboxName(answers.sandbox);
      if (sandbox !== answers.sandbox) answers = { ...answers, sandbox };
    } catch {
      answers = withoutDraftAnswers(answers, ["sandbox"]);
    }
  }

  if (answers.policy && !deps.policyChoices().some((choice) => choice.value === answers.policy)) {
    answers = withoutDraftAnswers(answers, ["policy"]);
  }

  return JSON.stringify(answers) === JSON.stringify(original) ? draft : { ...draft, answers };
}

function formatInference(inference: OnboardInferenceIntent): string {
  const model = inference.model ?? "provider default";
  const endpoint = inference.endpointUrl ? `, ${inference.endpointUrl}` : "";
  const auth = inference.authMethod ? `, auth: ${inference.authMethod}` : "";
  return `${inference.provider} / ${model}${endpoint}${auth}`;
}

function renderReview(
  deps: Pick<OnboardIntentDraftUiDeps, "log">,
  draft: OnboardIntentDraft,
): void {
  const answers = draft.answers;
  deps.log("");
  deps.log("  Review configuration");
  deps.log(`    Agent: ${answers.agent}`);
  deps.log(`    Inference: ${formatInference(answers.inference!)}`);
  deps.log(`    Sandbox: ${answers.sandbox}`);
  deps.log(`    Web search: ${answers.web_search ?? "disabled"}`);
  deps.log(
    `    Messaging: ${answers.messaging && answers.messaging.length > 0 ? answers.messaging.join(", ") : "none"}`,
  );
  deps.log(
    `    Managed tools: ${answers.tools!.hermesGateways.length > 0 ? answers.tools!.hermesGateways.join(", ") : "none"}`,
  );
  const resourceOverrides = [
    answers.resources!.cpu ? `CPU: ${answers.resources!.cpu}` : null,
    answers.resources!.memory ? `RAM: ${answers.resources!.memory}` : null,
  ].filter(Boolean);
  deps.log(
    `    Resources: ${answers.resources!.profile}${resourceOverrides.length > 0 ? ` (${resourceOverrides.join(", ")})` : ""}, GPU: ${answers.resources!.gpu}`,
  );
  deps.log(`    Policy: ${answers.policy}`);
  deps.log("");
  deps.log("    1) Apply configuration");
  deps.log("    2) Edit a choice");
  deps.log("    3) Exit onboarding");
}

async function promptReview(
  deps: Pick<OnboardIntentDraftUiDeps, "prompt" | "log">,
  draft: OnboardIntentDraft,
): Promise<
  | { readonly kind: "apply" }
  | { readonly kind: "edit"; readonly step: OnboardIntentStepId }
  | { readonly kind: "exit" }
> {
  while (true) {
    renderReview(deps, draft);
    const action = (await deps.prompt("  Choose [1]: ")).trim().toLowerCase();
    if (!action || action === "1" || action === "apply") return { kind: "apply" };
    if (action === "3" || action === "exit" || action === "quit") return { kind: "exit" };
    if (action !== "2" && action !== "edit") {
      deps.log("  Choose Apply configuration, Edit a choice, or Exit onboarding.");
      continue;
    }

    deps.log("");
    deps.log("  Edit a choice:");
    const stepIds = Object.keys(STEP_LABELS) as OnboardIntentStepId[];
    stepIds.forEach((step, index) => deps.log(`    ${index + 1}) ${STEP_LABELS[step]}`));
    writeNavigationHint(deps.log);
    const raw = await deps.prompt("  Choose a group to edit: ");
    const navigation = navigationIntent(raw);
    if (navigation === "exit") return { kind: "exit" };
    if (navigation === "back") continue;
    const selected = findChoice(
      raw,
      stepIds.map((step) => ({ value: step, label: STEP_LABELS[step] })),
    );
    if (selected) return { kind: "edit", step: selected.value as OnboardIntentStepId };
    deps.log(`  Enter a number from 1 to ${stepIds.length}, b, or exit.`);
  }
}

async function promptInference(
  deps: OnboardIntentDraftUiDeps,
  draft: OnboardIntentDraft,
  previous: OnboardInferenceIntent | undefined,
  direction: "forward" | "back",
): Promise<DraftPromptResult<OnboardInferenceIntent>> {
  const providerChoices = await deps.inferenceChoices(draft.answers.agent!);
  let providerChoice: OnboardInferenceIntentChoice | null =
    providerChoices.find((choice) => choice.value === previous?.provider) ?? null;
  let model: string | null = previous?.model ?? null;
  let endpointUrl: string | null = previous?.endpointUrl ?? null;
  let authMethod: string | null = previous?.authMethod ?? null;
  let stage: "provider" | "model" | "endpoint" | "auth" =
    direction === "back" && providerChoice
      ? providerChoice.authMethods && providerChoice.authMethods.length > 0
        ? "auth"
        : providerChoice.endpointRequired
          ? "endpoint"
          : "model"
      : "provider";

  while (true) {
    if (stage === "provider") {
      const result: DraftPromptResult<string> = await promptChoice<string>({
        title: "Inference provider",
        choices: providerChoices,
        previous: providerChoice?.value ?? previous?.provider,
        deps,
      });
      if (result.kind !== "answer") return result;
      const selected: OnboardInferenceIntentChoice | undefined = providerChoices.find(
        (choice) => choice.value === result.value,
      );
      if (!selected) throw new Error(`Inference provider is no longer available: ${result.value}`);
      if (providerChoice?.value !== selected.value) {
        model = null;
        endpointUrl = null;
        authMethod = null;
      }
      providerChoice = selected;
      stage = "model";
      continue;
    }

    if (stage === "model") {
      const result = await promptText({
        label: "Model",
        previous:
          model ??
          (previous?.provider === providerChoice!.value
            ? previous.model
            : providerChoice!.defaultModel),
        allowDefault: true,
        deps,
      });
      if (result.kind === "back") {
        stage = "provider";
        continue;
      }
      if (result.kind === "exit") return result;
      try {
        model = result.value === null ? null : deps.validateModel(result.value);
      } catch (error) {
        deps.log(`  ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      stage = providerChoice!.endpointRequired ? "endpoint" : "auth";
      continue;
    }

    if (stage === "endpoint") {
      const endpointResult = await promptText({
        label: "Endpoint URL",
        previous:
          endpointUrl ??
          (previous?.provider === providerChoice!.value ? previous.endpointUrl : null),
        deps,
      });
      if (endpointResult.kind === "back") {
        stage = "model";
        continue;
      }
      if (endpointResult.kind === "exit") return endpointResult;
      try {
        endpointUrl = validateOnboardIntentEndpointUrl(endpointResult.value!);
        stage = "auth";
        continue;
      } catch (error) {
        deps.log(`  ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }

    if (providerChoice!.authMethods && providerChoice!.authMethods!.length > 0) {
      const result = await promptChoice<string>({
        title: "Authentication method",
        choices: providerChoice!.authMethods!,
        previous:
          authMethod ?? (previous?.provider === providerChoice!.value ? previous.authMethod : null),
        deps,
      });
      if (result.kind === "back") {
        stage = providerChoice!.endpointRequired ? "endpoint" : "model";
        continue;
      }
      if (result.kind === "exit") return result;
      authMethod = result.value;
    }

    return {
      kind: "answer",
      value: { provider: providerChoice!.value, model, endpointUrl, authMethod },
    };
  }
}

async function promptWebSearch(
  deps: OnboardIntentDraftUiDeps,
  draft: OnboardIntentDraft,
  previous: string | null | undefined,
  direction: "forward" | "back",
): Promise<DraftPromptResult<string | null>> {
  const choices = deps.webSearchChoices(draft.answers.agent!);
  if (choices.length === 0) {
    return direction === "back" ? { kind: "back" } : { kind: "answer", value: null };
  }
  const result = await promptChoice<string>({
    title: "Web search",
    choices: [{ value: "none", label: "Disabled" }, ...choices],
    previous: previous === null ? "none" : previous,
    deps,
  });
  return result.kind === "answer" && result.value === "none"
    ? { kind: "answer", value: null }
    : result;
}

async function promptMessaging(
  deps: OnboardIntentDraftUiDeps,
  draft: OnboardIntentDraft,
  previous: readonly string[] | undefined,
  direction: "forward" | "back",
): Promise<DraftPromptResult<readonly string[]>> {
  const choices = deps.messagingChoices(draft.answers.agent!);
  if (choices.length === 0) {
    return direction === "back" ? { kind: "back" } : { kind: "answer", value: [] };
  }
  deps.log("");
  deps.log("  Messaging channels:");
  choices.forEach((choice, index) => deps.log(`    ${index + 1}) ${choice.label}`));
  writeNavigationHint(deps.log);
  const prior = previous?.join(",") ?? "none";
  while (true) {
    const raw = await deps.prompt(`  Enter numbers/IDs, or none [${prior}]: `);
    const navigation = navigationResult<readonly string[]>(navigationIntent(raw));
    if (navigation) return navigation;
    const normalized = raw.trim();
    if (!normalized) return { kind: "answer", value: previous ?? [] };
    if (/^(none|no|skip)$/i.test(normalized)) return { kind: "answer", value: [] };
    const selected: string[] = [];
    let invalid: string | null = null;
    for (const part of normalized.split(/[\s,]+/).filter(Boolean)) {
      const choice = findChoice(part, choices);
      if (!choice) {
        invalid = part;
        break;
      }
      if (!selected.includes(choice.value)) selected.push(choice.value);
    }
    if (!invalid) return { kind: "answer", value: selected };
    deps.log(`  Unknown messaging channel: ${invalid}`);
  }
}

async function promptManagedTools(
  deps: OnboardIntentDraftUiDeps,
  draft: OnboardIntentDraft,
  previous: OnboardToolIntent | undefined,
  direction: "forward" | "back",
): Promise<DraftPromptResult<OnboardToolIntent>> {
  const inference = draft.answers.inference!;
  const choices = deps.managedToolChoices(draft.answers.agent!, inference);
  if (choices.length === 0) {
    return direction === "back"
      ? { kind: "back" }
      : { kind: "answer", value: { hermesGateways: [] } };
  }

  const defaults =
    previous?.hermesGateways ?? deps.defaultManagedTools(draft.answers.agent!, inference);
  deps.log("");
  deps.log("  Managed tools:");
  choices.forEach((choice, index) => deps.log(`    ${index + 1}) ${choice.label}`));
  writeNavigationHint(deps.log);
  while (true) {
    const prior = defaults.length > 0 ? defaults.join(",") : "none";
    const raw = await deps.prompt(`  Enter numbers/IDs, or none [${prior}]: `);
    const navigation = navigationResult<OnboardToolIntent>(navigationIntent(raw));
    if (navigation) return navigation;
    const normalized = raw.trim();
    if (!normalized) return { kind: "answer", value: { hermesGateways: defaults } };
    if (/^(none|no|skip)$/i.test(normalized)) {
      return { kind: "answer", value: { hermesGateways: [] } };
    }
    const selected: string[] = [];
    let invalid: string | null = null;
    for (const part of normalized.split(/[\s,]+/).filter(Boolean)) {
      const choice = findChoice(part, choices);
      if (!choice) {
        invalid = part;
        break;
      }
      if (!selected.includes(choice.value)) selected.push(choice.value);
    }
    if (!invalid) return { kind: "answer", value: { hermesGateways: selected } };
    deps.log(`  Unknown managed tool: ${invalid}`);
  }
}

function createSteps(
  deps: OnboardIntentDraftUiDeps,
): DraftStep<OnboardIntentStepId, OnboardIntentDraft, unknown>[] {
  return [
    {
      id: "agent",
      label: STEP_LABELS.agent,
      read: (draft) => draft.answers.agent,
      write: (draft, value) => replaceAnswer(draft, "agent", String(value)),
      prompt: ({ previous }) =>
        promptChoice({
          title: "Agent",
          choices: deps.agentChoices(),
          previous: previous as string,
          deps,
        }),
    },
    {
      id: "inference",
      label: STEP_LABELS.inference,
      read: (draft) => draft.answers.inference,
      write: (draft, value) => replaceAnswer(draft, "inference", value as OnboardInferenceIntent),
      prompt: ({ draft, previous, direction }) =>
        promptInference(deps, draft, previous as OnboardInferenceIntent | undefined, direction),
    },
    {
      id: "sandbox",
      label: STEP_LABELS.sandbox,
      read: (draft) => draft.answers.sandbox,
      write: (draft, value) => replaceAnswer(draft, "sandbox", String(value)),
      prompt: async ({ draft, previous }) => {
        while (true) {
          const result = await promptText({
            label: "Sandbox name",
            previous:
              (previous as string | undefined) ?? deps.defaultSandboxName(draft.answers.agent!),
            deps,
          });
          if (result.kind !== "answer") return result;
          try {
            return { kind: "answer", value: deps.validateSandboxName(result.value!) };
          } catch (error) {
            deps.log(`  ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      },
    },
    {
      id: "web_search",
      label: STEP_LABELS.web_search,
      read: (draft) => draft.answers.web_search,
      write: (draft, value) => ({
        ...draft,
        answers: { ...draft.answers, web_search: value as string | null },
      }),
      prompt: ({ draft, previous, direction }) =>
        promptWebSearch(deps, draft, previous as string | null | undefined, direction),
    },
    {
      id: "messaging",
      label: STEP_LABELS.messaging,
      read: (draft) => draft.answers.messaging,
      write: (draft, value) => replaceAnswer(draft, "messaging", value as readonly string[]),
      prompt: ({ draft, previous, direction }) =>
        promptMessaging(deps, draft, previous as readonly string[] | undefined, direction),
    },
    {
      id: "tools",
      label: STEP_LABELS.tools,
      read: (draft) => draft.answers.tools,
      write: (draft, value) => replaceAnswer(draft, "tools", value as OnboardToolIntent),
      prompt: ({ draft, previous, direction }) =>
        promptManagedTools(deps, draft, previous as OnboardToolIntent | undefined, direction),
    },
    {
      id: "resources",
      label: STEP_LABELS.resources,
      read: (draft) => {
        const resources = draft.answers.resources;
        if (resources?.profile === "custom" && (!resources.cpu || !resources.memory)) {
          return undefined;
        }
        return resources;
      },
      write: (draft, value) => replaceAnswer(draft, "resources", value as OnboardResourceIntent),
      prompt: async ({ draft, previous, direction }) => {
        const prior = draft.answers.resources ?? (previous as OnboardResourceIntent | undefined);
        let profileValue = prior?.profile;
        let cpuValue = prior?.cpu ?? null;
        let memoryValue = prior?.memory ?? null;
        let stage: "profile" | "cpu" | "memory" | "gpu" =
          direction === "back" && prior ? "gpu" : "profile";
        while (true) {
          if (stage === "profile") {
            const profile = await promptChoice<string>({
              title: "Resource profile",
              choices: deps.resourceProfileChoices(),
              previous: profileValue,
              deps,
            });
            if (profile.kind !== "answer") return profile;
            if (profileValue !== profile.value) {
              cpuValue = null;
              memoryValue = null;
            }
            profileValue = profile.value;
            stage = profileValue === "custom" ? "cpu" : "gpu";
            continue;
          }
          if (stage === "cpu") {
            const cpu = await promptText({
              label: "CPU",
              previous: cpuValue ?? "25%",
              deps,
            });
            if (cpu.kind === "back") {
              stage = "profile";
              continue;
            }
            if (cpu.kind === "exit") return cpu;
            cpuValue = cpu.value;
            stage = "memory";
            continue;
          }
          if (stage === "memory") {
            const memory = await promptText({
              label: "RAM",
              previous: memoryValue ?? "25%",
              deps,
            });
            if (memory.kind === "back") {
              stage = "cpu";
              continue;
            }
            if (memory.kind === "exit") return memory;
            memoryValue = memory.value;
            stage = "gpu";
            continue;
          }
          const gpu = await promptChoice<OnboardResourceIntent["gpu"]>({
            title: "Sandbox GPU",
            choices: [
              { value: "auto", label: "Auto-detect" },
              { value: "enable", label: "Enable" },
              { value: "disable", label: "Disable" },
            ],
            previous: prior?.gpu,
            deps,
          });
          if (gpu.kind === "back") {
            stage = profileValue === "custom" ? "memory" : "profile";
            continue;
          }
          if (gpu.kind === "exit") return gpu;
          return {
            kind: "answer",
            value: {
              profile: profileValue,
              gpu: gpu.value,
              ...(cpuValue ? { cpu: cpuValue } : {}),
              ...(memoryValue ? { memory: memoryValue } : {}),
            },
          };
        }
      },
    },
    {
      id: "policy",
      label: STEP_LABELS.policy,
      read: (draft) => draft.answers.policy,
      write: (draft, value) => replaceAnswer(draft, "policy", String(value)),
      prompt: ({ previous }) =>
        promptChoice({
          title: "Policy tier",
          choices: deps.policyChoices(),
          previous: previous as string | undefined,
          deps,
        }),
    },
  ];
}

/** Collect and review the complete, secret-free onboarding configuration. */
export async function collectOnboardIntentDraft(
  deps: OnboardIntentDraftUiDeps,
  initialDraft: OnboardIntentDraft = createOnboardIntentDraft(),
): Promise<{ readonly kind: "apply" | "exit"; readonly draft: OnboardIntentDraft }> {
  const result = await collectIntentDraft({
    steps: createSteps(deps),
    initialDraft,
    review: (draft) => promptReview(deps, draft),
    reconcile: ({ previous, next, changedStep }) =>
      reconcileOnboardIntentDraft(previous, next, changedStep, deps.compatibility),
    prepareReview: (draft) => prepareDraftForReview(deps, draft),
    checkpoint: deps.checkpoint,
  });
  if (result.kind === "exit") return result;
  const accepted = { ...result.draft, phase: "accepted" as const };
  await deps.checkpoint(accepted);
  return { kind: "apply", draft: accepted };
}
