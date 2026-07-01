// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { BUILT_IN_CHANNEL_MANIFESTS, createBuiltInRenderTemplateResolver } from "../channels";
import type { RenderTemplateReferenceResolver } from "../compiler/engines/template";
import {
  type BuiltInMessagingHookOptions,
  createBuiltInMessagingHookRegistrations,
} from "../hooks";
import { MessagingHookRegistry } from "../hooks/registry";
import type { MessagingHookRegistration } from "../hooks/types";
import type { ChannelManifest } from "../manifest";
import { ChannelManifestRegistry } from "../manifest";

export interface MessagingPolicySource {
  readonly presetName: string;
  readonly channelId: string;
}

export interface MessagingCatalog {
  readonly manifests: readonly ChannelManifest[];
  readonly manifestRegistry: ChannelManifestRegistry;
  readonly hookRegistrations: readonly MessagingHookRegistration[];
  readonly hookRegistry: MessagingHookRegistry;
  readonly renderTemplateResolver: RenderTemplateReferenceResolver;
  readonly policySources: readonly MessagingPolicySource[];
}

export interface MessagingCatalogSource {
  readonly manifests?: readonly ChannelManifest[];
  readonly hookRegistrations?:
    | readonly MessagingHookRegistration[]
    | (() => readonly MessagingHookRegistration[]);
  readonly renderTemplateResolver?: RenderTemplateReferenceResolver;
  readonly policySources?: readonly MessagingPolicySource[];
}

export interface BuiltInMessagingCatalogOptions {
  readonly hooks?: BuiltInMessagingHookOptions;
}

export function createMessagingCatalog(source: MessagingCatalogSource = {}): MessagingCatalog {
  const manifests = [...(source.manifests ?? [])];
  let hookRegistrations: readonly MessagingHookRegistration[] | undefined;
  let manifestRegistry: ChannelManifestRegistry | undefined;
  let hookRegistry: MessagingHookRegistry | undefined;
  const getHookRegistrations = () => {
    if (!hookRegistrations) {
      const registrations =
        typeof source.hookRegistrations === "function"
          ? source.hookRegistrations()
          : (source.hookRegistrations ?? []);
      hookRegistrations = [...registrations];
    }
    return hookRegistrations;
  };
  return {
    manifests,
    get manifestRegistry() {
      manifestRegistry ??= new ChannelManifestRegistry(manifests);
      return manifestRegistry;
    },
    get hookRegistrations() {
      return getHookRegistrations();
    },
    get hookRegistry() {
      hookRegistry ??= new MessagingHookRegistry(getHookRegistrations());
      return hookRegistry;
    },
    renderTemplateResolver: source.renderTemplateResolver ?? (() => undefined),
    policySources: [...(source.policySources ?? [])],
  };
}

export function createBuiltInMessagingCatalog(
  options: BuiltInMessagingCatalogOptions = {},
): MessagingCatalog {
  return createMessagingCatalog({
    manifests: BUILT_IN_CHANNEL_MANIFESTS,
    hookRegistrations: () => createBuiltInMessagingHookRegistrations(options.hooks),
    renderTemplateResolver: createBuiltInRenderTemplateResolver(),
    policySources: builtInMessagingPolicySources(),
  });
}

function builtInMessagingPolicySources(): MessagingPolicySource[] {
  return BUILT_IN_CHANNEL_MANIFESTS.flatMap((manifest) =>
    (manifest.policyPresets ?? []).map((preset) => ({
      channelId: manifest.id,
      presetName: typeof preset === "string" ? preset : preset.name,
    })),
  );
}
