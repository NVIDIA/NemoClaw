// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardMachineState } from "../onboard/machine/types";

export function nextMachineStateAfterCompletedStep(
  stepName: string | null | undefined,
  session: { agent: string | null },
): OnboardMachineState | null {
  switch (stepName) {
    case "preflight":
      return "gateway";
    case "gateway":
      return "provider_selection";
    case "provider_selection":
      return "inference";
    case "inference":
      return "sandbox";
    case "sandbox":
      return session.agent ? "agent_setup" : "openclaw";
    case "openclaw":
    case "agent_setup":
      return "policies";
    case "policies":
      return "finalizing";
    default:
      return null;
  }
}
