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
  const providerNameCounts = new Map<string, number>();
  for (const provider of checkpoint.bindings.registeredProviders) {
    providerNameCounts.set(provider.name, (providerNameCounts.get(provider.name) ?? 0) + 1);
  }
  const missingProviders = [
    ...new Set(
      checkpoint.bindings.registeredProviders
        .filter(
          (provider) =>
            !provider.name ||
            !provider.type ||
            !provider.credentialEnv ||
            provider.name.trim() !== provider.name ||
            provider.type.trim() !== provider.type ||
            provider.credentialEnv.trim() !== provider.credentialEnv ||
            providerNameCounts.get(provider.name) !== 1 ||
            !available.liveRegisteredProviders.has(provider.name),
        )
        .map((provider) => provider.name || "<invalid provider binding>"),
    ),
  ];
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
