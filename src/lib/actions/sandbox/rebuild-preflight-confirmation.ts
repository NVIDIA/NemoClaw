// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveOpenshell } from "../../adapters/openshell/resolve";
import * as agentRuntime from "../../agent/runtime";
import { B, D, R, YW } from "../../cli/terminal-style";
import { prompt as askPrompt } from "../../credentials/store";
import {
  normalizeRebuildSandboxOptions,
  type RebuildSandboxOptions,
} from "../../domain/lifecycle/options";
import type { DcodeAutoApprovalMode } from "../../onboard/dcode-auto-approval";
import * as sandboxVersion from "../../sandbox/version";
import { redact } from "../../security/redact";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
} from "../../state/sandbox-session";
import type { ToolDisclosure } from "../../tool-disclosure";
import { type RebuildBail, type RebuildLog } from "./rebuild-credential-preflight";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";
import { ensureRebuildUsageNoticeAccepted } from "./rebuild-usage-notice";

export type RebuildVersionCheck = ReturnType<typeof sandboxVersion.checkAgentVersion>;

export function createRebuildCommandContext(
  options: string[] | RebuildSandboxOptions,
  opts: { throwOnError?: boolean },
): {
  bail: RebuildBail;
  log: RebuildLog;
  requestedToolDisclosure: ToolDisclosure | undefined;
  requestedDcodeAutoApprovalMode: DcodeAutoApprovalMode | undefined;
  requestedObservabilityEnabled: boolean | undefined;
  skipConfirm: boolean;
} {
  const normalized = normalizeRebuildSandboxOptions(options);
  const verbose = normalized.verbose === true || process.env.NEMOCLAW_REBUILD_VERBOSE === "1";
  return {
    log: verbose
      ? (message: string) =>
          console.error(`  ${D}[rebuild ${new Date().toISOString()}] ${redact(message)}${R}`)
      : () => {},
    requestedToolDisclosure: normalized.toolDisclosure,
    requestedDcodeAutoApprovalMode: normalized.dcodeAutoApprovalMode,
    requestedObservabilityEnabled: normalized.observabilityEnabled,
    skipConfirm: normalized.yes === true || normalized.force === true,
    bail: opts.throwOnError
      ? (message: string) => {
          throw new Error(message);
        }
      : // #6376: previously discarded `message` entirely, so any bail() call
        // that raised an actionable reason (e.g. `Failed to preserve MCP
        // bridges before rebuild: Sandbox 'X' has an incomplete MCP destroy
        // transaction. Re-run the sandbox destroy command …`) exited 1 with
        // no output at all — leaving the user with the last stage's spinner
        // line and no diagnosis. Emit the reason on stderr before exit so
        // `$?`-gated automation and interactive users see WHY rebuild
        // aborted. The message can carry a wrapped lower-level error
        // (`bail("...: " + error.message)`), so route it through the same
        // `redact` boundary `log` already uses (line above) before surfacing —
        // a bailed rebuild must not be the one path that leaks a URL/token.
        // `console.error` inherits the rebuild-diagnostic formatting (leading
        // two spaces).
        (message: string, code = 1) => {
          if (message) console.error(`  ${redact(message)}`);
          process.exit(code);
        },
  };
}

export function countActiveSandboxSessionsForRebuild(sandboxName: string): number {
  const opsBinRebuild = resolveOpenshell();
  // Source boundary: active-session detection depends on host process listing
  // and the OpenShell binary being installed. A failed/unavailable detector is
  // not evidence of active sessions, and rebuild's safety preflights still run
  // before destructive work. Keep the prior fail-open prompt behavior here;
  // remove this fallback only if session detection becomes a required, typed
  // OpenShell API that can distinguish "zero sessions" from "unavailable".
  if (!opsBinRebuild) return 0;
  try {
    const result = getActiveSandboxSessions(sandboxName, createSessionDeps(opsBinRebuild));
    return result.detected ? result.sessions.length : 0;
  } catch {
    return 0;
  }
}

export function getRebuildAgentDisplayName(sandboxName: string): string {
  return agentRuntime.getAgentDisplayName(agentRuntime.getSessionAgent(sandboxName));
}

export async function confirmSandboxRebuildIfNeeded(
  skipConfirm: boolean,
  activeSessionCount: number,
  prompt: typeof askPrompt = askPrompt,
  requestedDcodeAutoApprovalMode?: DcodeAutoApprovalMode,
): Promise<boolean> {
  if (requestedDcodeAutoApprovalMode === "thread-opt-in") {
    console.log(`  ${YW}Warning: Deep Agents Code thread auto-approval will be enabled.${R}`);
    console.log(
      "  Tool calls, including shell commands, may execute without further confirmation inside OpenShell.",
    );
    console.log("");
  }
  if (skipConfirm) return true;
  if (activeSessionCount > 0) {
    const plural = activeSessionCount > 1 ? "sessions" : "session";
    console.log(
      `  ${YW}⚠  Active SSH ${plural} detected (${activeSessionCount} connection${activeSessionCount > 1 ? "s" : ""})${R}`,
    );
    console.log(
      `  Rebuilding will terminate ${activeSessionCount === 1 ? "the" : "all"} active ${plural} with a Broken pipe error.`,
    );
    console.log("");
  }
  console.log("  This will:");
  console.log("    1. Back up workspace state");
  console.log("    2. Destroy and recreate the sandbox with the current image");
  console.log("    3. Restore workspace state into the new sandbox");
  console.log("");
  const answer = await prompt("  Proceed? [y/N]: ");
  if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
    console.log("  Cancelled.");
    return false;
  }
  return true;
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

export async function confirmRebuildIntent(
  sandboxName: string,
  agentName: string,
  skipConfirm: boolean,
  activeSessionCount: number,
  bail: RebuildBail,
  requestedDcodeAutoApprovalMode?: DcodeAutoApprovalMode,
): Promise<RebuildVersionCheck | null> {
  const versionCheck = sandboxVersion.checkAgentVersion(sandboxName);
  console.log("");
  console.log(`  ${B}Rebuild sandbox '${sandboxName}'${R}`);
  if (versionCheck.sandboxVersion) {
    console.log(`    Current:  ${agentName} v${versionCheck.sandboxVersion}`);
  }
  if (versionCheck.expectedVersion) {
    console.log(`    Target:   ${agentName} v${versionCheck.expectedVersion}`);
  }
  console.log("");
  if (
    !(await confirmSandboxRebuildIfNeeded(
      skipConfirm,
      activeSessionCount,
      askPrompt,
      requestedDcodeAutoApprovalMode,
    ))
  ) {
    return null;
  }
  await ensureRebuildUsageNoticeOrBail(bail);
  return versionCheck;
}
