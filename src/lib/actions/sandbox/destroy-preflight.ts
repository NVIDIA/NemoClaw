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
  const sandbox = registry.getSandbox(sandboxName);
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
