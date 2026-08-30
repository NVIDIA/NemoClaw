// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type { AgentStateLockPlan } from "../agent/definition-types";

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

const HOST_HELPER = path.resolve(__dirname, "../../../scripts/state-dir-guard.py");
const CONTAINER_HELPER = "/usr/local/lib/nemoclaw/state-dir-guard.py";
export const CONTAINER_STATE_LOCK_PLAN = "/usr/local/share/nemoclaw/state-lock-plan.json";
const CONTAINER_TIMEOUT = ["timeout", "--signal=TERM", "--kill-after=5s", "12m"];
const PLAN_ARRAY_FIELDS = [
  "readOnlyRoots",
  "confidentialRoots",
  "readOnlyPrefixes",
  "confidentialPrefixes",
  "writableSubpaths",
] as const;
const PLAN_FIELDS = new Set(["$comment", "version", ...PLAN_ARRAY_FIELDS]);

type GuardAction = "preflight" | "lock" | "unlock" | "startup";

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
  const details = [
    result.error,
    String(result.stderr ?? "").trim(),
    String(result.stdout ?? "").trim(),
  ]
    .filter((value): value is string => Boolean(value))
    .join("; ");
  const termination =
    result.signal !== null ? `signal ${result.signal}` : `status ${String(result.status)}`;
  return `${label} (${termination})${details ? `: ${details}` : ""}`;
}

function successful(result: PrivilegedExecResult): boolean {
  return result.status === 0 && result.signal === null && !result.error;
}

function parseInstalledPlan(payload: string): AgentStateLockPlan | string {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch (error) {
    return `installed state lock plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "installed state lock plan must be an object";
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !PLAN_FIELDS.has(key));
  if (unknown.length > 0) {
    return `installed state lock plan has unknown fields: ${unknown.join(", ")}`;
  }
  if (record.$comment !== undefined && typeof record.$comment !== "string") {
    return "installed state lock plan has a non-string $comment";
  }
  if (record.version !== 1) return "installed state lock plan version must be exactly 1";

  const parsed = { version: 1 } as AgentStateLockPlan;
  for (const field of PLAN_ARRAY_FIELDS) {
    const entries = record[field];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
      return `installed state lock plan field '${field}' must be a string array`;
    }
    if (new Set(entries).size !== entries.length) {
      return `installed state lock plan field '${field}' contains duplicates`;
    }
    parsed[field] = entries as string[];
  }
  return parsed;
}

function plansMatch(actual: AgentStateLockPlan, expected: AgentStateLockPlan): boolean {
  return PLAN_ARRAY_FIELDS.every(
    (field) =>
      JSON.stringify([...actual[field]].sort()) === JSON.stringify([...expected[field]].sort()),
  );
}

type RuntimePlanInspection =
  | { kind: "image-current" }
  | { kind: "host-current" }
  | { kind: "historical" }
  | { kind: "error"; issue: string };

function inspectRuntimePlan(
  privileged: PrivilegedExec,
  expected: AgentStateLockPlan,
  stateLockPlanInImage: boolean,
): RuntimePlanInspection {
  if (!stateLockPlanInImage) return { kind: "host-current" };
  const capability = privileged.run(["test", "-r", CONTAINER_STATE_LOCK_PLAN]);
  if (capability.status === 1 && capability.signal === null && !capability.error) {
    return { kind: "historical" };
  }
  if (!successful(capability)) {
    return {
      kind: "error",
      issue: resultFailure("state lock plan capability probe failed", capability),
    };
  }
  const read = privileged.run(["cat", CONTAINER_STATE_LOCK_PLAN]);
  if (!successful(read) || String(read.stderr ?? "").trim()) {
    return { kind: "error", issue: resultFailure("installed state lock plan read failed", read) };
  }
  const parsed = parseInstalledPlan(String(read.stdout ?? ""));
  if (typeof parsed === "string") return { kind: "error", issue: parsed };
  if (!plansMatch(parsed, expected)) {
    return {
      kind: "error",
      issue:
        "installed state lock plan differs from the current agent manifest; rebuild the sandbox before changing Shields",
    };
  }
  return { kind: "image-current" };
}

export function stateLockPlanCompatibilityIssues(
  privileged: PrivilegedExec,
  expected: AgentStateLockPlan,
  stateLockPlanInImage: boolean,
): string[] {
  const inspection = inspectRuntimePlan(privileged, expected, stateLockPlanInImage);
  return inspection.kind === "error" ? [inspection.issue] : [];
}

function parseGuardOutput(action: GuardAction, result: PrivilegedExecResult): string[] {
  const issues: GuardIssue[] = [];
  const summaries: GuardSummary[] = [];
  const contractIssues: string[] = [];
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");

  for (const line of stdout.split("\n")) {
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
      (record.action === "preflight" ||
        record.action === "lock" ||
        record.action === "unlock" ||
        record.action === "startup") &&
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
  if (stderr.trim()) {
    contractIssues.push(`state-dir guard wrote unexpected stderr: ${stderr.trim()}`);
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
  plan: AgentStateLockPlan,
  stateLockPlanInImage: boolean,
): string[] {
  const runtimePlan = inspectRuntimePlan(privileged, plan, stateLockPlanInImage);
  if (runtimePlan.kind === "error") return [runtimePlan.issue];

  if (runtimePlan.kind !== "host-current") {
    const capability = privileged.run(["test", "-r", CONTAINER_HELPER]);
    if (successful(capability)) {
      const planArgs =
        runtimePlan.kind === "image-current" ? ["--plan-file", CONTAINER_STATE_LOCK_PLAN] : [];
      return parseGuardOutput(
        action,
        privileged.run([
          ...CONTAINER_TIMEOUT,
          "python3",
          "-I",
          CONTAINER_HELPER,
          action,
          "--config-dir",
          configDir,
          ...planArgs,
        ]),
      );
    }
    if (!(capability.status === 1 && capability.signal === null && !capability.error)) {
      return [resultFailure("state-dir guard capability probe failed", capability)];
    }
    if (runtimePlan.kind === "image-current") {
      return [
        "state-dir guard is unavailable in an image that contains a generated state lock plan",
      ];
    }
  }

  let input: string;
  try {
    input = readHostHelper();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`trusted host state-dir guard cannot be read: ${message}`];
  }

  // Agent definitions without an image plan, plus images predating the helper,
  // use the bounded host-injection path. The #8006 compatibility branch ends
  // when every sandbox image supported for rebuild contains CONTAINER_STATE_LOCK_PLAN.
  const command = [
    ...CONTAINER_TIMEOUT,
    "python3",
    "-I",
    "-",
    action,
    "--config-dir",
    configDir,
    "--plan-json",
    JSON.stringify(plan),
  ];
  return parseGuardOutput(action, privileged.run(command, input));
}

function runHostStateDirGuard(
  privileged: PrivilegedExec,
  action: GuardAction,
  configDir: string,
  plan: AgentStateLockPlan,
): string[] {
  let input: string;
  try {
    input = readHostHelper();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`host state-dir helper cannot be read: ${message}`];
  }
  const command = [
    ...CONTAINER_TIMEOUT,
    "python3",
    "-I",
    "-",
    action,
    "--config-dir",
    configDir,
    "--plan-json",
    JSON.stringify(plan),
  ];
  return parseGuardOutput(action, privileged.run(command, input));
}

// Read-only recursive validation. Call this before top-level config mutation so
// a hostile nested link, hardlink, special entry, or cross-device mount fails
// without partially changing the protected tree.
export function preflightStateDirLock(
  privileged: PrivilegedExec,
  configDir: string,
  plan: AgentStateLockPlan,
  stateLockPlanInImage: boolean,
): string[] {
  return runStateDirGuard(privileged, "preflight", configDir, plan, stateLockPlanInImage);
}

// Apply and independently verify the complete recursive state-dir posture.
// `highRiskOwner` remains explicit to prevent a caller from accidentally using
// this fixed policy for a different ownership contract.
export function applyStateDirLockMode(
  privileged: PrivilegedExec,
  configDir: string,
  highRiskOwner: string,
  isLocking: boolean,
  plan: AgentStateLockPlan,
  stateLockPlanInImage: boolean,
): string[] {
  const expectedOwner = isLocking ? "root:sandbox" : "sandbox:sandbox";
  if (highRiskOwner !== expectedOwner) {
    return [
      `state-dir guard owner contract mismatch: ${highRiskOwner} (expected ${expectedOwner})`,
    ];
  }
  return runStateDirGuard(
    privileged,
    isLocking ? "lock" : "unlock",
    configDir,
    plan,
    stateLockPlanInImage,
  );
}

export function restoreStateDirLockPosture(
  privileged: PrivilegedExec,
  configDir: string,
  originallyLocked: boolean,
  plan: AgentStateLockPlan,
  stateLockPlanInImage: boolean,
): string[] {
  if (!originallyLocked) {
    return applyStateDirLockMode(
      privileged,
      configDir,
      "sandbox:sandbox",
      false,
      plan,
      stateLockPlanInImage,
    );
  }
  const preflightIssues = preflightStateDirLock(privileged, configDir, plan, stateLockPlanInImage);
  if (preflightIssues.length > 0) return preflightIssues;
  return applyStateDirLockMode(
    privileged,
    configDir,
    "root:sandbox",
    true,
    plan,
    stateLockPlanInImage,
  );
}

// Existing sandboxes may contain an older in-image guard, so startup always
// injects the trusted helper shipped with the current host CLI. The startup
// action changes only an empty, already sealed credentials root.
export function restoreStateDirStartupAccess(
  privileged: PrivilegedExec,
  configDir: string,
  plan: AgentStateLockPlan,
): string[] {
  return runHostStateDirGuard(privileged, "startup", configDir, plan);
}
