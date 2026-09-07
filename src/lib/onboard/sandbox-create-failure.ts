// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GATEWAY_PORT } from "../core/ports";
import { buildSandboxLogsArgs } from "../domain/sandbox/logs";
import { rejectSymlinksOnPath } from "../state/config-io";
import { nemoclawStateRoot } from "../state/state-root";
import {
  createDockerGpuDiagnosticRedactor,
  discoverDockerGpuDiagnosticSensitiveValuesFromEnv,
} from "./docker-gpu-diagnostic-redaction";
import { resolveGatewayLogPathForPort } from "./gateway/state-dir";

const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_RELEVANT_LOG_LINES = 120;
const MAX_GATEWAY_TAIL_LINES = 240;
const MAX_OPENSHELL_CAPTURE_BYTES = 64 * 1024;
const MAX_OPENSHELL_CAPTURE_LINES = 120;
const OPENSHELL_CAPTURE_TIMEOUT_MS = 10_000;

type RunCaptureOpenshell = (
  args: string[],
  options?: { ignoreError?: boolean; killProcessTreeOnTimeout?: boolean; timeout?: number },
) => string;

export type SandboxCreateFailureDiagnostics = {
  dir: string;
  gatewayLogPath: string | null;
  sandboxId: string | null;
  stateDir: string | null;
  consoleOutput: string | null;
  copiedConsoleOutput: string | null;
  gatewayTailPath: string | null;
  openshellLogsPath: string | null;
  backupPath: string | null;
  summaryLines: string[];
};

export type SandboxCreateFailureDiagnosticOptions = {
  homeDir?: string;
  gatewayPort?: number;
  gatewayLogPath?: string | null;
  gatewayStateDir?: string;
  gatewayName?: string;
  runCaptureOpenshell?: RunCaptureOpenshell;
  env?: NodeJS.ProcessEnv;
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

function boundedRedactedCapture(output: string, env: NodeJS.ProcessEnv): string[] {
  const bytes = Buffer.from(stripAnsi(output), "utf8");
  const offset = Math.max(0, bytes.length - MAX_OPENSHELL_CAPTURE_BYTES);
  let bounded = bytes.subarray(offset).toString("utf8");
  if (offset > 0) {
    const firstCompleteLine = bounded.indexOf("\n");
    bounded = firstCompleteLine === -1 ? "" : bounded.slice(firstCompleteLine + 1);
  }
  return createDockerGpuDiagnosticRedactor(discoverDockerGpuDiagnosticSensitiveValuesFromEnv(env))
    .redactText(bounded)
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .slice(-MAX_OPENSHELL_CAPTURE_LINES);
}

function captureOpenShellFailureLogs(
  dir: string,
  sandboxName: string,
  options: SandboxCreateFailureDiagnosticOptions,
): { path: string | null; summaryLines: string[] } {
  if (!options.runCaptureOpenshell) return { path: null, summaryLines: [] };
  try {
    const lines = boundedRedactedCapture(
      options.runCaptureOpenshell(
        buildSandboxLogsArgs(
          sandboxName,
          { follow: false, lines: String(MAX_OPENSHELL_CAPTURE_LINES), since: null },
          options.gatewayName,
        ),
        {
          ignoreError: true,
          killProcessTreeOnTimeout: true,
          timeout: OPENSHELL_CAPTURE_TIMEOUT_MS,
        },
      ),
      options.env ?? process.env,
    );
    if (lines.length === 0) return { path: null, summaryLines: [] };
    const filePath = path.join(dir, "openshell-logs.txt");
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`, { mode: 0o600 });
    return {
      path: filePath,
      summaryLines: lines.slice(-2).map((line) => `sandbox logs: ${line}`),
    };
  } catch {
    // Diagnostics must not replace the original sandbox-create failure.
    return { path: null, summaryLines: [] };
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
    gatewayLogCandidates(
      homeDir,
      options.gatewayPort ?? GATEWAY_PORT,
      options.gatewayStateDir ?? process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
    ).find((candidate) => fs.existsSync(candidate)) ??
    null;
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
  const openshellLogs = captureOpenShellFailureLogs(dir, sandboxName, options);
  const summaryLines = [
    `created_at=${now.toISOString()}`,
    `sandbox_name=${sandboxName}`,
    `sandbox_id=${sandboxId ?? "unknown"}`,
    `gateway_log=${gatewayLogPath ?? "not-found"}`,
    `gateway_tail=${gatewayTailPath ?? "not-written"}`,
    `state_dir=${stateDir ?? "unknown"}`,
    `console_output=${consoleOutput ?? "unknown"}`,
    `copied_console_output=${copiedConsoleOutput ?? "not-copied"}`,
    `openshell_logs=${openshellLogs.path ?? "not-written"}`,
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
    gatewayTailPath,
    openshellLogsPath: openshellLogs.path,
    backupPath,
    summaryLines:
      openshellLogs.summaryLines.length > 0
        ? [
            ...(relevantLines.length > 0 ? relevantLines : gatewayTailLines).slice(-2),
            ...openshellLogs.summaryLines,
          ].slice(-8)
        : relevantLines.length > 0
          ? relevantLines.slice(-8)
          : gatewayTailLines.slice(-8),
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
    console.error("  Recent OpenShell failure diagnostics:");
    for (const line of diagnostics.summaryLines) {
      console.error(`    ${line}`);
    }
  }
  if (diagnostics.backupPath) {
    console.error(`  State backup retained: ${diagnostics.backupPath}`);
  }
  return diagnostics;
}
