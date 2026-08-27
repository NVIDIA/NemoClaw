// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLI_DISPLAY_NAME, CLI_NAME } from "../../cli/branding";
import {
  getNamedGatewayLifecycleState,
  recoverNamedGatewayRuntime,
} from "../../gateway-runtime-action";
import { gatewayStartGuidance } from "../../gateway-start-guidance";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import { isTerminalSandboxPhase, TERMINAL_SANDBOX_PHASES } from "../../state/gateway";
export { isTerminalSandboxPhase, TERMINAL_SANDBOX_PHASES };
import {
  withMcpLifecycleLock,
  withMcpLifecycleLockSync,
} from "../../state/mcp-lifecycle-lock-acquisition";
import { selectSandboxOwningGateway } from "./gateway-select";
import {
  gatewayNamePattern,
  getKnownSandboxTargetGatewayName,
  getPersistedSandboxTargetGatewayName,
  getSandboxTargetGatewayName,
} from "./gateway-target";

const { pruneKnownHostsEntries } = require("../../onboard/known-hosts") as {
  pruneKnownHostsEntries: (contents: string) => string;
};

import { dockerStart } from "../../adapters/docker/container";
import {
  createCliOpenShellSandboxLookup,
  stripOpenShellCliAnsi,
  type CliOpenShellSandboxLookup,
} from "../../adapters/openshell/sandbox-observer-cli";
import {
  namedOpenShellGateway,
  selectedOpenShellGateway,
  type OpenShellSandboxError,
  type OpenShellSandboxErrorKind,
  type OpenShellSandboxTransportReason,
} from "../../adapters/openshell/sandbox-observer";
import {
  detectOpenShellStateRpcPreflightIssue,
  formatOpenShellStateRpcIssue,
  type OpenShellStateRpcIssue,
} from "../../adapters/openshell/gateway-drift";
import {
  captureOpenshell,
  captureOpenshellForStatus,
  getOpenshellBinary,
  getStatusProbeTimeoutMs,
  isCommandTimeout,
  runOpenshell,
} from "../../adapters/openshell/runtime";
import {
  OPENSHELL_OPERATION_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "../../adapters/openshell/timeouts";
import { D, G, R } from "../../cli/terminal-style";
import {
  type DockerDriverRecoveryResult,
  recoverDockerDriverSandbox,
} from "../../onboard/docker-driver-sandbox-recovery";
import {
  assertHermesPortableAgentLifecycleAuthority,
  buildHermesPortableCommandEnvironment,
  buildHermesPortableCommandAuthority,
  inspectPortableAgentReceiptDisposition,
  qualifyPortableAgentLifecycleAuthority,
  requalifyPortableAgentSandboxAuthority,
  recoverPortableAgentSandboxLifecycle,
  requireHermesPortableActiveLifecycleAuthority,
} from "../../onboard/experimental/portable-agent-lifecycle";
import type { PortableDemoLifecycleRecoveryResult } from "../../onboard/experimental/portable-demo-lifecycle";
import { compareAndSetLegacySandboxLifecycleGeneration } from "../../state/registry/lifecycle-generation";
import type { SandboxEntry } from "../../state/registry/types";
import { getSandboxDockerRuntime } from "./docker-health";
import { isDockerRuntimeDown, printDockerRuntimeDownGuidance } from "./gateway-failure-classifier";

export type SandboxGatewayState = {
  state: string;
  output: string;
  phase?: string | null;
  activeGateway?: string | null;
  recoveredGateway?: boolean;
  recoveryVia?: string | null;
  observationErrorKind?: OpenShellSandboxErrorKind;
  transportReason?: OpenShellSandboxTransportReason;
  gatewayRecoveryFailed?: boolean;
  /**
   * True when active Docker-driver sandbox recovery (#4423 part 2)
   * restarted the labeled sandbox container before the lookup
   * returned `present`. Callers can surface this in user-facing
   * output to explain why a previously-NotFound sandbox is now
   * Ready.
   */
  recoveredSandbox?: boolean;
  /**
   * Stable identifier for which Docker-driver recovery branch fired,
   * mirroring `DockerDriverRecoveryVia`. `null` when no Docker-side
   * recovery was attempted or required.
   */
  recoverySandboxVia?: string | null;
};

export type {
  HermesPortableActiveLifecycleAuthority,
  HermesPortableAgentLifecycleAuthority,
  PortableAgentReceiptDisposition,
} from "../../onboard/experimental/portable-agent-lifecycle";
export {
  buildHermesPortableCommandAuthority,
  buildHermesPortableCommandEnvironment,
  inspectPortableAgentReceiptDisposition,
  qualifyPortableAgentLifecycleAuthority,
  requalifyPortableAgentSandboxAuthority,
  requireHermesPortableActiveLifecycleAuthority,
};
export const withSandboxLifecycleLock = withMcpLifecycleLock;
export const withSandboxLifecycleLockSync = withMcpLifecycleLockSync;
export const withConnectSandboxLifecycleLock = withMcpLifecycleLock;

type SandboxGatewayStateLookup = (
  sandboxName: string,
  gatewayName?: string,
) => SandboxGatewayState | Promise<SandboxGatewayState>;

function gatewayScopedArgs(args: string[], gatewayName?: string): string[] {
  if (!gatewayName) return args;
  return [...args.slice(0, 2), "-g", gatewayName, ...args.slice(2)];
}

/** Resolve the authoritative gateway for a persisted sibling ownership row. */
export function resolvePersistedSandboxOwnershipGateway(sandbox: SandboxEntry): string {
  return getPersistedSandboxTargetGatewayName(sandbox);
}

/** Capture one gateway's live sandbox phases for host-global model ownership. */
export function captureSandboxOwnershipPhases(
  gatewayName: string,
  environment: NodeJS.ProcessEnv,
): { readonly output: string; readonly status: number | null } {
  const result = captureOpenshell(gatewayScopedArgs(["sandbox", "list"], gatewayName), {
    env: environment,
    ignoreError: true,
    includeStderr: true,
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  return { output: result.output, status: result.status };
}

/** Recover a receipt-bound portable sandbox before the live lookup rejects a stopped container. */
export function recoverPortableDemoSandboxLifecycleForConnect(
  sandboxName: string,
  sandbox: SandboxEntry | null,
  gatewayName: string,
): PortableDemoLifecycleRecoveryResult {
  return recoverPortableAgentSandboxLifecycle(
    sandboxName,
    {
      agent: sandbox?.agent,
      gatewayName,
      lifecycleGeneration: sandbox?.lifecycleGeneration,
      openshellDriver: sandbox?.openshellDriver,
      provider: sandbox?.provider,
    },
    {
      ...(sandbox
        ? {
            backfillRegistryGeneration: (generation: string) =>
              compareAndSetLegacySandboxLifecycleGeneration(sandbox, generation),
          }
        : {}),
      openshellBinary: getOpenshellBinary(),
      captureOpenshell: (args, timeoutMs) => {
        const result = captureOpenshell([...args], {
          ignoreError: true,
          includeStreams: true,
          timeout: timeoutMs,
        });
        return {
          status: result.status,
          stdout: result.stdout ?? result.output,
          stderr: result.stderr,
          error: result.error,
        };
      },
      readRegistry: (name) => (sandbox?.name === name ? sandbox : null),
    },
  );
}

/** Requalify Hermes receipt authority without starting or mutating its sandbox. */
export function assertHermesPortableLifecycleForConnect(
  sandboxName: string,
  sandbox: SandboxEntry,
  gatewayName: string,
): void {
  assertHermesPortableAgentLifecycleAuthority(
    sandboxName,
    {
      agent: sandbox.agent,
      gatewayName,
      lifecycleGeneration: sandbox.lifecycleGeneration,
      openshellDriver: sandbox.openshellDriver,
      provider: sandbox.provider,
    },
    { readRegistry: (name: string) => (name === sandboxName ? sandbox : null) },
  );
}

function gatewayEndpointOverrideState(): SandboxGatewayState | null {
  try {
    assertNoOpenShellGatewayEndpointOverride();
    return null;
  } catch (error) {
    return {
      state: "gateway_endpoint_override",
      output: `  Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function formatGatewaySchemaMismatchOutput(
  issue: OpenShellStateRpcIssue,
  action: string,
  command?: string,
): string {
  return formatOpenShellStateRpcIssue(issue, { action, command }).join("\n");
}

export function mergeLivePolicyIntoSandboxOutput(output: string, livePolicyOutput: string): string {
  const rawLines = String(output).split("\n");
  const cleanLines = stripOpenShellCliAnsi(String(output)).split("\n");
  const policyLineIdx = cleanLines.findIndex((line: string) => line.trim() === "Policy:");
  if (policyLineIdx === -1) return output;

  const before = rawLines.slice(0, policyLineIdx + 1).join("\n");
  const suffixLineIdx = cleanLines.findIndex(
    (line, index) =>
      index > policyLineIdx &&
      /^\s*(?:Id|Name|Phase|Resource version|Labels|Annotations|Policy source|Revision):(?:\s|$)/u.test(
        line,
      ),
  );
  const suffix =
    suffixLineIdx === -1
      ? ""
      : `\n${rawLines.slice(suffixLineIdx).join("\n").replace(/\n+$/u, "")}`;
  const cleanLivePolicy = stripOpenShellCliAnsi(String(livePolicyOutput));
  const delimIdx = cleanLivePolicy.search(/^---\s*$/m);
  const metadataPart = delimIdx !== -1 ? cleanLivePolicy.slice(0, delimIdx) : "";
  const yamlPart =
    delimIdx !== -1
      ? cleanLivePolicy.slice(delimIdx).replace(/^---\s*[\r\n]+/, "")
      : cleanLivePolicy;
  const trimmedYaml = yamlPart.trim();
  const looksLikeError = /^(error|failed|invalid|warning|status)\b/i.test(trimmedYaml);
  if (!trimmedYaml || looksLikeError || !/^[a-z_][a-z0-9_]*\s*:/m.test(trimmedYaml)) {
    return output;
  }

  const activeMatch = metadataPart.match(/^Active:\s*(\d+)\s*$/m);
  const rewrittenYaml =
    activeMatch && /^version:\s*\d+/m.test(trimmedYaml)
      ? trimmedYaml.replace(/^version:\s*\d+/m, `version: ${activeMatch[1]}`)
      : trimmedYaml;

  const indented = rewrittenYaml
    .split("\n")
    .map((line: string) => (line ? `  ${line}` : line))
    .join("\n");
  return `${before}\n\n${indented}${suffix}\n`;
}

/** Query sandbox presence and return its output with the live enforced policy. */
function sandboxObservationTarget(gatewayName?: string) {
  return gatewayName ? namedOpenShellGateway(gatewayName) : selectedOpenShellGateway();
}

function schemaMismatchState(action: string): SandboxGatewayState {
  return {
    state: "gateway_schema_mismatch",
    output: formatOpenShellStateRpcIssue(
      { kind: "protobuf_mismatch", drift: null, output: "" },
      { action },
    ).join("\n"),
  };
}

function sandboxObservationErrorState(
  error: OpenShellSandboxError,
  action: string,
): SandboxGatewayState {
  if (error.kind === "schema") return schemaMismatchState(action);
  if (error.kind === "transport") {
    return {
      state: "gateway_error",
      output: error.message,
      observationErrorKind: error.kind,
      transportReason: error.reason,
    };
  }
  if (error.kind === "authentication" || error.kind === "timeout") {
    return { state: "gateway_error", output: error.message, observationErrorKind: error.kind };
  }
  return { state: "unknown_error", output: error.message, observationErrorKind: error.kind };
}

export async function getSandboxGatewayState(
  sandboxName: string,
  gatewayName?: string,
  lookupSandbox: CliOpenShellSandboxLookup = createCliOpenShellSandboxLookup({
    capture: captureOpenshell,
    defaultTimeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
  }),
): Promise<SandboxGatewayState> {
  const endpointOverride = gatewayEndpointOverrideState();
  if (endpointOverride) return endpointOverride;
  const preflightIssue = detectOpenShellStateRpcPreflightIssue({ gatewayName });
  if (preflightIssue) {
    return {
      state: "gateway_schema_mismatch",
      output: formatGatewaySchemaMismatchOutput(
        preflightIssue,
        `verifying sandbox '${sandboxName}' against OpenShell`,
      ),
    };
  }
  const observed = await lookupSandbox({
    sandboxName,
    target: sandboxObservationTarget(gatewayName),
    timeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  const lookup = observed.result;
  const action = `verifying sandbox '${sandboxName}' against OpenShell`;
  if (!lookup.ok) return sandboxObservationErrorState(lookup.error, action);
  if (lookup.value.state === "missing") {
    return { state: "missing", output: "OpenShell did not find the sandbox." };
  }
  // Preserve the current CLI-formatted status display without putting it in
  // the transport-neutral observation contract. Presence and phase decisions
  // do not parse this text.
  let output = observed.displayOutput;
  if (lookup.value.state === "present") {
    const livePolicy = captureOpenshell(
      gatewayScopedArgs(["policy", "get", "--full", sandboxName], gatewayName),
      {
        ignoreError: true,
        timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      },
    );
    if (livePolicy.status === 0 && livePolicy.output.trim()) {
      output = mergeLivePolicyIntoSandboxOutput(output, livePolicy.output);
    }
    return { state: "present", output, phase: lookup.value.sandbox.phase };
  }
  return { state: "unknown_error", output: "OpenShell returned an unknown sandbox state." };
}

export async function getSandboxGatewayStateForStatus(
  sandboxName: string,
  gatewayName?: string,
  lookupSandbox: CliOpenShellSandboxLookup = createCliOpenShellSandboxLookup({
    capture: captureOpenshellForStatus,
    defaultTimeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
  }),
): Promise<SandboxGatewayState> {
  const timeoutMs = getStatusProbeTimeoutMs();
  const endpointOverride = gatewayEndpointOverrideState();
  if (endpointOverride) return endpointOverride;
  const preflightIssue = detectOpenShellStateRpcPreflightIssue({ gatewayName, timeoutMs });
  if (preflightIssue) {
    return {
      state: "gateway_schema_mismatch",
      output: formatGatewaySchemaMismatchOutput(
        preflightIssue,
        `checking status for sandbox '${sandboxName}'`,
        `${CLI_NAME} ${sandboxName} status`,
      ),
    };
  }
  const observed = await lookupSandbox({
    sandboxName,
    target: sandboxObservationTarget(gatewayName),
    timeoutMs,
  });
  const lookup = observed.result;
  const action = `checking status for sandbox '${sandboxName}'`;
  if (!lookup.ok && lookup.error.kind === "timeout") {
    return {
      state: "status_probe_timeout",
      output: `  Live sandbox status probe timed out after ${Math.ceil(timeoutMs / 1000)}s. Local registry data is shown above.`,
    };
  }
  if (!lookup.ok) return sandboxObservationErrorState(lookup.error, action);
  if (lookup.value.state === "missing") {
    return { state: "missing", output: "OpenShell did not find the sandbox." };
  }
  // Preserve the current CLI-formatted status display without putting it in
  // the transport-neutral observation contract. Presence and phase decisions
  // do not parse this text.
  let output = observed.displayOutput;
  if (lookup.value.state === "present") {
    const livePolicy = await captureOpenshellForStatus(
      gatewayScopedArgs(["policy", "get", "--full", sandboxName], gatewayName),
      {
        ignoreError: true,
        timeout: timeoutMs,
      },
    );
    if (!isCommandTimeout(livePolicy) && livePolicy.status === 0 && livePolicy.output.trim()) {
      output = mergeLivePolicyIntoSandboxOutput(output, livePolicy.output);
    }
    return { state: "present", output, phase: lookup.value.sandbox.phase };
  }
  return { state: "unknown_error", output: "OpenShell returned an unknown sandbox state." };
}

/**
 * Reconcile a NotFound sandbox lookup against the named NemoClaw gateway state.
 * When the active OpenShell gateway has drifted off nemoclaw, a NotFound is
 * ambiguous: the sandbox may actually be registered against the nemoclaw
 * gateway but invisible because some other gateway is currently active. This
 * helper self-heals an unscoped lookup by attempting `openshell gateway select
 * nemoclaw` and re-querying. When `pinnedGatewayName` is present, the NotFound
 * already came from the recorded owner, so ambient selection is ignored and
 * only the existing Docker-side recovery path is considered.
 */
export async function reconcileMissingAgainstNamedGateway(
  sandboxName: string,
  missingLookup: SandboxGatewayState,
  pinnedGatewayName?: string,
): Promise<SandboxGatewayState> {
  const targetGatewayName = pinnedGatewayName ?? getSandboxTargetGatewayName(sandboxName);
  if (pinnedGatewayName) {
    // The owner-scoped RPC reached this exact gateway and reported NotFound.
    // Ambient selection is irrelevant and must not trigger a sibling retry.
    return tryRecoverDockerDriverSandbox(sandboxName, missingLookup, pinnedGatewayName);
  }
  const lifecycle = getNamedGatewayLifecycleState(targetGatewayName);
  if (lifecycle.state === "connected_other") {
    runOpenshell(["gateway", "select", targetGatewayName], {
      ignoreError: true,
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    const retry = await getSandboxGatewayState(sandboxName, targetGatewayName);
    if (retry.state === "present") {
      return { ...retry, recoveredGateway: true, recoveryVia: "select" };
    }
    if (retry.state === "gateway_schema_mismatch") {
      return retry;
    }
    if (retry.state === "missing") {
      const after = getNamedGatewayLifecycleState(targetGatewayName);
      if (after.state === "healthy_named") {
        // Even with the right gateway selected, the sandbox is
        // still missing. Try Docker-side recovery before declaring
        // the sandbox truly absent.
        return tryRecoverDockerDriverSandbox(sandboxName, retry);
      }
      // The select moved the active gateway off, but the target gateway is
      // now missing or unreachable. Surface that post-select state so the
      // caller emits restart guidance, rather than `wrong_gateway_active`
      // pointing at the now-irrelevant pre-select active gateway.
      if (after.state === "missing_named") {
        return { state: "gateway_missing_after_restart", output: after.status };
      }
      if (after.state === "named_unreachable" || after.state === "named_unhealthy") {
        return { state: "gateway_unreachable_after_restart", output: after.status };
      }
    }
    return {
      state: "wrong_gateway_active",
      activeGateway: lifecycle.activeGateway,
      output: lifecycle.status,
    };
  }
  if (lifecycle.state === "missing_named") {
    return { state: "gateway_missing_after_restart", output: lifecycle.status };
  }
  if (lifecycle.state === "named_unreachable" || lifecycle.state === "named_unhealthy") {
    return { state: "gateway_unreachable_after_restart", output: lifecycle.status };
  }
  if (lifecycle.state === "healthy_named") {
    // The gateway is healthy and we already see `missing`. This is
    // the precise post-reboot precondition described in #4423: the
    // gateway came back fresh (per #4580's user-systemd unit) with
    // no sandbox memory, but Docker may still have the labeled
    // container. Attempt active Docker-side recovery before falling
    // through to non-destructive guidance.
    return tryRecoverDockerDriverSandbox(sandboxName, missingLookup);
  }
  return missingLookup;
}

/**
 * Attempt Docker-driver sandbox recovery (#4423) and re-query the
 * OpenShell gateway. Returns the new lookup with `recoveredSandbox`
 * flags set when recovery succeeded; otherwise returns the original
 * `missing` lookup unchanged so the caller's existing non-destructive
 * guidance fires.
 */
async function tryRecoverDockerDriverSandbox(
  sandboxName: string,
  missingLookup: SandboxGatewayState,
  gatewayName?: string,
): Promise<SandboxGatewayState> {
  let recovery: DockerDriverRecoveryResult;
  try {
    recovery = recoverDockerDriverSandbox(sandboxName);
  } catch {
    return missingLookup;
  }
  if (!recovery.recovered) {
    return missingLookup;
  }
  // Recovery succeeded against Docker; re-query OpenShell so the
  // returned state reflects what the gateway sees post-restart.
  const retried = await getSandboxGatewayState(sandboxName, gatewayName);
  return {
    ...retried,
    recoveredSandbox: true,
    recoverySandboxVia: recovery.via,
  };
}

/**
 * Print actionable guidance when the nemoclaw gateway exists but another
 * OpenShell gateway is currently active. Emphasizes that the sandbox has NOT
 * been removed and how to switch gateways before retrying. (#2276)
 */
export function printWrongGatewayActiveGuidance(
  sandboxName: string,
  activeGateway: string | null | undefined,
  writer: (message: string) => void = console.error,
  // The command to re-run after switching gateways. Defaults to `connect`;
  // callers in a different recovery flow (e.g. `rebuild`) pass their own so the
  // guidance points back to the workflow the user actually invoked.
  retryCommand = "connect",
): void {
  const targetGatewayName = getSandboxTargetGatewayName(sandboxName);
  const other =
    activeGateway && activeGateway !== targetGatewayName ? activeGateway : "another gateway";
  writer(
    `  Sandbox '${sandboxName}' is registered against the ${CLI_DISPLAY_NAME} gateway '${targetGatewayName}', but the currently active OpenShell gateway is '${other}'. Your sandbox has NOT been removed.`,
  );
  writer("  Switch gateways and retry:");
  writer(`      openshell gateway select ${targetGatewayName}`);
  writer(`  Then re-run: ${CLI_NAME} ${sandboxName} ${retryCommand}`);
}

/** Print troubleshooting hints based on gateway lifecycle state in the output. */
export function printGatewayLifecycleHint(
  output = "",
  sandboxName = "",
  writer: (message: string) => void = console.error,
): void {
  const cleanOutput = stripOpenShellCliAnsi(output);
  const targetGatewayName = getSandboxTargetGatewayName(sandboxName);
  // The gateway-side gRPC reply `sandbox has no spec` is returned when the
  // active OpenShell gateway does not know about the sandbox — which on a
  // multi-instance host typically means a sibling NemoClaw gateway (the one
  // the sandbox was actually onboarded against) is the owner, and the
  // current selection has to be switched back before the sandbox is
  // reachable. Surface a concrete switch-gateway hint rather than letting
  // the raw gRPC string be the last word.
  if (/sandbox has no spec/i.test(cleanOutput)) {
    writer(
      `  Sandbox '${sandboxName}' is registered against the ${CLI_DISPLAY_NAME} gateway '${targetGatewayName}', but the currently active OpenShell gateway does not know about it.`,
    );
    writer(
      "  On a multi-instance host, this usually means another NemoClaw gateway is the owner of this sandbox.",
    );
    writer(
      `  Select the owning gateway and retry: \`openshell gateway select ${targetGatewayName}\`, then \`${CLI_NAME} ${sandboxName} connect\`.`,
    );
    return;
  }
  if (/No gateway configured/i.test(cleanOutput)) {
    writer(
      `  The selected ${CLI_DISPLAY_NAME} gateway is no longer configured or its metadata/runtime has been lost.`,
    );
    writer(`  ${gatewayStartGuidance(targetGatewayName)}`);
    writer(
      "  If the gateway has to be rebuilt from scratch, recreate the affected sandbox afterward.",
    );
    return;
  }
  if (
    /Connection refused|client error \(Connect\)|tcp connect error/i.test(cleanOutput) &&
    gatewayNamePattern(targetGatewayName).test(cleanOutput)
  ) {
    writer(
      "  The target OpenShell gateway exists in metadata, but its API is refusing connections after restart.",
    );
    writer("  This usually means the gateway runtime did not come back cleanly after the restart.");
    writer(
      `  ${gatewayStartGuidance(targetGatewayName)} If the gateway stays in this state, rebuild it before expecting existing sandboxes to reconnect.`,
    );
    return;
  }
  if (/handshake verification failed/i.test(cleanOutput)) {
    writer("  This looks like gateway identity drift after restart.");
    writer(
      "  Existing sandboxes may still be recorded locally, but the current gateway no longer trusts their prior connection state.",
    );
    writer(
      `  Try re-establishing the ${CLI_DISPLAY_NAME} gateway/runtime first. If the sandbox is still unreachable, recreate just that sandbox with \`${CLI_NAME} onboard\`.`,
    );
    return;
  }
  if (/Connection refused|transport error/i.test(cleanOutput)) {
    writer(
      `  The sandbox '${sandboxName}' may still exist, but the current gateway/runtime is not reachable.`,
    );
    writer("  Check `openshell status`, verify the active gateway, and retry.");
    return;
  }
  if (/Missing gateway auth token|device identity required/i.test(cleanOutput)) {
    writer(
      "  The gateway is reachable, but the current auth or device identity state is not usable.",
    );
    writer("  Verify the active gateway and retry after re-establishing the runtime.");
  }
}

/** Print recovery guidance from a typed observation error or legacy CLI output. */
export function printSandboxGatewayStateHint(
  lookup: Pick<SandboxGatewayState, "observationErrorKind" | "output" | "transportReason">,
  sandboxName: string,
  writer: (message: string) => void = console.error,
): void {
  const targetGatewayName = getSandboxTargetGatewayName(sandboxName);
  switch (lookup.observationErrorKind) {
    case "transport":
      if (lookup.transportReason === "identity_mismatch") {
        writer("  This looks like gateway identity drift after restart.");
        writer(
          "  Existing sandboxes may still be recorded locally, but the selected gateway identity no longer matches the identity recorded before restart.",
        );
        writer(
          `  Re-establish the ${CLI_DISPLAY_NAME} gateway runtime first. If the sandbox stays unreachable, recreate only that sandbox with \`${CLI_NAME} onboard\`.`,
        );
        return;
      }
      writer(
        `  The sandbox '${sandboxName}' may still exist, but gateway '${targetGatewayName}' is not reachable.`,
      );
      writer("  Check `openshell status`, verify the active gateway, and retry.");
      return;
    case "authentication":
      writer("  OpenShell could not authenticate the sandbox observation.");
      writer("  Verify the active gateway and restore its authentication before retrying.");
      return;
    case "timeout":
      writer("  The OpenShell gateway did not answer before the sandbox observation timeout.");
      writer("  Check `openshell status` and retry after the gateway responds.");
      return;
    case "command":
      writer("  The OpenShell sandbox observation command failed.");
      writer("  Run `openshell status`, inspect the gateway, and retry.");
      return;
    default:
      printGatewayLifecycleHint(lookup.output, sandboxName, writer);
  }
}

export type GatewayRecoveryMode = "observe" | "recover";

export async function getReconciledSandboxGatewayState(
  sandboxName: string,
  opts: {
    getState?: SandboxGatewayStateLookup;
    gatewayRecovery?: GatewayRecoveryMode;
    selectOwningGateway?: boolean;
  } = {},
): Promise<SandboxGatewayState> {
  const getState = opts.getState ?? getSandboxGatewayState;
  const gatewayRecovery: GatewayRecoveryMode = opts.gatewayRecovery ?? "recover";
  let targetGatewayName = getKnownSandboxTargetGatewayName(sandboxName) ?? undefined;
  const endpointOverride = gatewayEndpointOverrideState();
  if (endpointOverride) return endpointOverride;
  if (targetGatewayName && opts.selectOwningGateway !== false) {
    // Keep OpenShell's active selection aligned for downstream operations, but
    // never trust that process-global state for this lookup: another CLI can
    // change it immediately after selection. The explicit gateway argument
    // below is the per-subprocess authority for the status RPC.
    const selection = selectSandboxOwningGateway(sandboxName);
    if (selection.outcome !== "selected") {
      const lifecycle = getNamedGatewayLifecycleState(targetGatewayName);
      return {
        state: "wrong_gateway_active",
        activeGateway: lifecycle.activeGateway,
        output:
          lifecycle.status ||
          `Failed to select owning gateway '${targetGatewayName}' for sandbox '${sandboxName}'.`,
      };
    }
    // Selection resolves registry ownership internally. If that snapshot changed
    // after the initial lookup, keep the subprocess-local RPC pin aligned with
    // the gateway that was actually selected rather than querying the stale one.
    targetGatewayName = selection.gatewayName;
  }
  const lookup = await getState(sandboxName, targetGatewayName);
  if (lookup.state === "present") {
    return lookup;
  }
  if (lookup.state === "missing") {
    return reconcileMissingAgainstNamedGateway(sandboxName, lookup, targetGatewayName);
  }

  if (lookup.state === "gateway_error") {
    if (gatewayRecovery === "observe") {
      return lookup;
    }
    const recoveryGatewayName = targetGatewayName ?? getSandboxTargetGatewayName();
    const recovery = await recoverNamedGatewayRuntime({ gatewayName: recoveryGatewayName });
    if (recovery.recovered) {
      const retried = await getState(sandboxName, recoveryGatewayName);
      if (retried.state === "present" || retried.state === "missing") {
        return { ...retried, recoveredGateway: true, recoveryVia: recovery.via || null };
      }
      if (retried.transportReason === "identity_mismatch") {
        return {
          state: "identity_drift",
          output: retried.output,
          recoveredGateway: true,
          recoveryVia: recovery.via || null,
        };
      }
      return { ...retried, recoveredGateway: true, recoveryVia: recovery.via || null };
    }
    const latestLifecycle = getNamedGatewayLifecycleState(recoveryGatewayName);
    const latestStatus = stripOpenShellCliAnsi(latestLifecycle.status || "");
    if (/No gateway configured/i.test(latestStatus)) {
      return {
        state: "gateway_missing_after_restart",
        output: latestLifecycle.status || lookup.output,
      };
    }
    if (
      /Connection refused|client error \(Connect\)|tcp connect error/i.test(latestStatus) &&
      gatewayNamePattern(recoveryGatewayName).test(latestStatus)
    ) {
      return {
        state: "gateway_unreachable_after_restart",
        output: latestLifecycle.status || lookup.output,
      };
    }
    if (
      recovery.after?.state === "named_unreachable" ||
      recovery.before?.state === "named_unreachable"
    ) {
      return {
        state: "gateway_unreachable_after_restart",
        output: recovery.after?.status || recovery.before?.status || lookup.output,
      };
    }
    return { ...lookup, gatewayRecoveryFailed: true };
  }

  return lookup;
}

const RECOVER_CONTAINER_START_TIMEOUT_MS = 30_000;

/**
 * Start a sandbox's Docker container when it exists but is stopped, before the
 * probe-only readiness wait begins polling. `recover` and `connect --probe-only`
 * both advertise that they restart a stopped sandbox, but the wait loop only
 * observes readiness. A container in `exited` cannot reach Ready. A plain
 * `docker start` can restore the same container with its workspace state and
 * managed configuration preserved (#8967). A nonzero or missing `docker start`
 * status continues to the readiness wait, which surfaces the existing
 * stopped-container guidance. The function leaves an unresolved, running, or
 * paused container unchanged. A paused container keeps its `docker unpause`
 * guidance. A caller that reaches this function after container startup makes
 * no change.
 */
export function startStoppedSandboxContainerForProbeRecovery(sandboxName: string): void {
  const runtime = getSandboxDockerRuntime(sandboxName);
  if (!runtime.containerName || runtime.running || runtime.paused) return;
  console.error(`  Sandbox '${sandboxName}' container is stopped — starting it...`);
  const result = dockerStart(runtime.containerName, {
    ignoreError: true,
    timeout: RECOVER_CONTAINER_START_TIMEOUT_MS,
  });
  if (result.status === 0) {
    console.error(`  ${G}✓${R} Started container '${runtime.containerName}'.`);
  } else {
    console.error(
      `  Docker could not start container '${runtime.containerName}' (exit ${result.status ?? "unknown"}); continuing with readiness checks.`,
    );
  }
}

export async function ensureLiveSandboxOrExit(
  sandboxName: string,
  {
    allowNonReadyPhase = false,
    gatewayRecovery = "recover",
    selectOwningGateway = true,
    exit = process.exit,
  }: {
    allowNonReadyPhase?: boolean;
    gatewayRecovery?: GatewayRecoveryMode;
    selectOwningGateway?: boolean;
    exit?: (code: number) => never;
  } = {},
): Promise<SandboxGatewayState> {
  const lookup = await getReconciledSandboxGatewayState(sandboxName, {
    gatewayRecovery,
    selectOwningGateway,
  });
  if (lookup.state === "present") {
    const phase = lookup.phase ?? null;
    if (!allowNonReadyPhase && phase && phase !== "Ready" && phase !== "Running") {
      // Don't steer toward rebuild when the host Docker daemon is down: the
      // sandbox is fine and recreating it cannot succeed until Docker is back
      // (#4428). Terminal phases (Failed/Error/...) are settled failures and
      // keep the rebuild guidance so a genuine failure is never masked.
      if (!isTerminalSandboxPhase(phase) && isDockerRuntimeDown(sandboxName)) {
        printDockerRuntimeDownGuidance(sandboxName);
        exit(1);
      }
      const dockerRuntime = getSandboxDockerRuntime(sandboxName);
      if (dockerRuntime.containerName && !dockerRuntime.running && !dockerRuntime.paused) {
        console.error(`  Sandbox '${sandboxName}' is stopped.`);
        console.error("  Workspace state is preserved.");
        console.error(`  Start it again with \`${CLI_NAME} ${sandboxName} start\`.`);
        exit(1);
      }
      if (phase === "Error" && dockerRuntime.paused && dockerRuntime.containerName) {
        console.error(`  Sandbox '${sandboxName}' is stuck in '${phase}' phase.`);
        console.error("");
        console.error(
          `  The Docker-driver container for '${sandboxName}' is paused: ${dockerRuntime.containerName}`,
        );
        console.error(
          "  A paused container can report 'Phase: Error' even though the sandbox is intact.",
        );
        console.error("  Resume it to restore the running phase:");
        console.error(`    ${D}docker unpause ${dockerRuntime.containerName}${R}`);
        exit(1);
      }
      console.error(`  Sandbox '${sandboxName}' is stuck in '${phase}' phase.`);
      console.error(
        "  This usually happens when a process crash inside the sandbox prevented clean startup.",
      );
      console.error("");
      if (phase === "Error" && dockerRuntime?.containerName) {
        console.error(
          `  Run \`${CLI_NAME} ${sandboxName} start\` to restart the crashed container and recover the sandbox with workspace state preserved.`,
        );
        console.error(
          `  (\`${CLI_NAME} ${sandboxName} rebuild --yes\` recreates the sandbox instead, but its pre-rebuild backup cannot snapshot a stopped container, so start it first.)`,
        );
      } else {
        console.error(
          `  Run \`${CLI_NAME} ${sandboxName} rebuild --yes\` to recreate the sandbox (--yes skips the confirmation prompt; workspace state will be preserved).`,
        );
      }
      exit(1);
    }
    return lookup;
  }
  if (lookup.state === "gateway_schema_mismatch") {
    console.error(lookup.output);
    exit(1);
  }
  if (lookup.state === "missing") {
    const targetGatewayName = getSandboxTargetGatewayName(sandboxName);
    const guard = getNamedGatewayLifecycleState(targetGatewayName);
    if (guard.state !== "healthy_named") {
      if (guard.state === "connected_other") {
        printWrongGatewayActiveGuidance(sandboxName, guard.activeGateway, console.error);
      } else {
        printGatewayLifecycleHint(guard.status || "", sandboxName, console.error);
      }
      exit(1);
    }
    // The sandbox is absent from a healthy NemoClaw gateway, but the local
    // registry entry still holds the metadata that `rebuild` / `onboard
    // --recreate-sandbox` need to recover it. Removing it here would race with
    // the recovery guidance `status` prints for a stuck/stale sandbox: a
    // routine `connect` would delete the very state the recommended
    // `rebuild --yes` depends on, so the rebuild then fails with "does not
    // exist" (#4497). Preserve the entry and route intentional purges through
    // the explicit `destroy` command instead of deleting state automatically.
    console.error(
      `  Sandbox '${sandboxName}' is registered locally, but is not present in the live OpenShell gateway.`,
    );
    console.error("  Your local registry entry has been preserved — nothing was removed.");
    console.error(
      `  If the live sandbox is stuck mid-provision, retry \`${CLI_NAME} ${sandboxName} rebuild --yes\` once it reappears to recreate it (workspace state is preserved when the live sandbox still exists).`,
    );
    console.error(
      `  If the sandbox was intentionally deleted, run \`${CLI_NAME} ${sandboxName} destroy\` to remove the stale local entry, or \`${CLI_NAME} onboard\` to create a new one.`,
    );
    exit(1);
  }
  if (lookup.state === "wrong_gateway_active") {
    printWrongGatewayActiveGuidance(sandboxName, lookup.activeGateway, console.error);
    exit(1);
  }
  if (lookup.state === "identity_drift") {
    console.error("  Gateway SSH identity changed after restart — clearing stale host keys...");
    const knownHostsPath = path.join(os.homedir(), ".ssh", "known_hosts");
    try {
      const kh = fs.readFileSync(knownHostsPath, "utf8");
      const cleaned = pruneKnownHostsEntries(kh);
      if (cleaned !== kh) fs.writeFileSync(knownHostsPath, cleaned);
    } catch {
      /* best-effort cleanup */
    }
    const retry = await getReconciledSandboxGatewayState(sandboxName, {
      gatewayRecovery,
      selectOwningGateway,
    });
    if (retry.state === "present") {
      console.error("  ✓ Reconnected after clearing stale SSH host keys.");
      return retry;
    }
    console.error(
      `  Could not reconnect to sandbox '${sandboxName}' after clearing stale host keys.`,
    );
    if (retry.output) {
      console.error(retry.output);
    }
    console.error(
      `  Recreate this sandbox with \`${CLI_NAME} onboard\` once the gateway runtime is stable.`,
    );
    exit(1);
  }
  if (lookup.state === "gateway_unreachable_after_restart") {
    console.error(
      `  Sandbox '${sandboxName}' may still exist, but the selected ${CLI_DISPLAY_NAME} gateway is still refusing connections after restart.`,
    );
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error(
      `  ${gatewayStartGuidance(getSandboxTargetGatewayName(sandboxName))} Check that \`openshell status\` reports the gateway healthy before reconnecting.`,
    );
    console.error(
      "  If the gateway never becomes healthy, rebuild the gateway and then recreate the affected sandbox.",
    );
    exit(1);
  }
  if (lookup.state === "gateway_error" && gatewayRecovery === "observe") {
    console.error(
      `  Sandbox '${sandboxName}' cannot be verified: the OpenShell gateway RPC returned an error.`,
    );
    if (lookup.output) {
      console.error(lookup.output);
    }
    printSandboxGatewayStateHint(lookup, sandboxName);
    console.error(
      `  This sandbox-scoped command will not restart the shared host gateway. ${gatewayStartGuidance(getSandboxTargetGatewayName(sandboxName))} Then retry this command.`,
    );
    exit(1);
  }
  if (lookup.state === "gateway_missing_after_restart") {
    console.error(
      `  Sandbox '${sandboxName}' may still exist locally, but the ${CLI_DISPLAY_NAME} gateway is no longer configured after restart/rebuild.`,
    );
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error(`  ${gatewayStartGuidance(getSandboxTargetGatewayName(sandboxName))}`);
    console.error(
      "  If the gateway had to be rebuilt from scratch, recreate the affected sandbox afterward.",
    );
    exit(1);
  }
  console.error(`  Unable to verify sandbox '${sandboxName}' against the live OpenShell gateway.`);
  if (lookup.output) {
    console.error(lookup.output);
  }
  printSandboxGatewayStateHint(lookup, sandboxName);
  console.error("  Check `openshell status` and the active gateway, then retry.");
  return exit(1);
}
