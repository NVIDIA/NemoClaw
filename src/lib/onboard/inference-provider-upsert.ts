// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Issue 3895. Sandbox rebuild calls back into onboard --resume after the
// host shell has been closed, so NVIDIA_API_KEY and friends are no longer
// in process.env even though the original onboard registered the provider
// in the OpenShell gateway. Re-running upsertProvider with an empty env
// would overwrite the gateway-stored credential, so this helper short
// circuits the upsert when the gateway already holds the credential and
// the host has nothing to contribute.

import type { ProbeRecovery } from "../validation-recovery";
import type { ValidationClassification } from "../validation";

export type UpsertResult = { ok: boolean; status?: number; message?: string };

export type UpsertOutcome =
  | { kind: "ok" }
  | { kind: "retry" }
  | { kind: "selection" }
  | { kind: "exit"; code: number };

export type RecoveryChoice = "credential" | "retry" | "selection" | "model" | string;

export interface InferenceProviderUpsertSpec {
  provider: string;
  providerType: string;
  credentialEnv: string;
  endpointUrl: string | null;
  env: Record<string, string>;
  credentialValue: string | null;
  label: string;
  helpUrl: string | null;
}

export interface InferenceProviderUpsertHandlers {
  upsertProvider: (
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: Record<string, string>,
  ) => UpsertResult;
  providerExistsInGateway: (name: string) => boolean;
  isMutableEndpointProvider: (name: string) => boolean;
  isNonInteractive: () => boolean;
  promptValidationRecovery: (
    label: string,
    classification: ProbeRecovery,
    credentialEnv: string,
    helpUrl: string | null,
  ) => Promise<RecoveryChoice>;
  classifyApplyFailure: (message: string) => ValidationClassification;
}

export async function reuseGatewayOrUpsertInferenceProvider(
  spec: InferenceProviderUpsertSpec,
  handlers: InferenceProviderUpsertHandlers,
): Promise<UpsertOutcome> {
  if (
    !spec.credentialValue &&
    !handlers.isMutableEndpointProvider(spec.provider) &&
    handlers.providerExistsInGateway(spec.provider)
  ) {
    return { kind: "ok" };
  }
  const result = handlers.upsertProvider(
    spec.provider,
    spec.providerType,
    spec.credentialEnv,
    spec.endpointUrl,
    spec.env,
  );
  if (result.ok) return { kind: "ok" };
  console.error(`  ${result.message}`);
  if (handlers.isNonInteractive()) {
    return { kind: "exit", code: result.status || 1 };
  }
  const retry = await handlers.promptValidationRecovery(
    spec.label,
    handlers.classifyApplyFailure(result.message ?? ""),
    spec.credentialEnv,
    spec.helpUrl,
  );
  if (retry === "credential" || retry === "retry") return { kind: "retry" };
  if (retry === "selection" || retry === "model") return { kind: "selection" };
  return { kind: "exit", code: result.status || 1 };
}
