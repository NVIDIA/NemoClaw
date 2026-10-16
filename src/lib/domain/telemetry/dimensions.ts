// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  TelemetryAgent,
  TelemetryConfiguration,
  TelemetryMetadataError,
  TelemetryModel,
  ValueStatus,
} from "./event";
import {
  readModelSelectionProvenance,
  readMatchingNativeModelSelection,
  readModelAssignmentSelection,
  type ModelAssignmentSelection,
  type ModelSelectionProvenance,
} from "./provenance";

import {
  AGENT_HARNESS_IDS,
  TELEMETRY_MODEL_IDS,
  TELEMETRY_API_FAMILIES,
  TELEMETRY_MODEL_KEYS,
  dataRecord,
  classifyTelemetryProvider,
} from "./values";
export {
  AGENT_HARNESS_IDS,
  TELEMETRY_MODEL_IDS,
  TELEMETRY_PROVIDER_PROFILES,
  TELEMETRY_API_FAMILIES,
  MODEL_SELECTION_SOURCES,
  COMPUTE_DRIVERS,
  GPU_STATES,
  MESSAGING_CHANNELS,
  POLICY_TIER_CATEGORIES,
  SANDBOX_OPERATING_SYSTEMS,
  MANAGED_AGENT_VERSIONS,
  TELEMETRY_MODEL_KEYS,
  dataRecord,
  classifyTelemetryProvider,
} from "./values";

const NATIVE_PROVIDERS: Readonly<Record<string, string>> = {
  nvidia: "nvidia",
  openai: "openai",
  anthropic: "anthropic",
  google: "google-gemini",
  "google-gemini": "google-gemini",
  openrouter: "openrouter",
  ollama: "ollama",
  vllm: "vllm",
  "llama-cpp": "llama-cpp",
  custom: "custom",
};

export function approvedCategory(
  value: unknown,
  allowed: readonly string[],
): { value: string; status: ValueStatus } {
  if (value === undefined || value === null || value === "")
    return { value: "unknown", status: "not_persisted" };
  if (typeof value !== "string") return { value: "unknown", status: "collection_error" };
  return allowed.includes(value) && value !== "unknown" && value !== "other"
    ? { value, status: "reported" }
    : { value: "other", status: "unapproved" };
}

export function classifyTelemetryAgent(
  value: unknown,
): Pick<TelemetryAgent, "agentHarnessId" | "agentHarnessStatus"> {
  const category = approvedCategory(value, AGENT_HARNESS_IDS);
  return { agentHarnessId: category.value, agentHarnessStatus: category.status };
}

export function classifyTelemetryApi(value: unknown): string {
  return typeof value === "string" && TELEMETRY_API_FAMILIES.some((item) => item === value)
    ? value
    : "unknown";
}

export function classifyTelemetrySandboxOS(raw: string): { value: string; status: ValueStatus } {
  const name = raw.trim();
  if (name === "Linux") return { value: "linux", status: "reported" };
  if (/^(?:Windows_NT|MINGW(?:32|64)_NT|MSYS_NT|CYGWIN_NT)(?:-[0-9]+(?:[.-][0-9]+)*)?$/.test(name))
    return { value: "windows", status: "reported" };
  if (["Darwin", "FreeBSD", "OpenBSD", "NetBSD", "SunOS", "AIX"].includes(name))
    return { value: "other", status: "unapproved" };
  return { value: "unknown", status: "collection_error" };
}

export interface RuntimeRouteAuthority {
  model?: string | null;
  provider?: string | null;
  modelSelectionProvenance?: unknown;
  nativeModelSelectionProvenance?: unknown;
  modelAssignmentSelections?: unknown;
  metadataErrors?: readonly TelemetryMetadataError[];
}

type ModelReference = {
  model: string;
  providerKey: string;
  api?: unknown;
  managed: boolean;
  nativeConfiguration?: unknown;
};

type AssignmentSources = {
  selections: Map<string, ModelAssignmentSelection>;
  conflicts: Set<string>;
  invalid: boolean;
};

function assignmentKey(
  agentId: string,
  assignment: TelemetryModel["assignment"],
  reference: string,
): string {
  return JSON.stringify([agentId, assignment, reference]);
}

function readAssignmentSources(value: unknown): AssignmentSources {
  const result: AssignmentSources = { selections: new Map(), conflicts: new Set(), invalid: false };
  if (value === undefined) return result;
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    !Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
      Object.hasOwn(descriptor, "value"),
    )
  ) {
    result.invalid = true;
    return result;
  }
  for (let index = 0; index < value.length; index += 1) {
    const selection = readModelAssignmentSelection(value[index]);
    if (!selection) {
      result.invalid = true;
      continue;
    }
    const key = assignmentKey(selection.agentId, selection.assignment, selection.reference);
    const previous = result.selections.get(key);
    if (previous && previous.modelSource !== selection.modelSource) {
      result.conflicts.add(key);
      result.invalid = true;
    } else result.selections.set(key, selection);
  }
  return result;
}

function projectAssignmentSource(
  reference: ModelReference,
  assignment: TelemetryModel["assignment"],
  authority: RuntimeRouteAuthority,
  bound: ModelSelectionProvenance | null,
  slot?: { agentId: string; reference: string; inherited: boolean; sources: AssignmentSources },
): { value: string; status: ValueStatus } {
  const failedWrite = authority.metadataErrors?.some(
    (error) =>
      (error.category === "native_model_source" &&
        reference.nativeConfiguration !== undefined &&
        assignment === "primary") ||
      (error.category === "model_source" &&
        (error.slot
          ? error.slot.agentId === slot?.agentId &&
            error.slot.assignment === assignment &&
            error.slot.reference === slot?.reference
          : reference.managed &&
            !(
              reference.nativeConfiguration !== undefined &&
              authority.nativeModelSelectionProvenance !== undefined
            ) &&
            (slot?.inherited ?? assignment === "primary"))),
  );
  if (failedWrite) return { value: "unknown", status: "collection_error" };
  if (slot) {
    const key = assignmentKey(slot.agentId, assignment, slot.reference);
    const explicit = slot.sources.selections.get(key);
    if (slot.sources.conflicts.has(key)) return { value: "unknown", status: "collection_error" };
    if (explicit)
      return explicit.modelSource === "unknown"
        ? { value: "unknown", status: "not_persisted" }
        : { value: explicit.modelSource, status: "reported" };
    if (slot.sources.invalid) return { value: "unknown", status: "collection_error" };
  }
  if (
    (slot?.inherited ?? assignment === "primary") &&
    (reference.managed ||
      (reference.nativeConfiguration !== undefined &&
        authority.nativeModelSelectionProvenance !== undefined)) &&
    reference.model === bound?.model &&
    bound &&
    bound.modelSource !== "unknown"
  )
    return { value: bound.modelSource, status: "reported" };
  return {
    value: "unknown",
    status:
      (reference.nativeConfiguration !== undefined &&
      authority.nativeModelSelectionProvenance !== undefined
        ? authority.nativeModelSelectionProvenance
        : reference.managed
          ? authority.modelSelectionProvenance
          : undefined) !== undefined && !bound
        ? "collection_error"
        : "not_persisted",
  };
}

function projectModel(
  reference: ModelReference,
  assignment: TelemetryModel["assignment"],
  authority: RuntimeRouteAuthority,
  slot?: { agentId: string; reference: string; inherited: boolean; sources: AssignmentSources },
): TelemetryModel {
  const model = approvedCategory(reference.model, TELEMETRY_MODEL_IDS);
  const nativeChoice =
    reference.nativeConfiguration !== undefined &&
    authority.nativeModelSelectionProvenance !== undefined;
  const parsed = readModelSelectionProvenance(
    nativeChoice ? authority.nativeModelSelectionProvenance : authority.modelSelectionProvenance,
  );
  const bound =
    parsed &&
    (nativeChoice
      ? readMatchingNativeModelSelection(
          reference.nativeConfiguration,
          authority.nativeModelSelectionProvenance,
        ) !== null
      : reference.managed &&
        parsed.model === authority.model &&
        parsed.provider === authority.provider)
      ? parsed
      : null;
  const source = projectAssignmentSource(reference, assignment, authority, bound, slot);
  const gatewayReceipt = readModelSelectionProvenance(authority.modelSelectionProvenance);
  const gatewayProvider =
    gatewayReceipt &&
    gatewayReceipt.model === authority.model &&
    gatewayReceipt.provider === authority.provider
      ? gatewayReceipt.providerProfile
      : undefined;
  const provider = reference.managed
    ? (bound?.providerProfile ?? gatewayProvider ?? classifyTelemetryProvider(authority.provider))
    : reference.providerKey
      ? (NATIVE_PROVIDERS[reference.providerKey] ?? "custom")
      : "unknown";
  const api = classifyTelemetryApi(reference.api);
  return {
    assignment,
    modelId: model.value,
    modelStatus: model.status,
    knownModelKey: TELEMETRY_MODEL_KEYS[model.value] ?? model.value,
    knownModelKeyStatus: model.status,
    modelSource: source.value,
    modelSourceStatus: source.status,
    providerProfile: provider,
    providerStatus:
      provider !== "unknown"
        ? "reported"
        : reference.managed && authority.provider == null
          ? "not_persisted"
          : "collection_error",
    apiFamily: api,
    apiStatus:
      api !== "unknown" ? "reported" : reference.api === undefined ? "unavailable" : "unapproved",
  };
}

export function unknownModel(
  assignment: TelemetryModel["assignment"],
  status: ValueStatus = "collection_error",
): TelemetryModel {
  return {
    assignment,
    modelId: "unknown",
    modelStatus: status,
    knownModelKey: "unknown",
    knownModelKeyStatus: status,
    modelSource: "unknown",
    modelSourceStatus: status,
    providerProfile: "unknown",
    providerStatus: status,
    apiFamily: "unknown",
    apiStatus: status,
  };
}

/** Current gateway routing is observed independently of configured native agent defaults. */
export function projectCurrentInferenceRoute(
  observation:
    | { ok: false }
    | {
        ok: true;
        value:
          | { state: "unconfigured" }
          | { state: "configured"; route: { model: string; provider: string } };
      },
  authority: RuntimeRouteAuthority,
): Pick<TelemetryConfiguration, "currentInferenceRoute" | "currentInferenceRouteStatus"> {
  if (!observation.ok || observation.value.state === "unconfigured") {
    const status = observation.ok ? "not_configured" : "collection_error";
    return {
      currentInferenceRoute: unknownModel("primary", status),
      currentInferenceRouteStatus: status,
    };
  }
  const route = observation.value.route;
  const receipt = readModelSelectionProvenance(authority.modelSelectionProvenance);
  const matching = receipt?.model === route.model && receipt.provider === route.provider;
  const currentInferenceRoute = projectModel(
    {
      model: route.model,
      providerKey: "",
      managed: true,
      api: matching ? receipt.apiFamily : undefined,
    },
    "primary",
    {
      ...authority,
      model: route.model,
      provider: route.provider,
      nativeModelSelectionProvenance: undefined,
    },
  );
  if (!matching)
    currentInferenceRoute.apiStatus =
      authority.modelSelectionProvenance === undefined ? "not_persisted" : "collection_error";
  return { currentInferenceRoute, currentInferenceRouteStatus: "reported" };
}

function modelSelection(value: unknown): {
  primary?: string;
  fallbacks?: unknown[];
  invalid?: boolean;
} {
  if (value === undefined) return {};
  if (typeof value === "string") return value.length > 0 ? { primary: value } : { invalid: true };
  const record = dataRecord(value);
  if (!record) return { invalid: true };
  const primary =
    typeof record.primary === "string" && record.primary.length > 0 ? record.primary : undefined;
  return {
    primary,
    invalid: record.primary !== undefined && primary === undefined,
    ...(record.fallbacks !== undefined
      ? { fallbacks: Array.isArray(record.fallbacks) ? record.fallbacks : [undefined] }
      : {}),
  };
}

function openClawReference(value: string, config: Record<string, unknown>): ModelReference {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1)
    throw new Error("Invalid native model reference");
  const providerKey = value.slice(0, separator);
  const provider = dataRecord(dataRecord(dataRecord(config.models)?.providers)?.[providerKey]);
  const api =
    provider?.api ??
    (providerKey === "anthropic"
      ? "anthropic-messages"
      : providerKey === "openai" || providerKey === "inference"
        ? "openai-completions"
        : undefined);
  const managed =
    typeof provider?.baseUrl === "string" &&
    /^https:\/\/inference\.local(?:\/v1)?\/?$/.test(provider.baseUrl);
  return { model: value.slice(separator + 1), providerKey, api, managed };
}

/** Native roster IDs are used only for local joins; none are returned in the event. */
export function parseRuntimeRoster(raw: string): Record<string, unknown>[] {
  let parsed: unknown;
  const text = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  try {
    parsed = JSON.parse(text);
  } catch {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== "[" && text[index] !== "{") continue;
      try {
        parsed = JSON.parse(text.slice(index));
        break;
      } catch {
        /* Native warning prefixes may contain brackets. */
      }
    }
    if (parsed === undefined) throw new Error("Missing native agent roster");
  }
  const rows = Array.isArray(parsed) ? parsed : dataRecord(parsed)?.agents;
  if (!Array.isArray(rows)) throw new Error("Invalid native agent roster");
  const ids = new Set<string>();
  return rows.map((value) => {
    const row = dataRecord(value);
    if (!row || typeof row.id !== "string" || row.id.length === 0 || ids.has(row.id))
      throw new Error("Invalid native agent roster entry");
    ids.add(row.id);
    return row;
  });
}

type RuntimeAgentProjection = Pick<
  TelemetryConfiguration,
  "agents" | "agentsStatus" | "defaultAgentModel"
>;

export function projectRuntimeAgents(
  runtime: Omit<TelemetryAgent, "models" | "modelsStatus">,
  config: unknown,
  roster: readonly Record<string, unknown>[] | undefined,
  authority: RuntimeRouteAuthority,
): RuntimeAgentProjection {
  if (runtime.agentHarnessId === "openclaw" && roster?.length === 0)
    return {
      agents: [],
      agentsStatus: "reported",
      defaultAgentModel: { agentPosition: -1, modelPosition: -1, status: "not_configured" },
    };
  const root = dataRecord(config);
  if (!root) {
    if (!roster) throw new Error("Invalid native configuration");
    return {
      agents: roster.map(() => ({
        ...runtime,
        modelsStatus: "collection_error",
        models: [unknownModel("primary")],
      })),
      agentsStatus: "reported",
      defaultAgentModel: { agentPosition: -1, modelPosition: -1, status: "collection_error" },
    };
  }
  if (runtime.agentHarnessId === "openclaw") {
    if (!roster) throw new Error("Missing native roster");
    const native = dataRecord(root.agents);
    if (!native) throw new Error("Missing native agent configuration");
    const defaultsConfig = dataRecord(native.defaults);
    const defaults = modelSelection(defaultsConfig?.model);
    const sources = readAssignmentSources(authority.modelAssignmentSelections);
    const entries = dataRecord(native.entries);
    const legacy = native.list;
    if (native.entries !== undefined && !entries)
      throw new Error("Invalid keyed agent configuration");
    if (
      legacy !== undefined &&
      (!Array.isArray(legacy) || !legacy.every((value) => dataRecord(value)))
    )
      throw new Error("Invalid legacy agent configuration");
    const projected = roster.map((row) => {
      const configured = entries
        ? dataRecord(entries[row.id as string])
        : Array.isArray(legacy)
          ? legacy.map(dataRecord).find((entry) => entry?.id === row.id)
          : null;
      const mismatch = Boolean((entries || legacy) && !configured);
      const override = modelSelection(configured?.model);
      const primary = override.primary ?? defaults.primary;
      const assignment =
        override.primary !== undefined || override.invalid ? "override" : "primary";
      const readModel = (value: unknown, assignment: TelemetryModel["assignment"]) => {
        try {
          if (typeof value !== "string" || mismatch) throw new Error("Invalid effective model");
          return projectModel(openClawReference(value, root), assignment, authority, {
            agentId: row.id as string,
            reference: value,
            inherited: assignment === "primary",
            sources,
          });
        } catch {
          return unknownModel(assignment);
        }
      };
      const models = [
        readModel(
          override.invalid || (!override.primary && defaults.invalid) ? undefined : primary,
          assignment,
        ),
        ...(override.fallbacks ?? defaults.fallbacks ?? []).map((model) =>
          readModel(model, "fallback"),
        ),
      ];
      const inheritedSubagents = dataRecord(defaultsConfig?.subagents);
      const overrideSubagents = dataRecord(configured?.subagents);
      const subagent =
        overrideSubagents?.model !== undefined
          ? overrideSubagents.model
          : inheritedSubagents?.model;
      const invalidSubagent =
        (configured?.subagents !== undefined && !overrideSubagents) ||
        (overrideSubagents?.model === undefined &&
          defaultsConfig?.subagents !== undefined &&
          !inheritedSubagents);
      if (invalidSubagent || subagent !== undefined)
        models.push(readModel(invalidSubagent ? undefined : subagent, "subagent"));
      const modelsStatus: ValueStatus =
        sources.invalid || models.some((model) => Object.values(model).includes("collection_error"))
          ? "collection_error"
          : "reported";
      return {
        agent: { ...runtime, modelsStatus, models },
        primary:
          row.isDefault === true ||
          (native.ownership !== "explicit" && configured?.default === true),
        invalidDefault:
          mismatch ||
          (roster.length > 1 && (!configured || typeof row.isDefault !== "boolean")) ||
          (row.isDefault !== undefined && typeof row.isDefault !== "boolean") ||
          (native.ownership !== "explicit" &&
            configured?.default !== undefined &&
            typeof configured.default !== "boolean"),
      };
    });
    const primary = projected.flatMap((row, index) => (row.primary ? [index] : []));
    const validDefaultEvidence = projected.every((row) => !row.invalidDefault);
    // A single observed logical agent is unambiguously the default runtime agent.
    const index =
      projected.length === 1 ? 0 : validDefaultEvidence && primary.length === 1 ? primary[0] : -1;
    return {
      agents: projected.map((row) => row.agent),
      agentsStatus: "reported",
      defaultAgentModel: {
        agentPosition: index,
        modelPosition: index >= 0 && projected[index].agent.models.length > 0 ? 0 : -1,
        status:
          index >= 0 && projected[index].agent.models[0]?.modelStatus !== "collection_error"
            ? "reported"
            : validDefaultEvidence && primary.length === 0 && projected.length > 1
              ? "not_configured"
              : "collection_error",
      },
    };
  }
  let reference: ModelReference;
  if (runtime.agentHarnessId === "hermes") {
    const model = dataRecord(root.model);
    if (!model || typeof model.default !== "string" || model.default.length === 0)
      throw new Error("Missing native Hermes model");
    const modes: Readonly<Record<string, string>> = {
      anthropic_messages: "anthropic-messages",
      codex_responses: "openai-responses",
    };
    reference = {
      model: model.default,
      providerKey: typeof model.provider === "string" ? model.provider : "",
      nativeConfiguration: root,
      api:
        model.api_mode === undefined || model.api_mode === ""
          ? "openai-completions"
          : typeof model.api_mode === "string"
            ? (modes[model.api_mode] ?? model.api_mode)
            : model.api_mode,
      managed:
        typeof model.base_url === "string" &&
        /^https:\/\/inference\.local(?:\/v1)?\/?$/.test(model.base_url),
    };
  } else if (runtime.agentHarnessId === "langchain-deepagents-code") {
    const models = dataRecord(root.models);
    if (!models || typeof models.default !== "string")
      throw new Error("Missing native DCode model");
    const separator = models.default.indexOf(":");
    if (separator <= 0 || separator === models.default.length - 1)
      throw new Error("Invalid native DCode model");
    const providerKey = models.default.slice(0, separator);
    const provider = dataRecord(dataRecord(models.providers)?.[providerKey]);
    const params = dataRecord(provider?.params);
    const modelParams = dataRecord(params?.[models.default.slice(separator + 1)]);
    reference = {
      model: models.default.slice(separator + 1),
      providerKey,
      api:
        providerKey === "openai" || providerKey === "openrouter"
          ? (modelParams?.use_responses_api ?? params?.use_responses_api) === true
            ? "openai-responses"
            : "openai-completions"
          : undefined,
      managed:
        typeof provider?.base_url === "string" &&
        /^https:\/\/inference\.local(?:\/v1)?\/?$/.test(provider.base_url),
    };
  } else
    return {
      agents: [],
      agentsStatus: "unapproved",
      defaultAgentModel: { agentPosition: -1, modelPosition: -1, status: "unapproved" },
    };
  const model = projectModel(reference, "primary", authority);
  return {
    agents: [
      {
        ...runtime,
        modelsStatus: Object.values(model).includes("collection_error")
          ? "collection_error"
          : "reported",
        models: [model],
      },
    ],
    agentsStatus: "reported",
    defaultAgentModel: { agentPosition: 0, modelPosition: 0, status: "reported" },
  };
}
