// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isPublishedSandboxRegistration } from "../../state/registry/route-reservation";
import type { SandboxEntry } from "../../state/registry/types";
import { isLocalInferenceProvider, NATIVE_LOCAL_CREDENTIAL_ENV } from "./agent-config";
import {
  normalizeNativeLocalProviderAttachment,
  type NativeLocalProviderAttachment,
} from "./attachment";

/**
 * The recorded native-local attachment when it authorizes the sandbox's recorded provider, model
 * and agent on the gateway resolved from the same row. Undefined means the record is invalid.
 */
export function authorizedNativeLocalAttachment(
  sandbox: SandboxEntry,
  gatewayName: string | undefined,
): NativeLocalProviderAttachment | undefined {
  const attachment = normalizeNativeLocalProviderAttachment(sandbox.nativeLocalProviderAttachment);
  if (
    !attachment ||
    sandbox.nativeHostedProviderAttachment !== undefined ||
    sandbox.nativeNvidiaProviderAttachment !== undefined ||
    !isPublishedSandboxRegistration(sandbox) ||
    attachment.sandboxName !== sandbox.name ||
    attachment.gatewayName !== gatewayName ||
    attachment.gatewayName !== sandbox.gatewayName ||
    attachment.provider !== sandbox.provider ||
    attachment.credentialEnv !== NATIVE_LOCAL_CREDENTIAL_ENV ||
    typeof sandbox.model !== "string" ||
    !sandbox.model.trim() ||
    !(sandbox.agent === "langchain-deepagents-code"
      ? attachment.agent === undefined
      : sandbox.agent === "hermes" || sandbox.agent === "pi"
        ? attachment.agent === sandbox.agent
        : sandbox.agent === "openclaw" &&
          attachment.agent === "openclaw" &&
          isLocalInferenceProvider(sandbox.provider) &&
          !sandbox.nimContainer)
  )
    return undefined;
  return attachment;
}
