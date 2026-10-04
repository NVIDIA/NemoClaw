// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { deleteCredential, saveCredential } from "../credentials/store";
import { listBuiltInMessagingChannelManifests } from "../messaging/channels";
import type {
  ChannelCredentialSpec,
  ChannelInputSpec,
  ChannelManifest,
} from "../messaging/manifest";

export interface ChannelBase {
  description: string;
  help: string;
  label: string;
  setupNotes?: readonly string[];
  userIdEnvKey?: string;
  userIdHelp?: string;
  userIdLabel?: string;
  allowIdsMode?: "dm" | "guild";
  channelIdEnvKey?: string;
  channelIdHelp?: string;
  channelIdLabel?: string;
  serverIdEnvKey?: string;
  serverIdHelp?: string;
  serverIdLabel?: string;
  requireMentionEnvKey?: string;
  requireMentionHelp?: string;
}

export interface CredentialBackedChannelDef extends ChannelBase {
  envKey?: string;
  appTokenEnvKey?: string;
  appTokenHelp?: string;
  appTokenLabel?: string;
  tokenFormat?: RegExp;
  tokenFormatHint?: string;
  appTokenFormat?: RegExp;
  appTokenFormatHint?: string;
  // "host-qr" channels capture a static token via a host-side QR handshake
  // (e.g. wechat/iLink). Defaults to "token-paste" when omitted.
  loginMethod?: "token-paste" | "host-qr";
}

export interface InSandboxQrChannelDef extends ChannelBase {
  // In-sandbox QR channels intentionally let the bot library own mutable
  // session state inside the sandbox after the operator pairs the account.
  // That is the runtime tradeoff of enabling the channel without a host bridge;
  // NemoClaw must still not declare host-side token env keys or OpenShell
  // provider credentials for these channels.
  loginMethod: "in-sandbox-qr";
  envKey?: never;
  appTokenEnvKey?: never;
  appTokenHelp?: never;
  appTokenLabel?: never;
  tokenFormat?: never;
  tokenFormatHint?: never;
  appTokenFormat?: never;
  appTokenFormatHint?: never;
}

export type ChannelDef = CredentialBackedChannelDef | InSandboxQrChannelDef;

export const KNOWN_CHANNELS: Record<string, ChannelDef> = Object.fromEntries(
  listBuiltInMessagingChannelManifests().map((manifest) => [
    manifest.id,
    channelDefFromManifest(manifest),
  ]),
);

export function getChannelDef(name: string): ChannelDef | undefined {
  return KNOWN_CHANNELS[name.trim().toLowerCase()];
}

export function knownChannelNames(): string[] {
  return Object.keys(KNOWN_CHANNELS);
}

export function listChannels(): Array<{ name: string } & ChannelDef> {
  return Object.entries(KNOWN_CHANNELS).map(([name, def]) => ({ name, ...def }));
}

export function getChannelTokenKeys(channel: ChannelDef): string[] {
  if (!channel.envKey) return [];
  return channel.appTokenEnvKey ? [channel.envKey, channel.appTokenEnvKey] : [channel.envKey];
}

export function channelUsesInSandboxQrPairing(channel: ChannelDef): boolean {
  return channel.loginMethod === "in-sandbox-qr";
}

export function channelHasStaticToken(
  channel: ChannelDef,
): channel is CredentialBackedChannelDef & { envKey: string } {
  return typeof channel.envKey === "string" && channel.envKey.length > 0;
}

export function persistChannelTokens(tokens: Record<string, string>): void {
  for (const [key, value] of Object.entries(tokens)) {
    saveCredential(key, value);
  }
}

export function clearChannelTokens(channel: ChannelDef): void {
  for (const key of getChannelTokenKeys(channel)) {
    deleteCredential(key);
  }
}

function channelDefFromManifest(manifest: ChannelManifest): ChannelDef {
  const credentials = manifest.credentials;
  const primaryCredential = credentials[0];
  const primaryInput = primaryCredential
    ? findInput(manifest, primaryCredential.sourceInput)
    : undefined;
  const appCredential = credentials[1];
  const appInput = appCredential ? findInput(manifest, appCredential.sourceInput) : undefined;
  const base: ChannelBase = {
    description: manifest.description ?? `${manifest.displayName} messaging`,
    help:
      primaryInput?.prompt?.help ??
      manifest.enrollmentHelp ??
      manifest.description ??
      `${manifest.displayName} messaging`,
    label: primaryInput?.prompt?.label ?? manifest.displayName,
    ...(manifest.enrollmentNotes ? { setupNotes: manifest.enrollmentNotes } : {}),
    ...configFieldMetadata(manifest),
  };

  if (manifest.auth.mode === "in-sandbox-qr") {
    return {
      ...base,
      loginMethod: "in-sandbox-qr",
    };
  }

  return {
    ...base,
    ...(manifest.auth.mode === "host-qr" ? { loginMethod: "host-qr" as const } : {}),
    ...(primaryCredential ? credentialFieldMetadata(primaryCredential, primaryInput) : {}),
    ...(appCredential ? appCredentialFieldMetadata(appCredential, appInput) : {}),
  };
}

function credentialFieldMetadata(
  credential: ChannelCredentialSpec,
  input: ChannelInputSpec | undefined,
): Pick<CredentialBackedChannelDef, "envKey" | "tokenFormat" | "tokenFormatHint"> {
  const tokenFormat = input?.formatPattern ? safeRegExp(input.formatPattern) : undefined;
  return {
    envKey: credential.providerEnvKey,
    ...(tokenFormat ? { tokenFormat } : {}),
    ...(input?.formatHint ? { tokenFormatHint: input.formatHint } : {}),
  };
}

function appCredentialFieldMetadata(
  credential: ChannelCredentialSpec,
  input: ChannelInputSpec | undefined,
): Pick<
  CredentialBackedChannelDef,
  "appTokenEnvKey" | "appTokenHelp" | "appTokenLabel" | "appTokenFormat" | "appTokenFormatHint"
> {
  const appTokenFormat = input?.formatPattern ? safeRegExp(input.formatPattern) : undefined;
  return {
    appTokenEnvKey: credential.providerEnvKey,
    ...(input?.prompt?.help ? { appTokenHelp: input.prompt.help } : {}),
    ...(input?.prompt?.label ? { appTokenLabel: input.prompt.label } : {}),
    ...(appTokenFormat ? { appTokenFormat } : {}),
    ...(input?.formatHint ? { appTokenFormatHint: input.formatHint } : {}),
  };
}

function configFieldMetadata(manifest: ChannelManifest): Partial<ChannelBase> {
  const metadata: Partial<ChannelBase> = {};
  const allowedUsers = findFirstInput(manifest, ["allowedUsers", "allowedIds", "userId"]);
  if (allowedUsers?.envKey) {
    metadata.userIdEnvKey = allowedUsers.envKey;
    metadata.allowIdsMode = inferAllowIdsMode(allowedUsers);
    if (allowedUsers.prompt?.help) metadata.userIdHelp = allowedUsers.prompt.help;
    if (allowedUsers.prompt?.label) metadata.userIdLabel = allowedUsers.prompt.label;
  }

  const allowedChannels = findInput(manifest, "allowedChannels");
  if (allowedChannels?.envKey) {
    metadata.channelIdEnvKey = allowedChannels.envKey;
    if (allowedChannels.prompt?.help) metadata.channelIdHelp = allowedChannels.prompt.help;
    if (allowedChannels.prompt?.label) metadata.channelIdLabel = allowedChannels.prompt.label;
  }

  const serverId = findInput(manifest, "serverId");
  if (serverId?.envKey) {
    metadata.serverIdEnvKey = serverId.envKey;
    if (serverId.prompt?.help) metadata.serverIdHelp = serverId.prompt.help;
    if (serverId.prompt?.label) metadata.serverIdLabel = serverId.prompt.label;
  }

  const requireMention = findInput(manifest, "requireMention");
  if (requireMention?.envKey) {
    metadata.requireMentionEnvKey = requireMention.envKey;
    if (requireMention.prompt?.help) metadata.requireMentionHelp = requireMention.prompt.help;
  }

  return metadata;
}

function findInput(manifest: ChannelManifest, inputId: string): ChannelInputSpec | undefined {
  return manifest.inputs.find((input) => input.id === inputId);
}

function findFirstInput(
  manifest: ChannelManifest,
  inputIds: readonly string[],
): ChannelInputSpec | undefined {
  return inputIds
    .map((inputId) => findInput(manifest, inputId))
    .find((input): input is ChannelInputSpec => Boolean(input));
}

function inferAllowIdsMode(input: ChannelInputSpec): ChannelBase["allowIdsMode"] {
  return input.statePath?.startsWith("discordGuilds.") ? "guild" : "dm";
}

function safeRegExp(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}
