// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxBaseImageResolutionMetadata } from "../../../src/lib/sandbox-base-image/types";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";

const HERMES_BASE_IMAGE_OVERRIDE_ENV = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";
const OFFICIAL_HERMES_BASE_DIGEST =
  /^ghcr\.io\/nvidia\/nemoclaw\/hermes-sandbox-base@sha256:[0-9a-f]{64}$/;
const LOCAL_HERMES_BASE = /^nemoclaw-hermes-sandbox-base-local:[^\s]+$/;

export interface RebuildHermesBaseReusePlan {
  sourceRef: string;
  preparedRef: string;
  childEnv: NodeJS.ProcessEnv;
}

/** Select the normal lane's exact phase 1 image under a test-owned local alias. */
export function planRebuildHermesBaseReuse(
  staleBaseMode: boolean,
  metadata: SandboxBaseImageResolutionMetadata | null,
  preparedRef: string,
): RebuildHermesBaseReusePlan | null {
  if (staleBaseMode) return null;
  if (!metadata) {
    throw new Error("normal rebuild-Hermes setup did not record base-image resolution metadata");
  }

  const sourceRef = metadata.ref.trim();
  const trustedSource =
    metadata.source === "pinned"
      ? Boolean(
          sourceRef &&
            OFFICIAL_HERMES_BASE_DIGEST.test(sourceRef) &&
            metadata.pinnedRemoteRef &&
            OFFICIAL_HERMES_BASE_DIGEST.test(metadata.pinnedRemoteRef),
        )
      : metadata.source === "local"
        ? Boolean(sourceRef && LOCAL_HERMES_BASE.test(sourceRef))
        : false;
  if (!trustedSource) {
    throw new Error(
      `normal rebuild-Hermes setup recorded unsupported base-image source '${metadata.source}'`,
    );
  }

  const normalizedPreparedRef = preparedRef.trim();
  if (!LOCAL_HERMES_BASE.test(normalizedPreparedRef)) {
    throw new Error("normal rebuild-Hermes setup requires a test-owned local base-image ref");
  }

  return {
    sourceRef,
    preparedRef: normalizedPreparedRef,
    childEnv: { [HERMES_BASE_IMAGE_OVERRIDE_ENV]: normalizedPreparedRef },
  };
}

/**
 * Build the explicit child environment used by the Hermes rebuild scenario.
 * The fixture-wide allowlist intentionally remains narrow; the selected
 * OpenShell channel and its explicit dev-artifact opt-in are the only extra
 * non-secret compatibility inputs forwarded from the parent test process.
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
