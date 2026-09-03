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
  readonly error?: unknown;
};

function outputText(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : "";
}

/** Join captured OpenShell diagnostics without exposing them to the terminal. */
export function openshellResultDiagnostic(result: {
  readonly error?: unknown;
  readonly output?: unknown;
  readonly stderr?: unknown;
  readonly stdout?: unknown;
}): string {
  const errorMessage = result.error instanceof Error ? result.error.message : "";
  const streams = [commandOutput(result), errorMessage].filter(Boolean);
  return streams.join(" ");
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

function canonicalizeRefresh(refresh: unknown): unknown {
  const block = recordValue(refresh);
  if (!block) return refresh;
  const canonical: Record<string, unknown> = { ...block };
  if (typeof block.strategy === "string") {
    canonical.strategy = block.strategy.trim().toLowerCase().replaceAll("-", "_");
  }
  if (Array.isArray(block.material)) {
    canonical.material = block.material.map((value) => {
      const material = recordValue(value);
      if (!material) return value;
      const { description: _description, ...fields } = material;
      return {
        ...fields,
        required: material.required ?? false,
        secret: material.secret ?? false,
      };
    });
  }
  return canonical;
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
      refresh: canonicalizeRefresh(credential.refresh ?? null),
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

export type CheckedInProviderProfileComparison = "indeterminate" | "match" | "mismatch";
export type RegisteredProfileComparison = CheckedInProviderProfileComparison | "absent";

/** Compare an exported gateway profile with its checked-in credential boundary. */
export function compareExportedProviderProfileWithContract(
  exported: string,
  expected: CheckedInProviderProfileContract,
): CheckedInProviderProfileComparison {
  try {
    const actual = providerProfileBoundary(JSON.parse(exported) as unknown);
    if (!actual) return "indeterminate";
    return isDeepStrictEqual(actual, expected.boundary) ? "match" : "mismatch";
  } catch {
    return "indeterminate";
  }
}

/** Return whether an exported gateway profile matches the checked-in contract. */
export function exportedProviderProfileMatchesContract(
  exported: string,
  expected: CheckedInProviderProfileContract,
): boolean {
  return compareExportedProviderProfileWithContract(exported, expected) === "match";
}

/** Normalize captured OpenShell diagnostics before exact classification. */
export function normalizeOpenshellDiagnostic(output: string): string {
  return output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/gu, "")
    .replace(/\n\s*│\s*/gu, " ")
    .trim();
}

/** Return whether a failed export proves that the requested profile is absent. */
export function isMissingProviderProfile(output: string, profileId: string): boolean {
  const normalized = normalizeOpenshellDiagnostic(output);
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

export function endpointlessProviderProfilePath(root: string, profileId: string): string {
  return path.join(root, "nemoclaw-blueprint", "provider-profiles", `${profileId}.yaml`);
}

export type CheckedInProviderProfileResult =
  | { readonly ok: true; readonly action: "imported" | "reused" }
  | {
      readonly ok: false;
      readonly reason: "import-failed" | "probe-failed" | "profile-drifted" | "profile-unreadable";
      readonly operation?: "import" | "post-import-export" | "profile-export";
      readonly diagnostic?: string;
      readonly diagnosticStatus?: number | null;
    };

const PROFILE_COMMAND_OPTIONS = {
  ignoreError: true,
  suppressOutput: true,
  stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
};

/** Import a checked-in profile when absent, or validate and reuse the registered profile. */
export function reconcileCheckedInProviderProfile(input: {
  readonly profileId?: string;
  readonly profilePath: string;
  readonly readCheckedInProfile: () => string;
  readonly runOpenshell: EndpointlessProviderProfileRunner;
  readonly probeBeforeImport?: boolean;
}): CheckedInProviderProfileResult {
  const expected = parseCheckedInProviderProfileContractSafely(input);
  if (!expected) return { ok: false, reason: "profile-unreadable" };
  const profileId = input.profileId ?? expected.profileId;

  const exportProfile = () =>
    input.runOpenshell(
      ["provider", "profile", "export", profileId, "--output", "json"],
      PROFILE_COMMAND_OPTIONS,
    );
  const validateExport = (
    result: ReturnType<EndpointlessProviderProfileRunner>,
    action: "imported" | "reused",
  ): CheckedInProviderProfileResult => {
    if (result.status !== 0) {
      return {
        ok: false,
        reason: "probe-failed",
        operation: action === "imported" ? "post-import-export" : "profile-export",
        diagnostic: openshellResultDiagnostic(result),
      };
    }
    const comparison = compareExportedProviderProfileWithContract(commandStdout(result), expected);
    if (comparison !== "match") {
      return {
        ok: false,
        reason: comparison === "mismatch" ? "profile-drifted" : "profile-unreadable",
        operation: action === "imported" ? "post-import-export" : "profile-export",
      };
    }
    return { ok: true, action };
  };

  if (input.probeBeforeImport !== false) {
    const exported = exportProfile();
    if (exported.status === 0) return validateExport(exported, "reused");
    const exportDiagnostic = openshellResultDiagnostic(exported);
    if (
      !Number.isInteger(exported.status) ||
      !isMissingProviderProfile(exportDiagnostic, profileId)
    ) {
      return {
        ok: false,
        reason: "probe-failed",
        operation: "profile-export",
        diagnostic: exportDiagnostic,
      };
    }
  }

  const imported = input.runOpenshell(
    ["provider", "profile", "import", "--file", input.profilePath],
    PROFILE_COMMAND_OPTIONS,
  );
  const importDiagnostic = openshellResultDiagnostic(imported);
  if (
    imported.status !== 0 &&
    !/already exists/iu.test(normalizeOpenshellDiagnostic(importDiagnostic))
  ) {
    return {
      ok: false,
      reason: "import-failed",
      operation: "import",
      diagnostic: importDiagnostic,
      diagnosticStatus: imported.status,
    };
  }
  return validateExport(exportProfile(), imported.status === 0 ? "imported" : "reused");
}

function parseCheckedInProviderProfileContractSafely(input: {
  readonly profileId?: string;
  readonly readCheckedInProfile: () => string;
}): CheckedInProviderProfileContract | null {
  try {
    const expected = parseCheckedInProviderProfileContract(input.readCheckedInProfile());
    return expected && (!input.profileId || expected.profileId === input.profileId)
      ? expected
      : null;
  } catch {
    return null;
  }
}

export type EndpointlessProviderProfileFailureReason =
  | "export-failed"
  | "import-failed"
  | "incompatible";

export type EndpointlessProviderProfileResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: EndpointlessProviderProfileFailureReason };

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
  const checkedInProfile = YAML.stringify({
    id: input.profileId,
    credentials: [],
    endpoints: [],
    binaries: [],
    inference_capable: input.inferenceCapable,
  });
  const result = reconcileCheckedInProviderProfile({
    profileId: input.profileId,
    profilePath: input.profilePath,
    readCheckedInProfile: () => checkedInProfile,
    runOpenshell: input.runOpenshell,
  });
  if (result.ok) return { ok: true };
  if (result.reason === "import-failed") return { ok: false, reason: "import-failed" };
  if (result.reason === "probe-failed") return { ok: false, reason: "export-failed" };
  return { ok: false, reason: "incompatible" };
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
