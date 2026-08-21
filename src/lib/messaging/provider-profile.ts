// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export const MESSAGING_CREDENTIAL_PROVIDER_TYPE = "nemoclaw-mcp-v1"; // gitleaks:allow

type MessagingProviderProfileRunner = (
  args: string[],
  options?: {
    readonly ignoreError?: boolean;
    readonly stdio?: ["ignore", "pipe", "pipe"];
  },
) => {
  readonly status?: number | null;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
};

function outputText(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : "";
}

function commandOutput(result: { readonly stdout?: unknown; readonly stderr?: unknown }): string {
  return `${outputText(result.stderr)}\n${outputText(result.stdout)}`;
}

function profileHasExpectedCredentialBoundary(output: string): boolean {
  try {
    const profile = JSON.parse(output) as Record<string, unknown>;
    return (
      profile.id === MESSAGING_CREDENTIAL_PROVIDER_TYPE &&
      Array.isArray(profile.credentials) &&
      profile.credentials.length === 0 &&
      Array.isArray(profile.endpoints) &&
      profile.endpoints.length === 0 &&
      Array.isArray(profile.binaries) &&
      profile.binaries.length === 0 &&
      profile.inference_capable === false
    );
  } catch {
    return false;
  }
}

export function messagingCredentialProviderProfilePath(root: string): string {
  return path.join(
    root,
    "nemoclaw-blueprint",
    "provider-profiles",
    `${MESSAGING_CREDENTIAL_PROVIDER_TYPE}.yaml`,
  );
}

/** Register and verify the endpointless profile used by static messaging credentials. */
export function ensureMessagingCredentialProviderProfile(input: {
  readonly root: string;
  readonly runOpenshell: MessagingProviderProfileRunner;
}): void {
  const imported = input.runOpenshell(
    ["provider", "profile", "import", "--file", messagingCredentialProviderProfilePath(input.root)],
    { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (imported.status === 0) return;

  const importOutput = commandOutput(imported);
  if (!/already exists/iu.test(importOutput)) {
    throw new Error("Could not import the OpenShell messaging credential profile.");
  }

  const exported = input.runOpenshell(
    ["provider", "profile", "export", MESSAGING_CREDENTIAL_PROVIDER_TYPE, "--output", "json"],
    { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (exported.status !== 0 || !profileHasExpectedCredentialBoundary(outputText(exported.stdout))) {
    throw new Error(
      `OpenShell provider profile '${MESSAGING_CREDENTIAL_PROVIDER_TYPE}' already exists but does not match NemoClaw's endpointless messaging credential contract.`,
    );
  }
}
