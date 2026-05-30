// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../../cli/branding";
import { captureOpenshell } from "../../../adapters/openshell/runtime";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import {
  agentSessionsDir,
  agentSessionsStorePath,
  sessionOwnedFilenameFindClause,
  validateAgentId,
  validateSessionKey,
} from "./paths";
import {
  parseSessionStore,
  resolveSessionIdForKey,
  type SessionStore,
} from "./store";

export interface SessionsRmOptions {
  agent: string;
  sessionKey?: string;
  force?: boolean;
}

export interface SessionsRmResult {
  scope: "agent" | "session";
  removedSessionId?: string;
  removedSessionKey?: string;
  filesRemoved: number;
}

const NOT_FOUND_HINT = `  Did the agent ever start in this sandbox? Try \`${CLI_NAME} <sandbox> sessions list\`.`;

export async function rmSandboxSessions(
  sandboxName: string,
  opts: SessionsRmOptions,
): Promise<SessionsRmResult> {
  const agentId = validateAgentId(opts.agent);
  const sessionKey = opts.sessionKey ? validateSessionKey(opts.sessionKey) : undefined;
  const force = opts.force === true;
  await ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase: true });

  const sessionsDir = agentSessionsDir(agentId);
  const storePath = agentSessionsStorePath(agentId);

  if (!sessionKey) {
    return wipeWholeAgent(sandboxName, sessionsDir, storePath, agentId, force);
  }
  return removeSingleSession(sandboxName, sessionsDir, storePath, agentId, sessionKey, force);
}

async function wipeWholeAgent(
  sandboxName: string,
  sessionsDir: string,
  storePath: string,
  agentId: string,
  force: boolean,
): Promise<SessionsRmResult> {
  const lockGuard = force
    ? "locks=0"
    : [
        "locks=$(find . -mindepth 1 -maxdepth 1 -type f -name '*.jsonl.lock' | wc -l | tr -d ' ')",
        'if [ "$locks" -gt 0 ]; then printf "REFUSE_LOCKS=%s\\n" "$locks"; exit 2; fi',
      ].join("\n");
  const lockReport = force
    ? "forced_locks=$(find . -mindepth 1 -maxdepth 1 -type f -name '*.jsonl.lock' | wc -l | tr -d ' ')"
    : "forced_locks=0";

  const script = [
    `if [ ! -d ${shellQuote(sessionsDir)} ]; then echo MISSING; exit 0; fi`,
    `cd ${shellQuote(sessionsDir)} || exit 1`,
    lockGuard,
    lockReport,
    "count=$(find . -mindepth 1 -maxdepth 1 \\( -name '*.jsonl' -o -name '*.jsonl.lock' \\) -type f | wc -l | tr -d ' ')",
    "find . -mindepth 1 -maxdepth 1 \\( -name '*.jsonl' -o -name '*.jsonl.lock' \\) -type f -delete",
    `printf '%s' '{}' > ${shellQuote(storePath)}`,
    'printf "REMOVED=%s\\nFORCED_LOCKS=%s\\n" "$count" "$forced_locks"',
  ].join("\n");

  const result = captureOpenshell(
    ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-c", script],
    { ignoreError: true },
  );

  if (result.output.includes("MISSING")) {
    console.error(`  Sessions directory not found for agent '${agentId}': ${sessionsDir}`);
    console.error(NOT_FOUND_HINT);
    process.exit(1);
  }
  const refuseLocks = parseRefuseLocks(result.output);
  if (refuseLocks !== null) {
    failOnActiveLocks(agentId, refuseLocks, sessionsDir);
  }
  if (result.status !== 0) {
    console.error(`  Failed to wipe sessions for agent '${agentId}':`);
    console.error(`  ${result.output}`);
    process.exit(1);
  }
  const filesRemoved = parseRemovedCount(result.output);
  const forcedLocks = parseForcedLocks(result.output);
  const forcedSuffix =
    forcedLocks > 0 ? ` Forced past ${forcedLocks} active write lock(s).` : "";
  console.error(
    `  Wiped agent '${agentId}' sessions directory (${filesRemoved} file${filesRemoved === 1 ? "" : "s"} removed; sessions.json reset).${forcedSuffix}`,
  );
  return { scope: "agent", filesRemoved };
}

async function removeSingleSession(
  sandboxName: string,
  sessionsDir: string,
  storePath: string,
  agentId: string,
  sessionKey: string,
  force: boolean,
): Promise<SessionsRmResult> {
  const storeText = readSessionStoreText(sandboxName, storePath, agentId);
  const store: SessionStore = parseSessionStore(storeText);
  const sessionId = resolveSessionIdForKey(store, sessionKey);
  const updatedStore = { ...store };
  delete updatedStore[sessionKey];
  const updatedJson = JSON.stringify(updatedStore);
  const safeJson = updatedJson.replace(/'/g, "'\\''");
  const ownedClause = sessionOwnedFilenameFindClause(sessionId);
  const lockFile = `${sessionId}.jsonl.lock`;

  const lockGuard = force
    ? "locked=0"
    : [
        `if [ -e ${shellQuote(lockFile)} ]; then printf "REFUSE_LOCKS=1\\n"; exit 2; fi`,
        "locked=0",
      ].join("\n");
  const lockReport = force
    ? `if [ -e ${shellQuote(lockFile)} ]; then forced_locks=1; else forced_locks=0; fi`
    : "forced_locks=0";

  const script = [
    `cd ${shellQuote(sessionsDir)} || exit 1`,
    lockGuard,
    lockReport,
    `count=$(find . -mindepth 1 -maxdepth 1 -type f ${ownedClause} | wc -l | tr -d ' ')`,
    `find . -mindepth 1 -maxdepth 1 -type f ${ownedClause} -delete`,
    `printf '%s' '${safeJson}' > ${shellQuote(storePath)}`,
    'printf "REMOVED=%s\\nFORCED_LOCKS=%s\\n" "$count" "$forced_locks"',
  ].join("\n");

  const result = captureOpenshell(
    ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-c", script],
    { ignoreError: true },
  );

  const refuseLocks = parseRefuseLocks(result.output);
  if (refuseLocks !== null) {
    failOnActiveLocks(agentId, refuseLocks, sessionsDir, sessionKey, sessionId);
  }
  if (result.status !== 0) {
    console.error(
      `  Failed to remove session '${sessionKey}' (id '${sessionId}') for agent '${agentId}':`,
    );
    console.error(`  ${result.output}`);
    process.exit(1);
  }
  const filesRemoved = parseRemovedCount(result.output);
  const forcedLocks = parseForcedLocks(result.output);
  const forcedSuffix = forcedLocks > 0 ? " Forced past active write lock." : "";
  console.error(
    `  Removed session '${sessionKey}' (id '${sessionId}') from agent '${agentId}' (${filesRemoved} file${filesRemoved === 1 ? "" : "s"} removed; sessions.json updated).${forcedSuffix}`,
  );
  void lockReport;
  return {
    scope: "session",
    removedSessionKey: sessionKey,
    removedSessionId: sessionId,
    filesRemoved,
  };
}

function failOnActiveLocks(
  agentId: string,
  lockCount: number,
  sessionsDir: string,
  sessionKey?: string,
  sessionId?: string,
): never {
  const scope = sessionKey ? `session '${sessionKey}' (id '${sessionId}')` : `agent '${agentId}'`;
  console.error(
    `  Refusing to remove ${scope}: ${lockCount} active write lock(s) (\`*.jsonl.lock\`) present under ${sessionsDir}.`,
  );
  console.error(
    `  The OpenClaw gateway is likely mid-write. Stop the agent (e.g. \`${CLI_NAME} <sandbox> recover\` or restart the gateway), then retry.`,
  );
  console.error(
    "  If you are sure the lock is stale (e.g. after a crashed gateway), re-run with --force to override.",
  );
  process.exit(1);
}

function readSessionStoreText(sandboxName: string, storePath: string, agentId: string): string {
  const result = captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--",
      "sh",
      "-c",
      `if [ -s ${shellQuote(storePath)} ]; then cat ${shellQuote(storePath)}; else echo '{}'; fi`,
    ],
    { ignoreError: true },
  );
  if (result.status !== 0) {
    console.error(
      `  Failed to read sessions store for agent '${agentId}': ${result.output || `exit ${result.status}`}`,
    );
    console.error(NOT_FOUND_HINT);
    process.exit(1);
  }
  return result.output;
}

function parseRemovedCount(output: string): number {
  const match = /REMOVED=(\d+)/.exec(output);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function parseRefuseLocks(output: string): number | null {
  const match = /REFUSE_LOCKS=(\d+)/.exec(output);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseForcedLocks(output: string): number {
  const match = /FORCED_LOCKS=(\d+)/.exec(output);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
