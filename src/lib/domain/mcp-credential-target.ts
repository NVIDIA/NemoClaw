// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type McpCredentialTarget = {
  server: string;
  url: string;
  providerName?: string;
};

export type AmbiguousMcpCredentialTarget = {
  entry: McpCredentialTarget;
  conflict: McpCredentialTarget;
};

/** Find credential-bound definitions that cannot be distinguished by endpoint. */
export function findAmbiguousMcpCredentialTarget(
  entries: readonly McpCredentialTarget[],
): AmbiguousMcpCredentialTarget | null {
  for (const [index, entry] of entries.entries()) {
    const conflict = entries
      .slice(0, index)
      .find(
        (candidate) =>
          candidate.server !== entry.server &&
          candidate.url === entry.url &&
          candidate.providerName !== entry.providerName &&
          (candidate.providerName !== undefined || entry.providerName !== undefined),
      );
    if (conflict) return { entry, conflict };
  }
  return null;
}
