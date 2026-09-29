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

function credentialPolicyEndpointKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return JSON.stringify([url.hostname, port, url.pathname || "/"]);
  } catch {
    // Invalid legacy values still retain the previous exact-string comparison.
    return rawUrl;
  }
}

/** Find credential-bound definitions that cannot be distinguished by endpoint. */
export function findAmbiguousMcpCredentialTarget(
  entries: readonly McpCredentialTarget[],
): AmbiguousMcpCredentialTarget | null {
  for (const [index, entry] of entries.entries()) {
    const endpointKey = credentialPolicyEndpointKey(entry.url);
    const conflict = entries
      .slice(0, index)
      .find(
        (candidate) =>
          candidate.server !== entry.server &&
          credentialPolicyEndpointKey(candidate.url) === endpointKey &&
          candidate.providerName !== undefined &&
          entry.providerName !== undefined &&
          candidate.providerName !== entry.providerName,
      );
    if (conflict) return { entry, conflict };
  }
  return null;
}
