// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeNativeNvidiaProviderAttachment,
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
} from "../../../src/lib/inference/native-nvidia/index.ts";
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

export async function readPublicNvidiaSwitchAttachmentEvidence(options: {
  readonly artifactName: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logicalProvider: string;
  readonly receipt: unknown;
  readonly sandbox: SandboxClient;
  readonly sandboxName: string;
}): Promise<string | null> {
  if (options.logicalProvider !== PUBLIC_NVIDIA_SWITCH_PROVIDER) return null;
  const receipt = normalizeNativeNvidiaProviderAttachment(options.receipt);
  const providerRedactionValues = [
    options.env.NVIDIA_API_KEY,
    options.env[NVIDIA_HOSTED_CREDENTIAL_ENV],
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const provider = await options.sandbox.openshell(
    ["provider", "get", "-g", "nemoclaw", NVIDIA_HOSTED_NATIVE_PROVIDER],
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
      timeoutMs: 60_000,
    },
  );
  return [
    `provider-inspection=${String(provider.exitCode)}`,
    `provider-name=${metadata?.name === receipt?.providerName ? "match" : "mismatch"}`,
    `provider-profile=${
      metadata?.type === receipt?.profileId &&
      metadata?.credentialKeys.length === 1 &&
      metadata.credentialKeys[0] === NVIDIA_HOSTED_CREDENTIAL_ENV &&
      metadata.configKeys.length === 0 &&
      metadata.type === NVIDIA_HOSTED_NATIVE_PROFILE_ID
        ? "match"
        : "mismatch"
    }`,
    `provider-id=${metadata?.revision?.id === receipt?.providerId ? "match" : "mismatch"}`,
    `attachment-inspection=${String(attachments.exitCode)}`,
    `attached=${String(attachments.stdout.split(/\s+/u).includes(NVIDIA_HOSTED_NATIVE_PROVIDER))}`,
    `schema=${String(receipt?.schemaVersion ?? "missing")}`,
    `profile=${receipt?.profileId ?? "missing"}`,
    `provider=${receipt?.providerName ?? "missing"}`,
  ].join(";");
}
