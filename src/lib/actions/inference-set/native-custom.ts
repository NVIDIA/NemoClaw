// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { InferenceSetDeps } from "../inference-set";
import { InferenceSetError } from "../inference-set-error";
import { redactInferenceSetRouteDiagnostic } from "../inference-set-provider-diagnostics";
import { cliOpenShellSandboxPolicyReader } from "../../adapters/openshell/sandbox-policy-cli";
import type { NativeProviderAttachment } from "../../inference/native-provider/contract";
import { prepareCustomNativeProvider } from "../../inference/native-provider/custom-setup";
import { customNativeCredentialEnv } from "../../inference/native-provider/hosted";
import { fixedNativeProviderForAttachment } from "../../inference/native-provider/fixed";
import { nativeProviderLifecycle } from "../../inference/native-provider";

export async function prepareCustomNativeSelection(input: {
  provider: string;
  expectedAttachment?: NativeProviderAttachment;
  gatewayName: string;
  sandboxName: string;
  endpointUrl?: string | null;
  credentialEnv?: string | null;
  inferenceApi?: string | null;
  beforeAttach?: (receipt: NativeProviderAttachment) => Promise<void>;
  deps: InferenceSetDeps;
}): Promise<{
  attachment: NativeProviderAttachment;
  attachmentChanged: boolean;
  endpointUrl?: string;
}> {
  if (!input.deps.getNativeHostedProviderAuthority || !input.deps.setNativeHostedProviderAuthority)
    throw new InferenceSetError("Native hosted provider ownership storage is unavailable");
  const credentialEnv = input.credentialEnv || customNativeCredentialEnv(input.provider);
  const policy = await (
    input.deps.sandboxPolicyReader ?? cliOpenShellSandboxPolicyReader
  ).readSandboxPolicy({
    target: { kind: "named", gatewayName: input.gatewayName },
    sandboxName: input.sandboxName,
    // Exclude the previous attachment's generated rule, which is detached
    // before replacement. The sandbox's base rules remain in place.
    scope: "base",
  });
  if (!policy.ok) {
    throw new InferenceSetError(
      `Cannot inspect the sandbox policy before selecting a custom endpoint: ${redactInferenceSetRouteDiagnostic(policy.error.message)} Resolve the policy-read error before retrying. No provider was changed.`,
    );
  }
  const receipt = await prepareCustomNativeProvider({
    gatewayName: input.gatewayName,
    provider: input.provider,
    endpointUrl: input.endpointUrl || "",
    api:
      input.inferenceApi ||
      (input.provider === "compatible-anthropic-endpoint"
        ? "anthropic-messages"
        : "openai-completions"),
    credentialEnv,
    credentialValue: input.deps.resolveCredentialValue(credentialEnv) || null,
    adapter: input.deps.providerAdapter,
    sandboxPolicyDocument: policy.value.document,
    recordedAttachment: input.expectedAttachment,
    recordedSandboxName: input.sandboxName,
    readAuthority: input.deps.getNativeHostedProviderAuthority,
    writeAuthority: input.deps.setNativeHostedProviderAuthority,
  });
  await input.beforeAttach?.(receipt);
  const attached = await nativeProviderLifecycle(
    fixedNativeProviderForAttachment(receipt),
  ).ensureNativeProviderAttached({
    adapter: input.deps.providerAdapter,
    target: { kind: "named", gatewayName: input.gatewayName },
    sandboxName: input.sandboxName,
    expected: receipt,
  });
  return {
    attachment: attached.receipt,
    attachmentChanged: attached.changed,
    endpointUrl: receipt.endpointUrl,
  };
}
