// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// sourceOfTruth: nemoclaw/src/shared/credential-filter-boundary.cts
// Keep this package entry wrapper implementation-free so migration and the CLI
// execute the same credential-stripping rules.
export {
  CONTEXT_PATTERNS as CONTEXT_SECRET_PATTERNS,
  CREDENTIAL_PLACEHOLDER,
  CREDENTIAL_SENSITIVE_BASENAMES,
  isConfigObject,
  isConfigValue,
  isCredentialField,
  isSafeCredentialPlaceholder,
  isSensitiveFile,
  sanitizeEnvFileContent,
  stripCredentials,
  valueLooksLikeSecret,
} from "../shared/credential-filter-boundary.cjs";

export type { ConfigObject, ConfigValue } from "../shared/credential-filter-boundary.cjs";
