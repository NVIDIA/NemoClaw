// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardCheckpoint } from "../state/onboard-checkpoint-types";

export interface BindingAvailability {
  readonly availableCredentialEnvs: ReadonlySet<string>;
  readonly liveRegisteredProviders: ReadonlySet<string>;
}

export type BindingRevalidation =
  | { readonly status: "ok" }
  | {
      readonly status: "stale";
      readonly missingCredentialEnvs: readonly string[];
      readonly missingProviders: readonly string[];
    };

export function revalidateCheckpointBindings(
  checkpoint: OnboardCheckpoint,
  available: BindingAvailability,
): BindingRevalidation {
  const missingCredentialEnvs = checkpoint.bindings.credentialEnvs.filter(
    (env) => !available.availableCredentialEnvs.has(env),
  );
  const missingProviders = checkpoint.bindings.registeredProviders
    .filter((provider) => !available.liveRegisteredProviders.has(provider.name))
    .map((provider) => provider.name);
  if (missingCredentialEnvs.length === 0 && missingProviders.length === 0) {
    return { status: "ok" };
  }
  return { status: "stale", missingCredentialEnvs, missingProviders };
}

export function bindingRevalidationGuidance(revalidation: BindingRevalidation): string | null {
  if (revalidation.status === "ok") return null;
  const parts: string[] = [];
  if (revalidation.missingCredentialEnvs.length > 0) {
    parts.push(
      `missing credential environment variables: ${revalidation.missingCredentialEnvs.join(", ")}`,
    );
  }
  if (revalidation.missingProviders.length > 0) {
    parts.push(`missing registered providers: ${revalidation.missingProviders.join(", ")}`);
  }
  return `Cannot resume safely — ${parts.join("; ")}. Re-supply the values and retry.`;
}
