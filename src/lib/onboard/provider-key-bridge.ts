// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveProviderCredential, saveCredential } from "../credentials/store";

const {
  isProviderKeyCredentialCandidate,
}: {
  isProviderKeyCredentialCandidate: (value: string | null | undefined) => boolean;
} = require("./providers");

// NEMOCLAW_PROVIDER_KEY is a permanent compatibility fallback for callers that
// passed provider credentials through the overloaded provider-key env before
// provider-specific credential envs were consistently documented. The source
// boundary is external automation env; removing it would break non-interactive
// callers, so this bridge filters selector values against providers.ts and is
// covered by onboard-provider-key-bridge plus the direct-credential-env check.
function getProviderKeyBridgeHint(): string {
  // check-direct-credential-env-ignore -- compatibility bridge filters selector values before staging credentials.
  return (process.env.NEMOCLAW_PROVIDER_KEY || "").trim();
}

export function stageRouterProviderKeyBridge(routerCredentialEnv: string): void {
  const providerKeyHint = getProviderKeyBridgeHint();
  if (!isProviderKeyCredentialCandidate(providerKeyHint)) return;
  if (resolveProviderCredential(routerCredentialEnv)) return;
  saveCredential(routerCredentialEnv, providerKeyHint);
}

export function stageBuildProviderKeyBridge(): void {
  const providerKeyHint = getProviderKeyBridgeHint();
  if (!isProviderKeyCredentialCandidate(providerKeyHint)) return;
  const existingNvidiaKey =
    resolveProviderCredential("NVIDIA_INFERENCE_API_KEY") ||
    resolveProviderCredential("NVIDIA_API_KEY");
  if (existingNvidiaKey) return;
  process.env.NVIDIA_INFERENCE_API_KEY = providerKeyHint;
}

export function stageRemoteProviderKeyBridge(credentialEnv: string | null): void {
  if (!credentialEnv) return;
  const providerKeyHint = getProviderKeyBridgeHint();
  if (!isProviderKeyCredentialCandidate(providerKeyHint)) return;
  if (resolveProviderCredential(credentialEnv)) return;
  saveCredential(credentialEnv, providerKeyHint);
}
