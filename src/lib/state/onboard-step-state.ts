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
      // `agent` is the stored agent-name string; "openclaw" is the sentinel for
      // the default OpenClaw flow and is null-equivalent everywhere else in the
      // tree (e.g. agent-resume-state normalizes it to null, and the sandbox
      // handler treats `!agentName || agentName === "openclaw"` as the default).
      // A bare truthiness test would route a stored "openclaw" to agent_setup
      // and skip the OpenClaw setup state on resume.
      return session.agent && session.agent !== "openclaw" ? "agent_setup" : "openclaw";
    case "openclaw":
    case "agent_setup":
      return "policies";
    case "policies":
      return "finalizing";
    default:
      return null;
  }
}
