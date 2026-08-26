// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type ProviderWithCredentialRevision = {
  credential: string;
  resourceVersion?: number;
};

export function findObservedCredentialRevision(
  proof: string,
  attachedProviders: ReadonlySet<string>,
  providers: ReadonlyMap<string, ProviderWithCredentialRevision>,
): string | null {
  const credential = proof.includes("openshell:resolve:env:GITHUB_TOKEN")
    ? "GITHUB_TOKEN"
    : proof.includes("openshell:resolve:env:SLACK_TOKEN")
      ? "SLACK_TOKEN"
      : null;
  if (credential === null) return null;
  const providerName = [...attachedProviders].find(
    (name) => providers.get(name)?.credential === credential,
  );
  if (!providerName) return null;
  return `v${String(providers.get(providerName)?.resourceVersion ?? 1)}`;
}
