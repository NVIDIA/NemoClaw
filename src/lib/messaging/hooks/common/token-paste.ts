// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookHandler,
  MessagingHookOutputMap,
  MessagingHookRegistration,
} from "../types";
import { createBuiltInChannelManifestRegistry } from "../../channels";
import type {
  ChannelHookOutputSpec,
  ChannelManifest,
  ChannelSecretInputSpec,
} from "../../manifest";

export const COMMON_TOKEN_PASTE_HOOK_HANDLER_ID = "common.tokenPaste";

export interface TokenPasteField {
  readonly envKey: string;
  readonly label: string;
  readonly help?: string;
  readonly format?: RegExp;
  readonly formatHint?: string;
}

export interface TokenPasteHookOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly getCredential?: (key: string) => string | null;
  readonly saveCredential?: (key: string, value: string) => void;
  readonly prompt?: (question: string, options?: { readonly secret?: boolean }) => Promise<string>;
  readonly log?: (message: string) => void;
  readonly resolveField?: (
    channelId: string,
    output: ChannelHookOutputSpec,
  ) => TokenPasteField | null;
}

export function createTokenPasteHook(options: TokenPasteHookOptions = {}): MessagingHookHandler {
  return async (context) => {
    const outputs: Record<string, MessagingHookOutputMap[string]> = {};
    const manifest = createBuiltInChannelManifestRegistry().get(context.channelId);
    const resolvedFields: Array<{
      readonly output: ChannelHookOutputSpec;
      readonly field: TokenPasteField;
      readonly token: string;
      readonly source: "existing" | "prompted";
    }> = [];

    for (const output of context.outputDeclarations ?? []) {
      if (output.kind !== "secret") continue;
      const field = resolveTokenPasteField(context.channelId, output, options);
      if (!field) {
        throw new Error(`No token-paste field registered for ${context.channelId}.${output.id}`);
      }
      const resolved = await resolveTokenValue(
        context.channelId,
        output,
        field,
        options,
        context.isInteractive !== false,
      );
      resolvedFields.push({
        output,
        field,
        token: resolved.token,
        source: resolved.source,
      });
      outputs[output.id] = {
        kind: "secret",
        value: resolved.token,
      };
    }

    for (const resolved of resolvedFields) {
      persistTokenValue(resolved.field, resolved.token, resolved.source, options);
      logTokenStatus(context.channelId, resolved.output, resolved.source, options);
      if (isPrimarySecretOutput(manifest, resolved.output)) {
        logEnrollmentNotes(manifest, options);
      }
    }

    return { outputs };
  };
}

export function createTokenPasteHookRegistration(
  options: TokenPasteHookOptions = {},
): MessagingHookRegistration {
  return {
    id: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
    handler: createTokenPasteHook(options),
  };
}

async function resolveTokenValue(
  channelId: string,
  output: ChannelHookOutputSpec,
  field: TokenPasteField,
  options: TokenPasteHookOptions,
  isInteractive: boolean,
): Promise<{ readonly token: string; readonly source: "existing" | "prompted" }> {
  const env = options.env ?? process.env;
  const readCredential = options.getCredential ?? (() => null);
  const prompt = options.prompt ?? missingPhaseOnePrompt;
  const log = options.log ?? ((message: string) => console.log(message));

  let token = normalizeCredentialValue(env[field.envKey]) || readCredential(field.envKey);
  let source: "existing" | "prompted" = "existing";
  if (token && field.format && !field.format.test(token)) {
    log(`  ✗ Invalid format. ${field.formatHint || "Check the token and try again."}`);
    if (!isInteractive) {
      log(formatSkippedInvalidTokenMessage(channelId, output));
      throw new Error(
        `Invalid token format for ${field.envKey}. ${
          field.formatHint || "Check the token and try again."
        }`,
      );
    }
    log(`  ✗ Invalid existing ${channelId} ${tokenNoun(output)} ignored.`);
    token = "";
  }
  if (!token) {
    if (!isInteractive) {
      log(formatSkippedNoTokenMessage(channelId, output));
      throw new Error(`No token entered for ${field.envKey}.`);
    }
    if (field.help) {
      log("");
      log(`  ${field.help}`);
    }
    token = normalizeCredentialValue(await prompt(`  ${field.label}: `, { secret: true }));
    source = "prompted";
  }
  if (!token) {
    log(formatSkippedNoTokenMessage(channelId, output));
    throw new Error(`No token entered for ${field.envKey}.`);
  }
  if (field.format && !field.format.test(token)) {
    log(`  ✗ Invalid format. ${field.formatHint || "Check the token and try again."}`);
    log(formatSkippedInvalidTokenMessage(channelId, output));
    throw new Error(
      `Invalid token format for ${field.envKey}. ${
        field.formatHint || "Check the token and try again."
      }`,
    );
  }

  return { token, source };
}

function persistTokenValue(
  field: TokenPasteField,
  token: string,
  source: "existing" | "prompted",
  options: TokenPasteHookOptions,
): void {
  const env = options.env ?? process.env;
  env[field.envKey] = token;
  if (source === "prompted") {
    const writeCredential = options.saveCredential ?? (() => {});
    writeCredential(field.envKey, token);
  }
}

async function missingPhaseOnePrompt(): Promise<string> {
  throw new Error("Token-paste hook requires an injected prompt implementation in phase 1.");
}

function normalizeCredentialValue(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r/g, "").trim();
}

function resolveTokenPasteField(
  channelId: string,
  output: ChannelHookOutputSpec,
  options: TokenPasteHookOptions,
): TokenPasteField | null {
  const custom = options.resolveField?.(channelId, output);
  if (custom) return custom;

  const manifest = createBuiltInChannelManifestRegistry().get(channelId);
  return manifest ? resolveManifestTokenPasteField(manifest, output) : null;
}

function resolveManifestTokenPasteField(
  manifest: ChannelManifest,
  output: ChannelHookOutputSpec,
): TokenPasteField | null {
  const input = manifest.inputs.find(
    (entry): entry is ChannelSecretInputSpec => entry.kind === "secret" && entry.id === output.id,
  );
  if (!input?.envKey) return null;
  return {
    envKey: input.envKey,
    label: input.prompt?.label ?? input.envKey,
    help: input.prompt?.help,
    format: input.formatPattern ? new RegExp(input.formatPattern) : undefined,
    formatHint: input.formatHint,
  };
}

export const tokenPasteHook = createTokenPasteHook();

function logTokenStatus(
  channelId: string,
  output: ChannelHookOutputSpec,
  source: "existing" | "prompted",
  options: TokenPasteHookOptions,
): void {
  const log = options.log ?? ((message: string) => console.log(message));
  if (source === "existing") {
    log(
      output.id === "botToken"
        ? `  ✓ ${channelId} — already configured`
        : `  ✓ ${channelId} ${tokenNoun(output)} — already configured`,
    );
    return;
  }
  log(`  ✓ ${channelId} ${tokenNoun(output)} saved`);
}

function logEnrollmentNotes(
  manifest: ChannelManifest | undefined,
  options: TokenPasteHookOptions,
): void {
  const log = options.log ?? ((message: string) => console.log(message));
  for (const line of manifest?.enrollmentNotes ?? []) {
    log(`  ${line}`);
  }
}

function isPrimarySecretOutput(
  manifest: ChannelManifest | undefined,
  output: ChannelHookOutputSpec,
): boolean {
  return (
    manifest?.inputs.find(
      (input): input is ChannelSecretInputSpec =>
        input.kind === "secret" && input.required && Boolean(input.envKey),
    )?.id === output.id
  );
}

function tokenNoun(output: ChannelHookOutputSpec): string {
  return output.id === "appToken" ? "app token" : "token";
}

function formatSkippedNoTokenMessage(channelId: string, output: ChannelHookOutputSpec): string {
  if (output.id === "appToken") {
    return `  Skipped ${channelId} app token (Socket Mode requires both tokens)`;
  }
  return `  Skipped ${channelId} (no token entered)`;
}

function formatSkippedInvalidTokenMessage(
  channelId: string,
  output: ChannelHookOutputSpec,
): string {
  if (output.id === "appToken") {
    return `  Skipped ${channelId} app token (invalid token format)`;
  }
  return `  Skipped ${channelId} (invalid token format)`;
}
