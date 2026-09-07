// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GATEWAY_PORT } from "../core/ports";
import { rejectSymlinksOnPath } from "../state/config-io";
import { nemoclawStateRoot } from "../state/state-root";
import { createDockerGpuDiagnosticRedactor } from "./docker-gpu-diagnostic-redaction";
import { resolveGatewayLogPathForPort } from "./gateway/state-dir";

const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_RELEVANT_LOG_LINES = 120;
const MAX_GATEWAY_TAIL_LINES = 240;
const MAX_GATEWAY_LOG_BYTES = 1024 * 1024;
const MAX_CONSOLE_OUTPUT_BYTES = 256 * 1024;
const MAX_STATE_DIR_ENTRIES = 200;
const diagnosticRedactor = createDockerGpuDiagnosticRedactor();

type BoundedFileTail = {
  contents: Buffer;
  truncated: boolean;
};

export type SandboxCreateFailureDiagnostics = {
  dir: string;
  gatewayLogPath: string | null;
  sandboxId: string | null;
  stateDir: string | null;
  consoleOutput: string | null;
  copiedConsoleOutput: string | null;
  gatewayTailPath: string | null;
  gatewayLogTruncated: boolean;
  consoleOutputTruncated: boolean;
  backupPath: string | null;
  summaryLines: string[];
};

export type SandboxCreateFailureDiagnosticOptions = {
  homeDir?: string;
  gatewayPort?: number;
  gatewayLogPath?: string | null;
  gatewayStateDir?: string;
  sandboxId?: string;
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

function gatewayLogCandidates(
  homeDir: string,
  gatewayPort: number,
  gatewayStateDir?: string,
): string[] {
  return [
    resolveGatewayLogPathForPort({
      configured: gatewayStateDir,
      home: homeDir,
      port: gatewayPort,
    }),
    path.join(homeDir, ".local", "state", "openshell", "openshell-gateway.log"),
  ];
}

function readBoundedFileTail(
  filePath: string,
  maxBytes: number,
  dropPartialFirstLine = false,
): BoundedFileTail | null {
  let fd: number | null = null;
  try {
    if (!fs.existsSync(filePath)) return null;
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    let contents = buffer.subarray(0, offset);
    if (start > 0 && dropPartialFirstLine) {
      const firstNewline = contents.indexOf(0x0a);
      contents = firstNewline < 0 ? Buffer.alloc(0) : contents.subarray(firstNewline + 1);
    }
    return { contents, truncated: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function readLogLines(filePath: string): { lines: string[]; truncated: boolean } | null {
  const tail = readBoundedFileTail(filePath, MAX_GATEWAY_LOG_BYTES, true);
  if (!tail) return null;
  const redacted = redactAndBoundText(
    stripAnsi(tail.contents.toString("utf8")),
    MAX_GATEWAY_LOG_BYTES,
    true,
  );
  return {
    lines: redacted.contents.split(/\r?\n/),
    truncated: tail.truncated || redacted.truncated,
  };
}

function redactAndBoundText(
  value: string,
  maxBytes: number,
  dropPartialFirstLine = false,
): { contents: string; truncated: boolean } {
  const redacted = Buffer.from(diagnosticRedactor.redactText(value), "utf8");
  if (redacted.length <= maxBytes) {
    return { contents: redacted.toString("utf8"), truncated: false };
  }
  let contents = redacted.subarray(redacted.length - maxBytes);
  if (dropPartialFirstLine) {
    const firstNewline = contents.indexOf(0x0a);
    contents = firstNewline < 0 ? Buffer.alloc(0) : contents.subarray(firstNewline + 1);
  }
  return { contents: contents.toString("utf8"), truncated: true };
}

function extractField(line: string, field: string): string | null {
  const match = line.match(new RegExp(`${field}=([^\\s]+)`));
  return match?.[1] ?? null;
}

function findLatestSandboxBlock(
  lines: string[],
  sandboxName: string,
  requiredSandboxId?: string,
): string[] {
  let startIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] || "";
    if (
      line.includes("create_sandbox received") &&
      extractField(line, "sandbox_name") === sandboxName &&
      (!requiredSandboxId || extractField(line, "sandbox_id") === requiredSandboxId)
    ) {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) {
    return requiredSandboxId ? lines : lines.slice(-MAX_RELEVANT_LOG_LINES);
  }

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i] || "";
    if (
      (line.includes("create_sandbox received") || line.includes("DeleteSandbox")) &&
      extractField(line, "sandbox_name") === sandboxName
    ) {
      endIndex = i + 1;
      break;
    }
  }
  return lines.slice(startIndex, endIndex);
}

function getLatestSandboxId(block: string[], sandboxName: string): string | null {
  for (const line of block) {
    if (extractField(line, "sandbox_name") !== sandboxName) continue;
    const field = extractField(line, "sandbox_id");
    if (field && UUID_RE.test(field)) return field;
  }
  return null;
}

function filterRelevantLines(
  block: string[],
  sandboxName: string,
  sandboxId: string | null,
  requireExactIdentity: boolean,
): string[] {
  const relevant = block.filter((line) => {
    if (!line.trim()) return false;
    if (requireExactIdentity) {
      return Boolean(sandboxId && extractField(line, "sandbox_id") === sandboxId);
    }
    if (extractField(line, "sandbox_name") === sandboxName) return true;
    if (sandboxId && extractField(line, "sandbox_id") === sandboxId) return true;
    return /ERROR krun|VmCreate|ProcessExited|console_output=|state_dir=/.test(line);
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

function copyFileTailIfPresent(
  src: string | null,
  dst: string,
): { path: string | null; truncated: boolean } {
  if (!src) return { path: null, truncated: false };
  try {
    const tail = readBoundedFileTail(src, MAX_CONSOLE_OUTPUT_BYTES);
    if (!tail) return { path: null, truncated: false };
    const redacted = redactAndBoundText(tail.contents.toString("utf8"), MAX_CONSOLE_OUTPUT_BYTES);
    fs.writeFileSync(dst, redacted.contents, { mode: 0o600 });
    return { path: dst, truncated: tail.truncated || redacted.truncated };
  } catch {
    return { path: null, truncated: false };
  }
}

function listStateDir(stateDir: string | null): string[] {
  if (!stateDir) return [];
  let dir: fs.Dir | null = null;
  try {
    if (!fs.existsSync(stateDir)) return [];
    dir = fs.opendirSync(stateDir);
    const entries: string[] = [];
    for (let index = 0; index < MAX_STATE_DIR_ENTRIES; index += 1) {
      const entry = dir.readSync();
      if (!entry) return entries;
      const suffix = entry.isDirectory() ? "/" : "";
      entries.push(`${entry.name}${suffix}`);
    }
    if (dir.readSync()) entries.push("<additional entries omitted>");
    return entries;
  } catch {
    return [];
  } finally {
    dir?.closeSync();
  }
}

export function collectSandboxCreateFailureDiagnostics(
  sandboxName: string,
  options: SandboxCreateFailureDiagnosticOptions = {},
): SandboxCreateFailureDiagnostics | null {
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? new Date();
  const gatewayPort = options.gatewayPort ?? GATEWAY_PORT;
  const dir = path.join(
    nemoclawStateRoot(homeDir, gatewayPort),
    "onboard-failures",
    `${timestampForPath(now)}-${sanitizePathPart(sandboxName)}`,
  );

  const gatewayLogPath =
    options.gatewayLogPath ??
    gatewayLogCandidates(
      homeDir,
      gatewayPort,
      options.gatewayStateDir ?? process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
    ).find((candidate) => fs.existsSync(candidate)) ??
    null;
  const gatewayLog = gatewayLogPath ? readLogLines(gatewayLogPath) : null;
  const rawLines = gatewayLog?.lines ?? null;
  const block = rawLines
    ? findLatestSandboxBlock(rawLines, sandboxName, options.sandboxId)
    : [];
  const sandboxId = options.sandboxId ?? getLatestSandboxId(block, sandboxName);
  const relevantLines = filterRelevantLines(
    block,
    sandboxName,
    sandboxId,
    options.sandboxId !== undefined,
  );
  if (options.sandboxId && relevantLines.length === 0) return null;
  const gatewayTailLines =
    rawLines && !options.sandboxId && relevantLines.length === 0
      ? rawLines.filter((line) => line.trim()).slice(-MAX_GATEWAY_TAIL_LINES)
      : [];
  const stateDir = latestFieldValue(relevantLines, "state_dir");
  const consoleOutput =
    latestFieldValue(relevantLines, "console_output") ??
    (stateDir ? path.join(stateDir, "rootfs-console.log") : null);

  try {
    rejectSymlinksOnPath(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    rejectSymlinksOnPath(dir);
  } catch {
    return null;
  }

  const copiedConsoleOutput = copyFileTailIfPresent(
    consoleOutput,
    path.join(dir, "rootfs-console.log"),
  );
  const stateEntries = listStateDir(stateDir);
  const backupPath = options.backupPath ?? null;

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
    `state_dir=${stateDir ?? "unknown"}`,
    `console_output=${consoleOutput ?? "unknown"}`,
    `copied_console_output=${copiedConsoleOutput.path ?? "not-copied"}`,
    `gateway_log_truncated=${String(gatewayLog?.truncated ?? false)}`,
    `console_output_truncated=${String(copiedConsoleOutput.truncated)}`,
    `backup_path=${backupPath ?? "none"}`,
  ];
  if (stateEntries.length > 0) {
    summaryLines.push("state_dir_entries:");
    summaryLines.push(...stateEntries.map((entry) => `  ${entry}`));
  }
  fs.writeFileSync(path.join(dir, "summary.txt"), `${summaryLines.join("\n")}\n`, {
    mode: 0o600,
  });
  const truncationNotices = [
    ...(gatewayLog?.truncated ? ["gateway log: earlier content omitted"] : []),
    ...(copiedConsoleOutput.truncated ? ["rootfs console: earlier content omitted"] : []),
  ];
  const diagnosticLines = relevantLines.length > 0 ? relevantLines : gatewayTailLines;

  return {
    dir,
    gatewayLogPath,
    sandboxId,
    stateDir,
    consoleOutput,
    copiedConsoleOutput: copiedConsoleOutput.path,
    gatewayTailPath,
    gatewayLogTruncated: gatewayLog?.truncated ?? false,
    consoleOutputTruncated: copiedConsoleOutput.truncated,
    backupPath,
    summaryLines: [
      ...truncationNotices,
      ...diagnosticLines.slice(-(8 - truncationNotices.length)),
    ],
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
    console.error("  Recent OpenShell gateway failure:");
    for (const line of diagnostics.summaryLines) {
      console.error(`    ${line}`);
    }
  }
  if (diagnostics.backupPath) {
    console.error(`  State backup retained: ${diagnostics.backupPath}`);
  }
  return diagnostics;
}
