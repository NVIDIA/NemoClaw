// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export const MESSAGING_CREDENTIAL_PROVIDER_TYPE = "nemoclaw-mcp-v1"; // gitleaks:allow

export type EndpointlessProviderProfileRunner = (
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

function profileHasExpectedCredentialBoundary(
  output: string,
  expected: { readonly id: string; readonly inferenceCapable: boolean },
): boolean {
  try {
    const profile = JSON.parse(output) as Record<string, unknown>;
    return (
      profile.id === expected.id &&
      Array.isArray(profile.credentials) &&
      profile.credentials.length === 0 &&
      Array.isArray(profile.endpoints) &&
      profile.endpoints.length === 0 &&
      Array.isArray(profile.binaries) &&
      profile.binaries.length === 0 &&
      profile.inference_capable === expected.inferenceCapable
    );
  } catch {
    return false;
  }
}

export function messagingCredentialProviderProfilePath(root: string): string {
  return endpointlessProviderProfilePath(root, MESSAGING_CREDENTIAL_PROVIDER_TYPE);
}

export function endpointlessProviderProfilePath(root: string, profileId: string): string {
  return path.join(root, "nemoclaw-blueprint", "provider-profiles", `${profileId}.yaml`);
}

export type EndpointlessProviderProfileResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "export-failed" | "import-failed" | "incompatible";
      readonly diagnostic: string;
    };

/** Import one endpointless profile or validate the exact existing contract. */
export function ensureEndpointlessProviderProfile(input: {
  readonly profileId: string;
  readonly inferenceCapable: boolean;
  readonly profilePath: string;
  readonly runOpenshell: EndpointlessProviderProfileRunner;
}): EndpointlessProviderProfileResult {
  const imported = input.runOpenshell(
    ["provider", "profile", "import", "--file", input.profilePath],
    { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (imported.status === 0) return { ok: true };

  const importOutput = commandOutput(imported);
  if (!/already exists/iu.test(importOutput)) {
    return { ok: false, reason: "import-failed", diagnostic: importOutput.trim() };
  }

  const exported = input.runOpenshell(
    ["provider", "profile", "export", input.profileId, "--output", "json"],
    { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (exported.status !== 0) {
    return { ok: false, reason: "export-failed", diagnostic: "" };
  }
  if (
    !profileHasExpectedCredentialBoundary(outputText(exported.stdout), {
      id: input.profileId,
      inferenceCapable: input.inferenceCapable,
    })
  ) {
    return { ok: false, reason: "incompatible", diagnostic: "" };
  }
  return { ok: true };
}

/** Register and verify the endpointless profile used by static messaging credentials. */
export function ensureMessagingCredentialProviderProfile(input: {
  readonly root: string;
  readonly runOpenshell: EndpointlessProviderProfileRunner;
}): void {
  const result = ensureEndpointlessProviderProfile({
    profileId: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    inferenceCapable: false,
    profilePath: messagingCredentialProviderProfilePath(input.root),
    runOpenshell: input.runOpenshell,
  });
  if (result.ok) return;
  if (result.reason === "import-failed") {
    throw new Error("Could not import the OpenShell messaging credential profile.");
  }
  if (result.reason === "export-failed") {
    throw new Error(
      `OpenShell provider profile '${MESSAGING_CREDENTIAL_PROVIDER_TYPE}' already exists but could not be exported for validation.`,
    );
  }
  throw new Error(
    `OpenShell provider profile '${MESSAGING_CREDENTIAL_PROVIDER_TYPE}' already exists but does not match NemoClaw's endpointless messaging credential contract.`,
  );
}
