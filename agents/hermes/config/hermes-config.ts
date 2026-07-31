// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HermesBuildSettings } from "./build-env.ts";
import { buildHermesManagedPolicy, finalizeHermesPlatformToolsets } from "./managed-policy.ts";

export { finalizeHermesPlatformToolsets };

/** Return the primary-home configuration from the managed Hermes policy model. */
export function buildHermesConfig(
  settings: HermesBuildSettings,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  return buildHermesManagedPolicy(settings, env).config;
}
