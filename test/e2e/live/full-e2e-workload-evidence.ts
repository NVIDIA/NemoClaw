// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertStockManagedImageReceipt } from "../fixtures/managed-image-receipt.ts";

export function readFullE2eColdWorkloadEvidence(
  sandboxName: string,
  usedBuildKitPrebuild: boolean,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.E2E_WORKLOAD_SOURCE === "local-dockerfile") {
    return { kind: "legacy-dockerfile" } as const;
  }
  if (usedBuildKitPrebuild) {
    throw new Error("managed-image cold onboarding must not use a local BuildKit prebuild");
  }
  const receipt = assertStockManagedImageReceipt({
    environment,
    expectedAgent: "openclaw",
    sandboxName,
  });
  if (!receipt) throw new Error("managed-image cold onboarding receipt is missing");
  return {
    kind: "managed-image",
    reference: receipt.reference,
    sourceCohort: receipt.sourceCohort,
    sourceRevision: receipt.sourceRevision,
  } as const;
}
