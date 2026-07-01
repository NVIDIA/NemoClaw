// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { BUILT_IN_CHANNEL_MANIFESTS, createBuiltInRenderTemplateResolver } from "./channels";
import { type BuiltInMessagingHookOptions, createBuiltInMessagingHookRegistrations } from "./hooks";
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
  defineMessagingChannel,
  type MessagingChannelModule,
  type MessagingPolicyContribution,
} from "./channels/module";

export interface MessagingWorkflowPlannerOptions {
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
  readonly templateResolver?: RenderTemplateReferenceResolver;
  readonly policyRoot?: string;
}

export class StaticMessagingCatalog implements MessagingCatalog {
  private readonly modules: readonly MessagingChannelModule[];
  private readonly createHookRegistrations: (
    options?: BuiltInMessagingHookOptions,
  ) => readonly MessagingHookRegistration[];
  private readonly templateResolver: RenderTemplateReferenceResolver;
  private readonly policyRoot: string;

  constructor(options: StaticMessagingCatalogOptions) {
    this.modules = validateChannelModules(options.modules);
    this.createHookRegistrations = options.createHookRegistrations ?? (() => []);
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
      ...this.modules.flatMap((module) => module.hooks?.() ?? []),
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
      this.createHookRegistry(options.hookOptions),
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
          ? explicit.map((contribution) => ({
              ...contribution,
              channelId: contribution.channelId ?? module.id,
            }))
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
    const sourcePath = path.resolve(this.policyRoot, contribution.source);
    if (!sourcePath.startsWith(`${this.policyRoot}${path.sep}`) && sourcePath !== this.policyRoot) {
      return null;
    }
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
    modules: BUILT_IN_CHANNEL_MANIFESTS.map(createManifestBackedChannelModule),
    createHookRegistrations: createBuiltInMessagingHookRegistrations,
    templateResolver: createBuiltInRenderTemplateResolver(),
  });
}

function createManifestBackedChannelModule(manifest: ChannelManifest): MessagingChannelModule {
  return defineMessagingChannel({
    kind: "nemoclaw.messaging.channel",
    apiVersion: 1,
    id: manifest.id,
    manifest: () => manifest,
  });
}

function validateChannelModules(
  modules: readonly MessagingChannelModule[],
): readonly MessagingChannelModule[] {
  const seen = new Set<string>();
  for (const module of modules) {
    if (module.kind !== "nemoclaw.messaging.channel") {
      throw new Error(`Invalid messaging channel module kind for '${module.id}'.`);
    }
    if (module.apiVersion !== 1) {
      throw new Error(`Unsupported messaging channel module API version for '${module.id}'.`);
    }
    if (module.id !== module.manifest().id) {
      throw new Error(
        `Messaging channel module id '${module.id}' must match manifest id '${module.manifest().id}'.`,
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

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
