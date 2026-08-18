// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readManagedWorkloadAuthority } from "../../../src/lib/onboard/workload/authority.ts";
import { load as loadSandboxRegistry } from "../../../src/lib/state/registry/persistence.ts";

export function readFullE2eColdWorkloadEvidence(
  sandboxName: string,
  usedBuildKitPrebuild: boolean,
) {
  const entry = loadSandboxRegistry().sandboxes[sandboxName];
  if (!entry) {
    throw new Error(`full E2E sandbox '${sandboxName}' is missing from the registry`);
  }

  const managedAuthority = readManagedWorkloadAuthority(entry);
  if (managedAuthority) {
    if (usedBuildKitPrebuild) {
      throw new Error("managed-image cold onboarding must not use a local BuildKit prebuild");
    }
    return {
      kind: managedAuthority.receipt.kind,
      reference: managedAuthority.receipt.reference,
      sourceCohort: managedAuthority.receipt.sourceCohort,
      sourceRevision: managedAuthority.receipt.sourceRevision,
    } as const;
  }

  if (entry.workload?.kind !== "legacy-dockerfile") {
    throw new Error("full E2E cold onboarding must register a supported workload receipt");
  }
  if (!usedBuildKitPrebuild) {
    throw new Error("legacy Dockerfile cold onboarding must use the local BuildKit prebuild");
  }
  return {
    kind: entry.workload.kind,
    reference: entry.workload.reference,
  } as const;
}
