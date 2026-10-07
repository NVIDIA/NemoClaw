// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { withRegistryLockAt } from "./lock";
import { load, save, REGISTRY_FILE } from "./persistence";
import type { SandboxEntry } from "./types";

type SelectionUpdates = Partial<
  Pick<
    SandboxEntry,
    | "modelSelectionProvenance"
    | "nativeModelSelectionProvenance"
    | "modelAssignmentSelections"
    | "configurationApplyPending"
    | "appliedPolicySelection"
  >
>;

/** Read only an already-published registration eligible for native selection evidence. */
export function readSandboxTelemetryEntry(name: string): SandboxEntry | null {
  const entry = load().sandboxes[name];
  return entry && !entry.pendingCreateIdentity && entry.pendingRouteReservation === undefined
    ? entry
    : null;
}

/** Change optional telemetry metadata only while the exact proved registration still owns it. */
export function updateSandboxTelemetrySelections(
  expected: SandboxEntry,
  updates: SelectionUpdates,
): boolean {
  if (expected.pendingCreateIdentity || expected.pendingRouteReservation !== undefined)
    return false;
  return withRegistryLockAt(
    REGISTRY_FILE,
    () => {
      const data = load();
      const current = data.sandboxes[expected.name];
      if (!current || !isDeepStrictEqual(current, expected)) return false;
      if (
        Object.keys(updates).some(
          (key) =>
            ![
              "modelSelectionProvenance",
              "nativeModelSelectionProvenance",
              "modelAssignmentSelections",
              "configurationApplyPending",
              "appliedPolicySelection",
            ].includes(key),
        )
      )
        return false;
      data.sandboxes[expected.name] = { ...current, ...updates };
      save(data);
      return true;
    },
    { maxRetries: 1, wait: () => {} },
  );
}
