// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MessagingHookRegistry } from "../hooks";
import type {
  ChannelManifestRegistry,
  MessagingAgentId,
  MessagingChannelId,
  MessagingCompilerWorkflow,
  SandboxMessagingPlan,
} from "../manifest";
import { ManifestCompiler } from "./manifest-compiler";
import type {
  ManifestCompilerContext,
  MessagingCompilerCredentialAvailability,
} from "./types";

export interface MessagingWorkflowPlannerBuildContext {
  readonly sandboxName: string;
  readonly agent: MessagingAgentId;
  readonly workflow: MessagingCompilerWorkflow;
  readonly isInteractive: boolean;
  readonly configuredChannels?: readonly MessagingChannelId[];
  readonly disabledChannels?: readonly MessagingChannelId[];
  readonly supportedChannelIds?: readonly MessagingChannelId[];
  readonly credentialAvailability?: MessagingCompilerCredentialAvailability;
}

export class MessagingWorkflowPlanner {
  private readonly compiler: ManifestCompiler;

  constructor(
    private readonly registry: ChannelManifestRegistry,
    hooks = new MessagingHookRegistry(),
  ) {
    this.compiler = new ManifestCompiler(registry, hooks);
  }

  async buildPlan(
    context: MessagingWorkflowPlannerBuildContext,
  ): Promise<SandboxMessagingPlan> {
    const configuredChannels = uniqueChannels(context.configuredChannels);
    const disabledChannels = onlyConfiguredChannels(context.disabledChannels, configuredChannels);
    this.assertSupportedChannels(configuredChannels, context);

    const compilerContext: ManifestCompilerContext = {
      sandboxName: context.sandboxName,
      agent: context.agent,
      isInteractive: context.isInteractive,
      workflow: context.workflow,
      configuredChannels,
      disabledChannels,
      supportedChannelIds: context.supportedChannelIds,
      credentialAvailability: context.credentialAvailability,
    };
    return this.compiler.compile(compilerContext);
  }

  private assertSupportedChannels(
    channelIds: readonly MessagingChannelId[],
    context: Pick<
      MessagingWorkflowPlannerBuildContext,
      "agent" | "supportedChannelIds"
    >,
  ): void {
    const supportedIds = new Set(this.supportedChannelIds(context));
    const unsupportedIds = uniqueChannels(channelIds)
      .filter((channelId) => !supportedIds.has(channelId))
      .sort();

    if (unsupportedIds.length > 0) {
      throw new Error(
        `Unsupported messaging channel(s) for ${context.agent}: ${unsupportedIds.join(", ")}`,
      );
    }
  }

  private supportedChannelIds(
    context: Pick<
      MessagingWorkflowPlannerBuildContext,
      "agent" | "supportedChannelIds"
    >,
  ): MessagingChannelId[] {
    const supportedFilter =
      context.supportedChannelIds && context.supportedChannelIds.length > 0
        ? new Set(context.supportedChannelIds)
        : null;

    return this.registry
      .list()
      .filter((manifest) => manifest.supportedAgents.includes(context.agent))
      .filter((manifest) => !supportedFilter || supportedFilter.has(manifest.id))
      .map((manifest) => manifest.id);
  }
}

function uniqueChannels(
  channelIds: readonly MessagingChannelId[] | undefined,
): MessagingChannelId[] {
  return [...new Set(channelIds ?? [])];
}

function onlyConfiguredChannels(
  channelIds: readonly MessagingChannelId[] | undefined,
  configuredChannels: readonly MessagingChannelId[],
): MessagingChannelId[] {
  const configured = new Set(configuredChannels);
  return uniqueChannels(channelIds).filter((channelId) => configured.has(channelId));
}
