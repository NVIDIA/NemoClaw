// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

// State-dir lock fan-out for shields up/down. The actual traversal lives in a
// root-only Python helper because shell `chown -R` / `chmod -R` cannot provide
// descriptor-relative, no-symlink-follow semantics or revoke writable file
// descriptors that were opened before shields-up.

export interface PrivilegedExecResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface PrivilegedExec {
  run(cmd: string[], input?: string): PrivilegedExecResult;
}

// Keep this inventory exported for documentation/tests that compare the host
// contract with shipped agent manifests. The helper owns enforcement and must
// be updated in the same change when this inventory changes.
export const HIGH_RISK_STATE_DIRS = [
  "skills",
  "agent",
  "hooks",
  "cron",
  "agents",
  "extensions",
  "plugins",
  "workspace",
  "memory",
  "devices",
  "canvas",
  "telegram",
  "wechat",
  "whatsapp",
  "platforms",
  "weixin",
  "profiles",
  "skins",
];

export const CONFIDENTIALITY_STATE_DIRS = ["credentials", "identity", "pairing"];
export const WRITABLE_RUNTIME_SUBPATHS = ["agents/*/sessions"];

const CONTAINER_HELPER = "/usr/local/lib/nemoclaw/state-dir-guard.py";
const HOST_HELPER = path.resolve(__dirname, "../../../scripts/state-dir-guard.py");
const CONTAINER_TIMEOUT = ["timeout", "--signal=TERM", "--kill-after=5s", "12m"];

type GuardAction = "preflight" | "lock" | "unlock";

type GuardIssue = {
  type: "issue";
  code: string;
  path: string;
  detail: string;
};

type GuardSummary = {
  type: "result";
  action: GuardAction;
  status: "ok" | "failed";
  issueCount: number;
};

function resultFailure(label: string, result: PrivilegedExecResult): string {
  const details = [result.error, result.stderr.trim(), result.stdout.trim()]
    .filter((value): value is string => Boolean(value))
    .join("; ");
  const termination =
    result.signal !== null ? `signal ${result.signal}` : `status ${String(result.status)}`;
  return `${label} (${termination})${details ? `: ${details}` : ""}`;
}

function parseGuardOutput(action: GuardAction, result: PrivilegedExecResult): string[] {
  const issues: GuardIssue[] = [];
  const summaries: GuardSummary[] = [];
  const contractIssues: string[] = [];

  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      contractIssues.push(`state-dir guard returned non-JSON output: ${trimmed}`);
      continue;
    }
    if (!value || typeof value !== "object") {
      contractIssues.push(`state-dir guard returned an invalid record: ${trimmed}`);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (
      record.type === "issue" &&
      typeof record.code === "string" &&
      typeof record.path === "string" &&
      typeof record.detail === "string"
    ) {
      issues.push(record as GuardIssue);
      continue;
    }
    if (
      record.type === "result" &&
      (record.action === "preflight" || record.action === "lock" || record.action === "unlock") &&
      (record.status === "ok" || record.status === "failed") &&
      typeof record.issueCount === "number" &&
      Number.isInteger(record.issueCount)
    ) {
      summaries.push(record as GuardSummary);
      continue;
    }
    contractIssues.push(`state-dir guard returned an unknown record: ${trimmed}`);
  }

  if (summaries.length !== 1) {
    contractIssues.push(`state-dir guard returned ${String(summaries.length)} result records`);
  }
  const summary = summaries[0];
  if (summary && summary.action !== action) {
    contractIssues.push(`state-dir guard result action=${summary.action} (expected ${action})`);
  }
  if (summary && summary.issueCount !== issues.length) {
    contractIssues.push(
      `state-dir guard result issueCount=${String(summary.issueCount)} (observed ${String(issues.length)})`,
    );
  }
  if (summary?.status === "ok" && (issues.length > 0 || result.status !== 0)) {
    contractIssues.push("state-dir guard reported success with issues or a non-zero exit");
  }
  if (summary?.status === "failed" && result.status === 0) {
    contractIssues.push("state-dir guard reported failure with a zero exit");
  }
  if (result.status === null || result.signal !== null || result.error) {
    contractIssues.push(resultFailure("state-dir guard execution failed", result));
  } else if (result.status !== 0 && issues.length === 0) {
    contractIssues.push(resultFailure("state-dir guard failed without a diagnostic", result));
  }
  if (result.stderr.trim()) {
    contractIssues.push(`state-dir guard wrote unexpected stderr: ${result.stderr.trim()}`);
  }

  return [
    ...issues.map(
      (issue) => `state-dir guard ${action} [${issue.code}] ${issue.path}: ${issue.detail}`,
    ),
    ...contractIssues,
  ];
}

let cachedHostHelper: string | null = null;

function readHostHelper(): string {
  if (cachedHostHelper !== null) return cachedHostHelper;
  cachedHostHelper = fs.readFileSync(HOST_HELPER, "utf-8");
  return cachedHostHelper;
}

function runStateDirGuard(
  privileged: PrivilegedExec,
  action: GuardAction,
  configDir: string,
): string[] {
  const capability = privileged.run(["test", "-r", CONTAINER_HELPER]);
  let command: string[];
  let input: string | undefined;
  if (capability.status === 0 && capability.signal === null && !capability.error) {
    command = [
      ...CONTAINER_TIMEOUT,
      "python3",
      "-I",
      CONTAINER_HELPER,
      action,
      "--config-dir",
      configDir,
    ];
  } else if (capability.status === 1 && capability.signal === null && !capability.error) {
    // New CLIs must still be able to rebuild an old sandbox image. Inject the
    // exact trusted helper shipped with this CLI over docker exec stdin rather
    // than falling back to symlink-following recursive shell commands.
    try {
      input = readHostHelper();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        `state-dir guard is absent in the sandbox and host helper cannot be read: ${message}`,
      ];
    }
    command = [...CONTAINER_TIMEOUT, "python3", "-I", "-", action, "--config-dir", configDir];
  } else {
    return [resultFailure("state-dir guard capability probe failed", capability)];
  }

  return parseGuardOutput(action, privileged.run(command, input));
}

// Read-only recursive validation. Call this before top-level config mutation so
// a hostile nested link, hardlink, special entry, or cross-device mount fails
// without partially changing the protected tree.
export function preflightStateDirLock(privileged: PrivilegedExec, configDir: string): string[] {
  return runStateDirGuard(privileged, "preflight", configDir);
}

// Apply and independently verify the complete recursive state-dir posture.
// `highRiskOwner` remains explicit to prevent a caller from accidentally using
// this fixed policy for a different ownership contract.
export function applyStateDirLockMode(
  privileged: PrivilegedExec,
  configDir: string,
  highRiskOwner: string,
  isLocking: boolean,
): string[] {
  const expectedOwner = isLocking ? "root:sandbox" : "sandbox:sandbox";
  if (highRiskOwner !== expectedOwner) {
    return [
      `state-dir guard owner contract mismatch: ${highRiskOwner} (expected ${expectedOwner})`,
    ];
  }
  return runStateDirGuard(privileged, isLocking ? "lock" : "unlock", configDir);
}

export function restoreStateDirLockPosture(
  privileged: PrivilegedExec,
  configDir: string,
  originallyLocked: boolean,
): string[] {
  if (!originallyLocked) {
    return applyStateDirLockMode(privileged, configDir, "sandbox:sandbox", false);
  }
  const preflightIssues = preflightStateDirLock(privileged, configDir);
  if (preflightIssues.length > 0) return preflightIssues;
  return applyStateDirLockMode(privileged, configDir, "root:sandbox", true);
}
