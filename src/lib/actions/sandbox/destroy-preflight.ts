// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import {
  hasAmbiguousSandboxContainerIdentity,
  type SandboxContainerIdentityRow,
} from "../../domain/sandbox/destroy";
import {
  OPENSHELL_MANAGED_BY_LABEL,
  OPENSHELL_SANDBOX_NAME_LABEL,
  OPENSHELL_SANDBOX_WORKSPACE_LABEL,
  queryDockerSandboxNameClaims,
} from "../../onboard/openshell-docker-sandbox-containers";
import { normalizeRuntimeProviderIdentity } from "../../onboard/runtime-provider/access";
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

export type DestroySandboxContainerIdentity =
  | { readonly outcome: "skipped" }
  | { readonly outcome: "unavailable"; readonly error: string }
  | { readonly outcome: "unambiguous" }
  | { readonly outcome: "ambiguous"; readonly rows: readonly SandboxContainerIdentityRow[] };

type ResolveContainerIdentityDeps = {
  queryClaims?: typeof queryDockerSandboxNameClaims;
};

/**
 * Resolve whether the host containers that claim this sandbox's name label
 * share one OpenShell-managed identity (#8999). Non-Docker runtime drivers
 * return `skipped`. A Docker failure or unparsable answer returns
 * `unavailable`; only positive evidence of a disputed name is `ambiguous`.
 */
export function resolveDestroySandboxContainerIdentity(
  sandboxName: string,
  openshellDriver: string | null | undefined,
  deps: ResolveContainerIdentityDeps = {},
): DestroySandboxContainerIdentity {
  if (normalizeRuntimeProviderIdentity(openshellDriver) !== "docker") {
    return { outcome: "skipped" };
  }
  const queryClaims = deps.queryClaims ?? queryDockerSandboxNameClaims;
  const claims = queryClaims(sandboxName);
  if (!claims.ok) return { outcome: "unavailable", error: claims.error };
  return hasAmbiguousSandboxContainerIdentity(claims.rows)
    ? { outcome: "ambiguous", rows: claims.rows }
    : { outcome: "unambiguous" };
}

// Container IDs are validated as 64-hex upstream; names and label values are
// attacker-controlled. Drop every non-printable byte, then JSON-quote so an
// embedded quote cannot forge an apparent field in the refusal output.
function terminalSafeLabelValue(value: string): string {
  return JSON.stringify(value.replace(/[^\x20-\x7e]/g, "?").slice(0, 64));
}

export function renderDestroySandboxContainerIdentityRefusal(
  sandboxName: string,
  rows: readonly SandboxContainerIdentityRow[],
): string[] {
  return [
    `  Refusing to destroy sandbox '${sandboxName}': ${rows.length} container(s) carry the ` +
      `label '${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}' but do not share one ` +
      `OpenShell-managed identity:`,
    ...rows.map(
      (row) =>
        `    - ${row.id.slice(0, 12)} name=${terminalSafeLabelValue(row.name)} ` +
        `${OPENSHELL_MANAGED_BY_LABEL}=${terminalSafeLabelValue(row.managedBy)} ` +
        `${OPENSHELL_SANDBOX_WORKSPACE_LABEL}=${terminalSafeLabelValue(row.workspace)}`,
    ),
    `  NemoClaw did not change any container, image, or local sandbox state.`,
    `  Inspect each container with 'docker inspect <id>'. Remove a container that is not an ` +
      `OpenShell sandbox with 'docker rm -f <id>', then rerun destroy.`,
    `  After you verify the destroy target yourself, 'destroy --force' skips this check.`,
  ];
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

export function prepareSandboxDestroy(
  sandboxName: string,
  options: { force?: boolean } = {},
): SandboxDestroyPreflight {
  const sandbox = registry.getSandbox(sandboxName);

  // Fail closed before any destructive work when the sandbox-name label is
  // disputed on the host: a foreign container that copies the label means the
  // destroy target's identity cannot be trusted (#8999). `--force` skips the
  // gate for an operator who verified the target, so a label squatter cannot
  // permanently block destroy.
  const containerIdentity = resolveDestroySandboxContainerIdentity(
    sandboxName,
    sandbox?.openshellDriver,
  );
  if (containerIdentity.outcome === "ambiguous" && options.force !== true) {
    for (const line of renderDestroySandboxContainerIdentityRefusal(
      sandboxName,
      containerIdentity.rows,
    )) {
      console.error(line);
    }
    process.exit(1);
  }
  if (containerIdentity.outcome === "ambiguous") {
    console.warn(
      `  ⚠ Containers that carry the label '${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}' do ` +
        `not share one OpenShell-managed identity. Destroy proceeds because of --force.`,
    );
  }
  if (containerIdentity.outcome === "unavailable") {
    console.warn(
      `  ⚠ Destroy skipped the container identity check for '${sandboxName}' because Docker did ` +
        `not answer it: ${terminalSafeLabelValue(containerIdentity.error)}`,
    );
  }

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
