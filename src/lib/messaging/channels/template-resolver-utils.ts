// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type RenderTemplateContext,
  type RenderTemplateReferenceResolution,
  resolvedRenderTemplateReference,
} from "../compiler/engines/template";
import type { MessagingSerializableValue } from "../manifest";

export type BuiltInRenderTemplateResolver = (
  reference: string,
  context: RenderTemplateContext,
) => RenderTemplateReferenceResolution | undefined;

export { resolvedRenderTemplateReference };

export function allowedIds(context: RenderTemplateContext, channel: string): string[] {
  return parseList(stateValue(context, `allowedIds.${channel}`));
}

export function stateValue(
  context: RenderTemplateContext,
  path: string,
): MessagingSerializableValue | undefined {
  const stateInput = context.inputs.find((input) => input.statePath === path);
  if (stateInput?.value !== undefined) return stateInput.value;
  const inputId = path.split(".").at(-1);
  return context.inputs.find((input) => input.inputId === inputId)?.value;
}

export function parseList(value: MessagingSerializableValue | undefined): string[] {
  if (Array.isArray(value)) return unique(value.map(String).map(cleanString).filter(Boolean));
  const text = cleanString(value);
  if (!text) return [];
  return unique(text.split(",").map(cleanString).filter(Boolean));
}

export function parseBoolean(value: MessagingSerializableValue | undefined): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = cleanString(value)?.toLowerCase();
  if (text === "1" || text === "true" || text === "yes" || text === "on") return true;
  if (text === "0" || text === "false" || text === "no" || text === "off") return false;
  return undefined;
}

export function nonEmptyString(value: unknown): string | undefined {
  return cleanString(value) || undefined;
}

export function cleanString(value: unknown): string {
  const text = String(value ?? "");
  if (/[\r\n]/.test(text)) {
    throw new Error("Messaging template values must not contain line breaks.");
  }
  return text.trim();
}

export function nonEmptyArray(values: readonly string[]): string[] | undefined {
  return values.length > 0 ? [...values] : undefined;
}

export function nonEmptyCsv(values: readonly string[]): string | undefined {
  return values.length > 0 ? values.join(",") : undefined;
}

export function nonEmptyObject<T extends Record<string, unknown>>(value: T): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
