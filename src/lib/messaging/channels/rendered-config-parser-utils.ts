// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelManifest,
  MessagingAgentId,
  MessagingSerializableValue,
  SandboxMessagingInputReference,
} from "../manifest";

export type RenderedConfigSourceKind = "structured" | "env";

export interface RenderedConfigVisibilityKey {
  readonly key: string;
  readonly inputId: string;
  readonly target: string;
  readonly kind: RenderedConfigSourceKind;
  readonly path?: readonly string[];
  readonly envKey?: string;
}

export type RenderedConfigSource =
  | {
      readonly kind: "structured";
      readonly value: unknown;
    }
  | {
      readonly kind: "env";
      readonly entries: ReadonlyMap<string, string>;
    };

export interface RenderedChannelConfigParserContext {
  readonly manifest: ChannelManifest;
  readonly agentId: MessagingAgentId;
  readonly inputs: readonly SandboxMessagingInputReference[];
}

export interface RenderedChannelConfigParser {
  listConfigVisibilityKeys(
    context: RenderedChannelConfigParserContext,
  ): readonly RenderedConfigVisibilityKey[];
  getValue(
    key: RenderedConfigVisibilityKey,
    source: RenderedConfigSource,
  ): MessagingSerializableValue | undefined;
}

export function structuredConfigKey(
  inputId: string,
  target: string,
  path: readonly string[],
  key = inputId,
): RenderedConfigVisibilityKey {
  return { key, inputId, target, kind: "structured", path };
}

export function envConfigKey(
  inputId: string,
  target: string,
  envKey: string,
  key = inputId,
): RenderedConfigVisibilityKey {
  return { key, inputId, target, kind: "env", envKey };
}

export function getStructuredConfigValue(
  source: RenderedConfigSource,
  path: readonly string[] | undefined,
): MessagingSerializableValue | undefined {
  if (source.kind !== "structured" || !path) return undefined;
  return getStructuredPath(source.value, path);
}

export function getEnvConfigValue(
  source: RenderedConfigSource,
  envKey: string | undefined,
): MessagingSerializableValue | undefined {
  if (source.kind !== "env" || !envKey) return undefined;
  return source.entries.get(envKey);
}

export function getStructuredPath(
  value: unknown,
  path: readonly string[],
): MessagingSerializableValue | undefined {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return isMessagingSerializableValue(current) ? current : undefined;
}

export function isMessagingSerializableValue(value: unknown): value is MessagingSerializableValue {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return true;
  if (Array.isArray(value)) return value.every(isMessagingSerializableValue);
  if (type !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isMessagingSerializableValue);
}
