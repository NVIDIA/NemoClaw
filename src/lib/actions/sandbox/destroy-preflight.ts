// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { type DestroyRunOpenshell, selectGatewayForSandboxDestroy } from "./destroy-gateway";
import { classifyDestroySandboxPresence } from "./destroy-presence";
import { getSandboxTargetGatewayName } from "./gateway-target";
import { assertMcpAdapterConfigMutationsAllowed } from "./mcp-bridge-runtime-capabilities";

export type SandboxDestroyPreflight = {
  cleanupGatewayName: string;
  runOpenshell: DestroyRunOpenshell;
  sandbox: SandboxEntry | null;
  sandboxConfirmedAbsent: boolean;
};

function assertPolicyTransitionsSettledBeforeDestroy(
  sandboxName: string,
  sandbox: SandboxEntry | null,
): void {
  const customTransition = sandbox?.customPolicyTransition;
  if (customTransition) {
    const retry =
      customTransition.operation === "remove"
        ? `'policy remove ${customTransition.name}'`
        : "policy add with --from-file or --from-dir";
    throw new Error(
      `Cannot destroy sandbox '${sandboxName}' while custom policy ${customTransition.operation} for '${customTransition.name}' needs repair. Re-run ${retry} to reconcile live and durable policy state.`,
    );
  }

  const baselineTransition = sandbox?.baselineExclusionTransition;
  if (baselineTransition) {
    throw new Error(
      `Cannot destroy sandbox '${sandboxName}' while baseline policy ${baselineTransition.operation} for '${baselineTransition.exclusion.key}' needs repair. Re-run 'policy ${baselineTransition.operation} ${baselineTransition.exclusion.key}' to reconcile live and durable policy state.`,
    );
  }
}

function clearAbsentSandboxPolicyTransition(
  sandboxName: string,
  sandbox: SandboxEntry | null,
): SandboxEntry | null {
  const customTransition = sandbox?.customPolicyTransition;
  const baselineTransition = sandbox?.baselineExclusionTransition;
  if (customTransition && baselineTransition) {
    throw new Error(
      `Cannot continue cleanup for absent sandbox '${sandboxName}' because its registry contains conflicting custom and baseline policy repair journals. No journal was cleared; repair the registry before retrying destroy.`,
    );
  }
  if (customTransition && !registry.clearCustomPolicyTransition(sandboxName, customTransition.id)) {
    throw new Error(
      `Cannot continue cleanup for absent sandbox '${sandboxName}' because its custom policy repair journal changed or could not be cleared. Local state was preserved; retry destroy.`,
    );
  }

  if (
    baselineTransition &&
    !registry.clearBaselineExclusionTransition(sandboxName, baselineTransition.id)
  ) {
    throw new Error(
      `Cannot continue cleanup for absent sandbox '${sandboxName}' because its baseline policy repair journal changed or could not be cleared. Local state was preserved; retry destroy.`,
    );
  }

  if (!customTransition && !baselineTransition) return sandbox;
  const refreshedSandbox = registry.getSandbox(sandboxName);
  assertPolicyTransitionsSettledBeforeDestroy(sandboxName, refreshedSandbox);
  return refreshedSandbox;
}

function stopSandboxInferenceResources(sandboxName: string, sandbox: SandboxEntry | null): void {
  const nim = require("../../inference/nim") as {
    stopNimContainer: (name: string, opts?: { silent?: boolean }) => void;
    stopNimContainerByName: (name: string) => void;
  };
  if (sandbox?.nimContainer) {
    console.log(`  Stopping NIM for '${sandboxName}'...`);
    nim.stopNimContainerByName(sandbox.nimContainer);
  } else {
    // Older registry entries may not record the convention-named container.
    nim.stopNimContainer(sandboxName, { silent: true });
  }

  // The Ollama auth proxy is per-sandbox. GPU model unload happens during
  // post-delete host cleanup, after the live sandbox is confirmed gone.
  if (sandbox?.provider?.includes("ollama")) {
    const { killStaleProxy } = require("../../inference/ollama/proxy") as {
      killStaleProxy: () => void;
    };
    killStaleProxy();
  }
}

export function prepareSandboxDestroy(sandboxName: string): SandboxDestroyPreflight {
  let sandbox = registry.getSandbox(sandboxName);
  console.log(`  Deleting sandbox '${sandboxName}'...`);
  const { runOpenshell } = require("../../adapters/openshell/runtime") as {
    runOpenshell: DestroyRunOpenshell;
  };

  // Capture the sandbox gateway before destructive work, then pin every
  // following OpenShell subprocess against that same registry-owned gateway.
  const cleanupGatewayName = getSandboxTargetGatewayName(sandboxName);
  selectGatewayForSandboxDestroy(sandboxName, cleanupGatewayName, runOpenshell);
  process.env.OPENSHELL_GATEWAY = cleanupGatewayName;

  const sandboxPresence = classifyDestroySandboxPresence(
    sandboxName,
    runOpenshell(["sandbox", "list", "-o", "json"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    }),
  );
  const sandboxConfirmedAbsent = sandboxPresence === "absent";
  if (sandboxConfirmedAbsent) {
    // Exact absence makes the live half of a pending policy transaction
    // irrelevant. Retire only the journal observed above, then continue from
    // a fresh row so absent-sandbox MCP cleanup can publish its own state.
    sandbox = clearAbsentSandboxPolicyTransition(sandboxName, sandbox);
  } else {
    // A live or unclassified sandbox may still carry either side of the
    // interrupted policy mutation. Preserve the journal and all owned state.
    assertPolicyTransitionsSettledBeforeDestroy(sandboxName, sandbox);
  }
  const mcpEntriesRequiringConfigMutation = Object.values(sandbox?.mcp?.bridges ?? {}).filter(
    (entry) => entry.addState !== "prepared",
  );
  if (
    !sandboxConfirmedAbsent &&
    sandbox &&
    !sandbox.mcp?.destroyPreparedAt &&
    !sandbox.mcp?.destroyPendingAt &&
    mcpEntriesRequiringConfigMutation.length > 0
  ) {
    // Fail before stopping local services or mutating any MCP resource when
    // the live adapter config cannot be changed safely.
    assertMcpAdapterConfigMutationsAllowed(sandboxName, sandbox, mcpEntriesRequiringConfigMutation);
  }

  stopSandboxInferenceResources(sandboxName, sandbox);
  return { cleanupGatewayName, runOpenshell, sandbox, sandboxConfirmedAbsent };
}
