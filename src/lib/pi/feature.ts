// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const PI_QUALIFICATION_FEATURE_ENV = "NEMOCLAW_PI_QUALIFICATION" as const;

export function isPiQualificationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PI_QUALIFICATION_FEATURE_ENV] === "1";
}

export function requirePiQualificationEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!isPiQualificationEnabled(env)) {
    throw new Error("Pi is a qualification candidate; it is not a selectable agent yet");
  }
}
