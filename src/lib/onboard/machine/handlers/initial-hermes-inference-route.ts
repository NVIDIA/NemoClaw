// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { usesNativeLocalInferenceForAgent } from "../../../inference/native-local/eligibility";
import type { SandboxEntry } from "../../../state/registry";
import { patchHermesInferenceConfig } from "../../../actions/inference-set";
import {
  readHermesNativeNvidiaCredentialHandleIfNeeded,
  readNativeNvidiaCredentialHandle,
} from "../../../actions/inference-set-provider";
import { readSandboxConfig, resolveAgentConfig, writeSandboxConfig } from "../../../sandbox/config";

const defaultDeps = {
  patchHermesInferenceConfig,
  readNativeNvidiaCredentialHandle,
  readSandboxConfig,
  resolveAgentConfig,
  writeSandboxConfig,
};

export async function initializeExternalHermesInferenceRoute(
  options: {
    getSandbox: (name: string) => SandboxEntry | null;
    sandboxName: string;
    gatewayName: string;
    model: string;
    provider: string;
    preferredInferenceApi: string | null;
    revalidateSandboxIdentity: (operation: string) => void;
  },
  deps = defaultDeps,
): Promise<void> {
  const {
    sandboxName,
    gatewayName,
    model,
    provider,
    preferredInferenceApi,
    revalidateSandboxIdentity,
  } = options;
  revalidateSandboxIdentity(
    `read initial Hermes inference configuration in sandbox '${sandboxName}'`,
  );
  const entry = options.getSandbox(sandboxName);
  if (
    !entry ||
    entry.agent !== "hermes" ||
    entry.workload?.kind !== "external-image" ||
    entry.gatewayName !== gatewayName ||
    entry.provider !== provider ||
    entry.model !== model
  ) {
    throw new Error(
      "Initial Hermes inference route does not match its registered external-image selection.",
    );
  }
  // The attached native route initializer owns projection and credential-only restore.
  // Do not replace its provider-bound reference with a shared-route sentinel.
  if (
    entry.registeredInferenceProviderAttachment ||
    entry.nativeLocalProviderAttachment ||
    usesNativeLocalInferenceForAgent(
      "hermes",
      provider,
      entry.endpointUrl,
      provider === "vllm-local" && Boolean(entry.nimContainer),
    )
  )
    return;
  const target = deps.resolveAgentConfig(sandboxName);
  if (target.agentName !== "hermes")
    throw new Error("Initial Hermes inference route requires Hermes configuration.");
  const config = deps.readSandboxConfig(sandboxName, target, gatewayName);
  const nativeProvider = Boolean(
    entry.nativeHostedProviderAttachment || entry.nativeNvidiaProviderAttachment,
  );
  const nativeCredentialHandle = await readHermesNativeNvidiaCredentialHandleIfNeeded({
    agentName: "hermes",
    provider,
    sandboxName,
    gatewayName,
    read: deps.readNativeNvidiaCredentialHandle,
  });
  deps.patchHermesInferenceConfig(
    config,
    provider,
    model,
    preferredInferenceApi,
    undefined,
    entry.endpointUrl ?? undefined,
    nativeProvider,
    nativeCredentialHandle,
  );
  revalidateSandboxIdentity(
    `apply initial Hermes inference configuration in sandbox '${sandboxName}'`,
  );
  deps.writeSandboxConfig(sandboxName, target, config, gatewayName);
}
