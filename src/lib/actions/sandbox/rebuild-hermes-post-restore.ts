// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime";
import { isDirectSandboxFallbackUnavailableError } from "../../sandbox/privileged-exec";
import type { GatewayRestartResult } from "./gateway-restart";
import {
  checkAndRecoverSandboxProcesses,
  executePrivilegedSandboxCommand,
  restartSandboxGateway,
  type SandboxCommandResult,
} from "./runtime/hermes-lifecycle";

const HERMES_CRON_CONTROL = "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py";
const HERMES_PYTHON = "/opt/hermes/.venv/bin/python";
const RECEIPT_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_V1:";
const CONTROL_ERROR_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_ERROR_V1:";
export const HERMES_CRON_RESTORE_DRAIN_MARKER_ROLLBACK_FAILED_CODE = "drain-marker-rollback-failed";
const BEGIN_TIMEOUT_MS = 70_000;
const CONTROL_TIMEOUT_MS = 25_000;
const RECOVERY_TIMEOUT_MS = BEGIN_TIMEOUT_MS + CONTROL_TIMEOUT_MS * 2 + 10_000;
const HERMES_GATEWAY_RECHECK_ATTEMPTS = 2;

type HermesCronRestoreAction =
  | "begin"
  | "validate"
  | "observe"
  | "complete"
  | "prepare-recover"
  | "recover";
type HermesCronRestoreReceiptAction = Exclude<HermesCronRestoreAction, "prepare-recover">;
type HermesCronRestoreDisposition =
  | "drain-acquired"
  | "restore-validated"
  | "replacement-observed"
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

export type HermesCronRestoreIdentity = Pick<
  HermesCronRestoreReceipt,
  "pid" | "start_time" | "drain_token"
>;

export interface PendingHermesCronRestore<T> {
  result: T;
  identity: HermesCronRestoreIdentity;
}

export type HermesCronRestoreRecoveryOutcome =
  | "dispatch-reactivated"
  | "operator-drain-preserved"
  | "not-required"
  | "unsupported";

export type HermesCronRestorePreparationOutcome = "gate-prepared" | "not-required" | "unsupported";

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

export type HermesPostRestoreGatewayRestartState =
  | "not-applicable"
  | "restarted"
  | "restart-failed";

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
    options: { quiet: boolean; runtimeSelection?: OpenShellRuntimeSelection },
  ) => GatewayRecoveryObservation;
  restartSandboxGateway?: (
    sandboxName: string,
    options: { quiet: boolean; runtimeSelection?: OpenShellRuntimeSelection },
  ) => GatewayRestartResult;
  observeHermesCronReplacement?: (
    sandboxName: string,
    originalIdentity: HermesCronRestoreIdentity,
  ) => HermesCronRestoreIdentity;
  runtimeSelection?: OpenShellRuntimeSelection;
}

export interface HermesPostRestoreGatewayVerification {
  state: HermesPostRestoreGatewayState;
  replacementIdentity?: HermesCronRestoreIdentity;
}

/**
 * Bind the running Hermes gateway to the state this rebuild just restored.
 *
 * Recreation starts the gateway, and the restore replaces its durable state
 * afterwards. An adapter that reads that state once at startup keeps the
 * pre-restore result for the life of the process — the WhatsApp bridge reads
 * its paired session that way — so the gateway can be alive and healthy while
 * still serving the state the rebuild replaced. A liveness check cannot see
 * that difference, so restart before runtime restoration and let the final
 * check report on the process left by every intervening acknowledged reload.
 * `relaunchManagedSupervisorSession` already restarts after its own restore
 * for the same reason.
 *
 * The split restart/verify exports let rebuild insert MCP restoration between
 * those two steps. Hermes MCP restoration performs its own acknowledged
 * gateway reload, so a later unconditional restart would discard the runtime
 * identity whose MCP load just converged. A gated rebuild keeps the root-owned
 * cron drain active across restart, MCP restoration, and final verification.
 */
export function ensureHermesGatewayAfterStateRestore(
  sandboxName: string,
  agentName: string,
  deps: HermesPostRestoreGatewayDeps = {},
): HermesPostRestoreGatewayState {
  const restartState = restartHermesGatewayAfterStateRestore(sandboxName, agentName, deps);
  return verifyHermesGatewayAfterStateRestore(sandboxName, agentName, restartState, deps);
}

export function ensureHermesGatewayAfterStateRestoreForCronGate(
  sandboxName: string,
  agentName: string,
  originalIdentity: HermesCronRestoreIdentity,
  deps: HermesPostRestoreGatewayDeps = {},
): HermesPostRestoreGatewayVerification {
  const restartState = restartHermesGatewayAfterStateRestore(sandboxName, agentName, deps);
  return verifyHermesGatewayAfterStateRestoreForCronGate(
    sandboxName,
    agentName,
    restartState,
    originalIdentity,
    deps,
  );
}

export function restartHermesGatewayAfterStateRestore(
  sandboxName: string,
  agentName: string,
  deps: HermesPostRestoreGatewayDeps = {},
): HermesPostRestoreGatewayRestartState {
  if (agentName !== "hermes") return "not-applicable";
  const restart = deps.restartSandboxGateway ?? restartSandboxGateway;
  const result = restart(sandboxName, {
    quiet: true,
    ...(deps.runtimeSelection ? { runtimeSelection: deps.runtimeSelection } : {}),
  });
  if (result.ok) return "restarted";
  const mcpRestoreCanSupersede =
    result.failureLayer === "MCP reconciliation refusal" &&
    result.restarted === true &&
    result.healthPassed === true;
  // Final verification still requires MCP reconciliation after restoration.
  return mcpRestoreCanSupersede ? "restarted" : "restart-failed";
}

export function verifyHermesGatewayAfterStateRestore(
  sandboxName: string,
  agentName: string,
  restartState: HermesPostRestoreGatewayRestartState,
  deps: HermesPostRestoreGatewayDeps = {},
): HermesPostRestoreGatewayState {
  return verifyHermesGatewayAfterStateRestoreImpl(sandboxName, agentName, restartState, deps).state;
}

export function verifyHermesGatewayAfterStateRestoreForCronGate(
  sandboxName: string,
  agentName: string,
  restartState: HermesPostRestoreGatewayRestartState,
  originalIdentity: HermesCronRestoreIdentity,
  deps: HermesPostRestoreGatewayDeps = {},
): HermesPostRestoreGatewayVerification {
  return verifyHermesGatewayAfterStateRestoreImpl(
    sandboxName,
    agentName,
    restartState,
    deps,
    originalIdentity,
  );
}

function sameGatewayIdentity(
  left: HermesCronRestoreIdentity,
  right: HermesCronRestoreIdentity,
): boolean {
  return left.pid === right.pid && left.start_time === right.start_time;
}

function verifyHermesGatewayAfterStateRestoreImpl(
  sandboxName: string,
  agentName: string,
  restartState: HermesPostRestoreGatewayRestartState,
  deps: HermesPostRestoreGatewayDeps,
  originalIdentity?: HermesCronRestoreIdentity,
): HermesPostRestoreGatewayVerification {
  if (agentName !== "hermes") return { state: "not-applicable" };
  const restarted = restartState === "restarted";
  const checkAndRecover =
    deps.checkAndRecoverSandboxProcesses ?? checkAndRecoverSandboxProcesses;
  const observeReplacement = deps.observeHermesCronReplacement ?? observeHermesCronReplacement;
  const maxAttempts = originalIdentity
    ? HERMES_GATEWAY_RECHECK_ATTEMPTS + 1
    : HERMES_GATEWAY_RECHECK_ATTEMPTS;
  let recovered = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let identityBeforeHealth: HermesCronRestoreIdentity | undefined;
    if (originalIdentity) {
      try {
        identityBeforeHealth = observeReplacement(sandboxName, originalIdentity);
      } catch {
        // The recovery check may still create the replacement process. A
        // later iteration must observe it both before and after health.
      }
    }
    const observation: GatewayRecoveryObservation = checkAndRecover(sandboxName, {
      quiet: true,
      ...(deps.runtimeSelection ? { runtimeSelection: deps.runtimeSelection } : {}),
    });
    if (
      observation.forwardRecoveryFailed === true ||
      observation.secretBoundaryRefused === true ||
      observation.mcpReconciliationRefused === true
    ) {
      return { state: "unverified" };
    }
    if (!observation.checked) continue;
    // Recovery replaces the process, so a recovered gateway reads the restored
    // state whatever the restart reported. A gateway that stayed up through a
    // failed restart is still serving what it read before the restore, which is
    // the state this step exists to replace.
    if (observation.recovered) {
      if (!originalIdentity) return { state: "recovered" };
      recovered = true;
      continue;
    }
    if ((!restarted && !recovered) || observation.wasRunning !== true) continue;
    if (!originalIdentity) return { state: recovered ? "recovered" : "healthy" };
    if (!identityBeforeHealth) continue;
    let identityAfterHealth: HermesCronRestoreIdentity;
    try {
      identityAfterHealth = observeReplacement(sandboxName, originalIdentity);
    } catch {
      return { state: "unverified" };
    }
    if (!sameGatewayIdentity(identityBeforeHealth, identityAfterHealth)) {
      return { state: "unverified" };
    }
    return {
      state: recovered ? "recovered" : "healthy",
      replacementIdentity: identityAfterHealth,
    };
  }
  return { state: "unverified" };
}

export function printHermesGatewayRestoreRecovery(
  sandboxName: string,
  state: HermesPostRestoreGatewayState,
  writeLine: (message: string) => void = console.log,
): void {
  if (state !== "unverified") return;
  writeLine(
    `    Hermes gateway health was not verified after state restore — it can still be serving the state this rebuild replaced; run \`${CLI_NAME} ${sandboxName} gateway restart\`, then \`${CLI_NAME} ${sandboxName} recover\` if that fails`,
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
  expectedAction: HermesCronRestoreReceiptAction,
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
    case "observe":
      actionValid =
        receipt.drain_acquired === true &&
        receipt.disposition === "replacement-observed" &&
        receipt.active_agents === 0 &&
        hasExactReceiptFields(receipt, [...baseFields, ...tokenFields, "active_agents"]);
      break;
    case "complete":
      actionValid =
        receipt.drain_acquired === true &&
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

function parseCronRestorePreparationReceipt(stdout: string): HermesCronRestorePreparationOutcome {
  const receiptLines = stdout.split(/\r?\n/u).filter((line) => line.startsWith(RECEIPT_PREFIX));
  if (receiptLines.length !== 1) {
    throw new Error("Hermes cron prepare-recover returned an invalid receipt");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(receiptLines[0].slice(RECEIPT_PREFIX.length));
  } catch {
    throw new Error("Hermes cron prepare-recover returned malformed JSON");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Hermes cron prepare-recover receipt failed validation");
  }
  const receipt = payload as Record<string, unknown>;
  const validDisposition =
    (receipt.drain_acquired === true && receipt.disposition === "gate-prepared") ||
    (receipt.drain_acquired === false && receipt.disposition === "not-required");
  if (
    receipt.version !== 1 ||
    receipt.action !== "prepare-recover" ||
    !validDisposition ||
    !hasExactReceiptFields(receipt, ["version", "action", "drain_acquired", "disposition"])
  ) {
    throw new Error("Hermes cron prepare-recover receipt failed validation");
  }
  return receipt.disposition as "gate-prepared" | "not-required";
}

function parseCronRestoreControlError(stderr: string): { code: string; message: string } | null {
  const signalLines = stderr
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(CONTROL_ERROR_PREFIX));
  if (signalLines.length !== 1) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(signalLines[0].slice(CONTROL_ERROR_PREFIX.length));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const signal = payload as Record<string, unknown>;
  if (
    !hasExactReceiptFields(signal, ["code", "message"]) ||
    typeof signal.code !== "string" ||
    signal.code.length === 0 ||
    typeof signal.message !== "string" ||
    signal.message.length === 0
  ) {
    return null;
  }
  return { code: signal.code, message: signal.message };
}

class HermesCronRestoreControlFailure extends Error {
  readonly action: HermesCronRestoreAction;
  readonly stderr: string;
  readonly controlCode?: string;

  constructor(action: HermesCronRestoreAction, stderr: string) {
    const controlError = parseCronRestoreControlError(stderr);
    const detail =
      controlError?.message ??
      stderr
        .trim()
        .split(/\r?\n/u)
        .filter((line) => !line.startsWith(CONTROL_ERROR_PREFIX))
        .at(-1);
    super(`Hermes cron ${action} failed${detail ? `: ${detail}` : ""}`);
    this.name = "HermesCronRestoreControlFailure";
    this.action = action;
    this.stderr = stderr;
    this.controlCode = controlError?.code;
  }
}

export function isHermesCronRestoreDrainMarkerRollbackFailure(error: unknown): boolean {
  return (
    error instanceof HermesCronRestoreControlFailure &&
    error.action === "complete" &&
    error.controlCode === HERMES_CRON_RESTORE_DRAIN_MARKER_ROLLBACK_FAILED_CODE
  );
}

function executeCronRestoreControl(
  sandboxName: string,
  action: HermesCronRestoreAction,
  identity?: HermesCronRestoreIdentity,
  replacementIdentity?: HermesCronRestoreIdentity,
): string {
  const command = [HERMES_PYTHON, "-I", HERMES_CRON_CONTROL, action];
  if (identity) {
    command.push("--pid", String(identity.pid), "--start-time", String(identity.start_time));
    if (identity.drain_token) command.push(`--drain-token=${identity.drain_token}`);
  }
  if (replacementIdentity) {
    command.push(
      "--replacement-pid",
      String(replacementIdentity.pid),
      "--replacement-start-time",
      String(replacementIdentity.start_time),
    );
  }
  let result: SandboxCommandResult | null;
  try {
    result = executePrivilegedSandboxCommand(
      sandboxName,
      command,
      action === "begin" || action === "observe"
        ? BEGIN_TIMEOUT_MS
        : action === "recover" || action === "complete"
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
  return result.stdout;
}

function runCronRestoreControl(
  sandboxName: string,
  action: HermesCronRestoreReceiptAction,
  identity?: HermesCronRestoreIdentity,
  replacementIdentity?: HermesCronRestoreIdentity,
): HermesCronRestoreReceipt {
  return parseCronRestoreReceipt(
    executeCronRestoreControl(sandboxName, action, identity, replacementIdentity),
    action,
  );
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

export function completeHermesCronRestoreAfterGatewayReplacement(
  sandboxName: string,
  originalIdentity: HermesCronRestoreIdentity,
  verifiedReplacementIdentity: HermesCronRestoreIdentity,
): HermesCronRestoreIdentity {
  if (!originalIdentity.drain_token) {
    throw new Error("Hermes cron completion requires the held drain token");
  }
  if (sameGatewayIdentity(originalIdentity, verifiedReplacementIdentity)) {
    throw new Error("Hermes cron completion requires a replacement gateway identity");
  }
  if (verifiedReplacementIdentity.drain_token !== originalIdentity.drain_token) {
    throw new Error("Hermes cron completion changed the held drain token");
  }
  const receipt = runCronRestoreControl(
    sandboxName,
    "complete",
    originalIdentity,
    verifiedReplacementIdentity,
  );
  if (
    receipt.drain_token !== originalIdentity.drain_token ||
    !sameGatewayIdentity(receipt, verifiedReplacementIdentity)
  ) {
    throw new Error("Hermes cron completion changed the verified replacement gateway identity");
  }
  return {
    pid: receipt.pid,
    start_time: receipt.start_time,
    ...(receipt.drain_token ? { drain_token: receipt.drain_token } : {}),
  };
}

export function observeHermesCronReplacement(
  sandboxName: string,
  originalIdentity: HermesCronRestoreIdentity,
): HermesCronRestoreIdentity {
  if (!originalIdentity.drain_token) {
    throw new Error("Hermes cron replacement observation requires the held drain token");
  }
  const receipt = runCronRestoreControl(sandboxName, "observe", originalIdentity);
  if (
    receipt.drain_token !== originalIdentity.drain_token ||
    sameGatewayIdentity(receipt, originalIdentity)
  ) {
    throw new Error("Hermes cron observation did not bind to a replacement gateway identity");
  }
  return {
    pid: receipt.pid,
    start_time: receipt.start_time,
    ...(receipt.drain_token ? { drain_token: receipt.drain_token } : {}),
  };
}

function isLegacyCronRestoreControl(
  error: unknown,
  action: "prepare-recover" | "recover",
): boolean {
  if (!(error instanceof HermesCronRestoreControlFailure)) return false;
  const invalidAction =
    action === "prepare-recover"
      ? /argument action: invalid choice: ['"]prepare-recover['"]/u
      : /argument action: invalid choice: ['"]recover['"]/u;
  return (
    /can't open file ['"]\/usr\/local\/lib\/nemoclaw\/hermes-cron-restore-control\.py['"]: \[Errno 2\] No such file or directory/u.test(
      error.stderr,
    ) || invalidAction.test(error.stderr)
  );
}

export function prepareHermesCronRestoreRecovery(
  sandboxName: string,
): HermesCronRestorePreparationOutcome {
  let stdout: string;
  try {
    stdout = executeCronRestoreControl(sandboxName, "prepare-recover");
  } catch (error) {
    if (isLegacyCronRestoreControl(error, "prepare-recover")) return "unsupported";
    throw error;
  }
  return parseCronRestorePreparationReceipt(stdout);
}

export function recoverHermesCronRestore(sandboxName: string): HermesCronRestoreRecoveryOutcome {
  let receipt: HermesCronRestoreReceipt;
  try {
    receipt = runCronRestoreControl(sandboxName, "recover");
  } catch (error) {
    if (isLegacyCronRestoreControl(error, "recover")) return "unsupported";
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
  onGateTransition: (state: "acquired", identity: HermesCronRestoreIdentity) => void = () => {},
): PendingHermesCronRestore<T> {
  const identity = beginHermesCronRestore(sandboxName);
  onGateTransition("acquired", identity);
  const result = restore();
  if (!result.restoreSucceeded) {
    throw new HermesCronRestoreIncompleteError();
  }
  validateHermesCronRestore(sandboxName, identity);
  return { result, identity };
}
