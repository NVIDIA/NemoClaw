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
  await ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase: true });

  const sessionsDir = agentSessionsDir(agentId);
  const storePath = agentSessionsStorePath(agentId);

  if (!sessionKey) {
    return wipeWholeAgent(sandboxName, sessionsDir, storePath, agentId);
  }
  return removeSingleSession(sandboxName, sessionsDir, storePath, agentId, sessionKey);
}

async function wipeWholeAgent(
  sandboxName: string,
  sessionsDir: string,
  storePath: string,
  agentId: string,
): Promise<SessionsRmResult> {
  const probe = captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--",
      "sh",
      "-c",
      `test -d ${shellQuote(sessionsDir)} && echo PRESENT || echo MISSING`,
    ],
    { ignoreError: true },
  );
  if (probe.status !== 0 || !probe.output.includes("PRESENT")) {
    console.error(`  Sessions directory not found for agent '${agentId}': ${sessionsDir}`);
    console.error(NOT_FOUND_HINT);
    process.exit(1);
  }

  const script = [
    `cd ${shellQuote(sessionsDir)} || exit 1`,
    "count=$(find . -mindepth 1 -maxdepth 1 \\( -name '*.jsonl' -o -name '*.jsonl.lock' \\) -type f | wc -l | tr -d ' ')",
    "find . -mindepth 1 -maxdepth 1 \\( -name '*.jsonl' -o -name '*.jsonl.lock' \\) -type f -delete",
    `printf '%s' '{}' > ${shellQuote(storePath)}`,
    'echo "REMOVED=$count"',
  ].join("\n");

  const result = captureOpenshell(
    ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-c", script],
    { ignoreError: true },
  );
  if (result.status !== 0) {
    console.error(`  Failed to wipe sessions for agent '${agentId}':`);
    console.error(`  ${result.output}`);
    process.exit(1);
  }
  const filesRemoved = parseRemovedCount(result.output);
  console.error(
    `  Wiped agent '${agentId}' sessions directory (${filesRemoved} file${filesRemoved === 1 ? "" : "s"} removed; sessions.json reset).`,
  );
  return { scope: "agent", filesRemoved };
}

async function removeSingleSession(
  sandboxName: string,
  sessionsDir: string,
  storePath: string,
  agentId: string,
  sessionKey: string,
): Promise<SessionsRmResult> {
  const storeText = readSessionStoreText(sandboxName, storePath, agentId);
  const store: SessionStore = parseSessionStore(storeText);
  const sessionId = resolveSessionIdForKey(store, sessionKey);
  const updatedStore = { ...store };
  delete updatedStore[sessionKey];
  const updatedJson = JSON.stringify(updatedStore);

  const safeJson = updatedJson.replace(/'/g, "'\\''");
  const ownedClause = sessionOwnedFilenameFindClause(sessionId);
  const script = [
    `cd ${shellQuote(sessionsDir)} || exit 1`,
    `count=$(find . -mindepth 1 -maxdepth 1 -type f ${ownedClause} | wc -l | tr -d ' ')`,
    `find . -mindepth 1 -maxdepth 1 -type f ${ownedClause} -delete`,
    `printf '%s' '${safeJson}' > ${shellQuote(storePath)}`,
    'echo "REMOVED=$count"',
  ].join("\n");

  const result = captureOpenshell(
    ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-c", script],
    { ignoreError: true },
  );
  if (result.status !== 0) {
    console.error(
      `  Failed to remove session '${sessionKey}' (id '${sessionId}') for agent '${agentId}':`,
    );
    console.error(`  ${result.output}`);
    process.exit(1);
  }
  const filesRemoved = parseRemovedCount(result.output);
  console.error(
    `  Removed session '${sessionKey}' (id '${sessionId}') from agent '${agentId}' (${filesRemoved} file${filesRemoved === 1 ? "" : "s"} removed; sessions.json updated).`,
  );
  return {
    scope: "session",
    removedSessionKey: sessionKey,
    removedSessionId: sessionId,
    filesRemoved,
  };
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
