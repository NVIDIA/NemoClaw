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

export interface MessagingWorkflowPlannerBaseContext {
  readonly sandboxName: string;
  readonly agent: MessagingAgentId;
  readonly isInteractive: boolean;
  readonly configuredChannels?: readonly MessagingChannelId[];
  readonly disabledChannels?: readonly MessagingChannelId[];
  readonly supportedChannelIds?: readonly MessagingChannelId[];
  readonly credentialAvailability?: MessagingCompilerCredentialAvailability;
}

export interface MessagingWorkflowPlannerOnboardContext
  extends MessagingWorkflowPlannerBaseContext {
  readonly selectedChannels: readonly MessagingChannelId[];
}

export interface MessagingWorkflowPlannerChannelContext
  extends MessagingWorkflowPlannerBaseContext {
  readonly channelId: MessagingChannelId;
}

export class MessagingWorkflowPlanner {
  private readonly compiler: ManifestCompiler;

  constructor(
    private readonly registry: ChannelManifestRegistry,
    hooks = new MessagingHookRegistry(),
  ) {
    this.compiler = new ManifestCompiler(registry, hooks);
  }

  async planOnboard(
    context: MessagingWorkflowPlannerOnboardContext,
  ): Promise<SandboxMessagingPlan> {
    const selectedChannels = uniqueChannels(context.selectedChannels);
    this.assertSupportedChannels(selectedChannels, context);

    return this.compileWorkflow(context, {
      workflow: "onboard",
      selectedChannels,
      configuredChannels: selectedChannels,
      disabledChannels: [],
    });
  }

  async planAddChannel(
    context: MessagingWorkflowPlannerChannelContext,
  ): Promise<SandboxMessagingPlan> {
    const configuredChannels = addChannels(context.configuredChannels, [context.channelId]);
    const disabledChannels = removeChannels(
      onlyConfiguredChannels(context.disabledChannels, configuredChannels),
      [context.channelId],
    );
    this.assertSupportedChannels([...configuredChannels, context.channelId], context);

    return this.compileWorkflow(context, {
      workflow: "add-channel",
      selectedChannels: [context.channelId],
      configuredChannels,
      disabledChannels,
    });
  }

  async planRemoveChannel(
    context: MessagingWorkflowPlannerChannelContext,
  ): Promise<SandboxMessagingPlan> {
    const configuredChannels = removeChannels(context.configuredChannels, [context.channelId]);
    const disabledChannels = removeChannels(
      onlyConfiguredChannels(context.disabledChannels, configuredChannels),
      [context.channelId],
    );
    this.assertSupportedChannels([...configuredChannels, context.channelId], context);

    return this.compileWorkflow(context, {
      workflow: "remove-channel",
      selectedChannels: [],
      configuredChannels,
      disabledChannels,
    });
  }

  async planStartChannel(
    context: MessagingWorkflowPlannerChannelContext,
  ): Promise<SandboxMessagingPlan> {
    const configuredChannels = uniqueChannels(context.configuredChannels);
    const selectedChannels = configuredChannels.includes(context.channelId)
      ? [context.channelId]
      : [];
    const disabledChannels = removeChannels(
      onlyConfiguredChannels(context.disabledChannels, configuredChannels),
      [context.channelId],
    );
    this.assertSupportedChannels([...configuredChannels, context.channelId], context);

    return this.compileWorkflow(context, {
      workflow: "start-channel",
      selectedChannels,
      configuredChannels,
      disabledChannels,
    });
  }

  async planStopChannel(
    context: MessagingWorkflowPlannerChannelContext,
  ): Promise<SandboxMessagingPlan> {
    const configuredChannels = uniqueChannels(context.configuredChannels);
    const selectedChannels = configuredChannels.includes(context.channelId)
      ? [context.channelId]
      : [];
    const disabledChannels = configuredChannels.includes(context.channelId)
      ? addChannels(onlyConfiguredChannels(context.disabledChannels, configuredChannels), [
          context.channelId,
        ])
      : onlyConfiguredChannels(context.disabledChannels, configuredChannels);
    this.assertSupportedChannels([...configuredChannels, context.channelId], context);

    return this.compileWorkflow(context, {
      workflow: "stop-channel",
      selectedChannels,
      configuredChannels,
      disabledChannels,
    });
  }

  async planRebuild(
    context: MessagingWorkflowPlannerBaseContext,
  ): Promise<SandboxMessagingPlan> {
    const configuredChannels = uniqueChannels(context.configuredChannels);
    const disabledChannels = onlyConfiguredChannels(context.disabledChannels, configuredChannels);
    this.assertSupportedChannels(configuredChannels, context);

    return this.compileWorkflow(context, {
      workflow: "rebuild",
      selectedChannels: [],
      configuredChannels,
      disabledChannels,
    });
  }

  private compileWorkflow(
    context: MessagingWorkflowPlannerBaseContext,
    workflow: {
      readonly workflow: MessagingCompilerWorkflow;
      readonly selectedChannels: readonly MessagingChannelId[];
      readonly configuredChannels: readonly MessagingChannelId[];
      readonly disabledChannels: readonly MessagingChannelId[];
    },
  ): Promise<SandboxMessagingPlan> {
    const compilerContext: ManifestCompilerContext = {
      sandboxName: context.sandboxName,
      agent: context.agent,
      isInteractive: context.isInteractive,
      workflow: workflow.workflow,
      selectedChannels: workflow.selectedChannels,
      configuredChannels: workflow.configuredChannels,
      disabledChannels: workflow.disabledChannels,
      supportedChannelIds: context.supportedChannelIds,
      credentialAvailability: context.credentialAvailability,
    };
    return this.compiler.compile(compilerContext);
  }

  private assertSupportedChannels(
    channelIds: readonly MessagingChannelId[],
    context: Pick<
      MessagingWorkflowPlannerBaseContext,
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
      MessagingWorkflowPlannerBaseContext,
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

function addChannels(
  current: readonly MessagingChannelId[] | undefined,
  additions: readonly MessagingChannelId[],
): MessagingChannelId[] {
  return uniqueChannels([...(current ?? []), ...additions]);
}

function removeChannels(
  current: readonly MessagingChannelId[] | undefined,
  removals: readonly MessagingChannelId[],
): MessagingChannelId[] {
  const remove = new Set(removals);
  return uniqueChannels(current).filter((channelId) => !remove.has(channelId));
}

function onlyConfiguredChannels(
  channelIds: readonly MessagingChannelId[] | undefined,
  configuredChannels: readonly MessagingChannelId[],
): MessagingChannelId[] {
  const configured = new Set(configuredChannels);
  return uniqueChannels(channelIds).filter((channelId) => configured.has(channelId));
}
