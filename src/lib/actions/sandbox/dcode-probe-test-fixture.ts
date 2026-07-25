// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { SANDBOX_EXEC_STARTED_MARKER } from "./sandbox-exec-output";

export type DcodeProbeState = "active" | "idle" | "unverifiable" | "no-runtime";

export function dcodeProbeOutput(state: DcodeProbeState, extra = ""): string {
  return `${SANDBOX_EXEC_STARTED_MARKER}\nNEMOCLAW_DCODE_PROBE=${state}\n${extra}`;
}

export function framedDcodeProbeOutput(state: DcodeProbeState, framePrefix = "stdout: "): string {
  return `${framePrefix}${SANDBOX_EXEC_STARTED_MARKER}\n${framePrefix}NEMOCLAW_DCODE_PROBE=${state}\n`;
}
