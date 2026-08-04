// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GATEWAY_PORT } from "../core/ports";
import { rejectSymlinksOnPath } from "../state/config-io";
import { nemoclawStateRoot } from "../state/state-root";
import { redactSandboxCreateFailureOutput } from "./created-sandbox-failure";

const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_RELEVANT_LOG_LINES = 120;
const MAX_GATEWAY_TAIL_LINES = 240;
const MAX_CREATE_OUTPUT_LINES = 240;
const MAX_CREATE_OUTPUT_CHARS = 32_000;
const MAX_FAILURE_EXCERPT_LINES = 8;
const TRUNCATED_OUTPUT_MARKER = "[diagnostic truncated; showing final output]";

export type SandboxCreateFailureDiagnostics = {
  dir: string;
  gatewayLogPath: string | null;
  sandboxId: string | null;
  stateDir: string | null;
  consoleOutput: string | null;
  copiedConsoleOutput: string | null;
  gatewayTailPath: string | null;
  createOutputPath: string | null;
  backupPath: string | null;
  summaryLines: string[];
};

export type SandboxCreateFailureDiagnosticOptions = {
  homeDir?: string;
  gatewayLogPath?: string | null;
  homebrewPrefix?: string | null;
  createOutput?: string | null;
  backupPath?: string | null;
  now?: Date;
};

function stripAnsi(value: string): string {
  return String(value || "").replace(ANSI_RE, "");
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "sandbox";
}

function timestampForPath(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function gatewayLogCandidates(homeDir: string, homebrewPrefix?: string | null): string[] {
  const candidates = [
    path.join(
      homeDir,
      ".local",
      "state",
      "nemoclaw",
      "openshell-docker-gateway",
      "openshell-gateway.log",
    ),
    path.join(homeDir, ".local", "state", "openshell", "openshell-gateway.log"),
  ];
  const homebrewPrefixes = [
    homebrewPrefix,
    process.env.HOMEBREW_PREFIX,
    "/opt/homebrew",
    "/usr/local",
  ].filter((prefix): prefix is string => Boolean(prefix) && path.isAbsolute(prefix as string));
  for (const prefix of new Set(homebrewPrefixes)) {
    candidates.push(
      path.join(prefix, "var", "log", "openshell", "openshell-gateway.err.log"),
      path.join(prefix, "var", "log", "openshell", "openshell-gateway.out.log"),
    );
  }
  return candidates;
}

function latestGatewayLogPath(candidates: string[]): string | null {
  let latest: { path: string; modified: number } | null = null;
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      if (latest === null || stat.mtimeMs > latest.modified) {
        latest = { path: candidate, modified: stat.mtimeMs };
      }
    } catch {
      // Continue to the next known log location.
    }
  }
  return latest?.path ?? null;
}

function readLogLines(filePath: string): string[] | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return redactSandboxCreateFailureOutput(stripAnsi(fs.readFileSync(filePath, "utf-8"))).split(
      /\r?\n/,
    );
  } catch {
    return null;
  }
}

function createOutputTail(value: string | null | undefined): string[] {
  const redacted = redactSandboxCreateFailureOutput(stripAnsi(value ?? "")).trim();
  if (!redacted) return [];
  const wasTruncated = redacted.length > MAX_CREATE_OUTPUT_CHARS;
  const lines = (wasTruncated ? redacted.slice(-MAX_CREATE_OUTPUT_CHARS) : redacted)
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (!wasTruncated) return lines.slice(-MAX_CREATE_OUTPUT_LINES);
  return [TRUNCATED_OUTPUT_MARKER, ...lines.slice(-(MAX_CREATE_OUTPUT_LINES - 1))];
}

function extractField(line: string, field: string): string | null {
  const match = line.match(new RegExp(`${field}=([^\\s]+)`));
  return match?.[1] ?? null;
}

function findLatestSandboxBlock(lines: string[], sandboxName: string): string[] {
  let startIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] || "";
    if (line.includes("create_sandbox received") && line.includes(`sandbox_name=${sandboxName}`)) {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) return lines.slice(-MAX_RELEVANT_LOG_LINES);

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i] || "";
    if (line.includes("DeleteSandbox") && line.includes(`sandbox_name=${sandboxName}`)) {
      endIndex = i + 1;
      break;
    }
  }
  return lines.slice(startIndex, endIndex);
}

function getLatestSandboxId(block: string[], sandboxName: string): string | null {
  for (const line of block) {
    if (!line.includes(`sandbox_name=${sandboxName}`)) continue;
    const field = extractField(line, "sandbox_id");
    if (field && UUID_RE.test(field)) return field;
  }
  return null;
}

function filterRelevantLines(
  block: string[],
  sandboxName: string,
  sandboxId: string | null,
): string[] {
  const relevant = block.filter((line) => {
    if (!line.trim()) return false;
    if (line.includes(`sandbox_name=${sandboxName}`)) return true;
    if (sandboxId && line.includes(`sandbox_id=${sandboxId}`)) return true;
    return /\bERROR\b|failed to (?:build|solve)|VmCreate|ProcessExited|console_output=|state_dir=/i.test(
      line,
    );
  });
  return relevant.slice(-MAX_RELEVANT_LOG_LINES);
}

function latestFieldValue(lines: string[], field: string): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const value = extractField(lines[i] || "", field);
    if (value) return value;
  }
  return null;
}

function copyFileIfPresent(src: string | null, dst: string): string | null {
  if (!src) return null;
  try {
    if (!fs.existsSync(src)) return null;
    fs.copyFileSync(src, dst);
    return dst;
  } catch {
    return null;
  }
}

function listStateDir(stateDir: string | null): string[] {
  if (!stateDir) return [];
  try {
    if (!fs.existsSync(stateDir)) return [];
    return fs.readdirSync(stateDir, { withFileTypes: true }).map((entry) => {
      const suffix = entry.isDirectory() ? "/" : "";
      return `${entry.name}${suffix}`;
    });
  } catch {
    return [];
  }
}

export function collectSandboxCreateFailureDiagnostics(
  sandboxName: string,
  options: SandboxCreateFailureDiagnosticOptions = {},
): SandboxCreateFailureDiagnostics | null {
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? new Date();
  const dir = path.join(
    nemoclawStateRoot(homeDir, GATEWAY_PORT),
    "onboard-failures",
    `${timestampForPath(now)}-${sanitizePathPart(sandboxName)}`,
  );

  try {
    rejectSymlinksOnPath(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    rejectSymlinksOnPath(dir);
  } catch {
    return null;
  }

  const gatewayLogPath =
    options.gatewayLogPath ??
    latestGatewayLogPath(gatewayLogCandidates(homeDir, options.homebrewPrefix));
  const rawLines = gatewayLogPath ? readLogLines(gatewayLogPath) : null;
  const block = rawLines ? findLatestSandboxBlock(rawLines, sandboxName) : [];
  const sandboxId = getLatestSandboxId(block, sandboxName);
  const relevantLines = filterRelevantLines(block, sandboxName, sandboxId);
  const gatewayTailLines =
    rawLines && relevantLines.length === 0
      ? rawLines.filter((line) => line.trim()).slice(-MAX_GATEWAY_TAIL_LINES)
      : [];
  const stateDir = latestFieldValue(relevantLines, "state_dir");
  const consoleOutput =
    latestFieldValue(relevantLines, "console_output") ??
    (stateDir ? path.join(stateDir, "rootfs-console.log") : null);
  const copiedConsoleOutput = copyFileIfPresent(
    consoleOutput,
    path.join(dir, "rootfs-console.log"),
  );
  const stateEntries = listStateDir(stateDir);
  const backupPath = options.backupPath ?? null;
  const createOutputLines = createOutputTail(options.createOutput);
  const createOutputPath =
    createOutputLines.length > 0 ? path.join(dir, "sandbox-create-output.log") : null;

  if (createOutputPath) {
    fs.writeFileSync(createOutputPath, `${createOutputLines.join("\n")}\n`, { mode: 0o600 });
  }

  if (relevantLines.length > 0) {
    fs.writeFileSync(
      path.join(dir, "openshell-gateway-relevant.log"),
      `${relevantLines.join("\n")}\n`,
      {
        mode: 0o600,
      },
    );
  }
  const gatewayTailPath =
    gatewayTailLines.length > 0 ? path.join(dir, "openshell-gateway-tail.log") : null;
  if (gatewayTailPath) {
    fs.writeFileSync(gatewayTailPath, `${gatewayTailLines.join("\n")}\n`, { mode: 0o600 });
  }
  const summaryLines = [
    `created_at=${now.toISOString()}`,
    `sandbox_name=${sandboxName}`,
    `sandbox_id=${sandboxId ?? "unknown"}`,
    `gateway_log=${gatewayLogPath ?? "not-found"}`,
    `gateway_tail=${gatewayTailPath ?? "not-written"}`,
    `create_output=${createOutputPath ?? "not-written"}`,
    `state_dir=${stateDir ?? "unknown"}`,
    `console_output=${consoleOutput ?? "unknown"}`,
    `copied_console_output=${copiedConsoleOutput ?? "not-copied"}`,
    `backup_path=${backupPath ?? "none"}`,
  ];
  const failureExcerpt = (
    createOutputLines.length > 0
      ? createOutputLines
      : relevantLines.length > 0
        ? relevantLines
        : gatewayTailLines
  ).slice(-MAX_FAILURE_EXCERPT_LINES);
  if (failureExcerpt.length > 0) {
    summaryLines.push("failure_excerpt:");
    summaryLines.push(...failureExcerpt.map((line) => `  ${line}`));
  }
  if (stateEntries.length > 0) {
    summaryLines.push("state_dir_entries:");
    summaryLines.push(...stateEntries.map((entry) => `  ${entry}`));
  }
  fs.writeFileSync(path.join(dir, "summary.txt"), `${summaryLines.join("\n")}\n`, {
    mode: 0o600,
  });

  return {
    dir,
    gatewayLogPath,
    sandboxId,
    stateDir,
    consoleOutput,
    copiedConsoleOutput,
    gatewayTailPath,
    createOutputPath,
    backupPath,
    summaryLines: failureExcerpt,
  };
}

export function printSandboxCreateFailureDiagnostics(
  sandboxName: string,
  options: SandboxCreateFailureDiagnosticOptions = {},
): SandboxCreateFailureDiagnostics | null {
  const diagnostics = collectSandboxCreateFailureDiagnostics(sandboxName, options);
  if (!diagnostics) return null;

  console.error(`  Diagnostics saved: ${diagnostics.dir}`);
  if (diagnostics.summaryLines.length > 0) {
    console.error("  Recent sandbox creation failure:");
    for (const line of diagnostics.summaryLines) {
      console.error(`    ${line}`);
    }
  }
  if (diagnostics.backupPath) {
    console.error(`  State backup retained: ${diagnostics.backupPath}`);
  }
  return diagnostics;
}
