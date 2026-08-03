// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const ONBOARD_INTENT_DRAFT_VERSION = 1;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const ONBOARD_INTENT_STEP_IDS = [
  "agent",
  "inference",
  "sandbox",
  "web_search",
  "messaging",
  "tools",
  "resources",
  "policy",
] as const;

export type OnboardIntentStepId = (typeof ONBOARD_INTENT_STEP_IDS)[number];

export interface OnboardInferenceIntent {
  readonly provider: string;
  /** Null means the provider's displayed default. */
  readonly model: string | null;
  /** Non-secret endpoint metadata for compatible providers. */
  readonly endpointUrl: string | null;
  /** Authentication mechanism only; never a credential value. */
  readonly authMethod: string | null;
}

export interface OnboardResourceIntent {
  readonly profile: string;
  readonly gpu: "auto" | "enable" | "disable";
  readonly cpu?: string | null;
  readonly memory?: string | null;
}

export interface OnboardToolIntent {
  /** Secret-free Hermes managed gateway preset names. */
  readonly hermesGateways: readonly string[];
}

export interface OnboardIntentAnswers {
  readonly agent?: string;
  readonly inference?: OnboardInferenceIntent;
  readonly sandbox?: string;
  readonly web_search?: string | null;
  readonly messaging?: readonly string[];
  readonly tools?: OnboardToolIntent;
  readonly resources?: OnboardResourceIntent;
  readonly policy?: string;
}

export interface OnboardIntentDraft {
  readonly version: typeof ONBOARD_INTENT_DRAFT_VERSION;
  readonly phase: "collecting" | "accepted";
  readonly answers: OnboardIntentAnswers;
}

export interface OnboardIntentCompatibility {
  provider(agent: string, inference: OnboardInferenceIntent): boolean;
  model(agent: string, inference: OnboardInferenceIntent): boolean;
  webSearch(agent: string, provider: string): boolean;
  messaging(agent: string, channel: string): boolean;
}

export function createOnboardIntentDraft(answers: OnboardIntentAnswers = {}): OnboardIntentDraft {
  return { version: ONBOARD_INTENT_DRAFT_VERSION, phase: "collecting", answers };
}

function withoutAnswers(
  draft: OnboardIntentDraft,
  fields: readonly (keyof OnboardIntentAnswers)[],
): OnboardIntentDraft {
  const answers = { ...draft.answers };
  for (const field of fields) delete answers[field];
  return { ...draft, answers };
}

function changed<Value>(before: Value, after: Value): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

/**
 * Preserve later answers only while they remain compatible with an edited
 * upstream answer. Derived policy intent is always recollected when an input
 * to policy planning changes.
 */
export function reconcileOnboardIntentDraft(
  previous: OnboardIntentDraft,
  next: OnboardIntentDraft,
  changedStep: OnboardIntentStepId,
  compatibility: OnboardIntentCompatibility,
): OnboardIntentDraft {
  const before = previous.answers;
  const after = next.answers;
  if (!changed(before[changedStep], after[changedStep])) return next;

  if (changedStep === "agent") {
    const agent = after.agent;
    if (!agent)
      return withoutAnswers(next, ["inference", "web_search", "messaging", "tools", "policy"]);
    let reconciled = next;
    const inference = reconciled.answers.inference;
    if (inference && !compatibility.provider(agent, inference)) {
      reconciled = withoutAnswers(reconciled, ["inference"]);
    } else if (inference && !compatibility.model(agent, inference)) {
      reconciled = {
        ...reconciled,
        answers: {
          ...reconciled.answers,
          inference: { ...inference, model: null },
        },
      };
    }
    const webSearch = reconciled.answers.web_search;
    if (webSearch && !compatibility.webSearch(agent, webSearch)) {
      reconciled = withoutAnswers(reconciled, ["web_search"]);
    }
    const messaging = reconciled.answers.messaging;
    if (messaging) {
      const supported = messaging.filter((channel) => compatibility.messaging(agent, channel));
      if (supported.length !== messaging.length) {
        reconciled = {
          ...reconciled,
          answers: { ...reconciled.answers, messaging: supported },
        };
      }
    }
    return withoutAnswers(reconciled, ["tools", "policy"]);
  }

  if (changedStep === "inference") {
    return withoutAnswers(next, ["tools", "policy"]);
  }

  if (changedStep === "web_search" || changedStep === "messaging" || changedStep === "tools") {
    return withoutAnswers(next, ["policy"]);
  }

  return next;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Accept endpoint metadata only when it cannot carry URL credentials. */
export function validateOnboardIntentEndpointUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Endpoint URL must be a valid http or https URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Endpoint URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Endpoint URL must not contain a username or password.");
  }
  if (parsed.search) {
    throw new Error("Endpoint URL must not contain query parameters.");
  }
  if (parsed.hash) {
    throw new Error("Endpoint URL must not contain a fragment.");
  }
  return parsed.toString();
}

function parseInference(value: unknown): OnboardInferenceIntent | undefined {
  if (!isObjectRecord(value)) return undefined;
  const provider = readString(value.provider);
  if (!provider) return undefined;
  const model = value.model === null ? null : readString(value.model);
  let endpointUrl: string | null = null;
  if (value.endpointUrl !== null) {
    const rawEndpointUrl = readString(value.endpointUrl);
    if (!rawEndpointUrl) return undefined;
    try {
      endpointUrl = validateOnboardIntentEndpointUrl(rawEndpointUrl);
    } catch {
      return undefined;
    }
  }
  const authMethod = value.authMethod === null ? null : readString(value.authMethod);
  if (value.model !== null && !model) return undefined;
  if (value.authMethod !== null && !authMethod) return undefined;
  return { provider, model, endpointUrl, authMethod };
}

function parseResources(value: unknown): OnboardResourceIntent | undefined {
  if (!isObjectRecord(value)) return undefined;
  const profile = readString(value.profile);
  const gpu = value.gpu;
  if (!profile || (gpu !== "auto" && gpu !== "enable" && gpu !== "disable")) return undefined;
  const cpu = value.cpu === null || value.cpu === undefined ? null : readString(value.cpu);
  const memory =
    value.memory === null || value.memory === undefined ? null : readString(value.memory);
  if (
    (value.cpu !== null && value.cpu !== undefined && !cpu) ||
    (value.memory !== null && value.memory !== undefined && !memory)
  ) {
    return undefined;
  }
  return {
    profile,
    gpu,
    ...(cpu ? { cpu } : {}),
    ...(memory ? { memory } : {}),
  };
}

function parseTools(value: unknown): OnboardToolIntent | undefined {
  if (!isObjectRecord(value) || !Array.isArray(value.hermesGateways)) return undefined;
  if (!value.hermesGateways.every((item) => readString(item))) return undefined;
  return { hermesGateways: value.hermesGateways.map((item) => String(item).trim()) };
}

/** Parse only the fixed, secret-free draft schema; unknown fields are discarded. */
export function parseOnboardIntentDraft(value: unknown): OnboardIntentDraft | null {
  if (!isObjectRecord(value) || value.version !== ONBOARD_INTENT_DRAFT_VERSION) return null;
  if (value.phase !== "collecting" && value.phase !== "accepted") return null;
  if (!isObjectRecord(value.answers)) return null;

  const source = value.answers;
  const answers: OnboardIntentAnswers = {};
  if (Object.hasOwn(source, "agent")) {
    const agent = readString(source.agent);
    if (!agent) return null;
    Object.assign(answers, { agent });
  }
  if (Object.hasOwn(source, "inference")) {
    const inference = parseInference(source.inference);
    if (!inference) return null;
    Object.assign(answers, { inference });
  }
  if (Object.hasOwn(source, "sandbox")) {
    const sandbox = readString(source.sandbox);
    if (!sandbox) return null;
    Object.assign(answers, { sandbox });
  }
  if (Object.hasOwn(source, "web_search")) {
    const webSearch = source.web_search === null ? null : readString(source.web_search);
    if (source.web_search !== null && !webSearch) return null;
    Object.assign(answers, { web_search: webSearch });
  }
  if (Object.hasOwn(source, "messaging")) {
    if (!Array.isArray(source.messaging) || !source.messaging.every((item) => readString(item))) {
      return null;
    }
    Object.assign(answers, { messaging: source.messaging.map((item) => String(item).trim()) });
  }
  if (Object.hasOwn(source, "tools")) {
    const tools = parseTools(source.tools);
    if (!tools) return null;
    Object.assign(answers, { tools });
  }
  if (Object.hasOwn(source, "resources")) {
    const resources = parseResources(source.resources);
    if (!resources) return null;
    Object.assign(answers, { resources });
  }
  if (Object.hasOwn(source, "policy")) {
    const policy = readString(source.policy);
    if (!policy) return null;
    Object.assign(answers, { policy });
  }

  return { version: ONBOARD_INTENT_DRAFT_VERSION, phase: value.phase, answers };
}
