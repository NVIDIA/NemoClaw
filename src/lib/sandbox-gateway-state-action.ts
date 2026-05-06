// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- extracted legacy sandbox liveness paths are covered through CLI subprocess tests. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLI_DISPLAY_NAME, CLI_NAME } from "./branding";
import { parseSandboxPhase } from "./gateway-state";
import {
  getNamedGatewayLifecycleState,
  recoverNamedGatewayRuntime,
} from "./gateway-runtime-action";
const { pruneKnownHostsEntries } = require("./onboard") as {
  pruneKnownHostsEntries: (contents: string) => string;
};
import * as onboardSession from "./onboard-session";
import type { Session } from "./onboard-session";
import { stripAnsi } from "./adapters/openshell/client";
import {
  captureOpenshell,
  captureOpenshellForStatus,
  getStatusProbeTimeoutMs,
  isCommandTimeout,
  runOpenshell,
} from "./adapters/openshell/runtime";
import {
  OPENSHELL_OPERATION_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "./adapters/openshell/timeouts";
import * as registry from "./registry";

type SandboxGatewayState = {
  state: string;
  output: string;
  activeGateway?: string | null;
  recoveredGateway?: boolean;
  recoveryVia?: string | null;
  gatewayRecoveryFailed?: boolean;
};

type SandboxGatewayStateLookup = (
  sandboxName: string,
) => SandboxGatewayState | Promise<SandboxGatewayState>;

export function mergeLivePolicyIntoSandboxOutput(
  output: string,
  livePolicyOutput: string,
): string {
  const rawLines = String(output).split("\n");
  const cleanLines = stripAnsi(String(output)).split("\n");
  const policyLineIdx = cleanLines.findIndex((line: string) => line.trim() === "Policy:");
  if (policyLineIdx === -1) return output;

  const before = rawLines.slice(0, policyLineIdx + 1).join("\n");
  const delimIdx = livePolicyOutput.search(/^---\s*$/m);
  const yamlPart =
    delimIdx !== -1
      ? livePolicyOutput.slice(delimIdx).replace(/^---\s*[\r\n]+/, "")
      : livePolicyOutput;
  const trimmedYaml = yamlPart.trim();
  const looksLikeError = /^(error|failed|invalid|warning|status)\b/i.test(trimmedYaml);
  if (!trimmedYaml || looksLikeError || !/^[a-z_][a-z0-9_]*\s*:/m.test(trimmedYaml)) {
    return output;
  }

  const indented = trimmedYaml
    .split("\n")
    .map((line: string) => (line ? `  ${line}` : line))
    .join("\n");
  return `${before}\n\n${indented}\n`;
}

/** Query sandbox presence and return its output with the live enforced policy. */
export function getSandboxGatewayState(sandboxName: string): SandboxGatewayState {
  const result = captureOpenshell(["sandbox", "get", sandboxName], {
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  let output = result.output;
  if (result.status === 0) {
    const livePolicy = captureOpenshell(["policy", "get", "--full", sandboxName], {
      ignoreError: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    });
    if (livePolicy.status === 0 && livePolicy.output.trim()) {
      output = mergeLivePolicyIntoSandboxOutput(output, livePolicy.output);
    }
    return { state: "present", output };
  }
  if (/\bNotFound\b|\bNot Found\b|sandbox not found/i.test(output)) {
    return { state: "missing", output };
  }
  if (
    /transport error|Connection refused|handshake verification failed|Missing gateway auth token|device identity required/i.test(
      output,
    )
  ) {
    return { state: "gateway_error", output };
  }
  return { state: "unknown_error", output };
}

export async function getSandboxGatewayStateForStatus(
  sandboxName: string,
): Promise<SandboxGatewayState> {
  const timeoutMs = getStatusProbeTimeoutMs();
  const result = await captureOpenshellForStatus(["sandbox", "get", sandboxName], {
    timeout: timeoutMs,
  });
  let output = result.output;
  if (isCommandTimeout(result)) {
    return {
      state: "status_probe_timeout",
      output: `  Live sandbox status probe timed out after ${Math.ceil(timeoutMs / 1000)}s. Local registry data is shown above.`,
    };
  }
  if (result.status === 0) {
    const livePolicy = await captureOpenshellForStatus(["policy", "get", "--full", sandboxName], {
      ignoreError: true,
      timeout: timeoutMs,
    });
    if (!isCommandTimeout(livePolicy) && livePolicy.status === 0 && livePolicy.output.trim()) {
      output = mergeLivePolicyIntoSandboxOutput(output, livePolicy.output);
    }
    return { state: "present", output };
  }
  if (/\bNotFound\b|\bNot Found\b|sandbox not found/i.test(output)) {
    return { state: "missing", output };
  }
  if (
    /transport error|Connection refused|handshake verification failed|Missing gateway auth token|device identity required/i.test(
      output,
    )
  ) {
    return { state: "gateway_error", output };
  }
  return { state: "unknown_error", output };
}

/**
 * Reconcile a NotFound sandbox lookup against the named NemoClaw gateway state.
 * When the active OpenShell gateway has drifted off nemoclaw, a NotFound is
 * ambiguous: the sandbox may actually be registered against the nemoclaw
 * gateway but invisible because some other gateway is currently active. This
 * helper self-heals by attempting `openshell gateway select nemoclaw` and
 * re-queries, or returns a `wrong_gateway_active` state so callers can surface
 * actionable guidance instead of destroying the registry entry.
 */
export function reconcileMissingAgainstNamedGateway(
  sandboxName: string,
  missingLookup: SandboxGatewayState,
): SandboxGatewayState {
  const lifecycle = getNamedGatewayLifecycleState();
  if (lifecycle.state === "connected_other") {
    runOpenshell(["gateway", "select", "nemoclaw"], {
      ignoreError: true,
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    const retry = getSandboxGatewayState(sandboxName);
    if (retry.state === "present") {
      return { ...retry, recoveredGateway: true, recoveryVia: "select" };
    }
    if (retry.state === "missing") {
      const after = getNamedGatewayLifecycleState();
      if (after.state === "healthy_named") {
        return retry;
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
  return missingLookup;
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
): void {
  const other = activeGateway && activeGateway !== "nemoclaw" ? activeGateway : "another gateway";
  writer(
    `  Sandbox '${sandboxName}' is registered against the ${CLI_DISPLAY_NAME} gateway, but the currently active OpenShell gateway is '${other}'. Your sandbox has NOT been removed.`,
  );
  writer("  Switch gateways and retry:");
  writer("      openshell gateway select nemoclaw");
  writer(`  Then re-run: ${CLI_NAME} ${sandboxName} connect`);
}

/** Print troubleshooting hints based on gateway lifecycle state in the output. */
export function printGatewayLifecycleHint(
  output = "",
  sandboxName = "",
  writer: (message: string) => void = console.error,
): void {
  const cleanOutput = stripAnsi(output);
  if (/No gateway configured/i.test(cleanOutput)) {
    writer(
      `  The selected ${CLI_DISPLAY_NAME} gateway is no longer configured or its metadata/runtime has been lost.`,
    );
    writer(
      "  Start the gateway again with `openshell gateway start --name nemoclaw` before expecting existing sandboxes to reconnect.",
    );
    writer(
      "  If the gateway has to be rebuilt from scratch, recreate the affected sandbox afterward.",
    );
    return;
  }
  if (
    /Connection refused|client error \(Connect\)|tcp connect error/i.test(cleanOutput) &&
    /Gateway:\s+nemoclaw/i.test(cleanOutput)
  ) {
    writer(
      "  The selected NemoClaw gateway exists in metadata, but its API is refusing connections after restart.",
    );
    writer("  This usually means the gateway runtime did not come back cleanly after the restart.");
    writer(
      "  Retry `openshell gateway start --name nemoclaw`; if it stays in this state, rebuild the gateway before expecting existing sandboxes to reconnect.",
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

export async function getReconciledSandboxGatewayState(
  sandboxName: string,
  opts: { getState?: SandboxGatewayStateLookup } = {},
): Promise<SandboxGatewayState> {
  const getState = opts.getState ?? getSandboxGatewayState;
  const lookup = await getState(sandboxName);
  if (lookup.state === "present") {
    return lookup;
  }
  if (lookup.state === "missing") {
    return reconcileMissingAgainstNamedGateway(sandboxName, lookup);
  }

  if (lookup.state === "gateway_error") {
    const recovery = await recoverNamedGatewayRuntime();
    if (recovery.recovered) {
      const retried = await getState(sandboxName);
      if (retried.state === "present" || retried.state === "missing") {
        return { ...retried, recoveredGateway: true, recoveryVia: recovery.via || null };
      }
      if (/handshake verification failed/i.test(retried.output)) {
        return {
          state: "identity_drift",
          output: retried.output,
          recoveredGateway: true,
          recoveryVia: recovery.via || null,
        };
      }
      return { ...retried, recoveredGateway: true, recoveryVia: recovery.via || null };
    }
    const latestLifecycle = getNamedGatewayLifecycleState();
    const latestStatus = stripAnsi(latestLifecycle.status || "");
    if (/No gateway configured/i.test(latestStatus)) {
      return {
        state: "gateway_missing_after_restart",
        output: latestLifecycle.status || lookup.output,
      };
    }
    if (
      /Connection refused|client error \(Connect\)|tcp connect error/i.test(latestStatus) &&
      /Gateway:\s+nemoclaw/i.test(latestStatus)
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

export async function ensureLiveSandboxOrExit(
  sandboxName: string,
  { allowNonReadyPhase = false }: { allowNonReadyPhase?: boolean } = {},
): Promise<SandboxGatewayState> {
  const lookup = await getReconciledSandboxGatewayState(sandboxName);
  if (lookup.state === "present") {
    const phase = parseSandboxPhase(lookup.output || "");
    if (!allowNonReadyPhase && phase && phase !== "Ready") {
      console.error(`  Sandbox '${sandboxName}' is stuck in '${phase}' phase.`);
      console.error(
        "  This usually happens when a process crash inside the sandbox prevented clean startup.",
      );
      console.error("");
      console.error(
        `  Run \`${CLI_NAME} ${sandboxName} rebuild --yes\` to recreate the sandbox (--yes skips the confirmation prompt; workspace state will be preserved).`,
      );
      process.exit(1);
    }
    return lookup;
  }
  if (lookup.state === "missing") {
    const guard = getNamedGatewayLifecycleState();
    if (guard.state !== "healthy_named") {
      if (guard.state === "connected_other") {
        printWrongGatewayActiveGuidance(sandboxName, guard.activeGateway, console.error);
      } else {
        printGatewayLifecycleHint(guard.status || "", sandboxName, console.error);
      }
      process.exit(1);
    }
    registry.removeSandbox(sandboxName);
    const session = onboardSession.loadSession();
    if (session && session.sandboxName === sandboxName) {
      onboardSession.updateSession((state: Session) => {
        state.sandboxName = null;
        return state;
      });
    }
    console.error(`  Sandbox '${sandboxName}' is not present in the live OpenShell gateway.`);
    console.error("  Removed stale local registry entry.");
    console.error(
      `  Run \`${CLI_NAME} list\` to confirm the remaining sandboxes, or \`${CLI_NAME} onboard\` to create a new one.`,
    );
    process.exit(1);
  }
  if (lookup.state === "wrong_gateway_active") {
    printWrongGatewayActiveGuidance(sandboxName, lookup.activeGateway, console.error);
    process.exit(1);
  }
  if (lookup.state === "identity_drift") {
    console.error("  Gateway SSH identity changed after restart — clearing stale host keys...");
    const knownHostsPath = path.join(os.homedir(), ".ssh", "known_hosts");
    if (fs.existsSync(knownHostsPath)) {
      try {
        const kh = fs.readFileSync(knownHostsPath, "utf8");
        const cleaned = pruneKnownHostsEntries(kh);
        if (cleaned !== kh) fs.writeFileSync(knownHostsPath, cleaned);
      } catch {
        /* best-effort cleanup */
      }
    }
    const retry = await getReconciledSandboxGatewayState(sandboxName);
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
    process.exit(1);
  }
  if (lookup.state === "gateway_unreachable_after_restart") {
    console.error(
      `  Sandbox '${sandboxName}' may still exist, but the selected ${CLI_DISPLAY_NAME} gateway is still refusing connections after restart.`,
    );
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error(
      "  Retry `openshell gateway start --name nemoclaw` and verify `openshell status` is healthy before reconnecting.",
    );
    console.error(
      "  If the gateway never becomes healthy, rebuild the gateway and then recreate the affected sandbox.",
    );
    process.exit(1);
  }
  if (lookup.state === "gateway_missing_after_restart") {
    console.error(
      `  Sandbox '${sandboxName}' may still exist locally, but the ${CLI_DISPLAY_NAME} gateway is no longer configured after restart/rebuild.`,
    );
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error(
      "  Start the gateway again with `openshell gateway start --name nemoclaw` before retrying.",
    );
    console.error(
      "  If the gateway had to be rebuilt from scratch, recreate the affected sandbox afterward.",
    );
    process.exit(1);
  }
  console.error(`  Unable to verify sandbox '${sandboxName}' against the live OpenShell gateway.`);
  if (lookup.output) {
    console.error(lookup.output);
  }
  printGatewayLifecycleHint(lookup.output, sandboxName);
  console.error("  Check `openshell status` and the active gateway, then retry.");
  process.exit(1);
}
