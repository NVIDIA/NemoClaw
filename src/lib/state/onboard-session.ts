// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Onboard session management — create, load, save, and update the
 * onboarding session file (~/.nemoclaw/onboard-session.json) with
 * step-level progress tracking and file-based locking.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { SandboxPolicyAuthority } from "../adapters/openshell/policy-authority";
import { isErrnoException } from "../core/errno";
import { isObjectRecord, type JsonObject, type JsonValue } from "../core/json-types";
import { DEFAULT_GATEWAY_PORT, GATEWAY_PORT } from "../core/ports";
import {
  parseServingProfileProvenance,
  type ServingProfileProvenance,
} from "../inference/serving/profile-provenance";
import { normalizeWebSearchConfig, type WebSearchConfig } from "../inference/web-search";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import { compactSandboxMessagingPlanForPersistence } from "../messaging/persistence";
import { parseSandboxMessagingPlan } from "../messaging/plan-validation";
import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../name-validation";
import { describeGatewayOwner, type GatewayOwnerDescription } from "../onboard/gateway-ownership";
import {
  createOnboardMachineEvent,
  emitOnboardMachineEvent,
  machineStateFromOnboardSessionStep,
} from "../onboard/machine/events";
import {
  assertValidOnboardMachineTransition,
  isOnboardMachineState,
  isTerminalOnboardMachineState,
} from "../onboard/machine/transitions";
import type { OnboardMachineState, OnboardNonTerminalMachineState } from "../onboard/machine/types";
import { normalizeReasoningEffort, type ReasoningEffort } from "../onboard/reasoning-mode";
import {
  assertStationExpressInstallerResumeMatches,
  bindStationExpressProviderSelection,
  isValidStationExpressProviderState,
  isValidStationExpressReceiptGeneration,
  parseStationExpressResumeIntent,
  reconcileStationExpressInstallerResumeRetirement,
  type StationExpressResumeIntent,
} from "../onboard/station-express-resume";
import { redactSensitiveText, redactUrl } from "../security/redact";
import { inspectCheckpoint, serializeCheckpoint } from "./onboard-checkpoint";
import type { OnboardCheckpoint } from "./onboard-checkpoint-types";
import {
  assignSafeToolDisclosureUpdate,
  normalizeSessionToolDisclosure,
  preserveInvalidSessionToolDisclosure,
  type ToolDisclosure,
} from "./onboard-session-tool-disclosure";
import { nextMachineStateAfterCompletedStep } from "./onboard-step-state";
import {
  listRetainedSandboxRecoveryRecords as readRetainedSandboxRecoveryRecords,
  parseNemoClawPolicyCreationReceipt,
  recordRetainedSandboxRecovery as writeRetainedSandboxRecovery,
  retainedSandboxRecoveryAuthorityIsCurrent,
  retainedSandboxRecoveryFile,
  resolveRetainedSandboxRecovery as retireRetainedSandboxRecovery,
  type RecordRetainedSandboxRecoveryInput,
  type RetainedSandboxRecoveryRecord,
  type RetainedSandboxRecoveryReason,
  type RetainedSandboxVerifiedEffectivePolicyIdentity,
} from "./onboard-session/retained-sandbox-recovery";
import type { SandboxHostMount } from "./registry/types";
import { hasUnsafeHostMountTerminalText } from "./registry/host-mount";
import { nemoclawStateRoot } from "./state-root";

export { normalizePersistedSandboxHostMounts } from "./registry/host-mount";

export const SESSION_VERSION = 1;
export const MACHINE_SNAPSHOT_VERSION = 1;
export const CANCELLATION_RECOVERY_STATUS = "recovery_required";
const INVALID_HOST_MOUNT_SESSIONS = new WeakSet<object>();
export const SESSION_DIR = nemoclawStateRoot(process.env.HOME || "/tmp", GATEWAY_PORT);
export const SESSION_FILE = path.join(SESSION_DIR, "onboard-session.json");
export const LOCK_FILE = path.join(SESSION_DIR, "onboard.lock");
export const RETAINED_SANDBOX_RECOVERY_FILE = retainedSandboxRecoveryFile(SESSION_DIR);
const LEGACY_STATE_MIGRATION_LOCK = path.join(
  nemoclawStateRoot(process.env.HOME || "/tmp", DEFAULT_GATEWAY_PORT),
  ".gateway-state-migration.lock",
);
const SAFE_VLLM_INSTALL_MODEL = /^[A-Za-z0-9._:/-]+$/;

export class InvalidPersistedPolicyAuthorityError extends Error {}
export class InvalidPersistedApfInterceptorIntentError extends Error {}
export class InvalidPersistedCancellationRecoveryError extends Error {}

// Session-specific aliases for the shared JSON types.
type SessionJsonValue = JsonValue;
type UnknownRecord = JsonObject;
type StepStatus = "pending" | "in_progress" | "complete" | "failed" | "skipped";
export type HermesAuthMethod = "oauth" | "api_key";

const STEP_STATES: readonly StepStatus[] = [
  "pending",
  "in_progress",
  "complete",
  "failed",
  "skipped",
];
const VALID_STEP_STATES: ReadonlySet<string> = new Set(STEP_STATES);

export { hasInvalidSessionToolDisclosure } from "./onboard-session-tool-disclosure";

// ── Types ────────────────────────────────────────────────────────

export interface StepState {
  status: StepStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface SessionFailure {
  step: string | null;
  message: string | null;
  recordedAt: string;
  interrupted?: boolean;
}

export interface SessionCancellationRecovery {
  readonly reason: "cancelled_after_sandbox_creation" | "retained_after_sandbox_creation_failure";
  readonly sandboxName: string;
  readonly sandboxIdentityFingerprint: string | null;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string;
  readonly verifiedEffectivePolicyIdentity: RetainedSandboxVerifiedEffectivePolicyIdentity | null;
  readonly createAttemptNonce: string;
  readonly policyCreationReceipt: RetainedSandboxRecoveryRecord["policyCreationReceipt"];
  readonly recordedAt: string;
}

function sameCancellationRecovery(
  left: SessionCancellationRecovery | null,
  right: SessionCancellationRecovery | null,
): boolean {
  if (left === null || right === null) return left === right;
  const leftPolicy = left.verifiedEffectivePolicyIdentity;
  const rightPolicy = right.verifiedEffectivePolicyIdentity;
  const leftReceipt = left.policyCreationReceipt;
  const rightReceipt = right.policyCreationReceipt;
  return (
    left.reason === right.reason &&
    left.sandboxName === right.sandboxName &&
    left.sandboxIdentityFingerprint === right.sandboxIdentityFingerprint &&
    left.gatewayName === right.gatewayName &&
    left.gatewayPort === right.gatewayPort &&
    left.lifecycleGeneration === right.lifecycleGeneration &&
    left.createAttemptNonce === right.createAttemptNonce &&
    left.recordedAt === right.recordedAt &&
    (leftPolicy === null || rightPolicy === null
      ? leftPolicy === rightPolicy
      : leftPolicy.hash === rightPolicy.hash &&
        leftPolicy.activeVersion === rightPolicy.activeVersion) &&
    (leftReceipt === null || rightReceipt === null
      ? leftReceipt === rightReceipt
      : leftReceipt.schemaVersion === rightReceipt.schemaVersion &&
        leftReceipt.origin === rightReceipt.origin &&
        leftReceipt.gatewayName === rightReceipt.gatewayName &&
        leftReceipt.gatewayPort === rightReceipt.gatewayPort &&
        leftReceipt.sandboxName === rightReceipt.sandboxName &&
        leftReceipt.lifecycleGeneration === rightReceipt.lifecycleGeneration &&
        leftReceipt.sandboxIdentityFingerprint === rightReceipt.sandboxIdentityFingerprint &&
        leftReceipt.policyHash === rightReceipt.policyHash &&
        leftReceipt.policyVersion === rightReceipt.policyVersion)
  );
}

export interface SessionMetadata {
  gatewayName: string;
  fromDockerfile: string | null;
  hostMounts?: SandboxHostMount[];
}

function structurallyInvalidHostMounts(source: unknown): boolean {
  if (typeof source !== "object" || source === null) return false;
  const metadata = (source as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return false;
  const hostMounts = (metadata as { hostMounts?: unknown }).hostMounts;
  if (hostMounts === undefined) return false;
  return (
    !Array.isArray(hostMounts) ||
    hostMounts.some(
      (candidate) =>
        !isObject(candidate) ||
        typeof candidate.source !== "string" ||
        typeof candidate.target !== "string" ||
        hasUnsafeHostMountTerminalText(candidate.source) ||
        hasUnsafeHostMountTerminalText(candidate.target) ||
        candidate.readOnly !== true,
    )
  );
}

export function hasInvalidSessionHostMounts(session: unknown): boolean {
  return (
    (typeof session === "object" && session !== null && INVALID_HOST_MOUNT_SESSIONS.has(session)) ||
    structurallyInvalidHostMounts(session)
  );
}

function preserveInvalidSessionHostMounts(source: unknown, target: object): void {
  if (hasInvalidSessionHostMounts(source)) INVALID_HOST_MOUNT_SESSIONS.add(target);
}

export type SessionRecoveryReceiptReason =
  | "failed_terminal_snapshot"
  | "reopened_complete_snapshot";

/**
 * Durable, secret-free receipt for a terminal snapshot recovery.
 *
 * The receipt remains attached until the next machine snapshot replaces it.
 * If the process stops after the repaired snapshot is saved but before the
 * next transition, the next resume retries the same observer-dispatch ID.
 */
export interface SessionRecoveryReceipt {
  id: string;
  reason: SessionRecoveryReceiptReason;
  entry: OnboardNonTerminalMachineState;
  appliedAt: string;
  revision: number;
}

export function createSessionRecoveryReceiptId(
  sessionId: string,
  revision: number,
  reason: SessionRecoveryReceiptReason,
  entry: OnboardNonTerminalMachineState,
): string {
  return createHash("sha256")
    .update(JSON.stringify([sessionId, revision, reason, entry]))
    .digest("hex");
}

export interface OnboardMachineSnapshot {
  version: typeof MACHINE_SNAPSHOT_VERSION;
  state: OnboardMachineState;
  stateEnteredAt: string | null;
  revision: number;
  recoveryReceipt?: SessionRecoveryReceipt;
}

export interface SandboxPromptProgress {
  sandboxName: boolean;
  webSearch: boolean;
  messaging: boolean;
  resourceProfile: boolean;
}

export interface SessionResourceProfile {
  cpu: string;
  memory: string;
}

export interface Session {
  version: number;
  sessionId: string;
  resumable: boolean;
  status: string;
  mode: string;
  startedAt: string;
  updatedAt: string;
  lastStepStarted: string | null;
  lastCompletedStep: string | null;
  failure: SessionFailure | null;
  cancellationRecovery: SessionCancellationRecovery | null;
  agent: string | null;
  sandboxName: string | null;
  provider: string | null;
  model: string | null;
  /** Secret-free model intent retained only while a managed vLLM install is unfinished. */
  vllmInstallModel: string | null;
  /** GPU exposed to the host-side managed vLLM container for this onboarding attempt. */
  vllmGpuDevice: string | null;
  /** Exact secret-free serving recipe identity selected before runtime side effects. */
  servingProfileProvenance: ServingProfileProvenance | null;
  /** Secret-free installer choices needed to retry an interrupted DGX Station Express run. */
  stationExpressIntent: StationExpressResumeIntent | null;
  /** Receipt generation durably awaiting exact-match retirement after Station completion. */
  stationExpressReceiptRetirement: string | null;
  endpointUrl: string | null;
  credentialEnv: string | null;
  hermesAuthMethod: HermesAuthMethod | null;
  preferredInferenceApi: string | null;
  compatibleEndpointReasoning: string | null;
  compatibleEndpointReasoningEffort: ReasoningEffort | null;
  nimContainer: string | null;
  routerPid: number | null;
  routerCredentialHash: string | null;
  webSearchConfig: WebSearchConfig | null;
  /** Completed secret-free choices that can be reused by an interrupted sandbox setup. */
  sandboxPromptProgress: SandboxPromptProgress;
  /** The selected sandbox resource values; null is an explicit OpenShell-default choice. */
  resourceProfile: SessionResourceProfile | null;
  /** Selected preference, retained even when a model-specific safeguard downgrades it. */
  toolDisclosure: ToolDisclosure;
  /** Enables credential-free OTLP trace export to NemoClaw's fixed local collector boundary. */
  observabilityEnabled: boolean;
  /** True when observability was explicitly enabled or disabled for this resumable run. */
  observabilityRequestedExplicitly: boolean;
  /** Operator-selected APF create mode; this is not observed policy provenance. */
  apfInterceptorRequested: boolean;
  hermesToolGateways: string[] | null;
  policyPresets: string[] | null;
  /** Policy authority selected from OpenShell metadata before policy-dependent effects. */
  policyAuthority: SandboxPolicyAuthority | null;
  messagingPlan: SandboxMessagingPlan | null;
  /** Non-secret names of credential providers registered before sandbox setup completed. */
  stagedCredentialProviders: string[];
  // SHA-256 hex digest of every legacy credential value successfully
  // written to the OpenShell gateway during this onboard session, keyed by
  // env-name. Persisted across process restarts so a `--resume` run that
  // skips already-completed upserts still knows the migration completed
  // earlier and can safely remove ~/.nemoclaw/credentials.json on the
  // final completeSession. Storing the hash (not just the env-name) lets
  // us detect when the legacy file value was edited between runs, when
  // the gateway provider was reset out-of-band, or when an unrelated
  // session is found on disk — in any of those cases the in-memory
  // migrated set is NOT seeded from the persisted record, so the cleanup
  // gate keeps the file until the *current* value is actually re-migrated.
  migratedLegacyValueHashes: Record<string, string> | null;
  gpuPassthrough: boolean;
  telegramConfig: TelegramConfig | null;
  wechatConfig: WechatConfig | null;
  metadata: SessionMetadata;
  machine: OnboardMachineSnapshot;
  checkpoint: OnboardCheckpoint | null;
  steps: Record<string, StepState>;
}

export interface TelegramConfig {
  requireMention: boolean;
}

export interface WechatConfig {
  // Stable per-account id returned by iLink (`ilink_bot_id`). Non-secret.
  accountId?: string;
  // Per-account base URL. Rotates via IDC redirects, so a change here is a
  // signal that we are now talking to a different gateway and the sandbox
  // must be rebuilt.
  baseUrl?: string;
  // WeChat user id of the operator who scanned the QR. PII-adjacent but not
  // secret — added to the DM allowlist by default.
  userId?: string;
}

export interface LockInfo {
  pid: number;
  startedAt: string | null;
  command: string | null;
}

export interface LockResult {
  acquired: boolean;
  lockFile: string;
  stale: boolean;
  holderPid?: number;
  holderStartedAt?: string | null;
  holderCommand?: string | null;
}

export interface SessionUpdates {
  // Nullable fields accept `null` as an explicit clear (e.g. a provider
  // switch from remote→local clears `credentialEnv`). `undefined` means
  // "leave unchanged". See filterSafeUpdates(). GH #2625.
  sandboxName?: string | null;
  provider?: string | null;
  model?: string | null;
  servingProfileProvenance?: ServingProfileProvenance | null;
  endpointUrl?: string | null;
  credentialEnv?: string | null;
  hermesAuthMethod?: HermesAuthMethod | null;
  preferredInferenceApi?: string | null;
  compatibleEndpointReasoning?: string | null;
  compatibleEndpointReasoningEffort?: ReasoningEffort | null;
  nimContainer?: string | null;
  routerPid?: number;
  routerCredentialHash?: string;
  webSearchConfig?: WebSearchConfig | null;
  toolDisclosure?: ToolDisclosure;
  observabilityEnabled?: boolean;
  hermesToolGateways?: string[] | null;
  policyPresets?: string[] | null;
  policyAuthority?: SandboxPolicyAuthority | null;
  messagingPlan?: SandboxMessagingPlan | null;
  migratedLegacyValueHashes?: Record<string, string>;
  gpuPassthrough?: boolean;
  telegramConfig?: TelegramConfig | null;
  wechatConfig?: WechatConfig | null;
  metadata?: { gatewayName?: string; fromDockerfile?: string | null };
  /** Ephemeral vLLM checkpoint proof consumed by Station provider binding; never persisted. */
  stationExpressModelIdentity?: string;
}

export interface DebugSessionSummary {
  version: number;
  sessionId: string;
  status: string;
  resumable: boolean;
  mode: string;
  startedAt: string;
  updatedAt: string;
  sandboxName: string | null;
  provider: string | null;
  model: string | null;
  vllmInstallModel: string | null;
  vllmGpuDevice: string | null;
  servingProfileProvenance: ServingProfileProvenance | null;
  endpointUrl: string | null;
  credentialEnv: string | null;
  hermesAuthMethod: HermesAuthMethod | null;
  preferredInferenceApi: string | null;
  compatibleEndpointReasoning: string | null;
  compatibleEndpointReasoningEffort: ReasoningEffort | null;
  nimContainer: string | null;
  toolDisclosure: ToolDisclosure;
  observabilityEnabled: boolean;
  observabilityRequestedExplicitly: boolean;
  apfInterceptorRequested: boolean;
  hermesToolGateways: string[] | null;
  policyPresets: string[] | null;
  policyAuthority: SandboxPolicyAuthority | null;
  gpuPassthrough: boolean;
  lastStepStarted: string | null;
  lastCompletedStep: string | null;
  failure: SessionFailure | null;
  cancellationRecovery: SessionCancellationRecovery | null;
  gatewayAuthority: GatewayOwnerDescription | null;
  machine: OnboardMachineSnapshot;
  steps: Record<string, StepState>;
}

// ── Helpers ──────────────────────────────────────────────────────

function ensureSessionDir(): void {
  assertSessionDirectoryHasNoSymlinks();
  fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  assertSessionDirectoryHasNoSymlinks();
  const stat = fs.lstatSync(SESSION_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("NemoClaw onboarding state directory is not a secure directory.");
  }
}

function assertSessionDirectoryHasNoSymlinks(): void {
  const home = path.resolve(process.env.HOME || "/tmp");
  let current = path.resolve(SESSION_DIR);
  while (current !== home && current !== path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(
          `NemoClaw onboarding state directory cannot be a symbolic link: ${current}`,
        );
      }
    } catch (error) {
      if (!(isErrnoException(error) && error.code === "ENOENT")) throw error;
    }
    current = path.dirname(current);
  }
}

interface PinnedSessionDirectory {
  readonly descriptor: number;
  readonly stat: fs.Stats;
}

function sameSessionFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function revalidatePinnedSessionDirectory(directory: PinnedSessionDirectory): void {
  assertSessionDirectoryHasNoSymlinks();
  const descriptorStat = fs.fstatSync(directory.descriptor);
  const pathStat = fs.lstatSync(SESSION_DIR);
  if (
    !descriptorStat.isDirectory() ||
    pathStat.isSymbolicLink() ||
    !pathStat.isDirectory() ||
    !sameSessionFileIdentity(directory.stat, descriptorStat) ||
    !sameSessionFileIdentity(directory.stat, pathStat)
  ) {
    throw new Error("NemoClaw onboarding state directory changed during validation.");
  }
}

function openPinnedSessionDirectory(): PinnedSessionDirectory {
  ensureSessionDir();
  const descriptor = fs.openSync(
    SESSION_DIR,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0),
  );
  try {
    const directory = { descriptor, stat: fs.fstatSync(descriptor) };
    revalidatePinnedSessionDirectory(directory);
    return directory;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function assertSessionFileIdentity(descriptor: number, filePath: string): fs.Stats {
  const descriptorStat = fs.fstatSync(descriptor);
  const pathStat = fs.lstatSync(filePath);
  if (
    !descriptorStat.isFile() ||
    descriptorStat.nlink !== 1 ||
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.nlink !== 1 ||
    !sameSessionFileIdentity(descriptorStat, pathStat)
  ) {
    throw new Error("NemoClaw onboarding session state changed during validation.");
  }
  return descriptorStat;
}

export function sessionPath(): string {
  return SESSION_FILE;
}

function defaultSteps(): Record<string, StepState> {
  return {
    preflight: { status: "pending", startedAt: null, completedAt: null, error: null },
    gateway: { status: "pending", startedAt: null, completedAt: null, error: null },
    sandbox: { status: "pending", startedAt: null, completedAt: null, error: null },
    provider_selection: { status: "pending", startedAt: null, completedAt: null, error: null },
    inference: { status: "pending", startedAt: null, completedAt: null, error: null },
    openclaw: { status: "pending", startedAt: null, completedAt: null, error: null },
    agent_setup: { status: "pending", startedAt: null, completedAt: null, error: null },
    policies: { status: "pending", startedAt: null, completedAt: null, error: null },
  };
}

export function isObject(value: unknown): value is UnknownRecord {
  return isObjectRecord(value);
}

function readString(value: SessionJsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function parseVllmInstallModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const model = value.trim();
  return model.length > 0 && model.length <= 512 && SAFE_VLLM_INSTALL_MODEL.test(model)
    ? model
    : null;
}

function parseVllmGpuDevice(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (/^\d+$/.test(candidate)) {
    const index = Number(candidate);
    if (Number.isSafeInteger(index)) return String(index);
  }
  return /^GPU-[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/.test(candidate)
    ? `GPU-${candidate.slice("GPU-".length).toLowerCase()}`
    : null;
}

function readHermesAuthMethod(value: SessionJsonValue | undefined): HermesAuthMethod | null {
  return value === "oauth" || value === "api_key" ? value : null;
}

function readPolicyAuthority(value: unknown): SandboxPolicyAuthority | null {
  return value === "nemoclaw-managed" || value === "externally-managed" ? value : null;
}

function readPositiveInteger(value: SessionJsonValue | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function readNonNegativeInteger(value: SessionJsonValue | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function readCanonicalIsoTimestamp(value: SessionJsonValue | undefined): string | null {
  if (typeof value !== "string") return null;
  try {
    return new Date(value).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

function readStringArray(value: SessionJsonValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function readStringRecord(value: SessionJsonValue | undefined): Record<string, string> | null {
  if (!isObject(value)) return null;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof k === "string" && typeof v === "string") result[k] = v;
  }
  return result;
}

function isStepStatus(value: string): value is StepStatus {
  return VALID_STEP_STATES.has(value);
}

function readStepStatus(value: SessionJsonValue | undefined): StepStatus | null {
  if (typeof value !== "string") return null;
  return isStepStatus(value) ? value : null;
}

function parseWebSearchConfig(value: SessionJsonValue | undefined): WebSearchConfig | null {
  if (!isObject(value) || value.fetchEnabled !== true) return null;
  return normalizeWebSearchConfig(value as Partial<WebSearchConfig>);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidCheckpointedSandboxName(value: unknown): boolean {
  return (
    typeof value === "string" && value.length <= NAME_MAX_LENGTH && NAME_VALID_PATTERN.test(value)
  );
}

function isValidNullableWebSearchChoice(value: unknown): boolean {
  return value === null || parseWebSearchConfig(value as SessionJsonValue | undefined) !== null;
}

function isValidNullableMessagingChoice(value: unknown, sandboxName: unknown): boolean {
  return (
    value === null ||
    (typeof sandboxName === "string" && parseSandboxMessagingPlan(value, { sandboxName }) !== null)
  );
}

function isValidNullableResourceChoice(value: unknown): boolean {
  return value === null || parseSessionResourceProfile(value) !== null;
}

function parseSandboxPromptProgress(
  value: unknown,
  choices: Record<string, unknown>,
): SandboxPromptProgress {
  const progress = isObject(value) ? value : {};
  return {
    sandboxName:
      progress.sandboxName === true &&
      hasOwn(choices, "sandboxName") &&
      isValidCheckpointedSandboxName(choices.sandboxName),
    webSearch:
      progress.webSearch === true &&
      hasOwn(choices, "webSearchConfig") &&
      isValidNullableWebSearchChoice(choices.webSearchConfig),
    messaging:
      progress.messaging === true &&
      hasOwn(choices, "messagingPlan") &&
      isValidNullableMessagingChoice(choices.messagingPlan, choices.sandboxName),
    resourceProfile:
      progress.resourceProfile === true &&
      hasOwn(choices, "resourceProfile") &&
      isValidNullableResourceChoice(choices.resourceProfile),
  };
}

function parseSessionResourceProfile(value: unknown): SessionResourceProfile | null {
  if (!isObject(value)) return null;
  const cpu = readString(value.cpu);
  const memory = readString(value.memory);
  return cpu !== null && memory !== null ? { cpu, memory } : null;
}

function parseTelegramConfig(value: unknown): TelegramConfig | null {
  if (!isObject(value)) return null;
  if (value.requireMention === true) return { requireMention: true };
  if (value.requireMention === false) return { requireMention: false };
  return null;
}

function parseWechatConfig(value: unknown): WechatConfig | null {
  if (!isObject(value)) return null;
  const result: WechatConfig = {};
  const accountId = readString(value.accountId);
  const baseUrl = readString(value.baseUrl);
  const userId = readString(value.userId);
  if (accountId) result.accountId = accountId;
  if (baseUrl) result.baseUrl = baseUrl;
  if (userId) result.userId = userId;
  return Object.keys(result).length > 0 ? result : null;
}

function parseSessionMetadata(value: SessionJsonValue | undefined): SessionMetadata | undefined {
  if (!isObject(value)) return undefined;
  const hostMounts =
    Array.isArray(value.hostMounts) &&
    value.hostMounts.every(
      (candidate) =>
        isObject(candidate) &&
        typeof candidate.source === "string" &&
        typeof candidate.target === "string" &&
        !hasUnsafeHostMountTerminalText(candidate.source) &&
        !hasUnsafeHostMountTerminalText(candidate.target) &&
        candidate.readOnly === true,
    )
      ? value.hostMounts.map((candidate): SandboxHostMount => ({
          source: (candidate as { source: string }).source,
          target: (candidate as { target: string }).target,
          readOnly: true,
        }))
      : [];
  return {
    gatewayName: readString(value.gatewayName) ?? "nemoclaw",
    fromDockerfile: readString(value.fromDockerfile),
    ...(hostMounts.length > 0 ? { hostMounts } : {}),
  };
}

function parseStepState(value: SessionJsonValue | undefined): StepState | null {
  if (!isObject(value)) return null;
  const status = readStepStatus(value.status);
  if (!status) return null;
  return {
    status,
    startedAt: readString(value.startedAt),
    completedAt: readString(value.completedAt),
    error: redactSensitiveText(value.error),
  };
}

function parseSessionRecoveryReceipt(
  value: SessionJsonValue | undefined,
  snapshotState: OnboardMachineState,
  snapshotStateEnteredAt: string | null,
  snapshotRevision: number,
  sessionId: string,
): SessionRecoveryReceipt | null {
  if (!isObject(value)) return null;
  const id = readString(value.id);
  const reason = readString(value.reason);
  const entry = readString(value.entry);
  const appliedAt = readCanonicalIsoTimestamp(value.appliedAt);
  const revision = readNonNegativeInteger(value.revision);
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
  if (reason !== "failed_terminal_snapshot" && reason !== "reopened_complete_snapshot") {
    return null;
  }
  if (!entry || !isOnboardMachineState(entry) || isTerminalOnboardMachineState(entry)) return null;
  if (
    entry !== snapshotState ||
    !appliedAt ||
    appliedAt !== snapshotStateEnteredAt ||
    revision !== snapshotRevision ||
    id !== createSessionRecoveryReceiptId(sessionId, revision, reason, entry)
  ) {
    return null;
  }
  return { id, reason, entry, appliedAt, revision };
}

function parseMachineSnapshot(
  value: SessionJsonValue | undefined,
  sessionId: string,
): OnboardMachineSnapshot | null {
  if (!isObject(value) || value.version !== MACHINE_SNAPSHOT_VERSION) return null;
  if (!isOnboardMachineState(value.state)) return null;
  const stateEnteredAt = readString(value.stateEnteredAt);
  const revision = readNonNegativeInteger(value.revision) ?? 0;
  const recoveryReceipt = parseSessionRecoveryReceipt(
    value.recoveryReceipt,
    value.state,
    stateEnteredAt,
    revision,
    sessionId,
  );
  return {
    version: MACHINE_SNAPSHOT_VERSION,
    state: value.state,
    stateEnteredAt,
    revision,
    ...(recoveryReceipt ? { recoveryReceipt } : {}),
  };
}

function parseStoredCheckpoint(value: unknown): OnboardCheckpoint | null {
  const inspected = inspectCheckpoint(value);
  return inspected.status === "loaded" ? inspected.checkpoint : null;
}

function parseLockInfo(value: SessionJsonValue | undefined): LockInfo | null {
  if (!isObject(value) || typeof value.pid !== "number") return null;
  return {
    pid: value.pid,
    startedAt: readString(value.startedAt),
    command: readString(value.command),
  };
}

// redactSensitiveText and redactUrl imported from ./redact (#2381).
export { redactSensitiveText, redactUrl };

export function sanitizeFailure(
  input:
    | {
        step?: SessionJsonValue;
        message?: SessionJsonValue;
        recordedAt?: SessionJsonValue;
        interrupted?: SessionJsonValue;
      }
    | null
    | undefined,
): SessionFailure | null {
  if (!input) return null;
  const step = readString(input.step);
  const message = redactSensitiveText(input.message);
  const recordedAt = readString(input.recordedAt) ?? new Date().toISOString();
  const interrupted = input.interrupted === true;
  return step || message ? { step, message, recordedAt, interrupted } : null;
}

function parseSessionCancellationRecovery(
  value: SessionJsonValue | undefined,
): SessionCancellationRecovery | null {
  if (
    !isObject(value) ||
    (value.reason !== "cancelled_after_sandbox_creation" &&
      value.reason !== "retained_after_sandbox_creation_failure")
  ) {
    return null;
  }
  const sandboxName = readString(value.sandboxName);
  const recordedAt = readCanonicalIsoTimestamp(value.recordedAt);
  const fingerprint =
    value.sandboxIdentityFingerprint === null ? null : readString(value.sandboxIdentityFingerprint);
  const gatewayName = readString(value.gatewayName);
  const gatewayPort = value.gatewayPort;
  const lifecycleGeneration = readString(value.lifecycleGeneration);
  const createAttemptNonce = readString(value.createAttemptNonce);
  const verifiedEffectivePolicyIdentity = (() => {
    if (value.verifiedEffectivePolicyIdentity === null) return null;
    if (!isObject(value.verifiedEffectivePolicyIdentity)) return undefined;
    const hash = readString(value.verifiedEffectivePolicyIdentity.hash);
    const activeVersion = value.verifiedEffectivePolicyIdentity.activeVersion;
    return hash && Number.isSafeInteger(activeVersion) && Number(activeVersion) > 0
      ? { hash, activeVersion: Number(activeVersion) }
      : undefined;
  })();
  let policyCreationReceipt: RetainedSandboxRecoveryRecord["policyCreationReceipt"] = null;
  if (value.policyCreationReceipt !== null) {
    try {
      policyCreationReceipt = parseNemoClawPolicyCreationReceipt(value.policyCreationReceipt);
    } catch {
      return null;
    }
  }
  if (
    !sandboxName ||
    sandboxName.length > NAME_MAX_LENGTH ||
    !NAME_VALID_PATTERN.test(sandboxName) ||
    !recordedAt ||
    (fingerprint !== null && !/^[0-9a-f]{64}$/u.test(fingerprint)) ||
    !gatewayName ||
    !Number.isSafeInteger(gatewayPort) ||
    Number(gatewayPort) < 1024 ||
    Number(gatewayPort) > 65_535 ||
    !lifecycleGeneration ||
    verifiedEffectivePolicyIdentity === undefined ||
    !createAttemptNonce ||
    !/^[0-9a-f]{62}$/u.test(createAttemptNonce) ||
    (policyCreationReceipt !== null &&
      (policyCreationReceipt.gatewayName !== gatewayName ||
        policyCreationReceipt.gatewayPort !== Number(gatewayPort) ||
        policyCreationReceipt.sandboxName !== sandboxName ||
        policyCreationReceipt.lifecycleGeneration !== lifecycleGeneration ||
        policyCreationReceipt.sandboxIdentityFingerprint !== fingerprint ||
        policyCreationReceipt.policyHash !== verifiedEffectivePolicyIdentity?.hash ||
        policyCreationReceipt.policyVersion !== verifiedEffectivePolicyIdentity?.activeVersion))
  ) {
    return null;
  }
  return {
    reason: value.reason,
    sandboxName,
    sandboxIdentityFingerprint: fingerprint,
    gatewayName,
    gatewayPort: Number(gatewayPort),
    lifecycleGeneration,
    verifiedEffectivePolicyIdentity,
    createAttemptNonce,
    policyCreationReceipt,
    recordedAt,
  };
}

// ── Session CRUD ─────────────────────────────────────────────────

function createMachineSnapshot(
  state: OnboardMachineState,
  stateEnteredAt: string | null,
  revision = 0,
): OnboardMachineSnapshot {
  return {
    version: MACHINE_SNAPSHOT_VERSION,
    state,
    stateEnteredAt,
    revision: Math.max(0, Math.trunc(revision)),
  };
}

function inferMachineState(session: Session): OnboardMachineState {
  if (session.status === "complete") return "complete";
  if (session.status === "failed") return "failed";

  const startedState = machineStateFromOnboardSessionStep(session.lastStepStarted);
  const startedStep = session.lastStepStarted ? session.steps[session.lastStepStarted] : null;
  if (startedState && startedStep?.status === "in_progress") return startedState;

  return nextMachineStateAfterCompletedStep(session.lastCompletedStep, session) ?? "init";
}

function inferMachineStateEnteredAt(session: Session, state: OnboardMachineState): string | null {
  if (state === "failed") return session.failure?.recordedAt ?? session.updatedAt;
  if (state === "complete") return session.updatedAt;

  const startedState = machineStateFromOnboardSessionStep(session.lastStepStarted);
  const startedStep = session.lastStepStarted ? session.steps[session.lastStepStarted] : null;
  if (state === startedState && startedStep?.status === "in_progress") {
    return startedStep.startedAt ?? session.updatedAt;
  }

  if (nextMachineStateAfterCompletedStep(session.lastCompletedStep, session) === state) {
    const completedStep = session.lastCompletedStep
      ? session.steps[session.lastCompletedStep]
      : null;
    return completedStep?.completedAt ?? session.updatedAt;
  }

  return session.startedAt;
}

function inferMachineSnapshot(session: Session): OnboardMachineSnapshot {
  const state = inferMachineState(session);
  return createMachineSnapshot(state, inferMachineStateEnteredAt(session, state));
}

function transitionMachineSnapshot(
  session: Session,
  state: OnboardMachineState,
  now: string,
): void {
  const current = session.machine ?? createMachineSnapshot("init", session.startedAt);
  if (current.state === state) {
    session.machine = {
      ...current,
      stateEnteredAt: current.stateEnteredAt ?? now,
    };
    return;
  }
  session.machine = createMachineSnapshot(state, now, current.revision + 1);
  syncCheckpointMachineState(session, state, now);
}

export function syncCheckpointMachineState(
  session: Session,
  state: OnboardMachineState,
  updatedAt: string,
): void {
  if (!session.checkpoint) return;
  session.checkpoint = { ...session.checkpoint, machineState: state, updatedAt };
}

export function createSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  const startedAt = overrides.startedAt ?? now;
  const sessionId = overrides.sessionId ?? `${Date.now()}-${randomUUID()}`;
  const steps = {
    ...defaultSteps(),
    ...(overrides.steps ?? {}),
  };
  const policyAuthority = readPolicyAuthority(overrides.policyAuthority);
  const session: Session = {
    version: SESSION_VERSION,
    sessionId,
    resumable: true,
    status: "in_progress",
    mode: overrides.mode ?? "interactive",
    startedAt,
    updatedAt: overrides.updatedAt ?? now,
    lastStepStarted: overrides.lastStepStarted ?? null,
    lastCompletedStep: overrides.lastCompletedStep ?? null,
    failure: overrides.failure ?? null,
    cancellationRecovery: parseSessionCancellationRecovery(
      overrides.cancellationRecovery as SessionJsonValue | undefined,
    ),
    agent: overrides.agent ?? null,
    sandboxName: overrides.sandboxName ?? null,
    provider: overrides.provider ?? null,
    model: overrides.model ?? null,
    vllmInstallModel: parseVllmInstallModel(overrides.vllmInstallModel),
    vllmGpuDevice: parseVllmGpuDevice(overrides.vllmGpuDevice),
    servingProfileProvenance: parseServingProfileProvenance(overrides.servingProfileProvenance),
    stationExpressIntent: parseStationExpressResumeIntent(overrides.stationExpressIntent),
    stationExpressReceiptRetirement: isValidStationExpressReceiptGeneration(
      overrides.stationExpressReceiptRetirement,
    )
      ? overrides.stationExpressReceiptRetirement
      : null,
    endpointUrl: overrides.endpointUrl ?? null,
    credentialEnv: overrides.credentialEnv ?? null,
    hermesAuthMethod: overrides.hermesAuthMethod ?? null,
    preferredInferenceApi: overrides.preferredInferenceApi ?? null,
    compatibleEndpointReasoning: overrides.compatibleEndpointReasoning ?? null,
    compatibleEndpointReasoningEffort: normalizeReasoningEffort(
      overrides.compatibleEndpointReasoningEffort,
    ),
    nimContainer: overrides.nimContainer ?? null,
    routerPid: readPositiveInteger(overrides.routerPid),
    routerCredentialHash: overrides.routerCredentialHash ?? null,
    webSearchConfig: normalizeWebSearchConfig(overrides.webSearchConfig),
    sandboxPromptProgress: parseSandboxPromptProgress(
      overrides.sandboxPromptProgress,
      overrides as Record<string, unknown>,
    ),
    resourceProfile: parseSessionResourceProfile(overrides.resourceProfile),
    toolDisclosure: normalizeSessionToolDisclosure(overrides.toolDisclosure),
    observabilityEnabled: overrides.observabilityEnabled === true,
    observabilityRequestedExplicitly: overrides.observabilityRequestedExplicitly === true,
    apfInterceptorRequested: overrides.apfInterceptorRequested === true,
    hermesToolGateways: readStringArray(overrides.hermesToolGateways),
    policyPresets:
      policyAuthority === "externally-managed" ? null : readStringArray(overrides.policyPresets),
    policyAuthority,
    messagingPlan: parseSandboxMessagingPlan(overrides.messagingPlan),
    stagedCredentialProviders: readStringArray(overrides.stagedCredentialProviders) ?? [],
    migratedLegacyValueHashes: overrides.migratedLegacyValueHashes
      ? readStringRecord(overrides.migratedLegacyValueHashes)
      : null,
    gpuPassthrough: overrides.gpuPassthrough === true,
    telegramConfig: parseTelegramConfig(overrides.telegramConfig),
    wechatConfig: parseWechatConfig(overrides.wechatConfig),
    metadata: {
      gatewayName: overrides.metadata?.gatewayName ?? "nemoclaw",
      fromDockerfile: overrides.metadata?.fromDockerfile ?? null,
      ...(overrides.metadata?.hostMounts?.length
        ? { hostMounts: overrides.metadata.hostMounts.map((mount) => ({ ...mount })) }
        : {}),
    },
    machine:
      parseMachineSnapshot(overrides.machine as SessionJsonValue | undefined, sessionId) ??
      createMachineSnapshot("init", startedAt),
    checkpoint: parseStoredCheckpoint(overrides.checkpoint),
    steps,
  };
  preserveInvalidSessionToolDisclosure(overrides, session);
  preserveInvalidSessionHostMounts(overrides, session);
  return session;
}

export function normalizeSession(data: Session | SessionJsonValue | undefined): Session | null {
  if (!isObject(data) || data.version !== SESSION_VERSION) return null;
  if (
    hasOwn(data, "apfInterceptorRequested") &&
    typeof data.apfInterceptorRequested !== "boolean"
  ) {
    throw new InvalidPersistedApfInterceptorIntentError(
      "Refusing to load the onboarding session: the saved APF selection is invalid.",
    );
  }
  const policyAuthority = readPolicyAuthority(data.policyAuthority);
  if (hasOwn(data, "policyAuthority") && data.policyAuthority !== null && !policyAuthority) {
    throw new InvalidPersistedPolicyAuthorityError(
      "Refusing to load the onboarding session: the saved policy authority is invalid.",
    );
  }
  const servingProfileProvenance = parseServingProfileProvenance(data.servingProfileProvenance);
  if (
    hasOwn(data, "servingProfileProvenance") &&
    data.servingProfileProvenance !== null &&
    !servingProfileProvenance
  ) {
    return null;
  }
  const vllmInstallModel = parseVllmInstallModel(data.vllmInstallModel);
  if (hasOwn(data, "vllmInstallModel") && data.vllmInstallModel !== null && !vllmInstallModel) {
    return null;
  }
  const vllmGpuDevice = parseVllmGpuDevice(data.vllmGpuDevice);
  if (hasOwn(data, "vllmGpuDevice") && data.vllmGpuDevice !== null && !vllmGpuDevice) {
    return null;
  }
  const compatibleEndpointReasoningEffort = normalizeReasoningEffort(
    data.compatibleEndpointReasoningEffort,
  );
  if (
    hasOwn(data, "compatibleEndpointReasoningEffort") &&
    data.compatibleEndpointReasoningEffort !== null &&
    !compatibleEndpointReasoningEffort
  ) {
    return null;
  }
  const stationExpressIntent = parseStationExpressResumeIntent(data.stationExpressIntent);
  if (
    hasOwn(data, "stationExpressIntent") &&
    data.stationExpressIntent !== null &&
    !stationExpressIntent
  )
    return null;
  const stationExpressReceiptRetirement = isValidStationExpressReceiptGeneration(
    data.stationExpressReceiptRetirement,
  )
    ? data.stationExpressReceiptRetirement
    : null;
  if (
    hasOwn(data, "stationExpressReceiptRetirement") &&
    data.stationExpressReceiptRetirement !== null &&
    !stationExpressReceiptRetirement
  ) {
    return null;
  }
  const cancellationRecovery = parseSessionCancellationRecovery(data.cancellationRecovery);
  if (
    hasOwn(data, "cancellationRecovery") &&
    data.cancellationRecovery !== null &&
    !cancellationRecovery
  ) {
    throw new InvalidPersistedCancellationRecoveryError(
      "Refusing to load the onboarding session: saved recovery authority is incomplete.",
    );
  }

  const normalized = createSession({
    sessionId: readString(data.sessionId) ?? undefined,
    mode: readString(data.mode) ?? undefined,
    startedAt: readString(data.startedAt) ?? undefined,
    updatedAt: readString(data.updatedAt) ?? undefined,
    agent: readString(data.agent),
    sandboxName: readString(data.sandboxName),
    provider: readString(data.provider),
    model: readString(data.model),
    vllmInstallModel,
    vllmGpuDevice,
    servingProfileProvenance,
    stationExpressIntent,
    stationExpressReceiptRetirement,
    endpointUrl: typeof data.endpointUrl === "string" ? redactUrl(data.endpointUrl) : null,
    credentialEnv: readString(data.credentialEnv),
    hermesAuthMethod: readHermesAuthMethod(data.hermesAuthMethod),
    preferredInferenceApi: readString(data.preferredInferenceApi),
    compatibleEndpointReasoning: readString(data.compatibleEndpointReasoning),
    compatibleEndpointReasoningEffort,
    nimContainer: readString(data.nimContainer),
    routerPid: readPositiveInteger(data.routerPid),
    routerCredentialHash: readString(data.routerCredentialHash),
    webSearchConfig: parseWebSearchConfig(data.webSearchConfig),
    sandboxPromptProgress: parseSandboxPromptProgress(data.sandboxPromptProgress, data),
    resourceProfile: parseSessionResourceProfile(data.resourceProfile),
    toolDisclosure: normalizeSessionToolDisclosure(data.toolDisclosure),
    observabilityEnabled: data.observabilityEnabled === true,
    observabilityRequestedExplicitly: data.observabilityRequestedExplicitly === true,
    apfInterceptorRequested: data.apfInterceptorRequested === true,
    hermesToolGateways: readStringArray(data.hermesToolGateways),
    policyPresets: readStringArray(data.policyPresets),
    policyAuthority,
    messagingPlan: parseSandboxMessagingPlan(data.messagingPlan),
    stagedCredentialProviders: readStringArray(data.stagedCredentialProviders) ?? [],
    migratedLegacyValueHashes: readStringRecord(data.migratedLegacyValueHashes),
    gpuPassthrough: data.gpuPassthrough === true,
    telegramConfig: parseTelegramConfig(data.telegramConfig),
    wechatConfig: parseWechatConfig(data.wechatConfig),
    lastStepStarted: readString(data.lastStepStarted),
    lastCompletedStep: readString(data.lastCompletedStep),
    failure: sanitizeFailure(isObject(data.failure) ? data.failure : null),
    cancellationRecovery,
    metadata: parseSessionMetadata(data.metadata),
    checkpoint: data.checkpoint as unknown as OnboardCheckpoint | null,
  });
  normalized.resumable = data.resumable !== false;
  normalized.status = readString(data.status) ?? normalized.status;
  if (
    (normalized.status === CANCELLATION_RECOVERY_STATUS) !== Boolean(cancellationRecovery) ||
    (cancellationRecovery !== null &&
      (normalized.resumable !== false ||
        normalized.sandboxName !== cancellationRecovery.sandboxName))
  ) {
    throw new InvalidPersistedCancellationRecoveryError(
      "Refusing to load the onboarding session: saved recovery authority is incomplete.",
    );
  }
  if (
    normalized.stationExpressIntent &&
    (data.resumable !== true ||
      normalized.mode !== "non-interactive" ||
      (data.status !== "in_progress" && data.status !== "failed"))
  ) {
    return null;
  }
  if (
    normalized.stationExpressReceiptRetirement &&
    (normalized.status !== "complete" ||
      normalized.resumable !== false ||
      normalized.stationExpressIntent !== null)
  ) {
    return null;
  }

  if (isObject(data.steps)) {
    for (const [name, step] of Object.entries(data.steps)) {
      const parsedStep = parseStepState(step);
      if (Object.prototype.hasOwnProperty.call(normalized.steps, name) && parsedStep) {
        normalized.steps[name] = parsedStep;
      }
    }
  }

  if (
    normalized.vllmInstallModel &&
    (!normalized.resumable ||
      (normalized.status !== "in_progress" && normalized.status !== "failed") ||
      (normalized.steps.provider_selection?.status !== "in_progress" &&
        normalized.steps.provider_selection?.status !== "failed"))
  ) {
    return null;
  }

  if (normalized.stationExpressIntent) {
    const intent = normalized.stationExpressIntent;
    if (
      !isValidStationExpressProviderState(
        intent,
        normalized.steps.provider_selection?.status,
        normalized.provider,
        normalized.model,
      )
    ) {
      return null;
    }
  }

  normalized.machine =
    parseMachineSnapshot(data.machine, normalized.sessionId) ?? inferMachineSnapshot(normalized);
  if (
    normalized.checkpoint &&
    (normalized.checkpoint.sessionId !== normalized.sessionId ||
      normalized.checkpoint.machineState !== normalized.machine.state)
  ) {
    return null;
  }
  preserveInvalidSessionToolDisclosure(data, normalized);
  preserveInvalidSessionHostMounts(data, normalized);

  return normalized;
}

export function loadSession(): Session | null {
  const lockOwned = heldLockFd !== null;
  let descriptor: number | null = null;
  try {
    if (lockOwned) assertOnboardLockOwned();
    let contents: string;
    if (lockOwned) {
      try {
        descriptor = fs.openSync(
          SESSION_FILE,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
        );
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          assertOnboardLockOwned();
          return null;
        }
        throw error;
      }
      assertSessionFileIdentity(descriptor, SESSION_FILE);
      contents = String(fs.readFileSync(descriptor, "utf-8"));
      assertSessionFileIdentity(descriptor, SESSION_FILE);
    } else {
      if (!fs.existsSync(SESSION_FILE)) return null;
      contents = fs.readFileSync(SESSION_FILE, "utf-8");
    }
    const parsed = JSON.parse(contents);
    const normalized = normalizeSession(parsed);
    if (lockOwned) assertOnboardLockOwned();
    return normalized;
  } catch (error) {
    if (
      error instanceof InvalidPersistedPolicyAuthorityError ||
      error instanceof InvalidPersistedApfInterceptorIntentError ||
      error instanceof InvalidPersistedCancellationRecoveryError
    ) {
      throw error;
    }
    if (lockOwned) throw error;
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function serializeSessionForDisk(session: Session): Record<string, unknown> {
  return {
    ...session,
    messagingPlan: session.messagingPlan
      ? compactSandboxMessagingPlanForPersistence(session.messagingPlan)
      : session.messagingPlan,
    checkpoint: session.checkpoint ? serializeCheckpoint(session.checkpoint) : null,
  };
}

export function saveSession(session: Session): Session {
  const normalized = normalizeSession(session) || createSession();
  normalized.updatedAt = new Date().toISOString();
  const lockOwned = heldLockFd !== null;
  if (lockOwned) assertOnboardLockOwned();
  const directory = lockOwned ? heldLockDirectory! : openPinnedSessionDirectory();
  const tmpFile = path.join(
    SESSION_DIR,
    `.onboard-session.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  let temporaryStat: fs.Stats | null = null;
  try {
    descriptor = fs.openSync(
      tmpFile,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    revalidatePinnedSessionDirectory(directory);
    temporaryStat = assertSessionFileIdentity(descriptor, tmpFile);
    fs.writeFileSync(descriptor, JSON.stringify(serializeSessionForDisk(normalized), null, 2));
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    temporaryStat = assertSessionFileIdentity(descriptor, tmpFile);
    revalidatePinnedSessionDirectory(directory);
    fs.renameSync(tmpFile, SESSION_FILE);
    revalidatePinnedSessionDirectory(directory);
    assertSessionFileIdentity(descriptor, SESSION_FILE);
    fs.fsyncSync(directory.descriptor);
    return normalized;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      revalidatePinnedSessionDirectory(directory);
      const pathStat = fs.lstatSync(tmpFile);
      if (
        temporaryStat !== null &&
        pathStat.isFile() &&
        pathStat.nlink === 1 &&
        sameSessionFileIdentity(temporaryStat, pathStat)
      ) {
        fs.unlinkSync(tmpFile);
      }
    } catch {
      // Preserve the original result. Ambiguous paths are left untouched.
    }
    if (!lockOwned) fs.closeSync(directory.descriptor);
  }
}

export function clearSession(): void {
  const lockOwned = heldLockFd !== null;
  let descriptor: number | null = null;
  try {
    if (lockOwned) {
      assertOnboardLockOwned();
      try {
        descriptor = fs.openSync(
          SESSION_FILE,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
        );
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          assertOnboardLockOwned();
          return;
        }
        throw error;
      }
      assertSessionFileIdentity(descriptor, SESSION_FILE);
    }
    try {
      fs.unlinkSync(SESSION_FILE);
    } catch (error) {
      if (!(isErrnoException(error) && error.code === "ENOENT")) throw error;
    }
    if (lockOwned) {
      assertOnboardLockOwned();
      try {
        fs.lstatSync(SESSION_FILE);
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") return;
        throw error;
      }
      throw new Error("NemoClaw onboarding session state changed during deletion.");
    }
  } catch (error) {
    if (lockOwned) throw error;
    return;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

// ── Locking ──────────────────────────────────────────────────────

function parseLockFile(contents: string): LockInfo | null {
  try {
    return parseLockInfo(JSON.parse(contents));
  } catch {
    return null;
  }
}

interface LockFileSnapshot {
  info: LockInfo | null;
  inode: bigint;
  mtimeMs: number;
}

function readLockFileSnapshot(): LockFileSnapshot {
  const fd = fs.openSync(LOCK_FILE, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) {
      return { info: null, inode: stat.ino, mtimeMs: Number(stat.mtimeMs) };
    }
    return {
      info: parseLockFile(String(fs.readFileSync(fd, "utf8"))),
      inode: stat.ino,
      mtimeMs: Number(stat.mtimeMs),
    };
  } finally {
    fs.closeSync(fd);
  }
}

const MALFORMED_STALE_SECONDS = 30;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

function readProcProcessStartMs(pid: number): number | null {
  try {
    const statText = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const btimeLine = fs
      .readFileSync("/proc/stat", "utf8")
      .split("\n")
      .find((line) => line.startsWith("btime "));
    const bootSeconds = btimeLine ? Number(btimeLine.trim().split(/\s+/)[1]) : NaN;
    const closeParen = statText.lastIndexOf(")");
    if (!Number.isFinite(bootSeconds) || closeParen < 0) return null;

    const fieldsAfterComm = statText
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const startTicks = Number(fieldsAfterComm[19]);
    if (!Number.isFinite(startTicks)) return null;

    // Linux exposes /proc/<pid>/stat starttime in USER_HZ ticks. 100 is the
    // stable value on supported NemoClaw Linux hosts.
    const clockTicksPerSecond = 100;
    return (bootSeconds + startTicks / clockTicksPerSecond) * 1000;
  } catch {
    return null;
  }
}

function lockHolderStillMatches(lock: LockInfo): boolean {
  if (!isProcessAlive(lock.pid)) return false;
  if (lock.pid === process.pid) return true;

  const lockStartedMs = lock.startedAt ? Date.parse(lock.startedAt) : NaN;
  if (!Number.isFinite(lockStartedMs)) return true;

  const processStartMs = readProcProcessStartMs(lock.pid);
  if (processStartMs === null) return true;

  // The original lock holder must have started before it wrote the lock. If
  // the currently-live PID started after the lock timestamp, the PID was reused
  // and the lock is stale even though kill(pid, 0) succeeds.
  return processStartMs <= lockStartedMs + 1000;
}

// File descriptor we hold across the lifetime of an acquired lock. On
// release, fstat(fd).ino vs stat(path).ino confirms the on-disk path
// still resolves to the file we created — closing the residual TOCTOU
// window in the inode-only check by tying ownership to a live
// descriptor rather than a value re-read from disk. See #1281.
let heldLockFd: number | null = null;
let heldLockDirectory: PinnedSessionDirectory | null = null;

export function assertOnboardLockOwned(): void {
  if (heldLockFd === null || heldLockDirectory === null) {
    throw new Error("This process does not own the NemoClaw onboarding lock.");
  }
  revalidatePinnedSessionDirectory(heldLockDirectory);
  assertSessionDirectoryHasNoSymlinks();
  const descriptorStat = fs.fstatSync(heldLockFd);
  const pathStat = fs.lstatSync(LOCK_FILE);
  if (
    !descriptorStat.isFile() ||
    descriptorStat.nlink !== 1 ||
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.nlink !== 1 ||
    descriptorStat.dev !== pathStat.dev ||
    descriptorStat.ino !== pathStat.ino
  ) {
    throw new Error("NemoClaw onboarding lock ownership changed during the operation.");
  }
}

function withOwnedOnboardLock<T>(command: string, operation: () => T): T {
  const managesOnboardLock = heldLockFd === null;
  if (managesOnboardLock) {
    const lock = acquireOnboardLock(command);
    if (!lock.acquired) {
      throw new Error(
        "Cannot update onboarding recovery while another onboarding run owns the lock.",
      );
    }
  }
  try {
    assertOnboardLockOwned();
    const result = operation();
    assertOnboardLockOwned();
    return result;
  } finally {
    if (managesOnboardLock) releaseOnboardLock();
  }
}

/** Report whether this process holds the exclusive onboarding writer lock. */
export function isOnboardLockHeldByCurrentProcess(): boolean {
  if (heldLockFd === null) return false;
  try {
    return (
      fs.fstatSync(heldLockFd, { bigint: true }).ino ===
      fs.statSync(LOCK_FILE, { bigint: true }).ino
    );
  } catch {
    return false;
  }
}

export function acquireOnboardLock(command: string | null = null): LockResult {
  ensureSessionDir();
  const payload = JSON.stringify(
    {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: typeof command === "string" ? command : null,
    },
    null,
    2,
  );

  // The retry budget here used to be 2, which is the bare minimum needed
  // for "see-stale → cleanup → reclaim". With the inode-verified cleanup
  // below it can take a few additional spins under contention because
  // multiple concurrent stale-cleaners can race and lose to each other
  // before one reclaims, so give the loop a little more room.
  // See issue #1281.
  const MAX_ATTEMPTS = 5;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let fd: number;
    try {
      // openSync(..., "wx", mode) is the atomic create-or-fail
      // primitive. We hold the resulting fd at module scope so
      // releaseOnboardLock() can later confirm the on-disk path still
      // resolves to the same file we created (fstat ino vs stat ino).
      fd = fs.openSync(LOCK_FILE, "wx", 0o600);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") {
        throw error;
      }

      // Capture both the parsed lock and the inode so we can verify the
      // file we're about to unlink is STILL the same stale file we read.
      // Without the inode check, two concurrent processes can both read
      // the same stale lock, and the slower one will unlink the fresh
      // lock the faster one just claimed, breaking mutual exclusion.
      // See issue #1281.
      let snapshot: LockFileSnapshot;
      try {
        snapshot = readLockFileSnapshot();
      } catch (readError) {
        if (isErrnoException(readError) && readError.code === "ENOENT") {
          continue;
        }
        throw readError;
      }
      const { info: existing, inode: staleInode } = snapshot;
      if (!existing) {
        // Malformed lock file. If the file is very recent (<30 s), a
        // concurrent process may be mid-write — leave it and retry.
        // Otherwise the file is stale debris from a crash between
        // openSync("wx") and writeSync() — remove it so subsequent
        // onboard runs are not permanently blocked (#2765).
        const ageMs = Date.now() - snapshot.mtimeMs;
        if (ageMs > MALFORMED_STALE_SECONDS * 1000) {
          unlinkIfInodeMatches(LOCK_FILE, staleInode);
        }
        continue;
      }
      if (lockHolderStillMatches(existing)) {
        return {
          acquired: false,
          lockFile: LOCK_FILE,
          stale: false,
          holderPid: existing.pid,
          holderStartedAt: existing.startedAt,
          holderCommand: existing.command,
        };
      }

      // Stale: unlink ONLY if the file on disk is still the same inode
      // we just read. If a concurrent process already cleaned up and
      // claimed the lock, the inode will have changed and we'll fall
      // through to the next iteration where openSync(wx) will either
      // succeed (we win) or fail EEXIST against the new holder (and we
      // re-read it).
      unlinkIfInodeMatches(LOCK_FILE, staleInode);
      continue;
    }

    // Atomic create succeeded — write the payload and keep the fd open
    // for the lifetime of the lock so releaseOnboardLock() can verify
    // ownership via the live descriptor.
    try {
      fs.writeSync(fd, payload);
    } catch (writeError) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {
        /* ignore */
      }
      throw writeError;
    }
    heldLockFd = fd;
    try {
      heldLockDirectory = openPinnedSessionDirectory();
      assertOnboardLockOwned();
      // Legacy-port migration holds its lock before checking every onboard
      // writer lock. Recheck here after atomically claiming onboard.lock so
      // either the writer or the migrator wins, never both.
      if (fs.existsSync(LEGACY_STATE_MIGRATION_LOCK)) {
        releaseOnboardLock();
        return { acquired: false, lockFile: LOCK_FILE, stale: false };
      }
    } catch (error) {
      heldLockFd = null;
      if (heldLockDirectory !== null) fs.closeSync(heldLockDirectory.descriptor);
      heldLockDirectory = null;
      fs.closeSync(fd);
      throw error;
    }
    return { acquired: true, lockFile: LOCK_FILE, stale: false };
  }

  return { acquired: false, lockFile: LOCK_FILE, stale: true };
}

/**
 * Unlink LOCK_FILE only if its current inode equals `expectedInode`.
 * The dual stat-then-unlink is the only portable POSIX primitive Node
 * exposes for this — there's no atomic "unlink-if-inode" syscall — so
 * a sufficiently unlucky race can still slip through. The window is
 * orders of magnitude smaller than the unconditional unlink it
 * replaces, and the outer loop will detect a wrong unlink on its next
 * `writeFileSync(wx)` attempt because either we re-create the file
 * or we observe the new lock with a different inode.
 */
function unlinkIfInodeMatches(filePath: string, expectedInode: bigint | null): void {
  if (expectedInode === null) {
    return;
  }
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    if (stat.ino !== expectedInode) {
      // Someone else replaced the file. Leave it alone.
      return;
    }
  } catch (statError) {
    if (isErrnoException(statError) && statError.code === "ENOENT") {
      return;
    }
    throw statError;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (unlinkError) {
    if (!isErrnoException(unlinkError) || unlinkError.code !== "ENOENT") {
      throw unlinkError;
    }
  }
}

export function releaseOnboardLock(): void {
  // Preferred path: we hold the fd from a successful acquireOnboardLock.
  // Verify the on-disk path still resolves to the same file (fstat ino
  // == stat ino) before unlinking. If they disagree, another process
  // has already replaced the lock and we must NOT touch their file.
  if (heldLockFd !== null) {
    const fd = heldLockFd;
    const directory = heldLockDirectory;
    heldLockFd = null;
    heldLockDirectory = null;
    try {
      const fdStat = fs.fstatSync(fd, { bigint: true });
      let pathInode: bigint | null = null;
      try {
        const pathStat = fs.statSync(LOCK_FILE, { bigint: true });
        pathInode = pathStat.ino;
      } catch (error) {
        if (!(isErrnoException(error) && error.code === "ENOENT")) {
          // Unexpected — fall through to closing the fd.
        }
      }
      if (pathInode !== null && pathInode === fdStat.ino) {
        try {
          fs.unlinkSync(LOCK_FILE);
        } catch (unlinkError) {
          if (!(isErrnoException(unlinkError) && unlinkError.code === "ENOENT")) {
            // Best effort — surfacing this would mask the real error.
          }
        }
      }
    } catch {
      // fstat can fail if the fd was already closed somehow; nothing
      // safe to do beyond closing it below.
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      if (directory !== null) {
        try {
          fs.closeSync(directory.descriptor);
        } catch {
          // ignore
        }
      }
    }
    return;
  }

  // Fallback (no fd held — e.g., a test wrote the lock file directly,
  // or a previous release already ran): preserve the legacy pid-based
  // behavior so we never unlink a malformed lock and never unlink a
  // lock owned by another pid.
  try {
    let snapshot: LockFileSnapshot;
    try {
      snapshot = readLockFileSnapshot();
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return;
      throw error;
    }
    if (!snapshot.info) return;
    if (snapshot.info.pid !== process.pid) return;
    unlinkIfInodeMatches(LOCK_FILE, snapshot.inode);
  } catch {
    return;
  }
}

// ── Step management ──────────────────────────────────────────────

export type NullableSessionUpdateIntent<T> =
  | { kind: "unchanged" }
  | { kind: "clear" }
  | { kind: "set"; value: T };

export type NullableSessionUpdateKey = {
  [K in keyof Session]-?: null extends Session[K] ? K : never;
}[keyof Session];

type NullableStringSessionUpdateKey = {
  [K in NullableSessionUpdateKey]-?: NonNullable<Session[K]> extends string ? K : never;
}[NullableSessionUpdateKey];

function sessionUpdateUnchanged<T>(): NullableSessionUpdateIntent<T> {
  return { kind: "unchanged" };
}

function sessionUpdateClear<T>(): NullableSessionUpdateIntent<T> {
  return { kind: "clear" };
}

function sessionUpdateSet<T>(value: T): NullableSessionUpdateIntent<T> {
  return { kind: "set", value };
}

export function getNullableStringUpdateIntent(
  value: unknown,
  normalize?: (v: string) => string | null,
): NullableSessionUpdateIntent<string> {
  if (value === undefined) return sessionUpdateUnchanged();
  if (value === null) return sessionUpdateClear();
  if (typeof value !== "string") return sessionUpdateUnchanged();

  const normalized = normalize ? normalize(value) : value;
  return normalized === null ? sessionUpdateClear() : sessionUpdateSet(normalized);
}

export function hasSessionUpdateValue<T>(intent: NullableSessionUpdateIntent<T>): boolean {
  return intent.kind !== "unchanged";
}

export function isSessionUpdateClear<T>(intent: NullableSessionUpdateIntent<T>): boolean {
  return intent.kind === "clear";
}

export function applyNullableSessionUpdate<K extends NullableSessionUpdateKey>(
  safe: Partial<Session>,
  key: K,
  intent: NullableSessionUpdateIntent<NonNullable<Session[K]>>,
): void {
  if (intent.kind === "unchanged") return;
  if (intent.kind === "clear") {
    (safe as Record<K, Session[K] | null>)[key] = null as Session[K] & null;
    return;
  }
  (safe as Record<K, Session[K]>)[key] = intent.value as Session[K];
}

// Apply an explicit-clear-aware update for a nullable session field.
//
//   value === "string"  → assign (after optional normalizer)
//   value === null      → explicit clear (persisted as null)
//   value === undefined → leave unchanged (caller didn't supply this field)
//
// Before GH #2625 the persistence layer only accepted strings, which meant
// a provider switch from remote (credentialEnv="OPENAI_API_KEY") to local
// (credentialEnv=null) silently dropped the clear and left the stale value
// on disk. The rebuild preflight then demanded a credential the current
// sandbox does not actually need.
function assignNullableString<K extends NullableStringSessionUpdateKey>(
  safe: Partial<Session>,
  key: K,
  value: unknown,
  normalize?: (v: string) => string | null,
): void {
  applyNullableSessionUpdate(
    safe,
    key,
    getNullableStringUpdateIntent(value, normalize) as NullableSessionUpdateIntent<
      NonNullable<Session[K]>
    >,
  );
  // Non-string, non-null, non-undefined values are silently dropped —
  // matches the pre-#2625 behavior for malformed input (e.g. numbers via
  // JSON re-entry).
}

export function filterSafeUpdates(updates: SessionUpdates): Partial<Session> {
  const safe: Partial<Session> = {};
  if (!isObject(updates)) return safe;
  assignNullableString(safe, "sandboxName", updates.sandboxName);
  assignNullableString(safe, "provider", updates.provider);
  assignNullableString(safe, "model", updates.model);
  if (updates.servingProfileProvenance === null) {
    safe.servingProfileProvenance = null;
  } else {
    const servingProfileProvenance = parseServingProfileProvenance(
      updates.servingProfileProvenance,
    );
    if (servingProfileProvenance) safe.servingProfileProvenance = servingProfileProvenance;
  }
  assignNullableString(safe, "endpointUrl", updates.endpointUrl, redactUrl);
  assignNullableString(safe, "credentialEnv", updates.credentialEnv);
  if (updates.hermesAuthMethod === "oauth" || updates.hermesAuthMethod === "api_key") {
    safe.hermesAuthMethod = updates.hermesAuthMethod;
  } else if (updates.hermesAuthMethod === null) {
    safe.hermesAuthMethod = null;
  }
  assignNullableString(safe, "preferredInferenceApi", updates.preferredInferenceApi);
  assignNullableString(safe, "compatibleEndpointReasoning", updates.compatibleEndpointReasoning);
  if (updates.compatibleEndpointReasoningEffort === null) {
    safe.compatibleEndpointReasoningEffort = null;
  } else {
    const compatibleEndpointReasoningEffort = normalizeReasoningEffort(
      updates.compatibleEndpointReasoningEffort,
    );
    if (compatibleEndpointReasoningEffort) {
      safe.compatibleEndpointReasoningEffort = compatibleEndpointReasoningEffort;
    }
  }
  assignNullableString(safe, "nimContainer", updates.nimContainer);
  if (
    typeof updates.routerPid === "number" &&
    Number.isInteger(updates.routerPid) &&
    updates.routerPid > 0
  ) {
    safe.routerPid = updates.routerPid;
  }
  if (typeof updates.routerCredentialHash === "string") {
    safe.routerCredentialHash = updates.routerCredentialHash;
  }
  if (isObject(updates.webSearchConfig) && updates.webSearchConfig.fetchEnabled === true) {
    safe.webSearchConfig = normalizeWebSearchConfig(
      updates.webSearchConfig as Partial<WebSearchConfig>,
    );
  } else if (updates.webSearchConfig === null) {
    safe.webSearchConfig = null;
  }
  assignSafeToolDisclosureUpdate(safe, updates.toolDisclosure);
  if (typeof updates.observabilityEnabled === "boolean") {
    safe.observabilityEnabled = updates.observabilityEnabled;
  }
  if (updates.hermesToolGateways === null) {
    safe.hermesToolGateways = null;
  } else if (Array.isArray(updates.hermesToolGateways)) {
    safe.hermesToolGateways = updates.hermesToolGateways.filter(
      (value) => typeof value === "string",
    );
  }
  if (updates.policyPresets === null) {
    safe.policyPresets = null;
  } else if (Array.isArray(updates.policyPresets)) {
    safe.policyPresets = updates.policyPresets.filter((value) => typeof value === "string");
  }
  if (updates.policyAuthority === null) {
    safe.policyAuthority = null;
  } else {
    const policyAuthority = readPolicyAuthority(updates.policyAuthority);
    if (policyAuthority) {
      safe.policyAuthority = policyAuthority;
      if (policyAuthority === "externally-managed") safe.policyPresets = null;
    }
  }
  if (updates.messagingPlan === null) {
    safe.messagingPlan = null;
  } else {
    const messagingPlan = parseSandboxMessagingPlan(updates.messagingPlan);
    if (messagingPlan) safe.messagingPlan = messagingPlan;
  }
  if (isObject(updates.migratedLegacyValueHashes)) {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(updates.migratedLegacyValueHashes)) {
      if (typeof k === "string" && typeof v === "string") cleaned[k] = v;
    }
    safe.migratedLegacyValueHashes = cleaned;
  }
  if (updates.gpuPassthrough === true || updates.gpuPassthrough === false) {
    safe.gpuPassthrough = updates.gpuPassthrough;
  }
  if (
    isObject(updates.telegramConfig) &&
    typeof updates.telegramConfig.requireMention === "boolean"
  ) {
    safe.telegramConfig = { requireMention: updates.telegramConfig.requireMention };
  } else if (updates.telegramConfig === null) {
    safe.telegramConfig = null;
  }
  if (isObject(updates.wechatConfig)) {
    const parsed = parseWechatConfig(updates.wechatConfig);
    if (parsed) safe.wechatConfig = parsed;
  } else if (updates.wechatConfig === null) {
    safe.wechatConfig = null;
  }
  if (isObject(updates.metadata) && typeof updates.metadata.gatewayName === "string") {
    safe.metadata = {
      gatewayName: updates.metadata.gatewayName,
      fromDockerfile:
        typeof updates.metadata.fromDockerfile === "string"
          ? updates.metadata.fromDockerfile
          : null,
    };
  }
  return safe;
}

export function updateSession(mutator: (session: Session) => Session | void): Session {
  const current = loadSession() || createSession();
  const next = typeof mutator === "function" ? mutator(current) || current : current;
  return saveSession(next);
}

export interface RetainedSandboxRecoveryContext {
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string;
  readonly verifiedEffectivePolicyIdentity: RetainedSandboxVerifiedEffectivePolicyIdentity | null;
  readonly createAttemptNonce: string;
  readonly policyCreationReceipt: RetainedSandboxRecoveryRecord["policyCreationReceipt"];
}

function persistIndependentRetainedSandboxRecovery(
  session: Session,
  reason: RetainedSandboxRecoveryReason,
  sandboxIdentityFingerprint: string | null,
  context: RetainedSandboxRecoveryContext,
): void {
  writeRetainedSandboxRecovery(RETAINED_SANDBOX_RECOVERY_FILE, {
    sandboxName: session.sandboxName!,
    sandboxIdentityFingerprint,
    gatewayName: context.gatewayName,
    gatewayPort: context.gatewayPort,
    lifecycleGeneration: context.lifecycleGeneration,
    verifiedEffectivePolicyIdentity: context.verifiedEffectivePolicyIdentity,
    createAttemptNonce: context.createAttemptNonce,
    policyCreationReceipt: context.policyCreationReceipt,
    reason,
  });
}

export function listRetainedSandboxRecoveryRecords(): readonly RetainedSandboxRecoveryRecord[] {
  return withOwnedOnboardLock("nemoclaw retained sandbox recovery read", () => {
    let records = readRetainedSandboxRecoveryRecords(RETAINED_SANDBOX_RECOVERY_FILE);
    const current = loadSession();
    const recovery = current?.cancellationRecovery ?? null;
    if (
      current &&
      recovery &&
      !records.some(
        (record) =>
          record.sandboxName === recovery.sandboxName &&
          record.sandboxIdentityFingerprint === recovery.sandboxIdentityFingerprint &&
          record.createAttemptNonce === recovery.createAttemptNonce,
      )
    ) {
      try {
        writeRetainedSandboxRecovery(RETAINED_SANDBOX_RECOVERY_FILE, {
          sandboxName: recovery.sandboxName,
          sandboxIdentityFingerprint: recovery.sandboxIdentityFingerprint,
          gatewayName: recovery.gatewayName,
          gatewayPort: recovery.gatewayPort,
          lifecycleGeneration: recovery.lifecycleGeneration,
          verifiedEffectivePolicyIdentity: recovery.verifiedEffectivePolicyIdentity,
          createAttemptNonce: recovery.createAttemptNonce,
          policyCreationReceipt: recovery.policyCreationReceipt,
          reason: recovery.reason,
          recordedAt: recovery.recordedAt,
        });
        records = readRetainedSandboxRecoveryRecords(RETAINED_SANDBOX_RECOVERY_FILE);
      } catch {
        // Keep the recovery-only session authoritative. A different-name run
        // remains blocked until a later read can durably reconstruct the
        // independent record.
      }
    }
    return records;
  });
}

export function recordRetainedSandboxRecovery(
  input: RecordRetainedSandboxRecoveryInput,
): RetainedSandboxRecoveryRecord {
  return withOwnedOnboardLock("nemoclaw retained sandbox recovery", () =>
    writeRetainedSandboxRecovery(RETAINED_SANDBOX_RECOVERY_FILE, input),
  );
}

export function retainedSandboxRecoveryMatchesSession(
  record: RetainedSandboxRecoveryRecord,
  session: Pick<Session, "cancellationRecovery"> | null | undefined,
): boolean {
  const recovery = session?.cancellationRecovery;
  if (!recovery) return false;
  return (
    record.sandboxName === recovery.sandboxName &&
    record.sandboxIdentityFingerprint === recovery.sandboxIdentityFingerprint &&
    record.gatewayName === recovery.gatewayName &&
    record.gatewayPort === recovery.gatewayPort &&
    record.lifecycleGeneration === recovery.lifecycleGeneration &&
    record.createAttemptNonce === recovery.createAttemptNonce
  );
}

/** Clear one recovery-only session after destroy verifies the retained resources absent. */
export function resolveRetainedSandboxRecovery(record: RetainedSandboxRecoveryRecord): boolean {
  return withOwnedOnboardLock("nemoclaw retained sandbox recovery completion", () => {
    if (!retainedSandboxRecoveryAuthorityIsCurrent(RETAINED_SANDBOX_RECOVERY_FILE, record)) {
      return false;
    }
    const current = loadSession();
    if (current && retainedSandboxRecoveryMatchesSession(record, current)) {
      current.status = "failed";
      current.resumable = false;
      current.sandboxName = null;
      current.cancellationRecovery = null;
      saveSession(current);
    }
    // Release the recovery-only session first. If this write fails, the exact
    // independent record remains available for a later completion attempt. If
    // record retirement then fails, that record still blocks only the retained
    // name while a different explicitly named onboarding run can proceed.
    return retireRetainedSandboxRecovery(RETAINED_SANDBOX_RECOVERY_FILE, record);
  });
}

export function markCancellationRecovery(
  sandboxName: string,
  sandboxIdentityFingerprint: string | undefined,
  context: RetainedSandboxRecoveryContext,
): Session {
  if (
    sandboxName.length > NAME_MAX_LENGTH ||
    !NAME_VALID_PATTERN.test(sandboxName) ||
    (sandboxIdentityFingerprint !== undefined &&
      !/^[0-9a-f]{64}$/u.test(sandboxIdentityFingerprint))
  ) {
    throw new Error("Cannot record cancellation recovery with invalid sandbox identity data.");
  }
  return withOwnedOnboardLock("nemoclaw cancellation recovery", () => {
    const saved = updateSession((session) => {
      if (session.sandboxName !== null && session.sandboxName !== sandboxName) {
        throw new Error("Cannot record cancellation recovery for a different onboarding sandbox.");
      }
      const recordedAt = new Date().toISOString();
      session.sandboxName = sandboxName;
      session.resumable = false;
      session.status = CANCELLATION_RECOVERY_STATUS;
      session.cancellationRecovery = {
        reason: "cancelled_after_sandbox_creation",
        sandboxName,
        sandboxIdentityFingerprint: sandboxIdentityFingerprint ?? null,
        ...context,
        recordedAt,
      };
      session.failure = {
        step: session.lastStepStarted,
        message:
          "Onboarding was cancelled after sandbox creation; administrator recovery is required.",
        recordedAt,
        interrupted: true,
      };
      return session;
    });
    const reread = loadSession();
    if (
      reread?.sessionId !== saved.sessionId ||
      reread.status !== CANCELLATION_RECOVERY_STATUS ||
      reread.resumable !== false ||
      !sameCancellationRecovery(reread.cancellationRecovery, saved.cancellationRecovery)
    ) {
      throw new Error("Cancellation recovery did not survive durable readback.");
    }
    persistIndependentRetainedSandboxRecovery(
      reread,
      "cancelled_after_sandbox_creation",
      sandboxIdentityFingerprint ?? null,
      context,
    );
    return saved;
  });
}

export function markRetainedSandboxRecovery(
  sandboxName: string,
  message: string,
  sandboxIdentityFingerprint: string | undefined,
  context: RetainedSandboxRecoveryContext,
): Session {
  if (
    sandboxName.length > NAME_MAX_LENGTH ||
    !NAME_VALID_PATTERN.test(sandboxName) ||
    (sandboxIdentityFingerprint !== undefined &&
      !/^[0-9a-f]{64}$/u.test(sandboxIdentityFingerprint))
  ) {
    throw new Error("Cannot record retained sandbox recovery with invalid identity data.");
  }
  return withOwnedOnboardLock("nemoclaw retained sandbox recovery", () => {
    const saved = updateSession((session) => {
      if (session.sandboxName !== null && session.sandboxName !== sandboxName) {
        throw new Error(
          "Cannot record retained sandbox recovery for a different onboarding sandbox.",
        );
      }
      const recordedAt = new Date().toISOString();
      const sanitizedMessage = redactSensitiveText(message);
      session.sandboxName = sandboxName;
      session.resumable = false;
      session.status = CANCELLATION_RECOVERY_STATUS;
      session.cancellationRecovery = {
        reason: "retained_after_sandbox_creation_failure",
        sandboxName,
        sandboxIdentityFingerprint: sandboxIdentityFingerprint ?? null,
        ...context,
        recordedAt,
      };
      session.failure = {
        step: session.lastStepStarted,
        message: sanitizedMessage,
        recordedAt,
        interrupted: true,
      };
      const sandboxStep = session.steps.sandbox;
      if (sandboxStep) sandboxStep.error = sanitizedMessage;
      return session;
    });
    const reread = loadSession();
    if (
      reread?.sessionId !== saved.sessionId ||
      reread.status !== CANCELLATION_RECOVERY_STATUS ||
      reread.resumable !== false ||
      !sameCancellationRecovery(reread.cancellationRecovery, saved.cancellationRecovery)
    ) {
      throw new Error("Retained sandbox recovery did not survive durable readback.");
    }
    persistIndependentRetainedSandboxRecovery(
      reread,
      "retained_after_sandbox_creation_failure",
      sandboxIdentityFingerprint ?? null,
      context,
    );
    return reread;
  });
}

export type CompareAndSwapSessionResult = "updated" | "busy" | "mismatch";

/**
 * Mutate the current session while this process owns the onboarding lock.
 *
 * Reuse the process-local `LOCK_FILE` lock when the caller already holds it.
 * Otherwise, acquire the lock without waiting and return `busy` when another
 * onboarding writer owns it.
 */
export function compareAndSwapSession(
  matches: (session: Session) => boolean,
  mutator: (session: Session) => Session | void,
  command = "nemoclaw session compare-and-swap",
): CompareAndSwapSessionResult {
  const managesOnboardLock = heldLockFd === null;
  if (managesOnboardLock) {
    const lock = acquireOnboardLock(command);
    if (!lock.acquired) return "busy";
  }
  try {
    const current = loadSession();
    if (!current || !matches(current)) return "mismatch";
    const next = mutator(current) || current;
    saveSession(next);
    return "updated";
  } finally {
    if (managesOnboardLock) releaseOnboardLock();
  }
}

export function markStepStarted(stepName: string): Session {
  const updatedSession = updateSession((session) => {
    const step = session.steps[stepName];
    if (!step) return session;
    const now = new Date().toISOString();
    step.status = "in_progress";
    step.startedAt = now;
    step.completedAt = null;
    step.error = null;
    session.lastStepStarted = stepName;
    session.failure = null;
    session.status = "in_progress";
    return session;
  });
  return updatedSession;
}

export function markStepComplete(stepName: string, updates: SessionUpdates = {}): Session {
  const safeUpdates = filterSafeUpdates(updates);
  return updateSession((session) => {
    const step = session.steps[stepName];
    if (!step) return session;
    // Spark managed-vLLM Express intents (#7231) carry no receipt/served state
    // and exist only to re-arm the install on resume, so clear them once
    // provider selection completes instead of binding a Station selection.
    const sparkExpressComplete =
      stepName === "provider_selection" && session.stationExpressIntent?.kind === "spark";
    const stationExpressIntent =
      stepName === "provider_selection" && session.stationExpressIntent && !sparkExpressComplete
        ? bindStationExpressProviderSelection(
            session.stationExpressIntent,
            safeUpdates.provider,
            safeUpdates.model,
            updates.stationExpressModelIdentity,
          )
        : null;
    const now = new Date().toISOString();
    step.status = "complete";
    step.completedAt = now;
    step.error = null;
    session.lastCompletedStep = stepName;
    session.failure = null;
    Object.assign(session, safeUpdates);
    if (stepName === "provider_selection") session.vllmInstallModel = null;
    if (stationExpressIntent) session.stationExpressIntent = stationExpressIntent;
    else if (sparkExpressComplete) session.stationExpressIntent = null;
    return session;
  });
}

export function markStepSkipped(stepName: string): Session {
  return updateSession((session) => {
    const step = session.steps[stepName];
    if (!step) return session;
    if (step.status === "complete" || step.status === "failed" || step.status === "skipped")
      return session;
    step.status = "skipped";
    step.startedAt = null;
    step.completedAt = null;
    step.error = null;
    if (session.lastStepStarted === stepName) session.lastStepStarted = null;
    return session;
  });
}

export function markStepRejected(stepName: string): Session {
  return updateSession((session) => {
    const step = session.steps[stepName];
    if (!step) return session;
    step.status = "skipped";
    step.startedAt = null;
    step.completedAt = null;
    step.error = null;
    if (session.lastStepStarted === stepName) session.lastStepStarted = null;
    if (stepName === "provider_selection") {
      session.provider = null;
      session.model = null;
      session.vllmInstallModel = null;
      session.endpointUrl = null;
      session.credentialEnv = null;
      session.hermesAuthMethod = null;
      session.preferredInferenceApi = null;
      session.compatibleEndpointReasoning = null;
      session.compatibleEndpointReasoningEffort = null;
      session.nimContainer = null;
      session.hermesToolGateways = null;
      session.sandboxName = null;
      session.sandboxPromptProgress.sandboxName = false;
      session.resumable = false;
      session.status = "failed";
      session.failure = null;
      if (session.checkpoint) {
        session.checkpoint = {
          ...session.checkpoint,
          sandboxIdentity: { kind: "unset" },
          updatedAt: new Date().toISOString(),
        };
      }
    }
    return session;
  });
}

export function markStepFailed(stepName: string, message: string | null = null): Session {
  return updateSession((session) => {
    const step = session.steps[stepName];
    if (!step) return session;
    step.status = "failed";
    step.completedAt = null;
    step.error = redactSensitiveText(message);
    return session;
  });
}

/** Persist the validated model needed to retry an interrupted managed-vLLM install. */
export function checkpointVllmInstallModel(modelId: string): Session {
  const model = parseVllmInstallModel(modelId);
  if (!model) throw new Error("Managed vLLM install produced an invalid model checkpoint.");
  return updateSession((session) => {
    const providerStep = session.steps.provider_selection;
    if (providerStep?.status !== "in_progress") {
      throw new Error(
        "Managed vLLM install intent can only be checkpointed during provider selection.",
      );
    }
    session.vllmInstallModel = model;
  });
}

/**
 * Single synchronous terminal-failure owner for process-exit / backstop paths.
 *
 * Records exactly one failed transition and one terminal event pair for an
 * interrupted step, replacing the legacy step-mutation escape hatch on the
 * process-exit path. It is idempotent by construction: if the durable machine
 * is already terminal (an in-band failure or a prior backstop already recorded
 * the terminal event pair) it returns null rather than recording a second failure,
 * so the failed transition is validated and never doubled. Performs no
 * sandbox/provider/policy effects.
 */
export function finalizeIncompleteOnboardStep(
  stepName: string,
  message: string | null = null,
  interrupted = false,
): Session | null {
  const existing = loadSession();
  if (!existing) return null;
  // A cancellation after sandbox creation has its own fail-closed lifecycle.
  // Preserve that durable marker when the ordinary process-exit backstop runs
  // later in the same exit sequence.
  if (existing.status === CANCELLATION_RECOVERY_STATUS && existing.cancellationRecovery !== null) {
    return existing;
  }
  if (isTerminalOnboardMachineState(existing.machine.state)) return null;

  let emitted = false;
  const updatedSession = updateSession((session) => {
    const step = session.steps[stepName];
    if (!step) return session;
    if (isTerminalOnboardMachineState(session.machine.state)) return session;
    const now = new Date().toISOString();
    // Guard the terminality invariant: only a legal <non-terminal> -> failed
    // transition may be recorded here.
    assertValidOnboardMachineTransition(session.machine.state, "failed");
    step.status = "failed";
    step.completedAt = null;
    step.error = redactSensitiveText(message);
    session.failure = sanitizeFailure({
      step: stepName,
      message,
      recordedAt: now,
      interrupted,
    });
    session.status = "failed";
    transitionMachineSnapshot(session, "failed", now);
    emitted = true;
    return session;
  });
  if (emitted) {
    emitOnboardMachineEvent(
      createOnboardMachineEvent({
        type: "state.failed",
        session: updatedSession,
        step: stepName,
        error: message,
      }),
    );
    emitOnboardMachineEvent(
      createOnboardMachineEvent({
        type: "onboard.failed",
        session: updatedSession,
        state: "failed",
        step: stepName,
        error: message,
      }),
    );
  }
  return emitted ? updatedSession : null;
}

export interface CompleteSessionOptions {
  emitEvents?: boolean;
}

export function completeSession(
  updates: SessionUpdates = {},
  options: CompleteSessionOptions = {},
): Session {
  const safeUpdates = filterSafeUpdates(updates);
  let wasComplete = false;
  let receiptGeneration: string | null = null;
  let updatedSession = updateSession((session) => {
    const intentReceiptGeneration =
      session.stationExpressIntent?.kind === "spark"
        ? null
        : (session.stationExpressIntent?.receiptGeneration ?? null);
    receiptGeneration = session.stationExpressReceiptRetirement ?? intentReceiptGeneration;
    if (intentReceiptGeneration) {
      assertStationExpressInstallerResumeMatches(intentReceiptGeneration);
    }
    const now = new Date().toISOString();
    wasComplete = session.status === "complete";
    Object.assign(session, safeUpdates);
    session.status = "complete";
    session.resumable = false;
    session.vllmInstallModel = null;
    session.stationExpressIntent = null;
    session.stationExpressReceiptRetirement = receiptGeneration;
    session.failure = null;
    transitionMachineSnapshot(session, "complete", now);
    return session;
  });
  if (receiptGeneration) {
    updatedSession = reconcileStationExpressReceiptRetirement(receiptGeneration);
  }
  if (options.emitEvents !== false && Object.keys(safeUpdates).length > 0) {
    emitOnboardMachineEvent(
      createOnboardMachineEvent({
        type: "context.updated",
        session: updatedSession,
        state: "complete",
        metadata: { fields: Object.keys(safeUpdates) },
      }),
    );
  }
  if (options.emitEvents !== false && !wasComplete) {
    emitOnboardMachineEvent(
      createOnboardMachineEvent({
        type: "onboard.completed",
        session: updatedSession,
        state: "complete",
      }),
    );
  }
  return updatedSession;
}

function assertStationExpressReceiptRetirementSession(
  session: Session | null,
  expectedGeneration: string,
): asserts session is Session {
  if (
    !session ||
    session.stationExpressReceiptRetirement !== expectedGeneration ||
    session.status !== "complete" ||
    session.resumable !== false ||
    session.stationExpressIntent !== null
  ) {
    throw new Error("DGX Station Express receipt retirement state does not match this attempt.");
  }
}

export function reconcileStationExpressReceiptRetirement(expectedGeneration: string): Session {
  if (!isValidStationExpressReceiptGeneration(expectedGeneration)) {
    throw new Error("DGX Station Express receipt generation is invalid.");
  }
  const ownsOnboardLock = heldLockFd === null;
  if (ownsOnboardLock) {
    const lock = acquireOnboardLock("nemoclaw onboard (Station receipt retirement recovery)");
    if (!lock.acquired) {
      throw new Error(
        "Cannot reconcile DGX Station Express receipt retirement while another onboarding run is in progress.",
      );
    }
  }
  try {
    assertStationExpressReceiptRetirementSession(loadSession(), expectedGeneration);
    return reconcileStationExpressInstallerResumeRetirement(expectedGeneration, () =>
      updateSession((session) => {
        assertStationExpressReceiptRetirementSession(session, expectedGeneration);
        session.stationExpressReceiptRetirement = null;
        return session;
      }),
    );
  } finally {
    if (ownsOnboardLock) releaseOnboardLock();
  }
}

export function summarizeForDebug(
  session: Session | null = loadSession(),
): DebugSessionSummary | null {
  if (!session) return null;
  const gatewayAuthority =
    session.checkpoint?.gatewayAuthority.kind === "selected"
      ? describeGatewayOwner(session.checkpoint.gatewayAuthority.value)
      : null;
  return {
    version: session.version,
    sessionId: session.sessionId,
    status: session.status,
    resumable: session.resumable,
    mode: session.mode,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    sandboxName: session.sandboxName,
    provider: session.provider,
    model: session.model,
    vllmInstallModel: session.vllmInstallModel,
    vllmGpuDevice: session.vllmGpuDevice,
    servingProfileProvenance: session.servingProfileProvenance,
    endpointUrl: redactUrl(session.endpointUrl),
    credentialEnv: session.credentialEnv,
    hermesAuthMethod: session.hermesAuthMethod,
    preferredInferenceApi: session.preferredInferenceApi,
    compatibleEndpointReasoning: session.compatibleEndpointReasoning,
    compatibleEndpointReasoningEffort: session.compatibleEndpointReasoningEffort,
    nimContainer: session.nimContainer,
    toolDisclosure: session.toolDisclosure,
    observabilityEnabled: session.observabilityEnabled,
    observabilityRequestedExplicitly: session.observabilityRequestedExplicitly,
    apfInterceptorRequested: session.apfInterceptorRequested,
    hermesToolGateways: session.hermesToolGateways,
    policyPresets: session.policyPresets,
    policyAuthority: session.policyAuthority,
    gpuPassthrough: session.gpuPassthrough,
    lastStepStarted: session.lastStepStarted,
    lastCompletedStep: session.lastCompletedStep,
    failure: sanitizeFailure(session.failure),
    cancellationRecovery: session.cancellationRecovery,
    gatewayAuthority,
    machine: session.machine,
    steps: Object.fromEntries(
      Object.entries(session.steps).map(([name, step]) => [
        name,
        {
          status: step.status,
          startedAt: step.startedAt,
          completedAt: step.completedAt,
          error: step.error,
        },
      ]),
    ),
  };
}
