// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// sourceOfTruth: nemoclaw/src/shared/credential-filter-boundary.cts
// Keep this package entry wrapper implementation-free so migration and the CLI
// execute the same credential-stripping rules.
import * as credentialFilterBoundaryNamespace from "../shared/credential-filter-boundary.cjs";

type CredentialFilterBoundary = typeof import("../shared/credential-filter-boundary.cjs");

// Native Node exposes the CommonJS object as `default`, while Vitest exposes
// the transpiled source's named exports directly.
const credentialFilterBoundary =
  (credentialFilterBoundaryNamespace as { default?: CredentialFilterBoundary }).default ??
  credentialFilterBoundaryNamespace;

export const {
  CONTEXT_PATTERNS: CONTEXT_SECRET_PATTERNS,
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
} = credentialFilterBoundary;

export type { ConfigObject, ConfigValue } from "../shared/credential-filter-boundary.cjs";
