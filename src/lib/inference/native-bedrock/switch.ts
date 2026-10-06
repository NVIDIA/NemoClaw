// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import {
  getNativeBedrockProviderAuthority,
  setNativeBedrockProviderAuthority,
  clearNativeBedrockProviderAuthority,
} from "../../state/registry/native-bedrock-provider-authority";
import { classifyCustomAnthropicEndpoint, hasBedrockRuntimeAwsAuthEnv } from "../bedrock-runtime";
import { ensureBedrockRuntimeAdapter } from "../bedrock-runtime-adapter";
import { nativeBedrockIdentity, type NativeBedrockProviderAttachment } from "./contract";
import {
  ensureNativeBedrockProvider,
  ensureNativeBedrockProviderAttached,
  detachNativeBedrockProvider,
} from "./profile";
import { retireNativeBedrockProvider } from "./retire";
import { hasOtherNativeProviderReference } from "../native-provider/retirement-references";
export { hasOtherNativeProviderReference } from "../native-provider/retirement-references";

export type NativeBedrockSwitchDeps = {
  listSandboxes: () => {
    sandboxes: Parameters<typeof hasOtherNativeProviderReference>[0]["sandboxes"];
  };
  providerAdapter: OpenShellProviderAdapter;
  resolveCredentialValue: (key: string) => string;
  log: (message: string) => void;
  ensureBedrockRuntimeAdapter?: typeof ensureBedrockRuntimeAdapter;
  getNativeBedrockProviderAuthority?: typeof getNativeBedrockProviderAuthority;
  setNativeBedrockProviderAuthority?: typeof setNativeBedrockProviderAuthority;
  clearNativeBedrockProviderAuthority?: typeof clearNativeBedrockProviderAuthority;
  verifyBedrockAdapterGeneration?: Parameters<
    typeof ensureNativeBedrockProviderAttached
  >[0]["verifyAdapterGeneration"];
};
export { detachNativeBedrockProvider };

export async function prepareNativeBedrockSelection(input: {
  selected: boolean;
  endpointUrl?: string | null;
  credentialEnv?: string | null;
  gatewayName: string;
  sandboxName: string;
  previousAttachment?: NativeBedrockProviderAttachment;
  deps: NativeBedrockSwitchDeps;
}): Promise<{ attachment?: NativeBedrockProviderAttachment; changed: boolean }> {
  if (!input.selected) return { changed: false };
  const { deps } = input;
  const classification = classifyCustomAnthropicEndpoint(input.endpointUrl ?? "");
  if (classification.kind !== "bedrock-runtime")
    throw new Error("Invalid native Bedrock endpoint.");
  let attachment = input.previousAttachment;
  if (
    !attachment ||
    attachment.endpointUrl !== classification.endpointUrl ||
    attachment.gatewayName !== input.gatewayName
  ) {
    const compatibleCredential =
      deps.resolveCredentialValue(input.credentialEnv || "COMPATIBLE_ANTHROPIC_API_KEY") || null;
    if (!compatibleCredential && !hasBedrockRuntimeAwsAuthEnv())
      throw new Error(
        "Bedrock Runtime requires configured AWS authentication or an explicit compatible credential.",
      );
    const adapter = await (deps.ensureBedrockRuntimeAdapter ?? ensureBedrockRuntimeAdapter)({
      classification,
      compatibleCredential,
    });
    const binding = {
      endpointUrl: adapter.endpointUrl,
      region: adapter.region,
      adapterGeneration: adapter.generation,
      adapterBaseUrl: adapter.baseUrl,
      gatewayName: input.gatewayName,
    };
    const identity = nativeBedrockIdentity(binding);
    attachment = await ensureNativeBedrockProvider({
      binding,
      adapter: deps.providerAdapter,
      credentialValue: adapter.token,
      expected: (deps.getNativeBedrockProviderAuthority ?? getNativeBedrockProviderAuthority)(
        input.gatewayName,
        identity.profileId,
      ),
    });
    (deps.setNativeBedrockProviderAuthority ?? setNativeBedrockProviderAuthority)(
      input.gatewayName,
      attachment,
    );
  }
  const attached = await ensureNativeBedrockProviderAttached({
    adapter: deps.providerAdapter,
    sandboxName: input.sandboxName,
    expected: attachment,
    verifyAdapterGeneration: deps.verifyBedrockAdapterGeneration,
  });
  return { attachment, changed: attached.changed };
}

export async function retireUnusedBedrockProvider(
  attachment: NativeBedrockProviderAttachment,
  deps: NativeBedrockSwitchDeps,
  sandboxName?: string,
): Promise<void> {
  if (
    hasOtherNativeProviderReference({
      sandboxes: deps.listSandboxes().sandboxes,
      gatewayName: attachment.gatewayName,
      sandboxName,
      expected: attachment,
    })
  )
    return;
  try {
    await retireNativeBedrockProvider({
      adapter: deps.providerAdapter,
      expected: attachment,
      clearAuthority: () =>
        (deps.clearNativeBedrockProviderAuthority ?? clearNativeBedrockProviderAuthority)(
          attachment.gatewayName,
          attachment,
        ),
    });
  } catch {
    deps.log(
      "  Warning: unused Bedrock provider removal was not confirmed; ownership is retained for credential reset.",
    );
  }
}

export async function rollbackNativeBedrockSelection(input: {
  committed: boolean;
  changed: boolean;
  attachment?: NativeBedrockProviderAttachment;
  previousDetached: boolean;
  previousAttachment?: NativeBedrockProviderAttachment;
  sandboxName: string;
  deps: NativeBedrockSwitchDeps;
}): Promise<void> {
  if (input.committed) return;
  const common = { adapter: input.deps.providerAdapter, sandboxName: input.sandboxName };
  if (input.changed && input.attachment)
    await detachNativeBedrockProvider({ ...common, expected: input.attachment });
  if (input.previousDetached && input.previousAttachment)
    await ensureNativeBedrockProviderAttached({
      ...common,
      expected: input.previousAttachment,
      verifyAdapterGeneration: input.deps.verifyBedrockAdapterGeneration,
    });
  if (input.attachment && input.attachment.providerName !== input.previousAttachment?.providerName)
    await retireUnusedBedrockProvider(input.attachment, input.deps, input.sandboxName);
}
