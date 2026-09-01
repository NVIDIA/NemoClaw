// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "./provider-command";

export type EndpointlessProviderProfileRunner = (
  args: string[],
  options?: {
    readonly ignoreError?: boolean;
    readonly suppressOutput?: boolean;
    readonly stdio?: ["ignore", "pipe", "pipe"];
    readonly timeout?: number;
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

type ProviderProfileBoundary = Readonly<{
  id: string;
  credentials: readonly Readonly<Record<string, unknown>>[];
  endpoints: readonly unknown[];
  binaries: readonly string[];
  inference_capable: boolean;
}>;

export type CheckedInProviderProfileContract = Readonly<{
  profileId: string;
  boundary: ProviderProfileBoundary;
}>;

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function providerProfileBoundary(value: unknown): ProviderProfileBoundary | null {
  const profile = recordValue(value);
  if (
    !profile ||
    typeof profile.id !== "string" ||
    !Array.isArray(profile.credentials) ||
    !Array.isArray(profile.endpoints) ||
    !Array.isArray(profile.binaries) ||
    profile.binaries.some((binary) => typeof binary !== "string") ||
    typeof profile.inference_capable !== "boolean"
  ) {
    return null;
  }
  const credentials = profile.credentials.map((value) => {
    const credential = recordValue(value);
    if (
      !credential ||
      typeof credential.name !== "string" ||
      !Array.isArray(credential.env_vars) ||
      credential.env_vars.some((envVar) => typeof envVar !== "string") ||
      typeof credential.required !== "boolean" ||
      typeof credential.auth_style !== "string" ||
      typeof credential.header_name !== "string" ||
      (credential.query_param !== undefined && typeof credential.query_param !== "string") ||
      (credential.refresh !== undefined && recordValue(credential.refresh) === null)
    ) {
      return null;
    }
    return {
      name: credential.name,
      env_vars: credential.env_vars,
      required: credential.required,
      auth_style: credential.auth_style,
      header_name: credential.header_name,
      query_param: credential.query_param,
      refresh: credential.refresh ?? null,
    };
  });
  if (credentials.some((credential) => credential === null)) return null;
  if (profile.endpoints.some((endpoint) => recordValue(endpoint) === null)) return null;
  return {
    id: profile.id,
    credentials: credentials as readonly Readonly<Record<string, unknown>>[],
    endpoints: profile.endpoints,
    binaries: profile.binaries as string[],
    inference_capable: profile.inference_capable,
  };
}

/** Parse the credential boundary owned by one checked-in provider profile. */
export function parseCheckedInProviderProfileContract(
  source: string,
): CheckedInProviderProfileContract | null {
  try {
    const boundary = providerProfileBoundary(YAML.parse(source) as unknown);
    return boundary ? { profileId: boundary.id, boundary } : null;
  } catch {
    return null;
  }
}

/** Compare an exported gateway profile with its checked-in credential boundary. */
export function exportedProviderProfileMatchesContract(
  exported: string,
  expected: CheckedInProviderProfileContract,
): boolean {
  try {
    const actual = providerProfileBoundary(JSON.parse(exported) as unknown);
    return actual !== null && isDeepStrictEqual(actual, expected.boundary);
  } catch {
    return false;
  }
}

function isMissingProviderProfile(output: string, profileId: string): boolean {
  const normalized = output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/gu, "")
    .replace(/\n\s*│\s*/gu, " ")
    .trim();
  const escapedProfileId = profileId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const missingMessage = new RegExp(
    `^(?:(?:custom )?provider )?profile(?: ['\"]${escapedProfileId}['\"])? not found[.!]?$`,
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

export type EndpointlessProviderProfileFailureReason =
  | "export-failed"
  | "import-failed"
  | "incompatible";

export type EndpointlessProviderProfileResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: EndpointlessProviderProfileFailureReason;
    };

/** OpenShell provider type registered for every OpenAI-surface inference route. */
export const OPENAI_GATEWAY_PROVIDER_TYPE = "openai";

export type OpenAiProviderProfileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly messages: readonly string[] };

/** Return the recovery guidance for an endpointless OpenAI profile failure. */
export function endpointlessProviderProfileFailureMessages(
  reason: EndpointlessProviderProfileFailureReason,
): readonly string[] {
  if (reason === "import-failed") {
    return [
      `\n  ✗ OpenShell could not import the checked-in '${OPENAI_GATEWAY_PROVIDER_TYPE}' inference provider profile.`,
      "    Confirm OpenShell is available and authorized, then retry this command.",
    ];
  }
  if (reason === "export-failed") {
    return [
      `\n  ✗ OpenShell provider profile '${OPENAI_GATEWAY_PROVIDER_TYPE}' could not be read for validation.`,
      "    Confirm OpenShell is available, authorized, and the profile is readable, then retry this command.",
    ];
  }
  return [
    `\n  ✗ OpenShell provider profile '${OPENAI_GATEWAY_PROVIDER_TYPE}' already exists but does not match NemoClaw's endpointless inference contract.`,
    "    Remove the conflicting profile, then retry this command.",
  ];
}

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
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
  const validateExportedProfile = (
    result: ReturnType<EndpointlessProviderProfileRunner>,
  ): EndpointlessProviderProfileResult => {
    if (result.status !== 0) return { ok: false, reason: "export-failed" };
    return profileHasExpectedCredentialBoundary(commandStdout(result), {
      id: input.profileId,
      inferenceCapable: input.inferenceCapable,
    })
      ? { ok: true }
      : { ok: false, reason: "incompatible" };
  };

  const exported = exportProfile();
  if (exported.status === 0) {
    return validateExportedProfile(exported);
  }

  if (!Number.isInteger(exported.status)) {
    return { ok: false, reason: "export-failed" };
  }
  const exportOutput = commandOutput(exported);
  if (!isMissingProviderProfile(exportOutput, input.profileId)) {
    return { ok: false, reason: "export-failed" };
  }

  const imported = input.runOpenshell(
    ["provider", "profile", "import", "--file", input.profilePath],
    {
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    },
  );
  if (imported.status !== 0 && !/already exists/iu.test(commandOutput(imported))) {
    return { ok: false, reason: "import-failed" };
  }
  return validateExportedProfile(exportProfile());
}

/** Validate or import the endpointless OpenAI profile through the OpenShell adapter. */
export function checkOpenAiInferenceProviderProfile(deps: {
  readonly runOpenshell: EndpointlessProviderProfileRunner;
  readonly root?: string;
}): OpenAiProviderProfileCheck {
  const result = ensureEndpointlessProviderProfile({
    profileId: OPENAI_GATEWAY_PROVIDER_TYPE,
    inferenceCapable: true,
    profilePath: endpointlessProviderProfilePath(
      deps.root ?? REPOSITORY_ROOT,
      OPENAI_GATEWAY_PROVIDER_TYPE,
    ),
    runOpenshell: deps.runOpenshell,
  });
  if (result.ok) return { ok: true };
  return { ok: false, messages: endpointlessProviderProfileFailureMessages(result.reason) };
}
