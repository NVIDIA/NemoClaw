// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function isNonInteractiveEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEMOCLAW_NON_INTERACTIVE === "1";
}

export function isNonInteractiveSession(
  env: NodeJS.ProcessEnv = process.env,
  stdinIsTty: boolean = Boolean(process.stdin.isTTY),
): boolean {
  return isNonInteractiveEnv(env) || !stdinIsTty;
}
