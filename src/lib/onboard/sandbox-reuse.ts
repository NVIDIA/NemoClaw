// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DASHBOARD_PORT } from "../core/ports";
import * as registry from "../state/registry";
import { bestEffortForwardStop } from "./forward-cleanup";

export interface SandboxReuseDeps {
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string;
  runOpenshell(args: string[], opts?: Record<string, unknown>): unknown;
  getSandboxStateFromOutputs(sandboxName: string, getOutput: string, listOutput: string): string;
  note(message: string): void;
}

export interface SandboxReuseHelpers {
  getSandboxReuseState(sandboxName: string | null): string;
  repairRecordedSandbox(sandboxName: string | null): void;
}

export function createSandboxReuseHelpers(deps: SandboxReuseDeps): SandboxReuseHelpers {
  function getSandboxReuseState(sandboxName: string | null): string {
    if (!sandboxName) return "missing";
    const getOutput = deps.runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
    const listOutput = deps.runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
    return deps.getSandboxStateFromOutputs(sandboxName, getOutput, listOutput);
  }

  function repairRecordedSandbox(sandboxName: string | null): void {
    if (!sandboxName) return;
    deps.note(`  [resume] Cleaning up recorded sandbox '${sandboxName}' before recreating it.`);
    bestEffortForwardStop(deps.runOpenshell, DASHBOARD_PORT);
    deps.runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    registry.removeSandbox(sandboxName);
  }

  return { getSandboxReuseState, repairRecordedSandbox };
}
