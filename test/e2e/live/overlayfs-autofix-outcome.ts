// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const OVERLAY_SIGNATURES =
  /overlayfs.*snapshotter cannot be enabled|CreateDiff: Canceled|failed to mount overlay/i;

export type NegativeOverlayOutcome = "reproduced" | "timeout" | "unrelated";

export function negativeOverlayOutcome(
  result: Pick<ShellProbeResult, "exitCode">,
  evidence: string,
): NegativeOverlayOutcome {
  return OVERLAY_SIGNATURES.test(evidence)
    ? "reproduced"
    : result.exitCode === 124
      ? "timeout"
      : "unrelated";
}
