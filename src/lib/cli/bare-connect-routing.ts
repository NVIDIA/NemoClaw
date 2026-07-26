// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { NormalizedSandboxArgv } from "./argv-normalizer";
import { CLI_NAME } from "./branding";

type SandboxSummary = {
  name: string;
  pendingRouteReservation?: true;
};

export type BareConnectRoutingDeps = {
  findRegisteredSandboxName: (tokens: string[]) => string | null;
  getDefault: () => string | null;
  getSandbox: (name: string) => unknown | null;
  listSandboxes: () => { sandboxes: SandboxSummary[] };
  printConnectOrderHint: (candidate: string | null) => void;
  printSandboxConnectHelp: (sandboxName?: string) => void;
  recoverRegistryEntries: () => Promise<unknown>;
};

/**
 * Route a bare `connect` invocation to the default sandbox.
 *
 * Returns the (possibly rewritten) argv to dispatch, or `null` when the
 * invocation was fully handled here (bare `connect --help`). A registered
 * sandbox literally named `connect` keeps the historical name-first grammar.
 */
export async function resolveBareConnectArgv(
  normalized: NormalizedSandboxArgv,
  deps: BareConnectRoutingDeps,
): Promise<NormalizedSandboxArgv | null> {
  if (normalized.sandboxName !== "connect" || deps.getSandbox("connect")) {
    return normalized;
  }

  if (normalized.action !== "connect") {
    const reorderedCandidate = deps.findRegisteredSandboxName([normalized.action]);
    if (reorderedCandidate) {
      deps.printConnectOrderHint(reorderedCandidate);
      process.exit(1);
    }
    return normalized;
  }

  if (normalized.connectHelpRequested) {
    deps.printSandboxConnectHelp(deps.getDefault() ?? undefined);
    return null;
  }

  const defaultName = await resolveDefaultSandboxForBareConnect(deps);
  if (!defaultName) printBareConnectWithoutDefault(deps);
  return { ...normalized, sandboxName: defaultName };
}

async function resolveDefaultSandboxForBareConnect(
  deps: BareConnectRoutingDeps,
): Promise<string | null> {
  const currentDefault = deps.getDefault();
  if (currentDefault) return currentDefault;

  await deps.recoverRegistryEntries();
  return deps.getDefault();
}

function printBareConnectWithoutDefault(deps: BareConnectRoutingDeps): never {
  const pendingNames = deps
    .listSandboxes()
    .sandboxes.filter((sandbox) => sandbox.pendingRouteReservation === true)
    .map((sandbox) => sandbox.name);

  console.error(`  '${CLI_NAME} connect' could not resolve a ready default sandbox.`);
  console.error("");
  if (pendingNames.length > 0) {
    console.error(`  Sandbox setup is still pending: ${pendingNames.join(", ")}`);
    console.error("  Wait for onboarding to finish or remove the incomplete sandbox.");
  } else {
    console.error(`  Run '${CLI_NAME} onboard' to create one.`);
  }
  process.exit(1);
}
