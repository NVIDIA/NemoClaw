// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { basename } from "node:path";

import {
  SECRET_BLOCK_PATTERNS,
  STRUCTURED_TOKEN_PATTERNS,
  TOKEN_PREFIX_PATTERNS,
  isCredentialField,
  isSafeCredentialPlaceholder,
} from "../../../nemoclaw/dist/shared/credential-filter-boundary.cjs";

// Public jwt.io documentation vector, also shipped in Zod's parser tests.
// Keep the segments separate so repository secret scanners do not mistake the
// reviewed fixture itself for a credential.
const PUBLIC_JWT_DOCUMENTATION_VECTOR = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ",
  "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
].join(".");
const PRIVATE_KEY_BEGIN = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const PRIVATE_KEY_END = ["-----END", "PRIVATE KEY-----"].join(" ");
const MSAL_PRIVATE_KEY_DOCUMENTATION_SHAPE = `${PRIVATE_KEY_BEGIN} ... ${PRIVATE_KEY_END}`;
const DSA_PRIVATE_KEY_BEGIN = ["-----BEGIN", "DSA PRIVATE KEY-----"].join(" ");
const DSA_PRIVATE_KEY_END = ["-----END", "DSA PRIVATE KEY-----"].join(" ");
const BOTOCORE_DSA_PRIVATE_KEY_DOCUMENTATION_SHAPE = `${DSA_PRIVATE_KEY_BEGIN}<a very long private key string>${DSA_PRIVATE_KEY_END}`;
// whatsapp-rust-bridge publishes this byte sequence inside its generated WASM
// bundle. It only happens to have the shape of an AWS access-key identifier.
const WHATSAPP_RUST_BRIDGE_WASM_AWS_SHAPED_BYTES = ["AKIA", "1JDQYCQC", "ANIA9GDQ"].join("");
// @pinojs/redact ships one wildcard test containing these synthetic values.
// Require its complete published signature so any altered or partial fixture
// continues through the ordinary credential checks.
const PINO_REDACT_WILDCARD_TEST_MARKER =
  "Tests for Issue #2319: @pinojs/redact fails to redact patterns with 3+ consecutive wildcards";
const PINO_REDACT_PUBLIC_CREDENTIAL_FIXTURES = [
  "password: 'secret-2-levels'",
  "password: 'secret-3-levels'",
  "password: 'secret-4-levels'",
  "password: 'secret-5-levels'",
  "password: 'secret-6-levels'",
  "password: 'secret-value'",
  "token: 'token1'",
  "token: 'token2'",
  "token: 'token3'",
  "password: 'secret'",
  "username: 'admin'",
  "password: 'secret1'",
  "password: 'secret2'",
  "authorization: 'Bearer secret-token'",
  "authorization: 'Bearer another-token'",
] as const;

export {
  CREDENTIAL_PLACEHOLDER,
  CREDENTIAL_SENSITIVE_BASENAMES,
  isConfigObject,
  isConfigValue,
  isCredentialField,
  isSafeCredentialPlaceholder,
  isSensitiveFile,
  redactCredentialText,
  sanitizeEnvFileContent,
  stripCredentials,
  valueLooksLikeSecret,
} from "../../../nemoclaw/dist/shared/credential-filter-boundary.cjs";
export type {
  ConfigObject,
  ConfigValue,
} from "../../../nemoclaw/dist/shared/credential-filter-boundary.cjs";

/** Detect standalone credential fingerprints without interpreting surrounding file structure. */
export function textContainsHighConfidenceCredential(
  value: string,
  options: { privateKeyHeader?: boolean } = {},
): boolean {
  const withoutPlaceholders = textWithoutSafeCredentialFixtures(value);
  for (const pattern of [
    ...TOKEN_PREFIX_PATTERNS,
    ...STRUCTURED_TOKEN_PATTERNS,
    ...SECRET_BLOCK_PATTERNS,
  ]) {
    pattern.lastIndex = 0;
    if (pattern.test(withoutPlaceholders)) return true;
  }
  return (
    options.privateKeyHeader !== false &&
    /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/u.test(withoutPlaceholders)
  );
}

function textWithoutSafeCredentialFixtures(value: string): string {
  const normalizedPinoRedactFixture =
    value.includes(PINO_REDACT_WILDCARD_TEST_MARKER) &&
    PINO_REDACT_PUBLIC_CREDENTIAL_FIXTURES.every((fixture) => value.includes(fixture))
      ? PINO_REDACT_PUBLIC_CREDENTIAL_FIXTURES.reduce(
          (normalized, fixture) => normalized.replaceAll(fixture, "value: 'unused'"),
          value,
        )
      : value;
  return (
    normalizedPinoRedactFixture
      .replace(/(?:Bearer\s+)?openshell:resolve:env:[A-Za-z0-9_]+/giu, "unused")
      .replace(/(?:xox[bx]|xapp)-OPENSHELL-RESOLVE-ENV-[A-Za-z0-9_-]+/gu, (candidate) =>
        isSafeCredentialPlaceholder(candidate) ? "unused" : candidate,
      )
      // Generated bundles contain the accepted-placeholder matcher itself.
      // Normalize that exact source fragment without stripping the reserved
      // prefix from malformed placeholder-shaped credential values.
      .replace(/(?:xox[bx]|xapp)-OPENSHELL-RESOLVE-ENV-\[A-Za-z0-9_\]\+/gu, "unused")
      .replace(/(?<![A-Za-z0-9_-])sk-OPENSHELL-PROXY-REWRITE(?![A-Za-z0-9_-])/gu, "unused")
      // The shared provider signature intentionally has no leading boundary.
      // Exclude embedded English fragments such as `task-concurrency-diagnosis`
      // while continuing to reject standalone sk-* credential values.
      .replace(/(?<=[A-Za-z0-9])sk-(?=[A-Za-z0-9_-]{20,})/gu, "sk_")
      // Upstream skill documentation uses visibly synthetic repeated-x tokens.
      // Preserve those examples without accepting placeholder-shaped values
      // that contain any other token material.
      .replace(/(?<![A-Za-z0-9_-])(?:gh[pousr]_|sk-)[xX]{10,}(?![A-Za-z0-9_-])/gu, "unused")
      // AWS and botocore publish synthetic access-key examples whose final
      // marker is literally EXAMPLE. Preserve only that visibly public shape.
      .replace(/(?<![A-Z0-9])A(?:K|S)IA[A-Z0-9]{9}EXAMPLE(?![A-Z0-9])/gu, "unused")
      .replaceAll(WHATSAPP_RUST_BRIDGE_WASM_AWS_SHAPED_BYTES, "unused")
      .replaceAll(PUBLIC_JWT_DOCUMENTATION_VECTOR, "unused")
      // MSAL's shipped TypeScript source documents the PEM shape with a
      // literal ellipsis between its delimiters; it is not key material.
      .replaceAll(MSAL_PRIVATE_KEY_DOCUMENTATION_SHAPE, "unused")
      // Botocore's public IAM examples use this literal prose placeholder
      // between DSA delimiters. Preserve only that exact published shape.
      .replaceAll(BOTOCORE_DSA_PRIVATE_KEY_DOCUMENTATION_SHAPE, "unused")
      // OpenClaw's public Microsoft Teams QA bundle uses this fixed marker for
      // its private test transport. Exempt only the exact bearer value.
      .replace(/\bBearer[ \t]+private-qa(?![A-Za-z0-9_-])/giu, "unused")
      .replaceAll("[STRIPPED_BY_MIGRATION]", "unused")
  );
}

/** Detect standalone and context-anchored credentials in opaque file content. */
export function textContainsCredential(
  value: string,
  options: { opaqueAssignments?: boolean; privateKeyHeader?: boolean } = {},
): boolean {
  const withoutPlaceholders = textWithoutSafeCredentialFixtures(value);
  if (textContainsHighConfidenceCredential(withoutPlaceholders, options)) return true;
  const authorization =
    /\b(?:Proxy-)?Authorization["']?[ \t]*[:=][ \t]*["']?Bearer[ \t]+([A-Za-z0-9_.+/=-]{10,})/gimu;
  if (authorization.test(withoutPlaceholders)) return true;
  if (options.opaqueAssignments === false) return false;
  const assignment =
    /(?<![A-Za-z0-9_.-])["']?([_A-Za-z][_A-Za-z0-9.-]{0,127})["']?[ \t]*[:=][ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;{}]+))/gu;
  for (;;) {
    const match = assignment.exec(withoutPlaceholders);
    if (!match) break;
    const field = match[1]!.replace(/^_+/u, "");
    const candidate = match[2] ?? match[3] ?? match[4] ?? "";
    if (
      !/^(?:module\.)?exports\./u.test(field) &&
      isCredentialField(field) &&
      !isSafeCredentialPlaceholder(candidate)
    ) {
      return true;
    }
    // A non-credential outer JSON key can contain a nested credential key.
    // Advance one character so the bounded scan considers that inner object.
    assignment.lastIndex = match.index + 1;
  }
  return false;
}

/** Detect npm registry credential directives even when their values are opaque. */
export function npmConfigContainsCredentialDirective(value: string): boolean {
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const directive = key.slice(key.lastIndexOf(":") + 1);
    if (/^_?(?:auth(?:token)?|password|username)$/iu.test(directive)) return true;
  }
  return false;
}

/** Dependency lockfiles do not store NemoClaw runtime credentials. */
const SNAPSHOT_CREDENTIAL_SCAN_EXCLUDED_BASENAMES = new Set([
  ".package-lock.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-lock.yml",
]);

/** Whether a filename is a dependency lockfile. */
export function isDependencyLockfile(filename: string): boolean {
  return SNAPSHOT_CREDENTIAL_SCAN_EXCLUDED_BASENAMES.has(basename(filename).toLowerCase());
}
