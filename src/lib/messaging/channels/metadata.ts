// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelAgentPackageSpec,
  ChannelManifest,
  ChannelPolicyPresetReference,
  ChannelPolicyPresetSpec,
  MessagingAgentId,
} from "../manifest";
import { BUILT_IN_CHANNEL_MANIFESTS } from "./built-ins";

export interface MessagingManifestMetadataOptions {
  readonly agent?: MessagingAgentId;
  readonly manifests?: readonly ChannelManifest[];
}

export interface MessagingCredentialMetadata {
  readonly channelId: string;
  readonly credentialId: string;
  readonly sourceInput: string;
  readonly providerNameTemplate: string;
  readonly providerNameSuffix: string;
  readonly providerEnvKey: string;
  readonly placeholder: string;
  readonly primary: boolean;
}

export interface MessagingConfigEnvMetadata {
  readonly channelId: string;
  readonly inputId: string;
  readonly envKey: string;
  readonly envAliases: readonly string[];
  readonly statePath?: string;
  readonly validValues?: readonly string[];
}

export interface MessagingPolicyPresetMetadata {
  readonly channelId: string;
  readonly presetName: string;
  readonly policyKeys: readonly string[];
  readonly agentPolicyKeys: Partial<Record<MessagingAgentId, readonly string[]>>;
  readonly requiredAtCreate: boolean;
  readonly validationWarningLines: readonly string[];
}

export interface OpenClawRuntimeChannelMetadata {
  readonly channelId: string;
  readonly configKeys: readonly string[];
  readonly logPatterns: readonly string[];
}

export interface MessagingPackageInstallMetadata {
  readonly channelId: string;
  readonly packageId: string;
  readonly agents: readonly MessagingAgentId[];
  readonly manager: string;
  readonly spec: string;
  readonly pin?: boolean;
}

export function listBuiltInMessagingChannelManifests(
  options: MessagingManifestMetadataOptions = {},
): ChannelManifest[] {
  return selectManifests(options);
}

export function listAvailableMessagingChannelIds(
  options: MessagingManifestMetadataOptions = {},
): string[] {
  return selectManifests(options).map((manifest) => manifest.id);
}

export function listMessagingCredentialMetadata(
  options: MessagingManifestMetadataOptions = {},
): MessagingCredentialMetadata[] {
  return selectManifests(options).flatMap((manifest) =>
    manifest.credentials.map((credential) => ({
      channelId: manifest.id,
      credentialId: credential.id,
      sourceInput: credential.sourceInput,
      providerNameTemplate: credential.providerName,
      providerNameSuffix: providerNameSuffix(credential.providerName),
      providerEnvKey: credential.providerEnvKey,
      placeholder: credential.placeholder,
      primary: credential.primary === true,
    })),
  );
}

export function getMessagingCredentialEnvKeysByChannel(
  options: MessagingManifestMetadataOptions = {},
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    selectManifests(options).map((manifest) => [
      manifest.id,
      manifest.credentials.map((credential) => credential.providerEnvKey),
    ]),
  );
}

export function getMessagingChannelForCredentialEnvKey(
  envKey: string,
  options: MessagingManifestMetadataOptions = {},
): string | null {
  return (
    listMessagingCredentialMetadata(options).find(
      (credential) => credential.providerEnvKey === envKey,
    )?.channelId ?? null
  );
}

export function getMessagingProviderSuffixesByChannel(
  options: MessagingManifestMetadataOptions = {},
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    selectManifests(options).flatMap((manifest) => {
      const suffixes = manifest.credentials.map((credential) =>
        providerNameSuffix(credential.providerName),
      );
      return suffixes.length > 0 ? [[manifest.id, suffixes]] : [];
    }),
  );
}

export function listMessagingProviderSuffixes(
  options: MessagingManifestMetadataOptions = {},
): string[] {
  return uniqueStrings(
    listMessagingCredentialMetadata(options).map((credential) => credential.providerNameSuffix),
  );
}

export function listMessagingProviderNamesForChannel(
  sandboxName: string,
  channelId: string,
  options: MessagingManifestMetadataOptions = {},
): string[] {
  const manifest = selectManifests(options).find((entry) => entry.id === channelId);
  if (!manifest) return [];
  return manifest.credentials.map((credential) =>
    credential.providerName.replaceAll("{sandboxName}", sandboxName),
  );
}

export function listMessagingConfigEnvMetadata(
  options: MessagingManifestMetadataOptions = {},
): MessagingConfigEnvMetadata[] {
  return selectManifests(options).flatMap((manifest) =>
    manifest.inputs.flatMap((input) => {
      if (input.kind !== "config" || !input.envKey) return [];
      return [
        {
          channelId: manifest.id,
          inputId: input.id,
          envKey: input.envKey,
          envAliases: input.envAliases ?? [],
          ...(input.statePath ? { statePath: input.statePath } : {}),
          ...(input.validValues ? { validValues: input.validValues } : {}),
        },
      ];
    }),
  );
}

export function listMessagingConfigEnvKeys(
  options: MessagingManifestMetadataOptions = {},
): string[] {
  return uniqueStrings(listMessagingConfigEnvMetadata(options).map((input) => input.envKey));
}

export function getMessagingConfigEnvAliases(
  options: MessagingManifestMetadataOptions = {},
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    listMessagingConfigEnvMetadata(options)
      .filter((input) => input.envAliases.length > 0)
      .map((input) => [input.envKey, input.envAliases]),
  );
}

export function listMessagingPolicyPresetMetadata(
  options: MessagingManifestMetadataOptions = {},
): MessagingPolicyPresetMetadata[] {
  return selectManifests(options).flatMap((manifest) =>
    (manifest.policyPresets ?? []).map((preset) => {
      const normalized = normalizePolicyPreset(preset);
      return {
        channelId: manifest.id,
        presetName: normalized.name,
        policyKeys: normalized.policyKeys ?? [normalized.name],
        agentPolicyKeys: normalized.agentPolicyKeys ?? {},
        requiredAtCreate: normalized.requiredAtCreate === true,
        validationWarningLines: normalized.validationWarningLines ?? [],
      };
    }),
  );
}

export function getMessagingPolicyKeysByChannel(
  options: MessagingManifestMetadataOptions = {},
): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, string[]> = {};
  for (const preset of listMessagingPolicyPresetMetadata(options)) {
    const keys = options.agent
      ? (preset.agentPolicyKeys[options.agent] ?? preset.policyKeys)
      : preset.policyKeys;
    result[preset.channelId] = uniqueStrings([...(result[preset.channelId] ?? []), ...keys]);
  }
  return result;
}

export function listRequiredCreateTimeMessagingPolicyPresetNames(
  options: MessagingManifestMetadataOptions = {},
): string[] {
  return uniqueStrings(
    listMessagingPolicyPresetMetadata(options)
      .filter((preset) => preset.requiredAtCreate)
      .map((preset) => preset.presetName),
  );
}

export function listRequiredCreateTimeMessagingPolicyPresetsByChannel(
  options: MessagingManifestMetadataOptions = {},
): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, string[]> = {};
  for (const preset of listMessagingPolicyPresetMetadata(options)) {
    if (!preset.requiredAtCreate) continue;
    result[preset.channelId] = uniqueStrings([
      ...(result[preset.channelId] ?? []),
      preset.presetName,
    ]);
  }
  return result;
}

export function getMessagingPolicyKeyAliases(
  options: MessagingManifestMetadataOptions = {},
): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, string[]> = {};
  for (const preset of listMessagingPolicyPresetMetadata(options)) {
    result[preset.presetName] = uniqueStrings([
      ...(result[preset.presetName] ?? []),
      ...preset.policyKeys,
      ...Object.values(preset.agentPolicyKeys).flatMap((keys) => keys ?? []),
    ]);
  }
  return result;
}

export function getMessagingPolicyPresetValidationWarnings(
  options: MessagingManifestMetadataOptions = {},
): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, string[]> = {};
  for (const preset of listMessagingPolicyPresetMetadata(options)) {
    if (preset.validationWarningLines.length === 0) continue;
    result[preset.presetName] = uniqueStrings([
      ...(result[preset.presetName] ?? []),
      ...preset.validationWarningLines,
    ]);
  }
  return result;
}

export function listOpenClawRuntimeChannelMetadata(
  options: MessagingManifestMetadataOptions = {},
): OpenClawRuntimeChannelMetadata[] {
  return selectManifests({ ...options, agent: "openclaw" }).flatMap((manifest) => {
    const visibility = manifest.runtime?.openclaw?.visibility;
    if (!visibility) return [];
    if (visibility.configKeys.length === 0 || visibility.logPatterns.length === 0) return [];
    return [
      {
        channelId: manifest.id,
        configKeys: [...visibility.configKeys],
        logPatterns: [...visibility.logPatterns],
      },
    ];
  });
}

export function listMessagingPackageInstallSpecs(
  options: MessagingManifestMetadataOptions = {},
): MessagingPackageInstallMetadata[] {
  return selectManifests(options).flatMap((manifest) =>
    (manifest.agentPackages ?? []).flatMap((agentPackage) => {
      if (options.agent && agentPackage.agent !== options.agent) return [];
      return [
        {
          channelId: manifest.id,
          packageId: agentPackage.id,
          agents: [agentPackage.agent],
          ...packageInstallValue(agentPackage),
        },
      ];
    }),
  );
}

function selectManifests(options: MessagingManifestMetadataOptions): ChannelManifest[] {
  const manifests = options.manifests ?? BUILT_IN_CHANNEL_MANIFESTS;
  const agent = options.agent;
  const selected = agent
    ? manifests.filter((manifest) => manifest.supportedAgents.includes(agent))
    : manifests;
  return [...selected];
}

function providerNameSuffix(providerNameTemplate: string): string {
  return providerNameTemplate.replaceAll("{sandboxName}", "");
}

function normalizePolicyPreset(preset: ChannelPolicyPresetReference): ChannelPolicyPresetSpec {
  return typeof preset === "string" ? { name: preset } : preset;
}

function packageInstallValue(
  value: ChannelAgentPackageSpec,
): Pick<MessagingPackageInstallMetadata, "manager" | "spec" | "pin"> {
  return {
    manager: value.manager,
    spec: value.spec,
    ...(typeof value.pin === "boolean" ? { pin: value.pin } : {}),
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
