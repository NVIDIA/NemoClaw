// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { fingerprintBuildContext } from "../../adapters/fs/build-context-fingerprint";
import type { PreparedSandboxBuildContext } from "../../onboard/build-context-stage";

export type FingerprintedPreparedBuildContext = PreparedSandboxBuildContext & {
  contextFingerprint: string;
  verifyBuildCtx(): boolean;
};

/** Keep temporary rebuild inputs alive until the transaction releases them. */
export function createIdempotentBuildContextCleanup(cleanup: () => boolean): () => boolean {
  let cleaned = false;
  const dispose = () => {
    if (cleaned) return true;
    const succeeded = cleanup();
    if (succeeded) {
      cleaned = true;
      process.removeListener("exit", dispose);
    }
    return succeeded;
  };
  process.on("exit", dispose);
  return dispose;
}

/** Confirm that a retained private context still matches the prebuilt bytes. */
export function verifyPreparedBuildContext(prepared: FingerprintedPreparedBuildContext): boolean {
  try {
    if (!prepared.verifyBuildCtx.call(prepared)) return false;
    if (fingerprintBuildContext(prepared.buildCtx) !== prepared.contextFingerprint) return false;
    return prepared.preparedOpenClawLegacyImage?.verify() ?? true;
  } catch {
    return false;
  }
}

/** Commit a verified retained image to recreation at the synchronous delete edge. */
export function retainPreparedImageForRecreate(
  prepared: FingerprintedPreparedBuildContext,
): boolean {
  try {
    return prepared.preparedOpenClawLegacyImage?.retainForRecreate() ?? true;
  } catch {
    return false;
  }
}

/** Release an unused retained image through its bound immutable cleanup path. */
export function abortPreparedImageRecreate(prepared: FingerprintedPreparedBuildContext): boolean {
  try {
    return prepared.preparedOpenClawLegacyImage?.abort() ?? true;
  } catch {
    return false;
  }
}

/** Bind an expected fingerprint to a context for final one-shot verification. */
export function createBuildContextVerifier(
  buildCtx: string,
  contextFingerprint: string,
): () => boolean {
  return () => {
    try {
      return fingerprintBuildContext(buildCtx) === contextFingerprint;
    } catch {
      return false;
    }
  };
}

/** Dispose retained build inputs after onboarding consumes them or rebuild aborts. */
export function disposePreparedBuildContext(prepared: FingerprintedPreparedBuildContext): boolean {
  const imageDisposed = abortPreparedImageRecreate(prepared);
  let contextDisposed = false;
  try {
    contextDisposed = prepared.cleanupBuildCtx();
  } catch {
    contextDisposed = false;
  }
  return imageDisposed && contextDisposed;
}
