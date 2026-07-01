// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { BUILT_IN_CHANNEL_MODULES } from "./channels";
import { type BuiltInMessagingHookOptions } from "./hooks";
import { createCommonHookRegistrations } from "./hooks";
import { MessagingHookRegistry, type MessagingHookRegistration } from "./hooks";
import {
  type ChannelManifest,
  type ChannelPolicyPresetReference,
  type ChannelPolicyPresetSpec,
  createChannelManifestRegistry,
  type ChannelManifestRegistry,
  type MessagingAgentId,
  type MessagingChannelId,
} from "./manifest";
import type { RenderTemplateReferenceResolver } from "./compiler/engines/template";
import { MessagingWorkflowPlanner } from "./compiler";
import {
  type MessagingChannelModule,
  type MessagingPolicyContribution,
  validateMessagingChannelModule,
} from "./channels/module";

export interface MessagingWorkflowPlannerOptions {
  readonly hooks?: "built-in" | "none";
  readonly hookOptions?: BuiltInMessagingHookOptions;
}

export interface MessagingCatalogAvailabilityOptions {
  readonly agent?: MessagingAgentId | null;
}

export interface MessagingCatalogPolicyOptions {
  readonly agent?: MessagingAgentId | null;
}

export interface MessagingCatalogPolicyLoadOptions {
  readonly agent: MessagingAgentId;
}

export interface MessagingCatalog {
  listChannels(): readonly MessagingChannelModule[];
  listAvailable(options?: MessagingCatalogAvailabilityOptions): readonly MessagingChannelModule[];
  createManifestRegistry(): ChannelManifestRegistry;
  createHookRegistry(options?: BuiltInMessagingHookOptions): MessagingHookRegistry;
  createTemplateResolver(): RenderTemplateReferenceResolver;
  createWorkflowPlanner(options?: MessagingWorkflowPlannerOptions): MessagingWorkflowPlanner;
  listPolicyContributions(
    options?: MessagingCatalogPolicyOptions,
  ): readonly MessagingPolicyContribution[];
  loadPolicyPreset(preset: string, options: MessagingCatalogPolicyLoadOptions): string | null;
  policyKeysForChannel(
    channelId: MessagingChannelId,
    options: MessagingCatalogPolicyLoadOptions,
  ): readonly string[];
}

export interface StaticMessagingCatalogOptions {
  readonly modules: readonly MessagingChannelModule[];
  readonly createHookRegistrations?: (
    options?: BuiltInMessagingHookOptions,
  ) => readonly MessagingHookRegistration[];
  readonly resolveModuleHookOptions?: (
    module: MessagingChannelModule,
    options?: BuiltInMessagingHookOptions,
  ) => unknown;
  readonly templateResolver?: RenderTemplateReferenceResolver;
  readonly policyRoot?: string;
}

export class StaticMessagingCatalog implements MessagingCatalog {
  private readonly modules: readonly MessagingChannelModule[];
  private readonly createHookRegistrations: (
    options?: BuiltInMessagingHookOptions,
  ) => readonly MessagingHookRegistration[];
  private readonly resolveModuleHookOptions: (
    module: MessagingChannelModule,
    options?: BuiltInMessagingHookOptions,
  ) => unknown;
  private readonly templateResolver: RenderTemplateReferenceResolver;
  private readonly policyRoot: string;

  constructor(options: StaticMessagingCatalogOptions) {
    this.modules = validateChannelModules(options.modules);
    this.createHookRegistrations = options.createHookRegistrations ?? (() => []);
    this.resolveModuleHookOptions = options.resolveModuleHookOptions ?? (() => undefined);
    this.templateResolver = options.templateResolver ?? (() => undefined);
    this.policyRoot =
      options.policyRoot ?? path.resolve(process.cwd(), "nemoclaw-blueprint/policies/presets");
  }

  listChannels(): readonly MessagingChannelModule[] {
    return [...this.modules];
  }

  listAvailable(
    options: MessagingCatalogAvailabilityOptions = {},
  ): readonly MessagingChannelModule[] {
    const agent = options.agent;
    if (!agent) return this.listChannels();
    return this.modules.filter((module) => module.manifest().supportedAgents.includes(agent));
  }

  createManifestRegistry(): ChannelManifestRegistry {
    return createChannelManifestRegistry(this.modules.map((module) => module.manifest()));
  }

  createHookRegistry(options?: BuiltInMessagingHookOptions): MessagingHookRegistry {
    return new MessagingHookRegistry([
      ...this.createHookRegistrations(options),
      ...this.modules.flatMap(
        (module) => module.hooks?.(this.resolveModuleHookOptions(module, options)) ?? [],
      ),
    ]);
  }

  createTemplateResolver(): RenderTemplateReferenceResolver {
    const moduleResolvers = this.modules.flatMap((module) =>
      (module.templates?.() ?? []).map((resolver) => resolver.resolve),
    );
    return (reference, context) => {
      for (const resolver of moduleResolvers) {
        const resolved = resolver(reference, context);
        if (resolved) return resolved;
      }
      return this.templateResolver(reference, context);
    };
  }

  createWorkflowPlanner(options: MessagingWorkflowPlannerOptions = {}): MessagingWorkflowPlanner {
    return new MessagingWorkflowPlanner(
      this.createManifestRegistry(),
      options.hooks === "none" ? undefined : this.createHookRegistry(options.hookOptions),
      this.createTemplateResolver(),
    );
  }

  listPolicyContributions(
    options: MessagingCatalogPolicyOptions = {},
  ): readonly MessagingPolicyContribution[] {
    const agent = options.agent ?? null;
    return this.modules.flatMap((module) => {
      const explicit = module.policies?.();
      const contributions =
        explicit && explicit.length > 0
          ? explicit.map((contribution) =>
              normalizeExplicitPolicyContribution(contribution, module.manifest(), this.policyRoot),
            )
          : policyContributionsFromManifest(module.manifest(), this.policyRoot);
      return agent
        ? contributions.filter((contribution) => contributionSupportsAgent(contribution, agent))
        : contributions;
    });
  }

  loadPolicyPreset(preset: string, options: MessagingCatalogPolicyLoadOptions): string | null {
    const contribution = this.listPolicyContributions({ agent: options.agent }).find(
      (entry) => entry.preset === preset,
    );
    if (!contribution) return null;
    const sourcePath = resolvePolicyContributionSourcePath(contribution, this.policyRoot);
    if (!sourcePath) return null;
    return fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, "utf-8") : null;
  }

  policyKeysForChannel(
    channelId: MessagingChannelId,
    options: MessagingCatalogPolicyLoadOptions,
  ): readonly string[] {
    return uniqueStrings(
      this.listPolicyContributions({ agent: options.agent })
        .filter((contribution) => contributionChannelId(contribution) === channelId)
        .flatMap((contribution) => contribution.policyKeys ?? [contribution.preset]),
    );
  }
}

export function createMessagingCatalog(options: StaticMessagingCatalogOptions): MessagingCatalog {
  return new StaticMessagingCatalog(options);
}

export function createBuiltInMessagingCatalog(): MessagingCatalog {
  return new StaticMessagingCatalog({
    modules: BUILT_IN_CHANNEL_MODULES,
    createHookRegistrations: (options) => createCommonHookRegistrations(options?.common),
    resolveModuleHookOptions: resolveBuiltInModuleHookOptions,
  });
}

function resolveBuiltInModuleHookOptions(
  module: MessagingChannelModule,
  options?: BuiltInMessagingHookOptions,
): unknown {
  switch (module.id) {
    case "discord":
      return withOpenClawBridgeHealthOptions(options?.discord, options?.openclawBridgeHealth);
    case "slack":
      return withOpenClawBridgeHealthOptions(options?.slack, options?.openclawBridgeHealth);
    case "teams":
      return options?.teams;
    case "telegram":
      return withOpenClawBridgeHealthOptions(options?.telegram, options?.openclawBridgeHealth);
    case "wechat":
      return options?.wechat;
    default:
      return undefined;
  }
}

function withOpenClawBridgeHealthOptions<
  T extends { readonly openclawBridgeHealth?: BuiltInMessagingHookOptions["openclawBridgeHealth"] },
>(
  options: T | undefined,
  openclawBridgeHealth: BuiltInMessagingHookOptions["openclawBridgeHealth"] | undefined,
): T {
  return {
    ...options,
    openclawBridgeHealth: {
      ...openclawBridgeHealth,
      ...options?.openclawBridgeHealth,
    },
  } as T;
}

function validateChannelModules(
  modules: readonly MessagingChannelModule[],
): readonly MessagingChannelModule[] {
  const seen = new Set<string>();
  for (const module of modules) {
    const errors = validateMessagingChannelModule(module).filter(
      (issue) => issue.severity === "error",
    );
    if (errors.length > 0) {
      throw new Error(
        [
          `Invalid messaging channel module '${module.id}'.`,
          ...errors.map((issue) => `  - ${issue.message}`),
        ].join("\n"),
      );
    }
    if (seen.has(module.id)) {
      throw new Error(`Duplicate messaging channel module id '${module.id}'.`);
    }
    seen.add(module.id);
  }
  return [...modules];
}

function policyContributionsFromManifest(
  manifest: ChannelManifest,
  policyRoot: string,
): MessagingPolicyContribution[] {
  return (manifest.policyPresets ?? []).flatMap((preset): MessagingPolicyContribution[] => {
    const normalized = normalizePolicyPreset(preset);
    const source = path.relative(policyRoot, path.join(policyRoot, `${normalized.name}.yaml`));
    if (!normalized.agentPolicyKeys || Object.keys(normalized.agentPolicyKeys).length === 0) {
      return [
        {
          channelId: manifest.id,
          preset: normalized.name,
          agents: manifest.supportedAgents,
          sourceRoot: policyRoot,
          source,
          policyKeys: normalized.policyKeys ?? [normalized.name],
          requiredAtCreate: normalized.requiredAtCreate === true,
          validationWarningLines: normalized.validationWarningLines ?? [],
        },
      ];
    }

    return manifest.supportedAgents.map((agent) => ({
      channelId: manifest.id,
      preset: normalized.name,
      agent,
      sourceRoot: policyRoot,
      source,
      policyKeys: normalized.agentPolicyKeys?.[agent] ?? normalized.policyKeys ?? [normalized.name],
      requiredAtCreate: normalized.requiredAtCreate === true,
      validationWarningLines: normalized.validationWarningLines ?? [],
    }));
  });
}

function normalizePolicyPreset(preset: ChannelPolicyPresetReference): ChannelPolicyPresetSpec {
  return typeof preset === "string" ? { name: preset } : preset;
}

function normalizeExplicitPolicyContribution(
  contribution: MessagingPolicyContribution,
  manifest: ChannelManifest,
  policyRoot: string,
): MessagingPolicyContribution {
  const manifestPolicy = (manifest.policyPresets ?? [])
    .map(normalizePolicyPreset)
    .find((preset) => preset.name === contribution.preset);
  return {
    channelId: contribution.channelId ?? manifest.id,
    agent: contribution.agent,
    agents:
      contribution.agent === undefined
        ? (contribution.agents ?? manifest.supportedAgents)
        : contribution.agents,
    preset: contribution.preset,
    sourceRoot: contribution.sourceRoot ?? policyRoot,
    source: contribution.source,
    policyKeys: contribution.policyKeys ?? policyKeysForContribution(contribution, manifestPolicy),
    requiredAtCreate: contribution.requiredAtCreate ?? manifestPolicy?.requiredAtCreate === true,
    validationWarningLines:
      contribution.validationWarningLines ?? manifestPolicy?.validationWarningLines ?? [],
  };
}

function policyKeysForContribution(
  contribution: MessagingPolicyContribution,
  manifestPolicy: ChannelPolicyPresetSpec | undefined,
): readonly string[] {
  if (!manifestPolicy) return [contribution.preset];
  if (contribution.agent) {
    return (
      manifestPolicy.agentPolicyKeys?.[contribution.agent] ??
      manifestPolicy.policyKeys ?? [manifestPolicy.name]
    );
  }
  return manifestPolicy.policyKeys ?? [manifestPolicy.name];
}

function contributionSupportsAgent(
  contribution: MessagingPolicyContribution,
  agent: MessagingAgentId,
): boolean {
  if (contribution.agent) return contribution.agent === agent;
  return !contribution.agents || contribution.agents.includes(agent);
}

function contributionChannelId(contribution: MessagingPolicyContribution): string {
  return contribution.channelId ?? contribution.preset;
}

function resolvePolicyContributionSourcePath(
  contribution: MessagingPolicyContribution,
  fallbackRoot: string,
): string | null {
  const sourceRoot = path.resolve(contribution.sourceRoot ?? fallbackRoot);
  const sourcePath = path.resolve(sourceRoot, contribution.source);
  return sourcePath === sourceRoot || sourcePath.startsWith(`${sourceRoot}${path.sep}`)
    ? sourcePath
    : null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
