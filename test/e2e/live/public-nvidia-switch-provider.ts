// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeNativeNvidiaProviderAttachment,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
} from "../../../src/lib/inference/native-nvidia/index.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";

export const PUBLIC_NVIDIA_SWITCH_PROVIDER = "nvidia-prod";
export const PUBLIC_NVIDIA_SWITCH_MODEL = "nvidia/nemotron-3-super-120b-a12b";

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
  const attachments = await options.sandbox.openshell(
    ["sandbox", "provider", "list", "-g", "nemoclaw", options.sandboxName],
    {
      artifactName: options.artifactName,
      env: options.env,
      timeoutMs: 60_000,
    },
  );
  return [
    `inspection=${String(attachments.exitCode)}`,
    `attached=${String(attachments.stdout.split(/\s+/u).includes(NVIDIA_HOSTED_NATIVE_PROVIDER))}`,
    `schema=${String(receipt?.schemaVersion ?? "missing")}`,
    `profile=${receipt?.profileId ?? "missing"}`,
    `provider=${receipt?.providerName ?? "missing"}`,
    `provider-id=${receipt ? "present" : "missing"}`,
  ].join(";");
}
