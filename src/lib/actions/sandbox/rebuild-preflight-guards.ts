// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  detectOpenShellStateRpcPreflightIssue,
  printOpenShellStateRpcIssue,
} from "../../adapters/openshell/gateway-drift";
import { CLI_NAME } from "../../cli/branding";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import type { RebuildBail } from "./rebuild-credential-preflight";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import type { RebuildVersionCheck } from "./rebuild-preflight-confirmation";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";

export function checkRebuildGatewaySchemaPreflight(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  bail: RebuildBail,
): boolean {
  const issue = detectOpenShellStateRpcPreflightIssue({
    gatewayName: resolveSandboxGatewayName(sb),
  });
  if (issue) {
    printOpenShellStateRpcIssue(issue, {
      action: `rebuilding sandbox '${sandboxName}'`,
      command: `${CLI_NAME} ${sandboxName} rebuild`,
    });
    bail("OpenShell gateway schema mismatch.");
    return false;
  }
  return true;
}

export async function runRebuildGatewayIntentPreflight<T>(options: {
  checkGatewaySchema: () => boolean;
  confirmIntent: () => Promise<T | null>;
}): Promise<T | null> {
  if (!options.checkGatewaySchema()) return null;
  return options.confirmIntent();
}

export function getRebuildSandboxEntryOrBail(
  sandboxName: string,
  bail: RebuildBail,
): RebuildSandboxEntry | null {
  const sb = registry.getSandbox(sandboxName) as RebuildSandboxEntry | null;
  if (!sb) {
    console.error(`  Sandbox '${sandboxName}' not found in registry.`);
    bail(`Sandbox '${sandboxName}' not found in registry.`);
    return null;
  }
  return sb;
}

export function isSingleAgentRebuildSupported(
  sb: registry.SandboxEntry & { agents?: unknown[] },
  bail: RebuildBail,
): boolean {
  if (sb.agents && sb.agents.length > 1) {
    console.error("  Multi-agent sandbox rebuild is not yet supported.");
    console.error(`  Back up state manually and recreate with \`${CLI_NAME} onboard\`.`);
    bail("Multi-agent sandbox rebuild is not yet supported.");
    return false;
  }
  return true;
}

export function acquireRebuildOnboardLock(sandboxName: string, bail: RebuildBail): () => void {
  const lock = onboardSession.acquireOnboardLock(
    `${CLI_NAME} ${sandboxName} rebuild --authoritative-resume`,
  );
  if (!lock.acquired) {
    console.error(`  Another ${CLI_NAME} onboarding run is already in progress.`);
    if (lock.holderPid) console.error(`  Lock holder PID: ${lock.holderPid}`);
    console.error("  Sandbox is untouched — no data was lost.");
    bail("Could not acquire onboard lock before rebuild");
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    onboardSession.releaseOnboardLock();
  };
  process.once("exit", release);
  return release;
}

/**
 * Derive the only registry transition rebuild itself can cause before locking.
 * Keep the pre-confirmation entry intact except for a successful live probe's
 * agent-version cache write, so every concurrent recreate/config change still
 * fails the exact locked-entry comparison below.
 */
export function expectedRebuildEntryAfterVersionCheck(
  confirmedEntry: RebuildSandboxEntry,
  confirmedEntrySnapshot: string,
  versionCheck: RebuildVersionCheck,
): RebuildSandboxEntry {
  if (versionCheck.detectionMethod !== "ssh-exec" || versionCheck.sandboxVersion === null) {
    return confirmedEntry;
  }
  const expectedEntry = JSON.parse(confirmedEntrySnapshot) as RebuildSandboxEntry;
  expectedEntry.agentVersion = versionCheck.sandboxVersion;
  return expectedEntry;
}

export function assertRebuildEntryUnchanged(
  sandboxName: string,
  confirmedEntrySnapshot: string,
  bail: RebuildBail,
): void {
  const lockedEntry = registry.getSandbox(sandboxName);
  if (lockedEntry && JSON.stringify(lockedEntry) === confirmedEntrySnapshot) return;
  printRebuildPreflightFailure(
    "the sandbox configuration changed while rebuild confirmation was pending.",
    "Review the current sandbox state and rerun rebuild.",
    "Sandbox configuration changed before rebuild lock acquisition",
    bail,
  );
}
