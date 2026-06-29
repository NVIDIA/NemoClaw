// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { VisibleConfigDisplay } from "./diagnostics";

export type VisibleConfigSeverity = "ok" | "info" | "warn";
export type VisibleConfigDoctorStatus = "ok" | "info" | "warn";

export function visibleConfigSeverity(
  source: VisibleConfigDisplay["source"],
): VisibleConfigSeverity {
  switch (source) {
    case "persisted":
      return "ok";
    case "default":
      return "info";
    case "invalid":
      return "warn";
  }
}

export function visibleConfigDoctorStatus(
  source: VisibleConfigDisplay["source"],
): VisibleConfigDoctorStatus {
  switch (source) {
    case "persisted":
      return "ok";
    case "default":
      return "info";
    case "invalid":
      return "warn";
  }
}

export interface VisibleConfigDoctorHintInput {
  readonly cli: string;
  readonly sandboxName: string;
  readonly channelName: string;
  readonly source: VisibleConfigDisplay["source"];
}

export function visibleConfigDoctorHint(input: VisibleConfigDoctorHintInput): string | undefined {
  if (input.source === "default") {
    return `run \`${input.cli} ${input.sandboxName} channels status --channel ${input.channelName}\` to confirm the resolved value`;
  }
  if (input.source === "invalid") {
    return `run \`${input.cli} ${input.sandboxName} channels add ${input.channelName}\` to re-enter a valid value`;
  }
  return undefined;
}
