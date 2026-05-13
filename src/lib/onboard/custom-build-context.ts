// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export const CUSTOM_BUILD_CONTEXT_WARN_BYTES = 100_000_000;

const CUSTOM_BUILD_CONTEXT_IGNORES = new Set([
  "node_modules",
  ".git",
  ".venv",
  "__pycache__",
  ".aws",
  ".credentials",
  ".direnv",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".ssh",
  "credentials.json",
  "key.json",
  "secrets",
  "secrets.json",
  "secrets.yaml",
  "token.json",
]);

function isIgnoredCustomBuildContextName(name: string): boolean {
  const lowerName = name.toLowerCase();
  return (
    CUSTOM_BUILD_CONTEXT_IGNORES.has(lowerName) ||
    lowerName === ".env" ||
    lowerName === ".envrc" ||
    lowerName.startsWith(".env.") ||
    lowerName.endsWith(".key") ||
    lowerName.endsWith(".pem") ||
    lowerName.endsWith(".pfx") ||
    lowerName.endsWith(".p12") ||
    lowerName.endsWith(".jks") ||
    lowerName.endsWith(".keystore") ||
    lowerName.endsWith(".tfvars") ||
    lowerName.endsWith("_ecdsa") ||
    lowerName.endsWith("_ed25519") ||
    lowerName.endsWith("_rsa") ||
    (lowerName.startsWith("service-account") && lowerName.endsWith(".json"))
  );
}

export function shouldIncludeCustomBuildContextPath(src: string): boolean {
  return !isIgnoredCustomBuildContextName(path.basename(src));
}

export function isInsideIgnoredCustomBuildContextPath(src: string): boolean {
  return path
    .normalize(src)
    .split(path.sep)
    .filter(Boolean)
    .some((part: string) => isIgnoredCustomBuildContextName(part));
}
