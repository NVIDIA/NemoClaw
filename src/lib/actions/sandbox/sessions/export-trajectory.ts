// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { CLI_NAME } from "../../../cli/branding";
import { captureOpenshell, runOpenshell } from "../../../adapters/openshell/runtime";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import { validateAgentId, validateSessionKey } from "./paths";

export interface SessionsExportTrajectoryOptions {
  agent: string;
  sessionKey: string;
  output?: string;
  workspace?: string;
  saveHost?: string;
  json?: boolean;
}

export interface TrajectoryExportSummary {
  outputDir: string;
  displayPath: string;
  sessionId: string;
  eventCount: number;
  runtimeEventCount: number;
  transcriptEventCount: number;
  files: string[];
}

export interface SessionsExportTrajectoryResult {
  summary: TrajectoryExportSummary;
  hostOut?: string;
}

export async function exportSandboxSessionTrajectory(
  sandboxName: string,
  opts: SessionsExportTrajectoryOptions,
): Promise<SessionsExportTrajectoryResult> {
  const agentId = validateAgentId(opts.agent);
  const sessionKey = validateSessionKey(opts.sessionKey);
  const saveHost = opts.saveHost ? path.resolve(opts.saveHost) : undefined;
  if (saveHost) fs.mkdirSync(saveHost, { recursive: true });

  await ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase: true });

  const execArgs = [
    "sandbox",
    "exec",
    "--name",
    sandboxName,
    "--",
    "openclaw",
    "sessions",
    "export-trajectory",
    "--agent",
    agentId,
    "--session-key",
    sessionKey,
    "--json",
  ];
  if (opts.output) execArgs.push("--output", opts.output);
  if (opts.workspace) execArgs.push("--workspace", opts.workspace);

  const result = captureOpenshell(execArgs, { ignoreError: true });
  if (result.status !== 0) {
    console.error(
      `  Failed to export trajectory for '${sessionKey}' on agent '${agentId}': exit ${result.status}`,
    );
    if (result.output.trim()) console.error(`  ${result.output.trim()}`);
    console.error(
      `  Verify the sandbox is healthy: \`${CLI_NAME} ${sandboxName} status\`.`,
    );
    process.exit(1);
  }
  const summary = parseTrajectoryExportSummary(result.output);
  if (!summary) {
    console.error(
      `  Could not parse trajectory export summary for '${sessionKey}'.`,
    );
    if (result.output.trim()) console.error(`  ${result.output.trim()}`);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(summary));
  } else {
    console.error(
      `  Exported trajectory for '${sessionKey}' (id '${summary.sessionId}'): ${summary.eventCount} events across ${summary.files.length} file(s).`,
    );
    console.error(`  Bundle (in sandbox): ${summary.displayPath || summary.outputDir}`);
  }

  if (!saveHost) {
    return { summary };
  }

  const remoteSource = ensureTrailingSlash(summary.outputDir);
  runOpenshell(["sandbox", "download", sandboxName, remoteSource, saveHost]);
  if (!opts.json) {
    console.error(`  Bundle copied to host: ${saveHost}`);
  }
  return { summary, hostOut: saveHost };
}

function parseTrajectoryExportSummary(output: string): TrajectoryExportSummary | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const candidates = trimmed.split(/\r?\n/).reverse();
  for (const line of candidates) {
    const stripped = line.trim();
    if (!stripped.startsWith("{") || !stripped.endsWith("}")) continue;
    const parsed = tryParseTrajectoryExportSummary(stripped);
    if (parsed) return parsed;
  }
  return tryParseTrajectoryExportSummary(trimmed);
}

function tryParseTrajectoryExportSummary(text: string): TrajectoryExportSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const outputDir = typeof obj.outputDir === "string" ? obj.outputDir : null;
  const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : null;
  if (!outputDir || !sessionId) return null;
  const files = Array.isArray(obj.files)
    ? obj.files.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    outputDir,
    displayPath: typeof obj.displayPath === "string" ? obj.displayPath : "",
    sessionId,
    eventCount: typeof obj.eventCount === "number" ? obj.eventCount : 0,
    runtimeEventCount: typeof obj.runtimeEventCount === "number" ? obj.runtimeEventCount : 0,
    transcriptEventCount:
      typeof obj.transcriptEventCount === "number" ? obj.transcriptEventCount : 0,
    files,
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
