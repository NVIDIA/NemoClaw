// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { preflightVllmModelEnv } from "../inference/vllm-models";

/**
 * Validate `NEMOCLAW_VLLM_MODEL` up front, before onboarding runs preflight or
 * touches Docker, mirroring the `connect` preflight added in #4567.
 *
 * The variable steers the express-vLLM installer, but it is only consumed deep
 * in the `[3/8]` provider step. That made it validated late and path-dependent:
 * any onboard path that does not run the installer silently ignored an invalid
 * slug, so an unrecognised value did not reliably surface as a non-zero exit
 * (#5207). Running the installer's own `selectVllmModelFromEnv` +
 * `assertGatedModelAccess` checks here gives one fail-fast surface with a
 * non-zero exit and the canonical, slug-listing error message.
 *
 * No-ops when the variable is unset or resolves cleanly.
 */
export function preflightVllmModelEnvOrExit(env: NodeJS.ProcessEnv = process.env): void {
  const result = preflightVllmModelEnv(env);
  if (result.ok) return;
  console.error(`  ${result.message}`);
  process.exit(1);
}
