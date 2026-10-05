// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeNativeHostedProviderAttachment } from "../../../src/lib/inference/native-hosted/contract.ts";
import { nativeHostedProfile } from "../../../src/lib/inference/native-hosted/profiles.ts";
import { parseCliOpenShellProviderMetadata } from "../../../src/lib/adapters/openshell/provider-metadata-cli.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";

export const PUBLIC_NVIDIA_SWITCH_PROVIDER = "nvidia-prod";
export const PUBLIC_NVIDIA_SWITCH_MODEL = "nvidia/nemotron-3-super-120b-a12b";
export const PUBLIC_NVIDIA_SWITCH_ATTACHMENT_EVIDENCE =
  "provider-inspection=0;provider-name=match;provider-profile=match;provider-id=match;attachment-inspection=0;attached=true;schema=1;profile=nemoclaw-nvidia-inference-v1;provider=nemoclaw-nvidia-prod-v1";

export function requirePublicNvidiaSwitchKey(value: string): string {
  if (!/^nvapi-[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("NVIDIA_API_KEY must be a public NVIDIA Endpoints nvapi-* key");
  }
  return value;
}

type AttachmentEvidenceOptions = {
  readonly artifactName: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logicalProvider: string;
  readonly receipt: unknown;
  readonly sandbox: SandboxClient;
  readonly sandboxName: string;
};

export async function readPublicNvidiaSwitchAttachmentEvidence(
  options: AttachmentEvidenceOptions,
): Promise<string | null> {
  if (options.logicalProvider !== PUBLIC_NVIDIA_SWITCH_PROVIDER) return null;
  return readNativeSwitchAttachmentEvidence(options);
}

export function expectedNativeSwitchAttachmentEvidence(provider: string): string | null {
  const profile = nativeHostedProfile(provider);
  if (!profile) return null;
  return `provider-inspection=0;provider-name=match;provider-profile=match;provider-id=match;attachment-inspection=0;attached=true;schema=1;profile=${profile.profileId};provider=${profile.providerName}`;
}

export async function readNativeSwitchAttachmentEvidence(
  options: AttachmentEvidenceOptions,
): Promise<string | null> {
  const profile = nativeHostedProfile(options.logicalProvider);
  if (!profile) return null;
  const receipt = normalizeNativeHostedProviderAttachment(options.receipt);
  const providerRedactionValues = [
    options.env.NVIDIA_API_KEY,
    options.env[profile.credentialEnv],
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const provider = await options.sandbox.openshell(
    ["provider", "get", "-g", "nemoclaw", profile.providerName],
    {
      artifactName: `${options.artifactName}-provider-metadata`,
      captureLimitBytes: 16 * 1024,
      env: options.env,
      persistArtifacts: true,
      redactionValues: providerRedactionValues,
      timeoutMs: 60_000,
    },
  );
  const metadata =
    provider.exitCode === 0 ? parseCliOpenShellProviderMetadata(provider.stdout) : null;
  const attachments = await options.sandbox.openshell(
    ["sandbox", "provider", "list", "-g", "nemoclaw", options.sandboxName],
    {
      artifactName: options.artifactName,
      env: options.env,
      redactionValues: providerRedactionValues,
      timeoutMs: 60_000,
    },
  );
  return [
    `provider-inspection=${String(provider.exitCode)}`,
    `provider-name=${metadata?.name === receipt?.providerName ? "match" : "mismatch"}`,
    `provider-profile=${
      metadata?.type === receipt?.profileId &&
      metadata?.credentialKeys.length === 1 &&
      metadata.credentialKeys[0] === profile.credentialEnv &&
      metadata.configKeys.length === 0 &&
      metadata.type === profile.profileId
        ? "match"
        : "mismatch"
    }`,
    `provider-id=${metadata?.revision?.id === receipt?.providerId ? "match" : "mismatch"}`,
    `attachment-inspection=${String(attachments.exitCode)}`,
    `attached=${String(attachments.stdout.split(/\s+/u).includes(profile.providerName))}`,
    `schema=${String(receipt?.schemaVersion ?? "missing")}`,
    `profile=${receipt?.profileId ?? "missing"}`,
    `provider=${receipt?.providerName ?? "missing"}`,
  ].join(";");
}
