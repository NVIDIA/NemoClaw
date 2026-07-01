// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RenderTemplateReferenceResolver } from "../compiler/engines/template";
import type { MessagingHookRegistration } from "../hooks";
import type { ChannelManifest, MessagingAgentId, MessagingChannelId } from "../manifest";

export interface MessagingChannelValidationIssue {
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface MessagingPolicyContribution {
  readonly channelId?: MessagingChannelId;
  readonly preset: string;
  readonly agent?: MessagingAgentId;
  readonly agents?: readonly MessagingAgentId[];
  readonly sourceRoot?: string;
  readonly source: string;
  readonly policyKeys?: readonly string[];
  readonly requiredAtCreate?: boolean;
  readonly validationWarningLines?: readonly string[];
}

export interface MessagingTemplateResolver {
  readonly namespace: string;
  readonly resolve: RenderTemplateReferenceResolver;
}

export interface MessagingRenderConfigParser {
  readonly id: "json" | "yaml" | "env-lines" | string;
  canHandle(target: string, agent: MessagingAgentId): boolean;
  parse(content: string): unknown;
  apply(document: unknown, entries: readonly unknown[]): unknown;
  serialize(document: unknown): string;
}

export interface MessagingRuntimeAsset {
  readonly id: string;
  readonly kind: "node-preload" | string;
  readonly source: string;
  readonly agents?: readonly MessagingAgentId[];
}

export interface MessagingChannelModule {
  readonly kind: "nemoclaw.messaging.channel";
  readonly apiVersion: 1;
  readonly id: MessagingChannelId;

  manifest(): ChannelManifest;
  hooks?(options?: unknown): readonly MessagingHookRegistration[];
  templates?(): readonly MessagingTemplateResolver[];
  policies?(): readonly MessagingPolicyContribution[];
  renderParsers?(): readonly MessagingRenderConfigParser[];
  runtimeAssets?(): readonly MessagingRuntimeAsset[];
  validate?(): readonly MessagingChannelValidationIssue[];
}

export function defineMessagingChannel<T extends MessagingChannelModule>(module: T): T {
  return module;
}
