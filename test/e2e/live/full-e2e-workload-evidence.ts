// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readManagedWorkloadAuthority } from "../../../src/lib/onboard/workload/authority.ts";
import { load as loadSandboxRegistry } from "../../../src/lib/state/registry/persistence.ts";

export function readFullE2eColdWorkloadEvidence(
  sandboxName: string,
  usedBuildKitPrebuild: boolean,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const entry = loadSandboxRegistry().sandboxes[sandboxName];
  if (!entry) {
    throw new Error(`full E2E sandbox '${sandboxName}' is missing from the registry`);
  }

  const managedAuthority = readManagedWorkloadAuthority(entry);
  if (!managedAuthority) {
    throw new Error("full E2E cold onboarding must register a managed-image workload receipt");
  }
  if (usedBuildKitPrebuild) {
    throw new Error("managed-image cold onboarding must not use a local BuildKit prebuild");
  }
  const expectedRevision = environment.E2E_MANAGED_IMAGE_REVISION?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/u.test(expectedRevision)) {
    throw new Error("full E2E cold onboarding requires one exact managed-image cohort revision");
  }
  if (managedAuthority.receipt.sourceRevision !== expectedRevision) {
    throw new Error("full E2E cold onboarding did not use the selected managed-image cohort");
  }
  return {
    kind: managedAuthority.receipt.kind,
    reference: managedAuthority.receipt.reference,
    sourceCohort: managedAuthority.receipt.sourceCohort,
    sourceRevision: managedAuthority.receipt.sourceRevision,
  } as const;
}
