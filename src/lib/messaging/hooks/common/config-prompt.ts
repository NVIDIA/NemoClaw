// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createBuiltInChannelManifestRegistry } from "../../channels";
import type {
  ChannelConfigInputSpec,
  ChannelHookOutputSpec,
  ChannelManifest,
  MessagingSerializableValue,
} from "../../manifest";
import { resolveMessagingChannelConfigEnvValue } from "../../../messaging-channel-config";
import type {
  MessagingHookHandler,
  MessagingHookInputMap,
  MessagingHookOutputMap,
  MessagingHookRegistration,
} from "../types";

export const COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID = "common.configPrompt";

export interface ConfigPromptField {
  readonly id: string;
  readonly envKey: string;
  readonly label: string;
  readonly help?: string;
  readonly emptyValueMessage?: string;
  readonly validValues?: readonly string[];
  readonly promptWhenInput?: string;
  readonly statePath?: string;
}

export interface ConfigPromptHookOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly prompt?: (question: string, options?: { readonly secret?: boolean }) => Promise<string>;
  readonly log?: (message: string) => void;
  readonly resolveField?: (
    channelId: string,
    output: ChannelHookOutputSpec,
  ) => ConfigPromptField | null;
}

export function createConfigPromptHook(
  options: ConfigPromptHookOptions = {},
): MessagingHookHandler {
  return async (context) => {
    const outputs: Record<string, MessagingHookOutputMap[string]> = {};
    const availableInputs: Record<string, MessagingSerializableValue> = {
      ...(context.inputs ?? {}),
    };

    for (const output of context.outputDeclarations ?? []) {
      if (output.kind !== "config") continue;
      const field = resolveConfigPromptField(context.channelId, output, options);
      if (!field) {
        throw new Error(
          `No config-prompt field registered for ${context.channelId}.${output.id}`,
        );
      }
      if (field.promptWhenInput && !hasInputValue(availableInputs, field.promptWhenInput)) {
        continue;
      }

      const existing = readExistingConfigValue(field, availableInputs, options);
      if (existing) {
        recordConfigValue(field, existing, outputs, availableInputs, options);
        logExistingConfigInput(context.channelId, field, existing, options);
        continue;
      }

      if (context.isInteractive === false) {
        continue;
      }

      if (field.help) log(options, `  ${field.help}`);
      const value = await promptConfigInputValue(field, options);
      if (value) {
        recordConfigValue(field, value, outputs, availableInputs, options);
        logSavedConfigInput(context.channelId, field, value, options);
      } else {
        logSkippedConfigInput(context.channelId, field, options);
      }
    }

    return { outputs };
  };
}

export function createConfigPromptHookRegistration(
  options: ConfigPromptHookOptions = {},
): MessagingHookRegistration {
  return {
    id: COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
    handler: createConfigPromptHook(options),
  };
}

function resolveConfigPromptField(
  channelId: string,
  output: ChannelHookOutputSpec,
  options: ConfigPromptHookOptions,
): ConfigPromptField | null {
  const custom = options.resolveField?.(channelId, output);
  if (custom) return custom;

  const manifest = createBuiltInChannelManifestRegistry().get(channelId);
  if (!manifest) return null;
  return resolveManifestConfigPromptField(manifest, output);
}

export function resolveManifestConfigPromptField(
  manifest: ChannelManifest,
  output: ChannelHookOutputSpec,
): ConfigPromptField | null {
  const input = manifest.inputs.find(
    (entry): entry is ChannelConfigInputSpec =>
      entry.kind === "config" && entry.id === output.id,
  );
  if (!input?.envKey || !input.prompt) return null;
  return {
    id: input.id,
    envKey: input.envKey,
    label: input.prompt.label,
    help: input.prompt.help,
    emptyValueMessage: input.prompt.emptyValueMessage,
    validValues: input.validValues,
    promptWhenInput: input.promptWhenInput,
    statePath: input.statePath,
  };
}

function readExistingConfigValue(
  field: ConfigPromptField,
  availableInputs: MessagingHookInputMap,
  options: ConfigPromptHookOptions,
): string | null {
  const env = options.env ?? process.env;
  const envValue =
    resolveMessagingChannelConfigEnvValue(field.envKey, env).value ?? env[field.envKey];
  return (
    normalizeConfigValue(field, envValue) ??
    normalizeConfigValue(field, availableInputs[field.id]) ??
    normalizeConfigValue(field, field.statePath ? availableInputs[field.statePath] : undefined)
  );
}

function recordConfigValue(
  field: ConfigPromptField,
  value: string,
  outputs: Record<string, MessagingHookOutputMap[string]>,
  availableInputs: Record<string, MessagingSerializableValue>,
  options: ConfigPromptHookOptions,
): void {
  const env = options.env ?? process.env;
  env[field.envKey] = value;
  outputs[field.id] = {
    kind: "config",
    value,
  };
  availableInputs[field.id] = value;
  if (field.statePath) availableInputs[field.statePath] = value;
}

async function promptConfigInputValue(
  field: ConfigPromptField,
  options: ConfigPromptHookOptions,
): Promise<string | null> {
  const prompt = options.prompt ?? missingConfigPrompt;
  if (isMentionModeInput(field)) {
    const answer = (await prompt("  Reply only when @mentioned? [Y/n]: ")).trim().toLowerCase();
    return answer === "n" || answer === "no" ? "0" : "1";
  }
  return normalizeConfigValue(field, await prompt(`  ${field.label}: `));
}

async function missingConfigPrompt(): Promise<string> {
  throw new Error(
    "Config-prompt hook requires an injected prompt implementation in phase 1.",
  );
}

function normalizeConfigValue(field: ConfigPromptField, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r/g, "").trim();
  if (!normalized) return null;
  if (field.validValues && !field.validValues.includes(normalized)) return null;
  return normalized;
}

function hasInputValue(
  inputs: Record<string, MessagingSerializableValue>,
  inputId: string,
): boolean {
  const value = inputs[inputId];
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined;
}

function logExistingConfigInput(
  channelId: string,
  field: ConfigPromptField,
  value: string,
  options: ConfigPromptHookOptions,
): void {
  if (isMentionModeInput(field)) {
    log(options, `  ✓ ${channelId} — reply mode already set: ${formatMentionMode(value)}`);
    return;
  }
  log(options, `  ✓ ${channelId} — ${configInputNoun(field)} already set: ${value}`);
}

function logSavedConfigInput(
  channelId: string,
  field: ConfigPromptField,
  value: string,
  options: ConfigPromptHookOptions,
): void {
  if (isMentionModeInput(field)) {
    log(options, `  ✓ ${channelId} reply mode saved: ${formatMentionMode(value)}`);
    return;
  }
  log(options, `  ✓ ${channelId} ${configInputNoun(field)} saved`);
}

function logSkippedConfigInput(
  channelId: string,
  field: ConfigPromptField,
  options: ConfigPromptHookOptions,
): void {
  const reason = field.emptyValueMessage ?? "left unset";
  log(options, `  Skipped ${channelId} ${configInputNoun(field)} (${reason})`);
}

function configInputNoun(field: ConfigPromptField): string {
  if (/channel/i.test(field.id)) return "channel IDs";
  if (/server/i.test(field.id)) return "server ID";
  if (/allowed|user/i.test(field.id)) return "allowed IDs";
  return field.label;
}

function isMentionModeInput(field: ConfigPromptField): boolean {
  return (
    field.validValues?.length === 2 &&
    field.validValues.includes("0") &&
    field.validValues.includes("1")
  );
}

function formatMentionMode(value: string): string {
  return value === "0" ? "all messages" : "@mentions only";
}

function log(options: ConfigPromptHookOptions, message: string): void {
  (options.log ?? console.log)(message);
}

export const configPromptHook = createConfigPromptHook();
