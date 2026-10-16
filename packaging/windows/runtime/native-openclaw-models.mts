// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type AgentDefaults = Record<string, unknown> & {
  model?: string | { primary?: string; fallbacks?: string[] };
  models?: Record<string, unknown>;
};
type PreviousConfiguration = {
  agents?: Record<string, unknown> & { defaults?: AgentDefaults; list?: unknown[] };
  [key: string]: unknown;
};
export type NativeModelCatalog = {
  provider: string;
  configuration: Record<string, unknown> & { models: (Record<string, unknown> & { id: string })[] };
  references: Record<string, string>;
  referenceAliases?: Record<string, string>;
};

/** Rebind transport on launch without resetting native model choices or tuning. */
export function nativeOpenClawModels(
  catalog: NativeModelCatalog,
  initialModel: string,
  previous: PreviousConfiguration = {},
  resetSelection = false,
) {
  const references = new Set(Object.values(catalog.references));
  const migrate = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    if (references.has(value)) return value;
    const alias = catalog.referenceAliases?.[value];
    if (alias && references.has(alias)) return alias;
    if (value.startsWith("nemoclawNative/"))
      return catalog.references[value.slice("nemoclawNative/".length)];
    return undefined;
  };
  const defaults = previous.agents?.defaults ?? {};
  const prior = typeof defaults.model === "string" ? { primary: defaults.model } : defaults.model;
  const primary =
    (resetSelection ? undefined : migrate(prior?.primary)) ?? catalog.references[initialModel];
  if (!primary)
    throw new Error(
      "The selected model is not available in OpenClaw's provider catalog. Configure an available model before starting.",
    );
  const priorModels = Object.fromEntries(
    Object.entries(defaults.models ?? {}).flatMap(([key, value]) => {
      const reference = migrate(key);
      return reference ? [[reference, value]] : [];
    }),
  );
  const models = Object.fromEntries(
    Object.values(catalog.references).map((reference) => [reference, priorModels[reference] ?? {}]),
  );
  return {
    models: { mode: "replace", providers: { [catalog.provider]: catalog.configuration } },
    agents: {
      ...previous.agents,
      defaults: {
        timeoutSeconds: 180,
        skipBootstrap: true,
        thinkingDefault: "off",
        ...defaults,
        models,
        model: {
          primary,
          ...(Array.isArray(prior?.fallbacks)
            ? { fallbacks: prior.fallbacks.map(migrate).filter(Boolean) }
            : {}),
        },
      },
      list: previous.agents?.list ?? [{ id: "main", default: true }],
    },
  };
}
