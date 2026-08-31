// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime";
import type { RebuildBail } from "./rebuild-credential-preflight";
import { openRebuildShieldsWindowForState } from "./rebuild-flow-helpers";
import { type RebuildShieldsWindow, relockRebuildShieldsWindow } from "./rebuild-shields";

export interface RebuildShieldsPhaseResult {
  window: RebuildShieldsWindow;
  staleSandboxWasLocked: boolean;
  relock: (sandboxStillExists: boolean) => boolean;
  bindRuntimeSelection: (runtimeSelection?: OpenShellRuntimeSelection) => void;
}

/**
 * Open the mutable rebuild window while preserving fail-safe lock cleanup.
 * Boundary coverage: rebuild-shields-finally.test.ts and rebuild-flow.test.ts.
 */
export function runRebuildShieldsPhase(
  sandboxName: string,
  recoveryRecreate: boolean,
  releaseOnboardLock: () => void,
  bail: RebuildBail,
): RebuildShieldsPhaseResult | null {
  let window: RebuildShieldsWindow | null;
  let staleSandboxWasLocked: boolean;
  try {
    ({ rebuildShieldsWindow: window, staleSandboxWasLocked } = openRebuildShieldsWindowForState(
      sandboxName,
      recoveryRecreate,
    ));
  } catch (error) {
    process.removeListener("exit", releaseOnboardLock);
    releaseOnboardLock();
    throw error;
  }
  if (!window) {
    process.removeListener("exit", releaseOnboardLock);
    releaseOnboardLock();
    bail("Failed to auto-unlock shields.");
    return null;
  }
  let runtimeSelection: OpenShellRuntimeSelection | undefined;
  return {
    window,
    staleSandboxWasLocked,
    bindRuntimeSelection: (selection) => {
      runtimeSelection = selection;
    },
    relock: (sandboxStillExists: boolean) =>
      relockRebuildShieldsWindow(
        sandboxName,
        window,
        sandboxStillExists,
        CLI_NAME,
        runtimeSelection,
      ),
  };
}
