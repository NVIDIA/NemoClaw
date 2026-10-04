// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ReadinessEvidence } from "./types";

export interface ObservationAge {
  ageMs: number | null;
  windowMs: number;
}

/** Report the age of an observation only when it falls outside the safe reuse window. */
export function measureObservationAge(
  observedAt: string,
  now: Date,
  windowMs: number,
): ObservationAge | null {
  const ageMs = now.getTime() - Date.parse(observedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return { ageMs: null, windowMs };
  return ageMs > windowMs ? { ageMs, windowMs } : null;
}

export function staleEvidence(
  id: string,
  subject: "Gateway" | "Host",
  completedAt: string,
  { ageMs, windowMs }: ObservationAge,
): ReadinessEvidence {
  const measured =
    ageMs === null
      ? `completed at ${completedAt}, which is not usable against the ${String(windowMs)}ms window`
      : `${String(ageMs)}ms old against a ${String(windowMs)}ms window`;
  return {
    id,
    summary: `${subject} observations exceeded their safe reuse window: ${measured}.`,
    details: { completedAt, ageMs, windowMs },
  };
}
