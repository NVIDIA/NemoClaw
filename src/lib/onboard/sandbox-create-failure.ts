// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_RELEVANT_LOG_LINES = 120;

export type SandboxCreateFailureDiagnostics = {
  dir: string;
  gatewayLogPath: string | null;
  sandboxId: string | null;
  stateDir: string | null;
  consoleOutput: string | null;
  copiedConsoleOutput: string | null;
  backupPath: string | null;
  summaryLines: string[];
};

export type SandboxCreateFailureDiagnosticOptions = {
  homeDir?: string;
  gatewayLogPath?: string | null;
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

function gatewayLogCandidates(homeDir: string): string[] {
  return [
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
}

function readLogLines(filePath: string): string[] | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return stripAnsi(fs.readFileSync(filePath, "utf-8")).split(/\r?\n/);
  } catch {
    return null;
  }
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
    homeDir,
    ".nemoclaw",
    "onboard-failures",
    `${timestampForPath(now)}-${sanitizePathPart(sandboxName)}`,
  );

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }

  const gatewayLogPath =
    options.gatewayLogPath ??
    gatewayLogCandidates(homeDir).find((candidate) => fs.existsSync(candidate)) ??
    null;
  const rawLines = gatewayLogPath ? readLogLines(gatewayLogPath) : null;
  const block = rawLines ? findLatestSandboxBlock(rawLines, sandboxName) : [];
  const sandboxId = getLatestSandboxId(block, sandboxName);
  const relevantLines = filterRelevantLines(block, sandboxName, sandboxId);
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

  if (relevantLines.length > 0) {
    fs.writeFileSync(
      path.join(dir, "openshell-gateway-relevant.log"),
      `${relevantLines.join("\n")}\n`,
      {
        mode: 0o600,
      },
    );
  }
  const summaryLines = [
    `created_at=${now.toISOString()}`,
    `sandbox_name=${sandboxName}`,
    `sandbox_id=${sandboxId ?? "unknown"}`,
    `gateway_log=${gatewayLogPath ?? "not-found"}`,
    `state_dir=${stateDir ?? "unknown"}`,
    `console_output=${consoleOutput ?? "unknown"}`,
    `copied_console_output=${copiedConsoleOutput ?? "not-copied"}`,
    `backup_path=${backupPath ?? "none"}`,
  ];
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
    backupPath,
    summaryLines: relevantLines.slice(-8),
  };
}
