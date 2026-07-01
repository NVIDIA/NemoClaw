// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  detectOpenShellStateRpcPreflightIssue,
  printOpenShellStateRpcIssue,
} from "../../adapters/openshell/gateway-drift";
import { resolveOpenshell } from "../../adapters/openshell/resolve";
import * as agentRuntime from "../../agent/runtime";
import { CLI_NAME } from "../../cli/branding";
import { RD as _RD, B, D, R, YW } from "../../cli/terminal-style";
import { prompt as askPrompt } from "../../credentials/store";
import {
  normalizeRebuildSandboxOptions,
  type RebuildSandboxOptions,
} from "../../domain/lifecycle/options";
import type { SandboxMessagingPlan } from "../../messaging";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import * as sandboxVersion from "../../sandbox/version";
import { redact } from "../../security/redact";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
} from "../../state/sandbox-session";
import { type RebuildBail, type RebuildLog } from "./rebuild-credential-preflight";
import { validatedRebuildRegistryUpdate } from "./rebuild-durable-config";
import {
  ensureRebuildAgentBaseImage,
  ensureRebuildTargetGatewaySelected,
  pinRebuildAgentBaseImageForRecreate,
  type RebuildAgentBaseImagePreflight,
  type RebuildLiveState,
  type RebuildSandboxEntry,
  resolveRebuildLiveState,
} from "./rebuild-flow-helpers";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { stageMessagingManifestPlanForRebuild } from "./rebuild-messaging-phase";
import {
  hydrateMessagingConfigForRebuild,
  preflightAuthoritativeOnboardRuntime,
  preflightRebuildTargetRuntime,
  prepareRebuildRecreateOptions,
  prepareRebuildTargetConfig,
  printRebuildPreflightFailure,
  type RebuildTargetConfig,
  stageRebuildHermesDashboardConfig,
} from "./rebuild-target-preflight";
import { ensureRebuildUsageNoticeAccepted } from "./rebuild-usage-notice";

function _rebuildLog(msg: string) {
  console.error(`  ${D}[rebuild ${new Date().toISOString()}] ${redact(msg)}${R}`);
}

function countActiveSandboxSessionsForRebuild(sandboxName: string): number {
  const opsBinRebuild = resolveOpenshell();
  // Source boundary: active-session detection depends on host process listing
  // and the OpenShell binary being installed. A failed/unavailable detector is
  // not evidence of active sessions, and rebuild's safety preflights still run
  // before destructive work. Keep the prior fail-open prompt behavior here;
  // remove this fallback only if session detection becomes a required, typed
  // OpenShell API that can distinguish "zero sessions" from "unavailable".
  if (!opsBinRebuild) return 0;

  try {
    const sessionResult = getActiveSandboxSessions(sandboxName, createSessionDeps(opsBinRebuild));
    return sessionResult.detected ? sessionResult.sessions.length : 0;
  } catch {
    return 0;
  }
}

async function confirmSandboxRebuildIfNeeded(
  skipConfirm: boolean,
  rebuildActiveSessionCount: number,
): Promise<boolean> {
  if (skipConfirm) return true;

  if (rebuildActiveSessionCount > 0) {
    const plural = rebuildActiveSessionCount > 1 ? "sessions" : "session";
    console.log(
      `  ${YW}⚠  Active SSH ${plural} detected (${rebuildActiveSessionCount} connection${rebuildActiveSessionCount > 1 ? "s" : ""})${R}`,
    );
    console.log(
      `  Rebuilding will terminate ${rebuildActiveSessionCount === 1 ? "the" : "all"} active ${plural} with a Broken pipe error.`,
    );
    console.log("");
  }
  console.log("  This will:");
  console.log("    1. Back up workspace state");
  console.log("    2. Destroy and recreate the sandbox with the current image");
  console.log("    3. Restore workspace state into the new sandbox");
  console.log("");
  const answer = await askPrompt("  Proceed? [y/N]: ");
  if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
    console.log("  Cancelled.");
    return false;
  }
  return true;
}

function checkRebuildGatewaySchemaPreflight(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  bail: (msg: string, code?: number) => never,
): boolean {
  const gatewayPreflightIssue = detectOpenShellStateRpcPreflightIssue({
    gatewayName: resolveSandboxGatewayName(sb),
  });
  if (gatewayPreflightIssue) {
    printOpenShellStateRpcIssue(gatewayPreflightIssue, {
      action: `rebuilding sandbox '${sandboxName}'`,
      command: `${CLI_NAME} ${sandboxName} rebuild`,
    });
    bail("OpenShell gateway schema mismatch.");
    return false;
  }
  return true;
}

function getRebuildSandboxEntryOrBail(
  sandboxName: string,
  bail: (msg: string, code?: number) => never,
): RebuildSandboxEntry | null {
  const sb = registry.getSandbox(sandboxName) as RebuildSandboxEntry | null;
  if (!sb) {
    console.error(`  Sandbox '${sandboxName}' not found in registry.`);
    bail(`Sandbox '${sandboxName}' not found in registry.`);
    return null;
  }
  return sb;
}

function isSingleAgentRebuildSupported(
  sb: registry.SandboxEntry & { agents?: unknown[] },
  bail: (msg: string, code?: number) => never,
): boolean {
  if (sb.agents && sb.agents.length > 1) {
    console.error("  Multi-agent sandbox rebuild is not yet supported.");
    console.error(`  Back up state manually and recreate with \`${CLI_NAME} onboard\`.`);
    bail("Multi-agent sandbox rebuild is not yet supported.");
    return false;
  }
  return true;
}

async function stageRebuildMessagingPlanOrBail(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  rebuildAgent: string | null,
  log: (msg: string) => void,
  bail: (msg: string, code?: number) => never,
): Promise<SandboxMessagingPlan | null> {
  try {
    return await stageMessagingManifestPlanForRebuild(sandboxName, sb, rebuildAgent, log);
  } catch (err) {
    // Source boundary: persisted registry messaging plans and current channel
    // manifests are host-side inputs. If they drift or become invalid, rebuild
    // must fail here before backup/delete; remove this boundary only if manifest
    // staging becomes total over all persisted registry states.
    const message = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error(
      `  ${_RD}Rebuild preflight failed:${R} messaging manifest plan could not be staged.`,
    );
    console.error(`  ${message}`);
    console.error("");
    console.error("  Sandbox is untouched — no data was lost.");
    bail(message);
    return null;
  }
}

function printRebuildVersionSummary(
  sandboxName: string,
  agentName: string,
  versionCheck: ReturnType<typeof sandboxVersion.checkAgentVersion>,
): void {
  console.log("");
  console.log(`  ${B}Rebuild sandbox '${sandboxName}'${R}`);
  if (versionCheck.sandboxVersion) {
    console.log(`    Current:  ${agentName} v${versionCheck.sandboxVersion}`);
  }
  if (versionCheck.expectedVersion) {
    console.log(`    Target:   ${agentName} v${versionCheck.expectedVersion}`);
  }
  console.log("");
}

async function ensureRebuildUsageNoticeOrBail(bail: RebuildBail): Promise<void> {
  let accepted = false;
  try {
    accepted = await ensureRebuildUsageNoticeAccepted({
      stdinIsTty: process.stdin?.isTTY === true,
    });
  } catch (err) {
    printRebuildPreflightFailure(
      "the current third-party software notice could not be recorded.",
      err instanceof Error ? err.message : String(err),
      "Third-party software notice preflight failed",
      bail,
    );
  }
  if (accepted) return;
  printRebuildPreflightFailure(
    "the current third-party software notice was not accepted.",
    "Accept the current notice before rebuilding.",
    "Third-party software notice was not accepted",
    bail,
  );
}

function acquireRebuildOnboardLock(sandboxName: string, bail: RebuildBail): () => void {
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

function assertRebuildEntryUnchanged(
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

export interface RebuildPreflightPhaseResult {
  sandboxEntry: RebuildSandboxEntry;
  rebuildAgent: string | null;
  versionCheck: ReturnType<typeof sandboxVersion.checkAgentVersion>;
  targetConfig: RebuildTargetConfig;
  recreateOptions: RebuildRecreateOnboardOpts;
  messagingPlan: SandboxMessagingPlan | null;
  baseImagePreflight: RebuildAgentBaseImagePreflight;
  liveState: RebuildLiveState;
  releaseOnboardLock: () => void;
  log: RebuildLog;
  bail: RebuildBail;
}

/**
 * Validate and pin the complete recreate contract while the old sandbox remains
 * intact. The returned onboard lock stays held across every destructive phase.
 * Boundary coverage: rebuild-flow.test.ts exercises all fail-closed preflights,
 * confirmation, stale recovery, credential/image/GPU checks, and registry drift.
 */
export async function runRebuildPreflightPhase(
  sandboxName: string,
  options: string[] | RebuildSandboxOptions = {},
  opts: { throwOnError?: boolean } = {},
): Promise<RebuildPreflightPhaseResult | null> {
  const normalized = normalizeRebuildSandboxOptions(options);
  const verbose = normalized.verbose === true || process.env.NEMOCLAW_REBUILD_VERBOSE === "1";
  const log: RebuildLog = verbose ? _rebuildLog : () => {};
  const skipConfirm = normalized.yes === true || normalized.force === true;
  const bail: RebuildBail = opts.throwOnError
    ? (message: string) => {
        throw new Error(message);
      }
    : (_message: string, code = 1) => process.exit(code);

  const activeSessionCount = countActiveSandboxSessionsForRebuild(sandboxName);
  const sandboxEntry = getRebuildSandboxEntryOrBail(sandboxName, bail);
  if (!sandboxEntry) return null;
  const confirmedEntrySnapshot = JSON.stringify(sandboxEntry);
  if (!isSingleAgentRebuildSupported(sandboxEntry, bail)) return null;

  const rebuildAgent = sandboxEntry.agent || null;
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const agentName = agentRuntime.getAgentDisplayName(agent);
  if (!checkRebuildGatewaySchemaPreflight(sandboxName, sandboxEntry, bail)) return null;

  const versionCheck = sandboxVersion.checkAgentVersion(sandboxName);
  printRebuildVersionSummary(sandboxName, agentName, versionCheck);
  const confirmed = await confirmSandboxRebuildIfNeeded(skipConfirm, activeSessionCount);
  if (!confirmed) return null;
  await ensureRebuildUsageNoticeOrBail(bail);

  const releaseOnboardLock = acquireRebuildOnboardLock(sandboxName, bail);
  let retainOnboardLock = false;
  try {
    assertRebuildEntryUnchanged(sandboxName, confirmedEntrySnapshot, bail);
    hydrateMessagingConfigForRebuild(sandboxName, log);
    if (!(await ensureRebuildTargetGatewaySelected(sandboxName, sandboxEntry, log, bail))) {
      return null;
    }

    const targetConfig = prepareRebuildTargetConfig(
      sandboxName,
      sandboxEntry,
      rebuildAgent,
      log,
      bail,
    );
    if (!targetConfig) return null;
    const { resumeConfig, durableConfig, credentialEnv, fromDockerfile } = targetConfig;
    const recreateOptions = prepareRebuildRecreateOptions(
      sandboxEntry,
      rebuildAgent,
      fromDockerfile,
      skipConfirm || confirmed,
      bail,
    );
    if (!recreateOptions) return null;
    if (
      !stageRebuildHermesDashboardConfig(
        rebuildAgent,
        sandboxEntry,
        recreateOptions.controlUiPort,
        bail,
      )
    ) {
      return null;
    }
    const messagingPlan = await stageRebuildMessagingPlanOrBail(
      sandboxName,
      sandboxEntry,
      rebuildAgent,
      log,
      bail,
    );
    if (
      !(await preflightAuthoritativeOnboardRuntime(
        sandboxName,
        resumeConfig,
        recreateOptions,
        bail,
      ))
    ) {
      return null;
    }
    if (!(await ensureRebuildTargetGatewaySelected(sandboxName, sandboxEntry, log, bail))) {
      return null;
    }
    if (!checkRebuildGatewaySchemaPreflight(sandboxName, sandboxEntry, bail)) return null;

    const baseImagePreflight = ensureRebuildAgentBaseImage(rebuildAgent, bail);
    if (!baseImagePreflight.ok) return null;
    const restoreBaseImageOverride = pinRebuildAgentBaseImageForRecreate(baseImagePreflight);
    let targetRuntimeReady = false;
    try {
      targetRuntimeReady = await preflightRebuildTargetRuntime(
        targetConfig,
        sandboxEntry,
        recreateOptions,
        log,
        bail,
      );
    } finally {
      restoreBaseImageOverride();
    }
    if (!targetRuntimeReady) return null;

    const validatedRegistryUpdate = validatedRebuildRegistryUpdate(
      resumeConfig,
      durableConfig,
      fromDockerfile,
      credentialEnv,
    );
    if (!registry.updateSandbox(sandboxName, validatedRegistryUpdate)) {
      bail("Sandbox registry entry disappeared during rebuild preflight");
      return null;
    }
    Object.assign(sandboxEntry, validatedRegistryUpdate);

    const liveState = await resolveRebuildLiveState(sandboxName, sandboxEntry, log, bail);
    if (!liveState) return null;
    retainOnboardLock = true;
    return {
      sandboxEntry,
      rebuildAgent,
      versionCheck,
      targetConfig,
      recreateOptions,
      messagingPlan,
      baseImagePreflight,
      liveState,
      releaseOnboardLock,
      log,
      bail,
    };
  } finally {
    if (!retainOnboardLock) {
      process.removeListener("exit", releaseOnboardLock);
      releaseOnboardLock();
    }
  }
}
