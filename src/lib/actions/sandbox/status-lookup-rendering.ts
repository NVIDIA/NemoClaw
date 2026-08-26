// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_DISPLAY_NAME, CLI_NAME } from "../../cli/branding";
import { D, R } from "../../cli/terminal-style";
import { deferSandboxLifecycleExit } from "../../core/process-exit";
import { gatewayStartGuidance } from "../../gateway-start-guidance";
import { isTerminalSandboxPhase } from "../../state/gateway";
import { getSandboxDockerRuntime } from "./docker-health";
import { isDockerRuntimeDown, printDockerRuntimeDownGuidance } from "./gateway-failure-classifier";
import type { SandboxGatewayState } from "./gateway-state";
import { printSandboxGatewayStateHint, printWrongGatewayActiveGuidance } from "./gateway-state";
import { getSandboxTargetGatewayName } from "./gateway-target";
import {
  printGatewayFailureLayerHeader,
  type SandboxStatusPreflightResult,
} from "./status-preflight";

type SandboxGatewayLookupStatusContext = {
  sandboxName: string;
  /** Whether the local registry holds `sandboxName`, as the status snapshot read it. */
  registered: boolean;
  lookup: SandboxGatewayState;
  phase: string | null;
  dockerRuntime: ReturnType<typeof getSandboxDockerRuntime> | null;
  effectivePreflight: SandboxStatusPreflightResult;
};

export async function printSandboxGatewayLookupStatus(
  context: SandboxGatewayLookupStatusContext,
): Promise<void> {
  switch (context.lookup.state) {
    case "present":
      printPresentSandboxGatewayLookupStatus(context);
      return;
    case "wrong_gateway_active":
      printWrongGatewayActiveLookupStatus(context);
      return;
    case "gateway_schema_mismatch":
      console.log(context.lookup.output);
      deferSandboxLifecycleExit(1);
    case "missing":
      printMissingLiveSandboxStatusGuidance(context);
      deferSandboxLifecycleExit(1);
    case "identity_drift":
      printIdentityDriftLookupStatus(context);
      return;
    case "gateway_unreachable_after_restart":
      await printGatewayUnreachableAfterRestartLookupStatus(context);
      return;
    case "gateway_missing_after_restart":
      await printGatewayMissingAfterRestartLookupStatus(context);
      return;
    case "sandbox_recovery_failed":
      printSandboxRecoveryFailedLookupStatus(context);
      return;
    default:
      await printUnknownGatewayLookupStatus(context);
  }
}

function printSandboxRecoveryFailedLookupStatus({
  sandboxName,
  lookup,
}: SandboxGatewayLookupStatusContext): void {
  console.log("");
  const recoveredFromDocker = "recoveredSandbox" in lookup && lookup.recoveredSandbox === true;
  console.log(
    recoveredFromDocker
      ? `  Sandbox '${sandboxName}' was restored from Docker, but its agent delivery chain could not be proven.`
      : `  Sandbox '${sandboxName}' is present, but its agent delivery chain could not be proven.`,
  );
  if (lookup.output) console.log(lookup.output);
  console.log(
    `  Retry \`${CLI_NAME} ${sandboxName} recover\` after addressing the reported layer.`,
  );
  deferSandboxLifecycleExit(1);
}

function printMissingLiveSandboxStatusGuidance({
  sandboxName,
  registered,
  lookup,
}: SandboxGatewayLookupStatusContext): void {
  console.log("");
  // A gateway NotFound cannot distinguish a deleted sandbox from a name the
  // local registry never held. Without `registered` the guidance below claims a
  // local registration that `sandbox start` and `sandbox stop` deny (#9425).
  if (!registered) {
    console.log(
      `  Sandbox '${sandboxName}' is not registered. Run '${CLI_NAME} list' to see registered sandboxes.`,
    );
    return;
  }
  console.log(
    `  Sandbox '${sandboxName}' is registered locally, but is not present in the live OpenShell gateway.`,
  );
  if (lookup.recoveredGateway) {
    const via = lookup.recoveryVia ? ` via ${lookup.recoveryVia}` : "";
    console.log(
      `  The ${CLI_DISPLAY_NAME} gateway was just recovered${via}; it may still be reconciling post-restart sandbox state.`,
    );
  }
  console.log("  No local registry entry was removed by this status check.");
  console.log(
    `  Retry \`${CLI_NAME} ${sandboxName} status\` after the gateway finishes reconnecting.`,
  );
  console.log(
    `  If the sandbox was intentionally deleted, run \`${CLI_NAME} list\` to inspect the remaining sandboxes or \`${CLI_NAME} onboard\` to create a new one.`,
  );
}

function printPresentSandboxGatewayLookupStatus({
  sandboxName,
  lookup,
  phase,
  dockerRuntime,
}: SandboxGatewayLookupStatusContext): void {
  console.log("");
  if ("recoveredGateway" in lookup && lookup.recoveredGateway) {
    console.log(
      `  Recovered ${CLI_DISPLAY_NAME} gateway runtime via ${("recoveryVia" in lookup ? lookup.recoveryVia : null) || "gateway reattach"}.`,
    );
    console.log("");
  }
  if ("recoveredSandbox" in lookup && lookup.recoveredSandbox) {
    const via =
      "recoverySandboxVia" in lookup && lookup.recoverySandboxVia
        ? ` via ${lookup.recoverySandboxVia}`
        : "";
    console.log(
      `  Recovered sandbox '${sandboxName}' from Docker${via}; OpenShell now sees it as live.`,
    );
    console.log("");
  }
  console.log(lookup.output);
  printNonReadySandboxPhaseGuidance({ sandboxName, phase, dockerRuntime });
}

function printWrongGatewayActiveLookupStatus({
  sandboxName,
  lookup,
}: SandboxGatewayLookupStatusContext): void {
  const activeGateway =
    "activeGateway" in lookup && typeof lookup.activeGateway === "string"
      ? lookup.activeGateway
      : undefined;
  console.log("");
  printWrongGatewayActiveGuidance(sandboxName, activeGateway, console.log);
  deferSandboxLifecycleExit(1);
}

function printIdentityDriftLookupStatus({
  sandboxName,
  lookup,
}: SandboxGatewayLookupStatusContext): void {
  console.log("");
  console.log(
    `  Sandbox '${sandboxName}' is recorded locally, but the gateway trust material rotated after restart.`,
  );
  if (lookup.output) {
    console.log(lookup.output);
  }
  console.log(
    "  Existing sandbox connections cannot be reattached safely after this gateway identity change.",
  );
  console.log(
    `  Recreate this sandbox with \`${CLI_NAME} onboard\` once the gateway runtime is stable.`,
  );
  deferSandboxLifecycleExit(1);
}

async function printGatewayUnreachableAfterRestartLookupStatus({
  sandboxName,
  lookup,
  effectivePreflight,
}: SandboxGatewayLookupStatusContext): Promise<void> {
  console.log("");
  await printGatewayFailureLayerHeader(sandboxName, effectivePreflight.failureLayer);
  console.log(
    `  Sandbox '${sandboxName}' may still exist, but the selected ${CLI_DISPLAY_NAME} gateway is still refusing connections after restart.`,
  );
  if (lookup.output) {
    console.log(lookup.output);
  }
  console.log(
    `  ${gatewayStartGuidance(getSandboxTargetGatewayName(sandboxName))} Check that \`openshell status\` reports the gateway healthy before reconnecting.`,
  );
  console.log(
    "  If the gateway never becomes healthy, rebuild the gateway and then recreate the affected sandbox.",
  );
  deferSandboxLifecycleExit(1);
}

async function printGatewayMissingAfterRestartLookupStatus({
  sandboxName,
  lookup,
  effectivePreflight,
}: SandboxGatewayLookupStatusContext): Promise<void> {
  console.log("");
  await printGatewayFailureLayerHeader(sandboxName, effectivePreflight.failureLayer);
  console.log(
    `  Sandbox '${sandboxName}' may still exist locally, but the ${CLI_DISPLAY_NAME} gateway is no longer configured after restart/rebuild.`,
  );
  if (lookup.output) {
    console.log(lookup.output);
  }
  console.log(`  ${gatewayStartGuidance(getSandboxTargetGatewayName(sandboxName))}`);
  console.log(
    "  If the gateway had to be rebuilt from scratch, recreate the affected sandbox afterward.",
  );
  deferSandboxLifecycleExit(1);
}

async function printUnknownGatewayLookupStatus({
  sandboxName,
  lookup,
  effectivePreflight,
}: SandboxGatewayLookupStatusContext): Promise<void> {
  console.log("");
  console.log(`  Could not verify sandbox '${sandboxName}' against the live OpenShell gateway.`);
  if (lookup.output) {
    console.log(lookup.output);
  }
  await printGatewayFailureLayerHeader(sandboxName, effectivePreflight.failureLayer);
  printSandboxGatewayStateHint(lookup, sandboxName, console.log);
  deferSandboxLifecycleExit(1);
}

function printNonReadySandboxPhaseGuidance({
  sandboxName,
  phase,
  dockerRuntime,
}: {
  sandboxName: string;
  phase: string | null;
  dockerRuntime: ReturnType<typeof getSandboxDockerRuntime> | null;
}): void {
  if (!phase || phase === "Ready") return;
  if (dockerRuntime?.containerName && !dockerRuntime.running && !dockerRuntime.paused) {
    console.log("");
    console.log(`  Sandbox '${sandboxName}' is stopped.`);
    console.log("  Workspace state is preserved.");
    console.log(`  Start it again with \`${CLI_NAME} ${sandboxName} start\`.`);
    return;
  }
  // A non-ready, non-terminal phase can mean two very different things. If
  // the Docker daemon is down, OpenShell can still return a present-but-
  // Provisioning sandbox (cached/transitional state); steering the user
  // toward rebuild is wrong because the sandbox is fine and rebuild cannot
  // succeed until Docker is back. Reclassify as a runtime outage first
  // (#4428). Terminal phases (Failed/Error/...) are settled sandbox
  // failures and keep the existing rebuild guidance even when Docker is
  // down, so a genuine failure is never masked.
  if (!isTerminalSandboxPhase(phase) && isDockerRuntimeDown(sandboxName)) {
    console.log("");
    printDockerRuntimeDownGuidance(sandboxName, { writer: console.log });
    deferSandboxLifecycleExit(1);
  }
  // A paused Docker-driver container can surface upstream as `Phase: Error`
  // (e.g. GPU passthrough on Ubuntu 24.04) even though the sandbox is
  // otherwise intact. We do not rewrite OpenShell's authoritative phase
  // (printed verbatim above); we add a paused-container recovery hint so
  // the failure mode is actionable, and skip the misleading rebuild
  // suggestion since unpausing — not recreating — is the fix. See #4495.
  // `Error` is terminal, so the #4428 runtime-down reclassification above
  // does not intercept this branch.
  if (phase === "Error" && dockerRuntime?.paused && dockerRuntime.containerName) {
    console.log("");
    console.log(
      `  The Docker-driver container for '${sandboxName}' is paused: ${dockerRuntime.containerName}`,
    );
    console.log(
      "  A paused container can report 'Phase: Error' even though the sandbox is intact.",
    );
    console.log("  Resume it to restore the running phase:");
    console.log(`    ${D}docker unpause ${dockerRuntime.containerName}${R}`);
    return;
  }
  console.log("");
  console.log(`  Sandbox '${sandboxName}' is stuck in '${phase}' phase.`);
  console.log(
    "  This usually happens when a process crash inside the sandbox prevented clean startup.",
  );
  console.log("");
  if (phase === "Error" && dockerRuntime?.containerName) {
    console.log(
      `  Run \`${CLI_NAME} ${sandboxName} start\` to restart the crashed container and recover the sandbox with workspace state preserved.`,
    );
    console.log(
      `  (\`${CLI_NAME} ${sandboxName} rebuild --yes\` recreates the sandbox instead, but its pre-rebuild backup cannot snapshot a stopped container, so start it first.)`,
    );
    return;
  }
  console.log(
    `  Run \`${CLI_NAME} ${sandboxName} rebuild --yes\` to recreate the sandbox (--yes skips the confirmation prompt; workspace state will be preserved).`,
  );
}
