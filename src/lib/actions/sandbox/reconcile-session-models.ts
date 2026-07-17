// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MANAGED_PROVIDER_ID } from "../../inference/config";
import { executeSandboxCommand } from "./process-recovery";
import type { RebuildLog } from "./rebuild-credential-preflight";
import { DEFAULT_AGENT_ID } from "./sessions/paths";

const OPENCLAW_CONFIG_PATH = "/sandbox/.openclaw/openclaw.json";

function defaultAgentSessionsPath(agentId: string): string {
  return `/sandbox/.openclaw/agents/${agentId}/sessions/sessions.json`;
}

export interface SessionModelReconcileResult {
  changed: boolean;
  content: string;
  clearedSessionKeys: string[];
}

/**
 * #7102: OpenClaw pins a `{ modelProvider, model }` on each stored session in
 * `agents/<id>/sessions/sessions.json`. `nemoclaw inference set` + `rebuild`
 * update the config default (`agents.defaults.model.primary`) but leave those
 * per-session pins on the pre-switch model, so the TUI status bar shows the old
 * model when it resumes the last session on the first connect after a switch.
 *
 * This reconciles the persisted pins: for a session whose pin is the *managed*
 * provider and no longer matches the current default, clear the pin so the
 * session falls back to the config default — matching OpenClaw's own clean-entry
 * semantics after `sessions.reset`. Sessions already on the default, and
 * sessions pinned to a different provider (an intentional per-session choice),
 * are left untouched. Pure so the contract is unit-tested without a sandbox.
 */
export function reconcilePinnedSessionModels(
  sessionsRaw: string,
  primaryModelRef: string | null,
): SessionModelReconcileResult {
  const noChange: SessionModelReconcileResult = {
    changed: false,
    content: sessionsRaw,
    clearedSessionKeys: [],
  };
  if (!primaryModelRef) return noChange;
  let parsed: unknown;
  try {
    parsed = JSON.parse(sessionsRaw);
  } catch {
    return noChange;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return noChange;
  const store = parsed as Record<string, unknown>;
  const clearedSessionKeys: string[] = [];
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const provider = record.modelProvider;
    const model = record.model;
    // Only touch pins on the managed provider; a different provider is an
    // intentional per-session choice.
    if (provider !== MANAGED_PROVIDER_ID || typeof model !== "string") continue;
    // Already following the current default → nothing to reconcile.
    if (`${provider}/${model}` === primaryModelRef) continue;
    delete record.model;
    delete record.modelProvider;
    clearedSessionKeys.push(key);
  }
  if (clearedSessionKeys.length === 0) return noChange;
  return {
    changed: true,
    content: `${JSON.stringify(store, null, 2)}\n`,
    clearedSessionKeys,
  };
}

function readPrimaryModelRef(sandboxName: string): string | null {
  const res = executeSandboxCommand(sandboxName, `cat ${OPENCLAW_CONFIG_PATH} 2>/dev/null`);
  if (!res || res.status !== 0 || !res.stdout.trim()) return null;
  try {
    const config = JSON.parse(res.stdout) as {
      agents?: { defaults?: { model?: { primary?: unknown } } };
    };
    const primary = config.agents?.defaults?.model?.primary;
    return typeof primary === "string" ? primary : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort reconcile of stale pinned session models after a rebuild restore.
 * MUST run in the post-restore window (gateway down): OpenClaw owns
 * `sessions.json` while it is live, so editing it there would race its writes.
 */
export function reconcileStalePinnedSessionModelsAfterRebuild(
  sandboxName: string,
  log: RebuildLog,
): void {
  const primary = readPrimaryModelRef(sandboxName);
  if (!primary) {
    log("Session model reconcile skipped: could not read agents.defaults.model.primary");
    return;
  }
  const sessionsPath = defaultAgentSessionsPath(DEFAULT_AGENT_ID);
  const readResult = executeSandboxCommand(sandboxName, `cat ${sessionsPath} 2>/dev/null`);
  if (!readResult || readResult.status !== 0 || !readResult.stdout.trim()) {
    log(`Session model reconcile skipped: no session store at ${sessionsPath}`);
    return;
  }
  const reconciled = reconcilePinnedSessionModels(readResult.stdout, primary);
  if (!reconciled.changed) {
    log("Session model reconcile: no stale pinned session models");
    return;
  }
  const encoded = Buffer.from(reconciled.content, "utf8").toString("base64");
  const tmpPath = `${sessionsPath}.nemoclaw-tmp`;
  const writeResult = executeSandboxCommand(
    sandboxName,
    `printf %s '${encoded}' | base64 -d > ${tmpPath} && mv ${tmpPath} ${sessionsPath}`,
  );
  if (!writeResult || writeResult.status !== 0) {
    log(
      `Session model reconcile: failed to write ${sessionsPath} (status=${writeResult?.status ?? "null"})`,
    );
    return;
  }
  log(
    `Session model reconcile: cleared stale pinned model on ${reconciled.clearedSessionKeys.length} session(s) so they follow ${primary}`,
  );
}
