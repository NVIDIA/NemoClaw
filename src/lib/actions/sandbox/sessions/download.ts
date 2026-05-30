// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { CLI_NAME } from "../../../cli/branding";
import { captureOpenshell, runOpenshell } from "../../../adapters/openshell/runtime";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import {
  agentSessionsDir,
  agentSessionsStorePath,
  sessionOwnedFilenameFindClause,
  validateAgentId,
  validateSessionKey,
} from "./paths";
import { parseSessionStore, resolveSessionIdForKey } from "./store";

export interface SessionsDownloadOptions {
  agent: string;
  sessionKey?: string;
  out?: string;
}

export interface SessionsDownloadResult {
  scope: "agent" | "session";
  out: string;
  filesDownloaded: number;
}

export async function downloadSandboxSessions(
  sandboxName: string,
  opts: SessionsDownloadOptions,
): Promise<SessionsDownloadResult> {
  const agentId = validateAgentId(opts.agent);
  const sessionKey = opts.sessionKey ? validateSessionKey(opts.sessionKey) : undefined;
  await ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase: true });

  const sessionsDir = agentSessionsDir(agentId);
  const defaultOut = path.resolve(
    process.cwd(),
    `sessions-${sandboxName}`,
    `agent-${agentId}`,
  );
  const outDir = opts.out ? path.resolve(opts.out) : defaultOut;
  fs.mkdirSync(outDir, { recursive: true });

  if (!sessionKey) {
    return downloadWholeAgent(sandboxName, sessionsDir, outDir, agentId);
  }
  return downloadSingleSession(sandboxName, sessionsDir, outDir, agentId, sessionKey);
}

async function downloadWholeAgent(
  sandboxName: string,
  sessionsDir: string,
  outDir: string,
  agentId: string,
): Promise<SessionsDownloadResult> {
  const probe = captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--",
      "sh",
      "-c",
      `if [ -d ${shellQuote(sessionsDir)} ]; then find ${shellQuote(sessionsDir)} -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' '; else echo MISSING; fi`,
    ],
    { ignoreError: true },
  );
  if (probe.status !== 0 || probe.output === "MISSING") {
    console.error(`  Sessions directory not found for agent '${agentId}': ${sessionsDir}`);
    console.error(
      `  Did the agent ever start in this sandbox? Try \`${CLI_NAME} <sandbox> sessions list\`.`,
    );
    process.exit(1);
  }

  runOpenshell(["sandbox", "download", sandboxName, `${sessionsDir}/`, outDir]);
  const filesDownloaded = countLocalFilesShallow(outDir);
  console.error(
    `  Downloaded agent '${agentId}' sessions to ${outDir} (${filesDownloaded} file${filesDownloaded === 1 ? "" : "s"}).`,
  );
  return { scope: "agent", out: outDir, filesDownloaded };
}

async function downloadSingleSession(
  sandboxName: string,
  sessionsDir: string,
  outDir: string,
  agentId: string,
  sessionKey: string,
): Promise<SessionsDownloadResult> {
  const storeText = readSessionStoreText(sandboxName, agentId);
  const store = parseSessionStore(storeText);
  const sessionId = resolveSessionIdForKey(store, sessionKey);

  const ownedClause = sessionOwnedFilenameFindClause(sessionId);
  const listResult = captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--",
      "sh",
      "-c",
      `cd ${shellQuote(sessionsDir)} 2>/dev/null && find . -mindepth 1 -maxdepth 1 -type f ${ownedClause} | sed 's|^\\./||'`,
    ],
    { ignoreError: true },
  );
  if (listResult.status !== 0) {
    console.error(
      `  Failed to list session files for '${sessionKey}' (id '${sessionId}'): exit ${listResult.status}`,
    );
    process.exit(1);
  }
  const files = listResult.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (files.length === 0) {
    console.error(
      `  No files found on disk for session '${sessionKey}' (id '${sessionId}') under ${sessionsDir}.`,
    );
    console.error("  The store entry may be orphaned; try `sessions cleanup --fix-missing`.");
    process.exit(1);
  }

  for (const fileName of files) {
    runOpenshell([
      "sandbox",
      "download",
      sandboxName,
      `${sessionsDir}/${fileName}`,
      `${outDir}/`,
    ]);
  }
  console.error(
    `  Downloaded session '${sessionKey}' (id '${sessionId}') to ${outDir} (${files.length} file${files.length === 1 ? "" : "s"}).`,
  );
  return { scope: "session", out: outDir, filesDownloaded: files.length };
}

function readSessionStoreText(sandboxName: string, agentId: string): string {
  const storePath = agentSessionsStorePath(agentId);
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
    process.exit(1);
  }
  return result.output;
}

function countLocalFilesShallow(dir: string): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
