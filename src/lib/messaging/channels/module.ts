// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RenderTemplateReferenceResolver } from "../compiler/engines/template";
import type { MessagingHookRegistration } from "../hooks";
import type { ChannelManifest, MessagingAgentId, MessagingChannelId } from "../manifest";

export interface MessagingChannelValidationIssue {
  readonly severity: "error" | "warning";
  readonly code?: string;
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

export interface MessagingChannelModuleValidationOptions {
  /**
   * Hook/template/policy factories may lazy-load implementation modules to
   * avoid channel-index cycles. Discovery validates their existence by default
   * and should only execute them after the channel graph is fully loaded.
   */
  readonly evaluateExtensions?: boolean;
}

export function defineMessagingChannel<T extends MessagingChannelModule>(module: T): T {
  return module;
}

export function isMessagingChannelModule(value: unknown): value is MessagingChannelModule {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MessagingChannelModule>;
  return (
    candidate.kind === "nemoclaw.messaging.channel" &&
    candidate.apiVersion === 1 &&
    typeof candidate.id === "string" &&
    typeof candidate.manifest === "function"
  );
}

export function validateMessagingChannelModule(
  module: MessagingChannelModule,
  options: MessagingChannelModuleValidationOptions = {},
): readonly MessagingChannelValidationIssue[] {
  const issues: MessagingChannelValidationIssue[] = [];

  if (module.kind !== "nemoclaw.messaging.channel") {
    issues.push(
      error("module.kind", `Channel '${module.id}' must use kind 'nemoclaw.messaging.channel'.`),
    );
  }
  if (module.apiVersion !== 1) {
    issues.push(
      error(
        "module.apiVersion",
        `Channel '${module.id}' uses unsupported module API version '${module.apiVersion}'.`,
      ),
    );
  }
  if (!isValidChannelId(module.id)) {
    issues.push(
      error(
        "module.id",
        `Channel id '${module.id}' must be lowercase kebab-case, starting with a letter.`,
      ),
    );
  }

  const manifest = safeManifest(module, issues);
  if (manifest) {
    validateManifest(module.id, manifest, issues);
  }

  if (options.evaluateExtensions) {
    validateHookRegistrations(module, issues);
    validateTemplateResolvers(module, issues);
    validatePolicyContributions(module, issues);
  }

  for (const issue of module.validate?.() ?? []) {
    issues.push(issue);
  }

  return issues;
}

function safeManifest(
  module: MessagingChannelModule,
  issues: MessagingChannelValidationIssue[],
): ChannelManifest | null {
  try {
    const manifest = module.manifest();
    if (!manifest || typeof manifest !== "object") {
      issues.push(error("manifest", `Channel '${module.id}' manifest() must return an object.`));
      return null;
    }
    return manifest;
  } catch (cause) {
    issues.push(
      error(
        "manifest",
        `Channel '${module.id}' manifest() threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    );
    return null;
  }
}

function validateManifest(
  moduleId: string,
  manifest: ChannelManifest,
  issues: MessagingChannelValidationIssue[],
): void {
  if (manifest.schemaVersion !== 1) {
    issues.push(
      error("manifest.schemaVersion", `Channel '${moduleId}' manifest schemaVersion must be 1.`),
    );
  }
  if (manifest.id !== moduleId) {
    issues.push(
      error(
        "manifest.id",
        `Channel module id '${moduleId}' must match manifest id '${manifest.id}'.`,
      ),
    );
  }
  if (!manifest.displayName || typeof manifest.displayName !== "string") {
    issues.push(
      error("manifest.displayName", `Channel '${moduleId}' manifest displayName is required.`),
    );
  }
  if (!Array.isArray(manifest.supportedAgents) || manifest.supportedAgents.length === 0) {
    issues.push(
      error(
        "manifest.supportedAgents",
        `Channel '${moduleId}' must declare at least one supported agent.`,
      ),
    );
  }
  if (!manifest.auth || typeof manifest.auth.mode !== "string") {
    issues.push(error("manifest.auth", `Channel '${moduleId}' must declare auth.mode.`));
  }

  const inputIds = new Set<string>();
  for (const input of manifest.inputs ?? []) {
    if (!input.id || inputIds.has(input.id)) {
      issues.push(
        error(
          "manifest.inputs",
          `Channel '${moduleId}' has duplicate or empty input id '${input.id}'.`,
        ),
      );
    }
    inputIds.add(input.id);
  }

  validateDuplicateIds(
    moduleId,
    "credential",
    (manifest.credentials ?? []).map((credential) => credential.id),
    issues,
  );
  for (const credential of manifest.credentials ?? []) {
    if (!inputIds.has(credential.sourceInput)) {
      issues.push(
        error(
          "manifest.credentials.sourceInput",
          `Channel '${moduleId}' credential '${credential.id}' references missing input '${credential.sourceInput}'.`,
        ),
      );
    }
  }

  validateDuplicateIds(
    moduleId,
    "hook",
    (manifest.hooks ?? []).map((hook) => hook.id),
    issues,
  );
  for (const hook of manifest.hooks ?? []) {
    if (!hook.handler || typeof hook.handler !== "string") {
      issues.push(
        error(
          "manifest.hooks.handler",
          `Channel '${moduleId}' hook '${hook.id}' must declare a handler.`,
        ),
      );
    }
  }

  validateDuplicateIds(
    moduleId,
    "render",
    (manifest.render ?? []).flatMap((entry, index) => (entry.id ? [entry.id] : [`#${index}`])),
    issues,
  );
}

function validateHookRegistrations(
  module: MessagingChannelModule,
  issues: MessagingChannelValidationIssue[],
): void {
  const hooks = safeOptionalList(module, "hooks", issues);
  if (!hooks) return;
  validateDuplicateIds(
    module.id,
    "hook registration",
    hooks.map((hook) => hook.id),
    issues,
  );
}

function validateTemplateResolvers(
  module: MessagingChannelModule,
  issues: MessagingChannelValidationIssue[],
): void {
  const templates = safeOptionalList(module, "templates", issues);
  if (!templates) return;
  validateDuplicateIds(
    module.id,
    "template resolver",
    templates.map((template) => template.namespace),
    issues,
  );
}

function validatePolicyContributions(
  module: MessagingChannelModule,
  issues: MessagingChannelValidationIssue[],
): void {
  const policies = safeOptionalList(module, "policies", issues);
  if (!policies) return;
  for (const contribution of policies) {
    if (!contribution.preset) {
      issues.push(
        error("policies.preset", `Channel '${module.id}' policy contribution must declare preset.`),
      );
    }
    if (!contribution.source) {
      issues.push(
        error(
          "policies.source",
          `Channel '${module.id}' policy contribution '${contribution.preset}' must declare source.`,
        ),
      );
    }
  }
}

function safeOptionalList<K extends "hooks" | "templates" | "policies">(
  module: MessagingChannelModule,
  key: K,
  issues: MessagingChannelValidationIssue[],
): readonly ReturnType<NonNullable<MessagingChannelModule[K]>>[number][] | null {
  try {
    return module[key]?.() ?? null;
  } catch (cause) {
    issues.push(
      error(
        `module.${key}`,
        `Channel '${module.id}' ${key}() threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    );
    return null;
  }
}

function validateDuplicateIds(
  moduleId: string,
  label: string,
  ids: readonly string[],
  issues: MessagingChannelValidationIssue[],
): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id)) {
      issues.push(
        error("duplicateId", `Channel '${moduleId}' has duplicate or empty ${label} id '${id}'.`),
      );
    }
    seen.add(id);
  }
}

function isValidChannelId(id: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id);
}

function error(code: string, message: string): MessagingChannelValidationIssue {
  return { severity: "error", code, message };
}
