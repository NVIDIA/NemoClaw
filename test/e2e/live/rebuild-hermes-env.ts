// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";

/**
 * Build the explicit child environment used by the Hermes rebuild scenario.
 * The fixture-wide allowlist intentionally remains narrow; the selected
 * OpenShell channel and its explicit dev-artifact opt-in are non-secret
 * integration inputs needed by install.sh.
 */
export function buildRebuildHermesChildEnv(
  base: NodeJS.ProcessEnv,
  overlay: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const openshellChannel = base.NEMOCLAW_OPENSHELL_CHANNEL;
  const acceptDevUnverifiedInstall = base.NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL;
  return {
    ...buildAvailabilityProbeEnv(base),
    ...(acceptDevUnverifiedInstall === undefined
      ? {}
      : { NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: acceptDevUnverifiedInstall }),
    ...(openshellChannel === undefined ? {} : { NEMOCLAW_OPENSHELL_CHANNEL: openshellChannel }),
    ...overlay,
  };
}
