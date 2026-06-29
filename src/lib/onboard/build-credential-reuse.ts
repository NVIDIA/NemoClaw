// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveProviderCredential } from "../credentials/store";
import { validateNvidiaApiKeyValue } from "../validation";
import type { EndpointValidationResult } from "./inference-selection-validation";
import { logMissingNvidiaApiKeyHelp } from "./missing-credential-hints";

/**
 * Non-interactive credential handling for the NVIDIA Endpoints ("build")
 * provider.
 *
 * Returns whether the OpenShell gateway already holds a validated credential
 * that must be reused without a local key. The gateway is the system of record
 * and nothing is written to host disk, so only the recovered-sandbox path (for
 * example `onboard --recreate-sandbox`) may rely on the existing gateway
 * credential. Explicit non-interactive provider selections still require a
 * local key so NemoClaw can validate the endpoint before continuing.
 *
 * Reuse skips endpoint re-validation rather than probing unauthenticated, which
 * would fail at stage [3/8]. See issue #5441.
 *
 * Exits the process when the credential is missing/invalid and unrecoverable.
 */
export function resolveNonInteractiveBuildCredential(opts: {
  provider: string;
  helpUrl: string | null | undefined;
  recoveredFromSandbox: boolean;
  providerExistsInGateway: (name: string) => boolean;
}): boolean {
  const { provider, helpUrl, recoveredFromSandbox, providerExistsInGateway } = opts;
  const resolvedNvidiaKey = resolveProviderCredential("NVIDIA_INFERENCE_API_KEY");
  if (resolvedNvidiaKey) {
    const keyError = validateNvidiaApiKeyValue(resolvedNvidiaKey);
    if (keyError) {
      console.error(keyError);
      console.error(`  Get a key from ${helpUrl}`);
      process.exit(1);
    }
    return false;
  }
  if (!recoveredFromSandbox || !providerExistsInGateway(provider)) {
    logMissingNvidiaApiKeyHelp(helpUrl);
    process.exit(1);
  }
  return true;
}

/**
 * Resolve the preferred inference API for the NVIDIA Endpoints ("build")
 * provider. When the gateway credential is reused without a local key, skip the
 * endpoint re-validation probe — it would run unauthenticated and fail (#5441) —
 * and reuse the already-validated credential. Otherwise run the existing
 * validation probe loop, returning a retry-selection signal when the user backs
 * out so the caller can re-enter provider selection.
 */
export async function resolveBuildPreferredInferenceApi(opts: {
  reuseGatewayCredentialWithoutLocalKey: boolean;
  note: (message: string) => void;
  probe: () => Promise<EndpointValidationResult>;
}): Promise<
  { retrySelection: true } | { retrySelection: false; preferredInferenceApi: string | null }
> {
  const { reuseGatewayCredentialWithoutLocalKey, note, probe } = opts;
  if (reuseGatewayCredentialWithoutLocalKey) {
    note("  Reusing existing gateway credential; skipping endpoint re-validation.");
    return { retrySelection: false, preferredInferenceApi: "openai-completions" };
  }
  while (true) {
    const validation = await probe();
    if (validation.ok) {
      return { retrySelection: false, preferredInferenceApi: validation.api };
    }
    if (validation.retry === "credential" || validation.retry === "retry") {
      continue;
    }
    return { retrySelection: true };
  }
}
