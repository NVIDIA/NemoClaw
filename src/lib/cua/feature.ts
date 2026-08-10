// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const CUA_FRAMEWORK_FEATURE_ENV = "NEMOCLAW_CUA_ENABLED" as const;
export const CUA_QUALIFICATION_FEATURE_ENV = "NEMOCLAW_CUA_QUALIFICATION" as const;
export const CUA_RUNTIME_MANIFEST_ENV = "NEMOCLAW_CUA_RUNTIME_MANIFEST" as const;
export const CUA_RUNTIME_MANIFEST_SHA256_ENV = "NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256" as const;
export const CUA_QUALIFICATION_ENVIRONMENT_ENV = "NEMOCLAW_CUA_QUALIFICATION_ENVIRONMENT" as const;
export const CUA_SANDBOX_IMAGE_ENV = "NEMOCLAW_CUA_SANDBOX_IMAGE_REF" as const;

/** Keep executable CUA lifecycle surfaces fail-closed until explicitly enabled. */
export function isCuaFrameworkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CUA_FRAMEWORK_FEATURE_ENV] === "1";
}

/** Refuse every CUA artifact or product-surface read before the default-off gate. */
export function requireCuaFrameworkEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!isCuaFrameworkEnabled(env)) {
    throw new Error("CUA is disabled; use the controlled Brev Launchable activation");
  }
}

/** Candidate lifecycle authority is narrower than enabling the CUA surface. */
export function isCuaQualificationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isCuaFrameworkEnabled(env) && env[CUA_QUALIFICATION_FEATURE_ENV] === "1";
}
