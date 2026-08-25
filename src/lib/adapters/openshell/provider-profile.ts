// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export type EndpointlessProviderProfileRunner = (
  args: string[],
  options?: {
    readonly ignoreError?: boolean;
    readonly suppressOutput?: boolean;
    readonly stdio?: ["ignore", "pipe", "pipe"];
  },
) => {
  readonly status?: number | null;
  readonly output?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
};

function outputText(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : "";
}

function commandOutput(result: {
  readonly output?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}): string {
  const streams = [outputText(result.stderr), outputText(result.stdout)].filter(Boolean);
  if (streams.length > 0) return streams.join("\n");
  if (Array.isArray(result.output)) {
    return [outputText(result.output[2]), outputText(result.output[1])].filter(Boolean).join("\n");
  }
  return outputText(result.output);
}

function commandStdout(result: { readonly output?: unknown; readonly stdout?: unknown }): string {
  const stdout = outputText(result.stdout);
  if (stdout) return stdout;
  return Array.isArray(result.output) ? outputText(result.output[1]) : outputText(result.output);
}

function isMissingProviderProfile(output: string, profileId: string): boolean {
  const normalized = output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/g, "")
    .trim();
  const escapedProfileId = profileId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const missingMessage = new RegExp(
    `^(?:provider )?profile(?: ['\"]${escapedProfileId}['\"])? not found$`,
    "iu",
  );
  if (missingMessage.test(normalized)) return true;

  const structuredStatus =
    /(?:status:\s*['"]?NotFound['"]?|code:\s*['"]Some requested entity was not found['"])/iu;
  const message = normalized.match(/message:\s*['"]([^'"\r\n]+)['"]/iu)?.[1]?.trim() ?? "";
  return structuredStatus.test(normalized) && missingMessage.test(message);
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

export function endpointlessProviderProfilePath(root: string, profileId: string): string {
  return path.join(root, "nemoclaw-blueprint", "provider-profiles", `${profileId}.yaml`);
}

export type EndpointlessProviderProfileResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "export-failed" | "import-failed" | "incompatible";
    };

/** Import one endpointless profile or validate the exact existing contract. */
export function ensureEndpointlessProviderProfile(input: {
  readonly profileId: string;
  readonly inferenceCapable: boolean;
  readonly profilePath: string;
  readonly runOpenshell: EndpointlessProviderProfileRunner;
}): EndpointlessProviderProfileResult {
  const exportProfile = () =>
    input.runOpenshell(["provider", "profile", "export", input.profileId, "--output", "json"], {
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

  const exported = exportProfile();
  if (exported.status === 0) {
    return profileHasExpectedCredentialBoundary(commandStdout(exported), {
      id: input.profileId,
      inferenceCapable: input.inferenceCapable,
    })
      ? { ok: true }
      : { ok: false, reason: "incompatible" };
  }

  const exportOutput = commandOutput(exported);
  if (!isMissingProviderProfile(exportOutput, input.profileId)) {
    return { ok: false, reason: "export-failed" };
  }

  const imported = input.runOpenshell(
    ["provider", "profile", "import", "--file", input.profilePath],
    { ignoreError: true, suppressOutput: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (imported.status === 0) return { ok: true };

  const importOutput = commandOutput(imported);
  if (!/already exists/iu.test(importOutput)) {
    return { ok: false, reason: "import-failed" };
  }

  const racedExport = exportProfile();
  if (racedExport.status !== 0) {
    return { ok: false, reason: "export-failed" };
  }
  if (
    !profileHasExpectedCredentialBoundary(commandStdout(racedExport), {
      id: input.profileId,
      inferenceCapable: input.inferenceCapable,
    })
  ) {
    return { ok: false, reason: "incompatible" };
  }
  return { ok: true };
}
