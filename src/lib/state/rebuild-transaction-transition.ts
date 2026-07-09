// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type {
  RebuildTransactionPhaseV1,
  RebuildTransactionReceiptsV1,
} from "./rebuild-transaction";

const NEXT_PHASE: Partial<Record<RebuildTransactionPhaseV1, RebuildTransactionPhaseV1>> = {
  prepared: "old_deleted",
  old_deleted: "replacement_created",
  replacement_created: "completed",
};

export function nextRebuildTransactionPhase(
  phase: RebuildTransactionPhaseV1,
): RebuildTransactionPhaseV1 | null {
  return NEXT_PHASE[phase] ?? null;
}

export function findReplacedRebuildReceipt(
  current: RebuildTransactionReceiptsV1,
  next: RebuildTransactionReceiptsV1,
): keyof RebuildTransactionReceiptsV1 | null {
  return (
    (["backup", "oldSandboxDeletion", "replacement"] as const).find(
      (key) => current[key] !== undefined && !isDeepStrictEqual(current[key], next[key]),
    ) ?? null
  );
}
