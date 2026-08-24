// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const CUA_FEATURE_ENV = "NEMOCLAW_CUA_ENABLED" as const;
export const CUA_SANDBOX_IMAGE_ENV = "NEMOCLAW_CUA_SANDBOX_IMAGE_REF" as const;

const SANDBOX_IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,511}$/;

export function isCuaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CUA_FEATURE_ENV] === "1";
}

export function requireCuaEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!isCuaEnabled(env)) {
    throw new Error(`NemoCUA is disabled; set ${CUA_FEATURE_ENV}=1 to use the experimental agent`);
  }
}

export function requireCuaSandboxImageRef(env: NodeJS.ProcessEnv = process.env): string {
  requireCuaEnabled(env);
  const rawImageRef = env[CUA_SANDBOX_IMAGE_ENV] ?? "";
  const imageRef = rawImageRef.trim();
  if (rawImageRef !== imageRef || !SANDBOX_IMAGE_REF.test(imageRef)) {
    throw new Error(
      `${CUA_SANDBOX_IMAGE_ENV} must name the prepared NemoCUA sandbox image without whitespace`,
    );
  }
  return imageRef;
}
