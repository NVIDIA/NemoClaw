// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import { isDirectSandboxFallbackUnavailableError } from "../../sandbox/privileged-exec";
import * as processRecovery from "./process-recovery";

const HERMES_CRON_CONTROL = "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py";
const HERMES_PYTHON = "/opt/hermes/.venv/bin/python";
const RECEIPT_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_V1:";
const BEGIN_TIMEOUT_MS = 70_000;
const CONTROL_TIMEOUT_MS = 25_000;
const RECOVERY_TIMEOUT_MS = BEGIN_TIMEOUT_MS + CONTROL_TIMEOUT_MS * 2 + 10_000;

type HermesCronRestoreAction = "begin" | "validate" | "release" | "recover";
type HermesCronRestoreDisposition =
  | "drain-acquired"
  | "restore-validated"
  | "dispatch-reactivated"
  | "operator-drain-preserved"
  | "not-required";

interface HermesCronRestoreReceipt {
  version: 1;
  action: HermesCronRestoreAction;
  pid: number;
  start_time: number;
  drain_acquired: boolean;
  drain_token?: string;
  active_agents?: number;
  profiles?: number;
  active_jobs?: number;
  script_jobs?: number;
  disposition: HermesCronRestoreDisposition;
  operator_drain_active: boolean;
  preserved_drain?: boolean;
}

type HermesCronRestoreIdentity = Pick<
  HermesCronRestoreReceipt,
  "pid" | "start_time" | "drain_token"
>;

export type HermesCronRestoreRecoveryOutcome =
  | "dispatch-reactivated"
  | "operator-drain-preserved"
  | "not-required"
  | "unsupported";

export class HermesCronRestoreIncompleteError extends Error {
  constructor() {
    super("Hermes state restore was incomplete while cron dispatch was drained");
    this.name = "HermesCronRestoreIncompleteError";
  }
}

export type HermesPostRestoreGatewayState =
  | "not-applicable"
  | "healthy"
  | "recovered"
  | "unverified";

type GatewayRecoveryObservation = {
  checked: boolean;
  wasRunning: boolean | null;
  recovered: boolean;
  forwardRecoveryFailed?: boolean;
  secretBoundaryRefused?: boolean;
  mcpReconciliationRefused?: boolean;
};

interface HermesPostRestoreGatewayDeps {
  checkAndRecoverSandboxProcesses?: (
    sandboxName: string,
    options: { quiet: boolean },
  ) => GatewayRecoveryObservation;
}

/**
 * Re-prove Hermes gateway health after workspace state restoration.
 *
 * Inner onboarding verifies the fresh image before rebuild restores the prior
 * state. That restore can still stop or wedge the gateway, so its earlier
 * readiness message is not authoritative for rebuild completion.
 */
export function ensureHermesGatewayAfterStateRestore(
  sandboxName: string,
  agentName: string,
  deps: HermesPostRestoreGatewayDeps = {},
): HermesPostRestoreGatewayState {
  if (agentName !== "hermes") return "not-applicable";
  const checkAndRecover =
    deps.checkAndRecoverSandboxProcesses ?? processRecovery.checkAndRecoverSandboxProcesses;
  const observation: GatewayRecoveryObservation = checkAndRecover(sandboxName, { quiet: true });
  if (
    !observation.checked ||
    observation.forwardRecoveryFailed === true ||
    observation.secretBoundaryRefused === true ||
    observation.mcpReconciliationRefused === true
  ) {
    return "unverified";
  }
  if (observation.wasRunning === true) return "healthy";
  if (observation.recovered) return "recovered";
  return "unverified";
}

export function printHermesGatewayRestoreRecovery(
  sandboxName: string,
  state: HermesPostRestoreGatewayState,
  writeLine: (message: string) => void = console.log,
): void {
  if (state !== "unverified") return;
  writeLine(
    `    Hermes gateway health was not verified after state restore — run \`${CLI_NAME} ${sandboxName} recover\` before relying on this sandbox`,
  );
}

function hasExactReceiptFields(
  payload: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const expected = new Set(fields);
  return (
    Object.keys(payload).length === expected.size &&
    Object.keys(payload).every((key) => expected.has(key))
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isReleaseDispositionValid(payload: Record<string, unknown>): boolean {
  const operatorDrainActive = payload.operator_drain_active;
  return (
    typeof operatorDrainActive === "boolean" &&
    payload.preserved_drain === operatorDrainActive &&
    payload.disposition ===
      (operatorDrainActive ? "operator-drain-preserved" : "dispatch-reactivated")
  );
}

function parseCronRestoreReceipt(
  stdout: string,
  expectedAction: HermesCronRestoreAction,
): HermesCronRestoreReceipt {
  const receiptLines = stdout.split(/\r?\n/u).filter((line) => line.startsWith(RECEIPT_PREFIX));
  if (receiptLines.length !== 1) {
    throw new Error(`Hermes cron ${expectedAction} returned an invalid receipt`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(receiptLines[0].slice(RECEIPT_PREFIX.length));
  } catch {
    throw new Error(`Hermes cron ${expectedAction} returned malformed JSON`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Hermes cron ${expectedAction} receipt failed validation`);
  }
  const receipt = payload as Record<string, unknown>;
  if (
    receipt.version !== 1 ||
    receipt.action !== expectedAction ||
    !Number.isSafeInteger(receipt.pid) ||
    Number(receipt.pid) <= 0 ||
    !isNonNegativeInteger(receipt.start_time) ||
    typeof receipt.drain_acquired !== "boolean" ||
    typeof receipt.operator_drain_active !== "boolean" ||
    (receipt.drain_acquired
      ? typeof receipt.drain_token !== "string" || receipt.drain_token.length === 0
      : "drain_token" in receipt)
  ) {
    throw new Error(`Hermes cron ${expectedAction} receipt failed validation`);
  }

  const baseFields = [
    "version",
    "action",
    "pid",
    "start_time",
    "drain_acquired",
    "disposition",
    "operator_drain_active",
  ];
  const tokenFields = receipt.drain_acquired ? ["drain_token"] : [];
  let actionValid = false;
  switch (expectedAction) {
    case "begin":
      actionValid =
        receipt.drain_acquired === true &&
        receipt.disposition === "drain-acquired" &&
        receipt.active_agents === 0 &&
        hasExactReceiptFields(receipt, [...baseFields, ...tokenFields, "active_agents"]);
      break;
    case "validate":
      actionValid =
        receipt.drain_acquired === true &&
        receipt.disposition === "restore-validated" &&
        isNonNegativeInteger(receipt.profiles) &&
        isNonNegativeInteger(receipt.active_jobs) &&
        isNonNegativeInteger(receipt.script_jobs) &&
        hasExactReceiptFields(receipt, [
          ...baseFields,
          ...tokenFields,
          "profiles",
          "active_jobs",
          "script_jobs",
        ]);
      break;
    case "release":
      actionValid =
        receipt.drain_acquired === true &&
        receipt.active_agents === 0 &&
        isReleaseDispositionValid(receipt) &&
        hasExactReceiptFields(receipt, [
          ...baseFields,
          ...tokenFields,
          "active_agents",
          "preserved_drain",
        ]);
      break;
    case "recover":
      if (receipt.drain_acquired) {
        actionValid =
          receipt.active_agents === 0 &&
          isNonNegativeInteger(receipt.profiles) &&
          isNonNegativeInteger(receipt.active_jobs) &&
          isNonNegativeInteger(receipt.script_jobs) &&
          isReleaseDispositionValid(receipt) &&
          hasExactReceiptFields(receipt, [
            ...baseFields,
            ...tokenFields,
            "active_agents",
            "profiles",
            "active_jobs",
            "script_jobs",
            "preserved_drain",
          ]);
      } else {
        actionValid =
          receipt.disposition === "not-required" &&
          isNonNegativeInteger(receipt.active_agents) &&
          receipt.preserved_drain === receipt.operator_drain_active &&
          hasExactReceiptFields(receipt, [...baseFields, "active_agents", "preserved_drain"]);
      }
      break;
  }
  if (!actionValid) {
    throw new Error(`Hermes cron ${expectedAction} receipt failed validation`);
  }
  return receipt as unknown as HermesCronRestoreReceipt;
}

class HermesCronRestoreControlFailure extends Error {
  constructor(
    action: HermesCronRestoreAction,
    readonly stderr: string,
  ) {
    const detail = stderr.trim().split(/\r?\n/u).at(-1);
    super(`Hermes cron ${action} failed${detail ? `: ${detail}` : ""}`);
    this.name = "HermesCronRestoreControlFailure";
  }
}

function runCronRestoreControl(
  sandboxName: string,
  action: HermesCronRestoreAction,
  identity?: HermesCronRestoreIdentity,
): HermesCronRestoreReceipt {
  const command = [HERMES_PYTHON, "-I", HERMES_CRON_CONTROL, action];
  if (identity) {
    command.push("--pid", String(identity.pid), "--start-time", String(identity.start_time));
    if (identity.drain_token) command.push("--drain-token", identity.drain_token);
  }
  let result: processRecovery.SandboxCommandResult | null;
  try {
    result = processRecovery.executePrivilegedSandboxCommand(
      sandboxName,
      command,
      action === "begin"
        ? BEGIN_TIMEOUT_MS
        : action === "recover"
          ? RECOVERY_TIMEOUT_MS
          : CONTROL_TIMEOUT_MS,
    );
  } catch (error) {
    if (isDirectSandboxFallbackUnavailableError(error)) {
      throw new Error(`Hermes cron ${action} privileged transport was unavailable`);
    }
    throw error;
  }
  if (!result) {
    throw new Error(`Hermes cron ${action} transport was unavailable`);
  }
  if (result.status !== 0) {
    throw new HermesCronRestoreControlFailure(action, result.stderr);
  }
  return parseCronRestoreReceipt(result.stdout, action);
}

export function beginHermesCronRestore(sandboxName: string): HermesCronRestoreIdentity {
  const receipt = runCronRestoreControl(sandboxName, "begin");
  return {
    pid: receipt.pid,
    start_time: receipt.start_time,
    ...(receipt.drain_token ? { drain_token: receipt.drain_token } : {}),
  };
}

export function validateHermesCronRestore(
  sandboxName: string,
  identity: HermesCronRestoreIdentity,
): void {
  const receipt = runCronRestoreControl(sandboxName, "validate", identity);
  if (
    receipt.pid !== identity.pid ||
    receipt.start_time !== identity.start_time ||
    receipt.drain_token !== identity.drain_token
  ) {
    throw new Error("Hermes cron validate receipt changed gateway identity");
  }
}

export function releaseHermesCronRestore(
  sandboxName: string,
  identity: HermesCronRestoreIdentity,
): void {
  const receipt = runCronRestoreControl(sandboxName, "release", identity);
  if (
    receipt.pid !== identity.pid ||
    receipt.start_time !== identity.start_time ||
    receipt.drain_token !== identity.drain_token
  ) {
    throw new Error("Hermes cron release receipt changed gateway identity");
  }
}

function isLegacyCronRestoreControl(error: unknown): boolean {
  if (!(error instanceof HermesCronRestoreControlFailure)) return false;
  return (
    /can't open file ['"]\/usr\/local\/lib\/nemoclaw\/hermes-cron-restore-control\.py['"]: \[Errno 2\] No such file or directory/u.test(
      error.stderr,
    ) || /argument action: invalid choice: ['"]recover['"]/u.test(error.stderr)
  );
}

export function recoverHermesCronRestore(sandboxName: string): HermesCronRestoreRecoveryOutcome {
  let receipt: HermesCronRestoreReceipt;
  try {
    receipt = runCronRestoreControl(sandboxName, "recover");
  } catch (error) {
    if (isLegacyCronRestoreControl(error)) return "unsupported";
    throw error;
  }
  if (
    receipt.disposition === "dispatch-reactivated" ||
    receipt.disposition === "operator-drain-preserved" ||
    receipt.disposition === "not-required"
  ) {
    return receipt.disposition;
  }
  throw new Error("Hermes cron recover returned an invalid disposition");
}

export function runHermesCronRestoreTransaction<T extends { restoreSucceeded: boolean }>(
  sandboxName: string,
  restore: () => T,
  onGateTransition: (
    state: "acquired" | "released",
    identity: HermesCronRestoreIdentity,
  ) => void = () => {},
): T {
  const identity = beginHermesCronRestore(sandboxName);
  onGateTransition("acquired", identity);
  const result = restore();
  if (!result.restoreSucceeded) {
    throw new HermesCronRestoreIncompleteError();
  }
  validateHermesCronRestore(sandboxName, identity);
  releaseHermesCronRestore(sandboxName, identity);
  onGateTransition("released", identity);
  return result;
}
