// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookHandler,
  MessagingHookOutputMap,
  MessagingHookRegistration,
} from "../types";
import { getChannelDef } from "../../../sandbox/channels";
import type { ChannelHookOutputSpec } from "../../manifest";

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

    for (const output of context.outputDeclarations ?? []) {
      if (output.kind !== "secret") continue;
      const field = resolveTokenPasteField(context.channelId, output, options);
      if (!field) {
        throw new Error(
          `No token-paste field registered for ${context.channelId}.${output.id}`,
        );
      }
      const token = await resolveTokenValue(field, options);
      outputs[output.id] = {
        kind: "secret",
        value: token,
      };
    }

    return { outputs };
  };
}

export function createCommonHookRegistrations(
  options: TokenPasteHookOptions = {},
): readonly MessagingHookRegistration[] {
  return [
    {
      id: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
      handler: createTokenPasteHook(options),
    },
  ] as const;
}

async function resolveTokenValue(
  field: TokenPasteField,
  options: TokenPasteHookOptions,
): Promise<string> {
  const env = options.env ?? process.env;
  const readCredential = options.getCredential ?? (() => null);
  const writeCredential = options.saveCredential ?? (() => {});
  const prompt = options.prompt ?? missingPhaseOnePrompt;
  const log = options.log ?? ((message: string) => console.log(message));

  let token = normalizeCredentialValue(env[field.envKey]) || readCredential(field.envKey);
  if (!token) {
    if (field.help) log(`  ${field.help}`);
    token = normalizeCredentialValue(await prompt(`  ${field.label}: `, { secret: true }));
  }
  if (!token) {
    throw new Error(`No token entered for ${field.envKey}.`);
  }
  if (field.format && !field.format.test(token)) {
    throw new Error(
      `Invalid token format for ${field.envKey}. ${
        field.formatHint || "Check the token and try again."
      }`,
    );
  }

  writeCredential(field.envKey, token);
  env[field.envKey] = token;
  return token;
}

async function missingPhaseOnePrompt(): Promise<string> {
  throw new Error(
    "Token-paste hook requires an injected prompt implementation in phase 1.",
  );
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

  const channel = getChannelDef(channelId);
  if (!channel) return null;
  if (output.id === "botToken" && "envKey" in channel && channel.envKey) {
    return {
      envKey: channel.envKey,
      label: channel.label,
      help: channel.help,
      format: channel.tokenFormat,
      formatHint: channel.tokenFormatHint,
    };
  }
  if (output.id === "appToken" && "appTokenEnvKey" in channel && channel.appTokenEnvKey) {
    return {
      envKey: channel.appTokenEnvKey,
      label: channel.appTokenLabel ?? `${channel.label} App Token`,
      help: channel.appTokenHelp,
      format: channel.appTokenFormat,
      formatHint: channel.appTokenFormatHint,
    };
  }
  return null;
}

export const tokenPasteHook = createTokenPasteHook();

export const COMMON_HOOK_REGISTRATIONS: readonly MessagingHookRegistration[] =
  createCommonHookRegistrations();
