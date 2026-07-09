// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  SUPPORTED_CREDENTIAL_ENV_NAMES,
  shouldStripCredentialEnv,
} from "../../../src/lib/security/credential-env.ts";
import {
  isCredentialField,
  isSafeCredentialPlaceholder,
  shouldScanSnapshotFileForCredentials,
  valueLooksLikeSecret,
} from "../../../src/lib/security/credential-filter.ts";

const CREDENTIAL_TOKEN_VALUE_PATTERN = /(?:nvapi-|sk-|Bearer )/;
const ENV_ASSIGNMENT_PATTERN = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/gm;
const STRUCTURED_CREDENTIAL_KEY_PATTERN =
  /["']?(?:apiKey|api_key|accessToken|access_token|secretKey|secret_key|bearerToken|bearer_token)["']?\s*[:=]\s*["'][^"']+["']/i;

// OpenClaw 2026.6.10 persists an environment variable name, rather than its
// resolved value, in generated agents/*/agent/models.json provider entries.
// Keep bare/braced names bounded to provider credentials used by NemoClaw or
// OpenClaw's ambient AWS auth. An explicitly prefixed secretref-env marker can
// name a custom environment variable because the prefix carries provenance.
// Re-audit this allowlist whenever OpenClaw changes its models.json credential
// encoding; remove it once snapshots use only typed secret-reference markers.
export const MODELS_JSON_CREDENTIAL_ENV_REFERENCES: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE",
  "AWS_SECRET_ACCESS_KEY",
  "COMPATIBLE_ANTHROPIC_API_KEY",
  "COMPATIBLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN",
  "NEMOCLAW_OLLAMA_PROXY_TOKEN",
  "NEMOCLAW_VLLM_LOCAL_TOKEN",
  "NGC_API_KEY",
  "NVIDIA_API_KEY",
  "NVIDIA_INFERENCE_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
]);
const BRACED_ENV_REFERENCE_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;
const SECRETREF_ENV_MARKER_PATTERN = /^secretref-env:[A-Z_][A-Z0-9_]*$/;
const SECRETREF_MANAGED_MARKER = "secretref-managed";
const MODELS_JSON_CREDENTIAL_FIELDS = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "bearertoken",
  "authtoken",
  "privatekey",
  "secretkey",
  "signingkey",
  "sessiontoken",
  "bottoken",
  "apptoken",
  "password",
  "token",
  "secret",
]);

function isModelsJsonCredentialField(fieldName: string): boolean {
  return (
    isCredentialField(fieldName) ||
    MODELS_JSON_CREDENTIAL_FIELDS.has(fieldName.replace(/[_-]/g, "").toLowerCase())
  );
}

function isModelsJsonCredentialMarker(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const bracedEnvName = BRACED_ENV_REFERENCE_PATTERN.exec(trimmed)?.[1];
  return (
    isSafeCredentialPlaceholder(trimmed) ||
    MODELS_JSON_CREDENTIAL_ENV_REFERENCES.has(trimmed) ||
    (bracedEnvName !== undefined && MODELS_JSON_CREDENTIAL_ENV_REFERENCES.has(bracedEnvName)) ||
    SECRETREF_ENV_MARKER_PATTERN.test(trimmed) ||
    trimmed === SECRETREF_MANAGED_MARKER
  );
}

function containsCredentialEnvAssignment(value: string): boolean {
  for (const match of value.matchAll(ENV_ASSIGNMENT_PATTERN)) {
    const name = match[1];
    if (name && (SUPPORTED_CREDENTIAL_ENV_NAMES.has(name) || shouldStripCredentialEnv(name))) {
      return true;
    }
  }
  return false;
}

function modelsJsonValueContainsCredentialLeak(value: unknown, fieldName?: string): boolean {
  if (fieldName && isModelsJsonCredentialField(fieldName)) {
    if (value === null) return false;
    return !isModelsJsonCredentialMarker(value);
  }

  if (typeof value === "string") {
    return containsCredentialEnvAssignment(value) || valueLooksLikeSecret(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => modelsJsonValueContainsCredentialLeak(entry));
  }
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, entry]) =>
    modelsJsonValueContainsCredentialLeak(entry, key),
  );
}

/**
 * Inspect generated OpenClaw models.json as JSON so credential markers can be
 * distinguished from concrete values. Malformed JSON fails closed because the
 * scanner cannot prove that credential-named fields contain only references.
 */
export function modelsJsonContainsCredentialLeak(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return true;
  }
  return modelsJsonValueContainsCredentialLeak(parsed);
}

/** Pure file-content half of the snapshot credential scan. */
export function snapshotFileContainsCredentialLeak(filename: string, body: string): boolean {
  if (!shouldScanSnapshotFileForCredentials(filename)) return false;

  const basename = path.basename(filename).toLowerCase();
  if (basename === "models.json") return modelsJsonContainsCredentialLeak(body);

  const tokenValueLeak = CREDENTIAL_TOKEN_VALUE_PATTERN.test(body);
  const envAssignmentLeak = containsCredentialEnvAssignment(body);
  // openclaw.json may legitimately contain non-secret provider metadata such
  // as credential env-var references. Still fail it on token-shaped values or
  // concrete env assignments, but reserve generic structured-key checks for
  // other env/json files where such keys indicate persisted credentials rather
  // than configuration schema.
  const structuredKeyLeak =
    basename !== "openclaw.json" && STRUCTURED_CREDENTIAL_KEY_PATTERN.test(body);
  return tokenValueLeak || envAssignmentLeak || structuredKeyLeak;
}

/** Walk a snapshot backup and return files that contain credential material. */
export function scanSnapshotCredentialLeaks(root: string): string[] {
  if (!fs.existsSync(root)) throw new Error(`Backup directory missing: ${root}`);
  const leaks: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !shouldScanSnapshotFileForCredentials(entry.name)) continue;
      const body = fs.readFileSync(fullPath, "utf8");
      if (snapshotFileContainsCredentialLeak(entry.name, body)) leaks.push(fullPath);
    }
  };
  visit(root);
  return leaks;
}
