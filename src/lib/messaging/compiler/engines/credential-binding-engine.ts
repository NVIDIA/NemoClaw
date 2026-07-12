// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelManifest,
  SandboxMessagingCredentialBindingPlan,
  SandboxMessagingInputReference,
} from "../../manifest";
import type { ManifestCompilerContext } from "../types";
import { hashCredential } from "../../../security/credential-hash";
import { resolveSandboxNameTemplate } from "./template";

export function planCredentialBindings(
  manifest: ChannelManifest,
  context: ManifestCompilerContext,
  inputs: readonly SandboxMessagingInputReference[],
): SandboxMessagingCredentialBindingPlan[] {
  return manifest.credentials.map((credential) => {
    const sourceInput = inputs.find((input) => input.inputId === credential.sourceInput);
    const credentialAvailable =
      sourceInput?.credentialAvailable === true ||
      context.credentialAvailability?.[credential.id] === true ||
      context.credentialAvailability?.[`${manifest.id}.${credential.id}`] === true;

    const envKey = sourceInput?.sourceEnv ?? credential.providerEnvKey;
    const credentialHash = credentialAvailable
      ? (hashCredential(process.env[envKey]) ?? undefined)
      : undefined;

    return {
      channelId: manifest.id,
      credentialId: credential.id,
      sourceInput: credential.sourceInput,
      providerName: resolveSandboxNameTemplate(credential.providerName, context.sandboxName),
      providerEnvKey: credential.providerEnvKey,
      placeholder: credential.placeholder,
      credentialAvailable,
      ...(credentialHash !== undefined ? { credentialHash } : {}),
    };
  });
}
