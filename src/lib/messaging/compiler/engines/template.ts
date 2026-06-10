// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelCredentialSpec,
  MessagingSerializableValue,
  MessagingTemplateString,
  SandboxMessagingInputReference,
} from "../../manifest";

const CREDENTIAL_PLACEHOLDER_PATTERN = /\{\{\s*credential\.([A-Za-z0-9_-]+)\.placeholder\s*\}\}/g;
const EXACT_TEMPLATE_PATTERN = /^\{\{\s*([^}]+?)\s*\}\}$/;
const TEMPLATE_REFERENCE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

export type RenderTemplateValue = MessagingSerializableValue | undefined;

export interface RenderTemplateReferenceResolution {
  readonly matched: true;
  readonly value: RenderTemplateValue;
}

export type RenderTemplateReferenceResolver = (
  reference: string,
  context: RenderTemplateContext,
) => RenderTemplateReferenceResolution | undefined;

export interface RenderTemplateContext {
  readonly inputs: readonly SandboxMessagingInputReference[];
  readonly env?: Record<string, string | undefined>;
  readonly referenceResolver?: RenderTemplateReferenceResolver;
}

export function resolvedRenderTemplateReference(
  value: RenderTemplateValue,
): RenderTemplateReferenceResolution {
  return { matched: true, value };
}

export function resolveSandboxNameTemplate(
  value: MessagingTemplateString,
  sandboxName: string,
): MessagingTemplateString {
  return value.replaceAll("{sandboxName}", sandboxName);
}

export function resolveCredentialTemplatesInValue(
  value: MessagingSerializableValue,
  credentials: readonly ChannelCredentialSpec[],
): MessagingSerializableValue {
  if (typeof value === "string") return resolveCredentialTemplatesInString(value, credentials);
  if (Array.isArray(value)) {
    return value.map((entry) => resolveCredentialTemplatesInValue(entry, credentials));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveCredentialTemplatesInValue(entry, credentials),
      ]),
    );
  }
  return value;
}

export function resolveCredentialTemplatesInLines(
  lines: readonly MessagingTemplateString[],
  credentials: readonly ChannelCredentialSpec[],
): MessagingTemplateString[] {
  return lines.map((line) => resolveCredentialTemplatesInString(line, credentials));
}

export function resolveRenderTemplatesInValue(
  value: MessagingSerializableValue,
  context: RenderTemplateContext,
): RenderTemplateValue {
  if (typeof value === "string") return resolveRenderTemplatesInString(value, context);
  if (Array.isArray(value)) {
    if (value.length === 0) return value;
    const resolved = value
      .map((entry) => resolveRenderTemplatesInValue(entry, context))
      .filter((entry): entry is MessagingSerializableValue => entry !== undefined);
    return resolved.length > 0 ? resolved : undefined;
  }
  if (value && typeof value === "object") {
    const sourceEntries = Object.entries(value);
    if (sourceEntries.length === 0) return value;
    const entries = sourceEntries
      .map(([key, entry]) => [key, resolveRenderTemplatesInValue(entry, context)] as const)
      .filter(
        (entry): entry is readonly [string, MessagingSerializableValue] => entry[1] !== undefined,
      );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

export function resolveRenderTemplatesInLines(
  lines: readonly MessagingTemplateString[],
  context: RenderTemplateContext,
): MessagingTemplateString[] {
  return lines
    .map((line) => resolveRenderTemplatesInString(line, context))
    .filter((line): line is string => typeof line === "string" && line.length > 0);
}

export function isTruthyRenderTemplate(
  value: MessagingTemplateString | undefined,
  context: RenderTemplateContext,
): boolean {
  if (!value) return true;
  const resolved = resolveRenderTemplatesInString(value, context);
  if (resolved === undefined || resolved === null || resolved === false) return false;
  if (Array.isArray(resolved)) return resolved.length > 0;
  if (typeof resolved === "object") return Object.keys(resolved).length > 0;
  if (typeof resolved === "string") return resolved.trim().length > 0;
  return true;
}

export function collectTemplateReferencesInValue(value: MessagingSerializableValue): string[] {
  if (typeof value === "string") return collectTemplateReferencesInString(value);
  if (Array.isArray(value)) {
    return unique(value.flatMap((entry) => collectTemplateReferencesInValue(entry)));
  }
  if (value && typeof value === "object") {
    return unique(Object.values(value).flatMap((entry) => collectTemplateReferencesInValue(entry)));
  }
  return [];
}

export function collectTemplateReferencesInLines(
  lines: readonly MessagingTemplateString[],
): string[] {
  return unique(lines.flatMap((line) => collectTemplateReferencesInString(line)));
}

function resolveCredentialTemplatesInString(
  value: MessagingTemplateString,
  credentials: readonly ChannelCredentialSpec[],
): MessagingTemplateString {
  return value.replace(CREDENTIAL_PLACEHOLDER_PATTERN, (match, credentialId: string) => {
    const credential = credentials.find((entry) => entry.id === credentialId);
    return credential?.placeholder ?? match;
  });
}

function resolveRenderTemplatesInString(
  value: MessagingTemplateString,
  context: RenderTemplateContext,
): RenderTemplateValue {
  const exact = value.match(EXACT_TEMPLATE_PATTERN);
  if (exact?.[1]) return resolveTemplateReference(exact[1].trim(), context);

  let omitted = false;
  const resolved = value.replace(TEMPLATE_REFERENCE_PATTERN, (match, reference: string) => {
    const replacement = resolveTemplateReference(reference.trim(), context);
    if (replacement === undefined || replacement === null) {
      omitted = true;
      return "";
    }
    if (Array.isArray(replacement)) return replacement.map(String).join(",");
    if (typeof replacement === "object") return JSON.stringify(replacement);
    return String(replacement);
  });
  return omitted ? undefined : resolved;
}

function resolveTemplateReference(
  reference: string,
  context: RenderTemplateContext,
): RenderTemplateValue {
  const resolved = context.referenceResolver?.(reference, context);
  return resolved?.matched ? resolved.value : "{{" + reference + "}}";
}

function collectTemplateReferencesInString(value: MessagingTemplateString): string[] {
  return unique(
    [...value.matchAll(TEMPLATE_REFERENCE_PATTERN)]
      .map((match) => match[1]?.trim())
      .filter(
        (reference): reference is string => typeof reference === "string" && reference.length > 0,
      ),
  );
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
