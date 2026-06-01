// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelCredentialSpec,
  MessagingSerializableValue,
  MessagingTemplateString,
} from "../../manifest";

const CREDENTIAL_PLACEHOLDER_PATTERN =
  /\{\{\s*credential\.([A-Za-z0-9_-]+)\.placeholder\s*\}\}/g;
const TEMPLATE_REFERENCE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

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

export function collectTemplateReferencesInValue(
  value: MessagingSerializableValue,
): string[] {
  if (typeof value === "string") return collectTemplateReferencesInString(value);
  if (Array.isArray(value)) {
    return unique(value.flatMap((entry) => collectTemplateReferencesInValue(entry)));
  }
  if (value && typeof value === "object") {
    return unique(
      Object.values(value).flatMap((entry) => collectTemplateReferencesInValue(entry)),
    );
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

function collectTemplateReferencesInString(value: MessagingTemplateString): string[] {
  return unique(
    [...value.matchAll(TEMPLATE_REFERENCE_PATTERN)]
      .map((match) => match[1]?.trim())
      .filter((reference): reference is string => typeof reference === "string" && reference.length > 0),
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
