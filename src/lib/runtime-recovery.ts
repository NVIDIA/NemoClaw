// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime recovery helpers — classify sandbox/gateway state from CLI
 * output and determine recovery strategy.
 */

import {
  parseCliOpenShellSandboxInventory,
  stripOpenShellCliAnsi,
} from "./adapters/openshell/sandbox-observer-cli";

/** Detect an OpenShell protobuf/wire schema-mismatch error in command output. */
export function isOpenShellProtobufSchemaMismatch(output = ""): boolean {
  const clean = stripOpenShellCliAnsi(output);
  return /invalid wire type/i.test(clean) || /proto(?:buf)?(?: decode| schema| wire)/i.test(clean);
}

/** Parse the set of all live sandbox names from `openshell sandbox list` output. */
export function parseLiveSandboxNames(listOutput = ""): Set<string> {
  return new Set(
    parseCliOpenShellSandboxInventory(listOutput).sandboxes.map((sandbox) => sandbox.name),
  );
}

export interface LiveSandboxEntry {
  name: string;
  phase: string | null;
}

/**
 * Parse `openshell sandbox list` rows into name + live PHASE pairs, skipping
 * headers and status/error lines. Used by #5714 list recovery to surface the
 * live phase (e.g. Ready) of a rediscovered sandbox without trusting the list
 * output for any other (e.g. agent) metadata it does not contain.
 */
export function parseLiveSandboxEntries(listOutput = ""): LiveSandboxEntry[] {
  return parseCliOpenShellSandboxInventory(listOutput).sandboxes.map(({ name, phase }) => ({
    name,
    phase,
  }));
}

/** Parse the set of sandbox names in a Ready/Running phase from `sandbox list` output. */
export function parseReadySandboxNames(listOutput = ""): Set<string> {
  return new Set(
    parseCliOpenShellSandboxInventory(listOutput)
      .sandboxes.filter((sandbox) => sandbox.readiness === "ready")
      .map((sandbox) => sandbox.name),
  );
}
