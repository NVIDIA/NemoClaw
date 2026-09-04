// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface PrivilegedExecResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface PrivilegedExec {
  run(command: string[], input?: string): PrivilegedExecResult;
}

const OPENCLAW_CONFIG_DIR = "/sandbox/.openclaw";
const CONTAINER_HELPER = "/usr/local/lib/nemoclaw/openclaw-config-guard.py";
const CONFIG_WRITE_TIMEOUT = ["timeout", "--signal=TERM", "--kill-after=5s", "5m"];
const SCHEMA_VALIDATION_TIMEOUT = ["timeout", "--signal=TERM", "--kill-after=5s", "30s"];
const MAX_SCHEMA_CANDIDATE_BYTES = 16 * 1024 * 1024;
const SCHEMA_VALIDATION_SCRIPT = `set -eu
umask 077
candidate="$(mktemp "${OPENCLAW_CONFIG_DIR}/.nemoclaw-openclaw-config.XXXXXX")"
trap 'rm -f -- "$candidate"' EXIT HUP INT TERM
head -c ${MAX_SCHEMA_CANDIDATE_BYTES + 1} > "$candidate"
candidate_size="$(wc -c < "$candidate")"
test "$candidate_size" -le ${MAX_SCHEMA_CANDIDATE_BYTES}
HOME=/sandbox OPENCLAW_CONFIG_PATH="$candidate" /usr/local/bin/openclaw config validate --json`;

export interface OpenClawConfigWriteResult {
  issues: string[];
  configSha256?: string;
}

function printableExcerpt(value: string, maxLength: number): string {
  return [...value.slice(0, maxLength)]
    .map((character) => (/^[\x20-\x7e]$/.test(character) ? character : " "))
    .join("")
    .trim();
}

function executionFailure(label: string, result: PrivilegedExecResult): string {
  const details = [result.error, result.stderr.trim(), result.stdout.trim()]
    .filter((value): value is string => Boolean(value))
    .join("; ");
  const termination =
    result.signal !== null ? `signal ${result.signal}` : `status ${String(result.status)}`;
  return `${label} (${termination})${details ? `: ${details}` : ""}`;
}

function schemaIssuePaths(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const issues = (payload as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  const paths: string[] = [];
  for (const issue of issues.slice(0, 8)) {
    if (!issue || typeof issue !== "object") continue;
    const issuePath = (issue as { path?: unknown }).path;
    if (typeof issuePath !== "string") continue;
    const sanitized = printableExcerpt(issuePath, 256);
    if (sanitized && !paths.includes(sanitized)) paths.push(sanitized);
  }
  return paths;
}

export function validateOpenClawConfigCandidate(
  privileged: PrivilegedExec,
  input: string,
): string[] {
  if (Buffer.byteLength(input, "utf8") > MAX_SCHEMA_CANDIDATE_BYTES) {
    return [
      "OpenClaw config candidate exceeds the 16 MiB size limit; existing config was not changed",
    ];
  }
  const result = privileged.run(
    [
      ...SCHEMA_VALIDATION_TIMEOUT,
      "/usr/bin/setpriv",
      "--reuid=gateway",
      "--regid=gateway",
      "--init-groups",
      "--",
      "sh",
      "-c",
      SCHEMA_VALIDATION_SCRIPT,
    ],
    input,
  );
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout.trim());
  } catch {
    payload = null;
  }
  const completed = result.signal === null && !result.error;
  if (
    completed &&
    result.status === 0 &&
    payload &&
    typeof payload === "object" &&
    (payload as { valid?: unknown }).valid === true
  ) {
    return [];
  }
  if (
    completed &&
    result.status === 1 &&
    payload &&
    typeof payload === "object" &&
    (payload as { valid?: unknown }).valid === false &&
    Array.isArray((payload as { issues?: unknown }).issues)
  ) {
    const paths = schemaIssuePaths(payload);
    const location = paths.length > 0 ? ` at ${paths.join(", ")}` : "";
    return [
      `OpenClaw config schema rejected the candidate${location}; existing config was not changed`,
    ];
  }
  const reason =
    result.signal !== null || result.status === 124 || result.status === 137
      ? "timed out or was terminated"
      : "could not run";
  return [
    `OpenClaw config schema validation ${reason}; existing config was not changed. Rebuild the sandbox if its OpenClaw runtime does not support config validate --json`,
  ];
}

export function writeOpenClawConfigCandidate(
  privileged: PrivilegedExec,
  input: string,
  expectedConfigSha256: string,
): OpenClawConfigWriteResult {
  if (!/^[0-9a-f]{64}$/.test(expectedConfigSha256)) {
    return { issues: ["OpenClaw config write requires a 64-character lowercase SHA-256"] };
  }
  const capability = privileged.run(["test", "-r", CONTAINER_HELPER]);
  if (capability.status !== 0 || capability.signal !== null || capability.error) {
    return {
      issues:
        capability.status === 1 && capability.signal === null && !capability.error
          ? [
              "OpenClaw config guard is absent in the sandbox; rebuild before writing config transactionally",
            ]
          : [executionFailure("OpenClaw config guard capability probe failed", capability)],
    };
  }
  const result = privileged.run(
    [
      ...CONFIG_WRITE_TIMEOUT,
      "python3",
      "-I",
      CONTAINER_HELPER,
      "write-config",
      "--config-dir",
      OPENCLAW_CONFIG_DIR,
      "--expected-config-sha256",
      expectedConfigSha256,
    ],
    input,
  );
  const issues: string[] = [];
  let summary: Record<string, unknown> | null = null;
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      issues.push(
        `OpenClaw config guard returned non-JSON output: ${printableExcerpt(trimmed, 2048)}`,
      );
      continue;
    }
    if (!record || typeof record !== "object") {
      issues.push("OpenClaw config guard returned an invalid record");
      continue;
    }
    const value = record as Record<string, unknown>;
    if (
      value.type === "issue" &&
      typeof value.code === "string" &&
      typeof value.path === "string" &&
      typeof value.detail === "string"
    ) {
      issues.push(
        `OpenClaw config guard write-config [${printableExcerpt(value.code, 64)}] ${printableExcerpt(value.path, 256)}: ${printableExcerpt(value.detail, 2048)}`,
      );
    } else if (value.type === "result" && value.action === "write-config") {
      if (summary) issues.push("OpenClaw config guard returned multiple result records");
      summary = value;
    } else {
      issues.push("OpenClaw config guard returned an unknown record");
    }
  }
  if (!summary) issues.push("OpenClaw config guard returned no result record");
  if (summary?.status !== "ok") issues.push("OpenClaw config guard did not report success");
  if (summary?.configDir !== OPENCLAW_CONFIG_DIR) {
    issues.push("OpenClaw config guard returned an unexpected config directory");
  }
  const files = summary?.files;
  if (
    !Array.isArray(files) ||
    files.length !== 2 ||
    files[0] !== "openclaw.json" ||
    files[1] !== ".config-hash"
  ) {
    issues.push("OpenClaw config guard returned an unexpected protected-file set");
  }
  if (result.status !== 0 || result.signal !== null || result.error) {
    issues.push(executionFailure("OpenClaw config guard execution failed", result));
  }
  if (result.stderr.trim()) {
    issues.push(`OpenClaw config guard wrote unexpected stderr: ${result.stderr.trim()}`);
  }
  const configSha256 = summary?.configSha256;
  if (typeof configSha256 !== "string" || !/^[0-9a-f]{64}$/.test(configSha256)) {
    issues.push("OpenClaw config guard returned an invalid config SHA-256");
  }
  return {
    issues,
    ...(typeof configSha256 === "string" ? { configSha256 } : {}),
  };
}
