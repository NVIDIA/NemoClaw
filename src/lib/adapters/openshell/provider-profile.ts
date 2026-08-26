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

/** Join captured OpenShell diagnostics without exposing them to the terminal. */
export function openshellResultDiagnostic(result: {
  readonly error?: Error;
  readonly stderr?: unknown;
  readonly stdout?: unknown;
}): string {
  return [outputText(result.stderr), outputText(result.stdout), result.error?.message ?? ""]
    .filter(Boolean)
    .join(" ");
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

/**
 * Strip ANSI escapes, carriage returns, and OpenShell's box-drawing line
 * continuations so a diagnostic can be pattern-matched regardless of the
 * terminal width or TTY-ness that produced them (#10159).
 */
export function normalizeOpenshellDiagnostic(output: string): string {
  return output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/gu, "")
    .replace(/\n\s*│\s*/gu, " ")
    .trim();
}

/**
 * Whether `output` (an export probe's failure diagnostic) means the profile
 * genuinely doesn't exist yet, as opposed to the probe itself failing for
 * some other reason (gateway unavailable, auth, timeout, malformed
 * response). Only a genuine "not found" makes it safe to proceed to import.
 */
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

/**
 * Project an OpenShell provider-profile document down to the fields that
 * define its authorization boundary (credentials, endpoints, binaries,
 * inference capability), or null if the document doesn't have the expected
 * shape. Callers compare this projection between an exported profile and its
 * checked-in YAML rather than trusting a matching profile ID alone, since a
 * host-global profile store can hold a profile some other process imported
 * under the same ID with a different boundary.
 */
export function credentialBoundary(doc: Record<string, unknown>): Record<string, unknown> | null {
  if (
    typeof doc.id !== "string" ||
    !Array.isArray(doc.credentials) ||
    !Array.isArray(doc.endpoints) ||
    !Array.isArray(doc.binaries) ||
    typeof doc.inference_capable !== "boolean"
  ) {
    return null;
  }
  const credentials = doc.credentials.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const credential = entry as Record<string, unknown>;
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
  if (credentials.some((entry) => entry === null)) return null;
  return {
    id: doc.id,
    credentials,
    endpoints: doc.endpoints,
    binaries: doc.binaries,
    inference_capable: doc.inference_capable,
  };
}

/**
 * Project one credential's `refresh` block into the representation OpenShell
 * exports it in.
 *
 * `provider profile export` re-serializes the stored profile rather than
 * echoing the YAML that was imported, so two fields do not survive the round
 * trip byte-identically on the OpenShell release this blueprint pins
 * (v0.0.106):
 *
 * - `strategy` is read through `provider_refresh_strategy_from_yaml`, which
 *   lowercases and maps `-` to `_`, and written back through
 *   `provider_refresh_strategy_to_yaml`, which only ever emits the snake_case
 *   wire spelling. A profile checked in as `google-service-account-jwt`
 *   therefore exports as `google_service_account_jwt`.
 * - `material[].required` and `material[].secret` carry no
 *   `skip_serializing_if`, so both are emitted on every entry even where the
 *   checked-in YAML omits them and relies on the `false` default.
 */
function canonicalizeRefresh(refresh: unknown): unknown {
  if (refresh === null || typeof refresh !== "object" || Array.isArray(refresh)) return refresh;
  const block = refresh as Record<string, unknown>;
  const canonical: Record<string, unknown> = { ...block };
  if (typeof block.strategy === "string") {
    canonical.strategy = block.strategy.trim().toLowerCase().replaceAll("-", "_");
  }
  if (Array.isArray(block.material)) {
    canonical.material = block.material.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const material = entry as Record<string, unknown>;
      const { description: _description, ...credentialMaterial } = material;
      return {
        ...credentialMaterial,
        required: material.required ?? false,
        secret: material.secret ?? false,
      };
    });
  }
  return canonical;
}

/**
 * Project a credential boundary into OpenShell's export representation so a
 * checked-in profile and the export of that same profile compare equal. Applied
 * to both sides of the comparison; it is a no-op on an already-exported
 * boundary. See {@link canonicalizeRefresh} for what OpenShell normalizes.
 */
export function canonicalizeCredentialBoundary(
  boundary: Record<string, unknown>,
): Record<string, unknown> {
  const credentials = boundary.credentials as Record<string, unknown>[];
  return {
    ...boundary,
    credentials: credentials.map((credential) => ({
      ...credential,
      refresh: canonicalizeRefresh(credential.refresh),
    })),
  };
}

/**
 * Whether an exported profile is the checked-in profile this codebase ships
 * for `expectedId`.
 *
 * `indeterminate` means the comparison never completed: the export was not
 * JSON, or the checked-in YAML could not be read, parsed, or projected to a
 * credential boundary. An unfinished read is not evidence of drift, so callers
 * must route it to "could not verify" rather than to guidance that deletes the
 * registered profile.
 */
export type CheckedInBoundaryComparison = "match" | "mismatch" | "indeterminate";
export type RegisteredProfileComparison = CheckedInBoundaryComparison | "absent";

function hasValidRefreshMaterialFlags(
  boundary: Record<string, unknown>,
  requireExplicitFlags: boolean,
): boolean {
  const credentials = boundary.credentials as Record<string, unknown>[];
  return credentials.every((credential) => {
    const refresh = credential.refresh;
    if (refresh === null || refresh === undefined) return true;
    if (typeof refresh !== "object" || Array.isArray(refresh)) return false;
    const material = (refresh as Record<string, unknown>).material;
    if (material === undefined) return true;
    if (!Array.isArray(material)) return false;
    return material.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const item = entry as Record<string, unknown>;
      return ["required", "secret"].every((field) => {
        const value = item[field];
        return requireExplicitFlags
          ? typeof value === "boolean"
          : value === undefined || typeof value === "boolean";
      });
    });
  });
}

export function compareExportedProfileToCheckedIn(
  exportedJson: string,
  readCheckedInYaml: () => string,
  expectedId: string,
): CheckedInBoundaryComparison {
  let expected: Record<string, unknown> | null;
  try {
    expected = credentialBoundary(YAML.parse(readCheckedInYaml()) as Record<string, unknown>);
  } catch {
    return "indeterminate";
  }
  if (expected === null || expected.id !== expectedId) return "indeterminate";

  let actual: Record<string, unknown> | null;
  try {
    actual = credentialBoundary(JSON.parse(exportedJson) as Record<string, unknown>);
  } catch {
    return "indeterminate";
  }
  if (actual === null) return "indeterminate";
  if (
    !hasValidRefreshMaterialFlags(actual, true) ||
    !hasValidRefreshMaterialFlags(expected, false)
  ) {
    return "indeterminate";
  }

  return isDeepStrictEqual(
    canonicalizeCredentialBoundary(actual),
    canonicalizeCredentialBoundary(expected),
  )
    ? "match"
    : "mismatch";
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

/** OpenShell provider type registered for every OpenAI-surface inference route. */
export const OPENAI_GATEWAY_PROVIDER_TYPE = "openai";

export type OpenAiProviderProfileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly messages: readonly string[] };

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

  const exported = exportProfile();
  if (exported.status === 0) {
    return profileHasExpectedCredentialBoundary(commandStdout(exported), {
      id: input.profileId,
      inferenceCapable: input.inferenceCapable,
    })
      ? { ok: true }
      : { ok: false, reason: "incompatible" };
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
  if (imported.status === 0) return { ok: true };

  const importOutput = commandOutput(imported);
  if (!/already exists/iu.test(normalizeOpenshellDiagnostic(importOutput))) {
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

  if (result.reason === "import-failed") {
    return {
      ok: false,
      messages: [
        `\n  ✗ OpenShell could not import the checked-in '${OPENAI_GATEWAY_PROVIDER_TYPE}' inference provider profile.`,
        "    Confirm OpenShell is available and authorized, then retry this command.",
      ],
    };
  }
  if (result.reason === "export-failed") {
    return {
      ok: false,
      messages: [
        `\n  ✗ OpenShell provider profile '${OPENAI_GATEWAY_PROVIDER_TYPE}' could not be read for validation.`,
        "    Confirm OpenShell is available, authorized, and the profile is readable, then retry this command.",
      ],
    };
  }
  return {
    ok: false,
    messages: [
      `\n  ✗ OpenShell provider profile '${OPENAI_GATEWAY_PROVIDER_TYPE}' already exists but does not match NemoClaw's endpointless inference contract.`,
      "    Remove the conflicting profile, then retry this command.",
    ],
  };
}
