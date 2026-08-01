// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import {
  PODMAN_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
  type PodmanBootstrapJournal,
  type PodmanBootstrapJournalPhase,
  type PodmanBootstrapJournalStore,
} from "./podman-bootstrap-journal";
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  type PodmanHeldWorkloadObservation,
} from "./podman-held-workload";
import type { PodmanGatewayWatcherLease } from "./podman-watcher-lease";

export const PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION = 1 as const;

const FULL_ID = /^(?:sha256:)?([a-f0-9]{64})$/u;
const BOOTSTRAP_IDENTITY = /^[a-f0-9]{64}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/u;
const SAFE_ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_ARGUMENTS = 512;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const MAX_ENVIRONMENT_BYTES = 256 * 1024;
const CREATE_TIMEOUT_MS = 300_000;

const FORBIDDEN_RUNTIME_FLAGS = new Set([
  "--cidfile",
  "--detach",
  "--env",
  "--env-file",
  "--entrypoint",
  "--http-proxy",
  "--label",
  "--name",
  "--privileged",
  "--pull",
  "--replace",
  "--rm",
  "--unsetenv-all",
  "-d",
  "-e",
  "-l",
]);

type JsonRecord = Record<string, unknown>;

export type AuthorityBoundPodmanBootstrapEngine = ContainerEngine & {
  readonly authorityId: string;
};

export interface PodmanBootstrapReplacementPlan {
  readonly schemaVersion: typeof PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION;
  readonly bootstrapIdentity: string;
  readonly heldWorkload: PodmanHeldWorkloadObservation;
  /** Podman create flags that do not select identity, labels, environment, entrypoint, or image. */
  readonly runtimeArgs: readonly string[];
  /** Written only to a private temporary env file and never put in the journal or process argv. */
  readonly environment: readonly string[];
  /** Image-owned bootstrap entrypoint. Its first element must be an absolute container path. */
  readonly entrypointArgv: readonly string[];
  readonly commandArgv: readonly string[];
  readonly replacementImageContentId: string;
}

export interface PodmanBootstrapPreparedReplacement {
  readonly schemaVersion: typeof PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION;
  readonly bootstrapIdentity: string;
  readonly originalRuntimeId: string;
  readonly replacementRuntimeId: string;
  readonly replacementStagingName: string;
  readonly replacementImageContentId: string;
  readonly replacementSpecFingerprint: string;
  readonly journal: PodmanBootstrapJournal;
}

interface PodmanBootstrapReplacementAuthority {
  readonly engine: AuthorityBoundPodmanBootstrapEngine;
  readonly journalStore: PodmanBootstrapJournalStore;
  readonly watcherLease: PodmanGatewayWatcherLease;
}

export interface PrepareStoppedPodmanBootstrapReplacementInput
  extends PodmanBootstrapReplacementAuthority {
  readonly plan: PodmanBootstrapReplacementPlan;
}

export interface StopExactPodmanBootstrapOriginalInput extends PodmanBootstrapReplacementAuthority {
  readonly prepared: PodmanBootstrapPreparedReplacement;
  readonly heldWorkload: PodmanHeldWorkloadObservation;
}

export interface RollbackPodmanBootstrapBeforeCommitInput
  extends PodmanBootstrapReplacementAuthority {
  readonly bootstrapIdentity: string;
  readonly heldWorkload: PodmanHeldWorkloadObservation;
}

export interface PodmanBootstrapRollbackReceipt {
  readonly bootstrapIdentity: string;
  readonly originalRuntimeId: string;
  readonly originalStarted: boolean;
  readonly replacementRemoved: boolean;
}

export class PodmanBootstrapPreparationError extends Error {
  public readonly rollbackRequired: boolean;

  public constructor(message: string, rollbackRequired = true) {
    super(message);
    this.name = "PodmanBootstrapPreparationError";
    this.rollbackRequired = rollbackRequired;
  }
}

interface NormalizedReplacementPlan extends PodmanBootstrapReplacementPlan {
  readonly heldWorkload: PodmanHeldWorkloadObservation;
  readonly runtimeArgs: readonly string[];
  readonly environment: readonly string[];
  readonly entrypointArgv: readonly string[];
  readonly commandArgv: readonly string[];
  readonly replacementImageContentId: string;
  readonly replacementStagingName: string;
  readonly originalSpecFingerprint: string;
  readonly replacementSpecFingerprint: string;
}

interface ExactContainerExpectation {
  readonly runtimeId: string;
  readonly name: string;
  readonly imageContentId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly running: boolean;
  readonly entrypointArgv?: readonly string[];
  readonly commandArgv?: readonly string[];
  readonly environment?: readonly string[];
  readonly supervisorArgv?: readonly string[];
}

interface ExactContainerObservation {
  readonly runtimeId: string;
  readonly name: string;
  readonly imageContentId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly running: boolean;
  readonly entrypointArgv: readonly string[];
  readonly commandArgv: readonly string[];
  readonly environment: readonly string[];
}

function failure(message: string, rollbackRequired = true): never {
  throw new PodmanBootstrapPreparationError(message, rollbackRequired);
}

function safeString(value: unknown, label: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.includes("\0") ||
    CONTROL_CHARACTER.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_ARGUMENT_BYTES
  ) {
    return failure(`${label} must be one bounded exact string.`, false);
  }
  return value;
}

function fullRuntimeId(value: unknown, label: string): string {
  const match = safeString(value, label).match(FULL_ID);
  if (!match?.[1]) return failure(`${label} must be one full lowercase runtime ID.`, false);
  return match[1];
}

function imageContentId(value: unknown, label: string): string {
  return `sha256:${fullRuntimeId(value, label)}`;
}

function exactArgv(value: unknown, label: string, allowEmpty = true): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARGUMENTS ||
    (!allowEmpty && value.length === 0)
  ) {
    return failure(`${label} must be a bounded argv array.`, false);
  }
  return Object.freeze(
    value.map((entry, index) => safeString(entry, `${label}[${String(index)}]`, true)),
  );
}

function exactStringMap(value: unknown, label: string): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure(`${label} must be an object.`, false);
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [
          safeString(key, `${label} key`),
          safeString(entry, `${label}.${key}`, true),
        ]),
    ),
  );
}

function canonicalLabels(
  heldWorkload: PodmanHeldWorkloadObservation,
): Readonly<Record<string, string>> {
  const labels = exactStringMap(heldWorkload.labels, "Podman held-workload labels");
  if (
    labels[PODMAN_MANAGED_LABEL] !== "true" ||
    labels[PODMAN_SANDBOX_ID_LABEL] !== heldWorkload.sandboxId ||
    labels[PODMAN_SANDBOX_NAME_LABEL] !== heldWorkload.sandboxName ||
    !Object.hasOwn(labels, PODMAN_SANDBOX_NAMESPACE_LABEL)
  ) {
    return failure("Podman replacement labels do not match exact OpenShell ownership.", false);
  }
  return labels;
}

function environmentEntries(value: unknown): readonly string[] {
  const entries = exactArgv(value, "Podman replacement environment");
  const keys = new Set<string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const key = separator > 0 ? entry.slice(0, separator) : "";
    if (!SAFE_ENVIRONMENT_KEY.test(key) || keys.has(key)) {
      return failure("Podman replacement environment contains an invalid or duplicate key.", false);
    }
    keys.add(key);
  }
  const serialized = `${entries.join("\n")}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_ENVIRONMENT_BYTES) {
    return failure("Podman replacement environment exceeds its private file transport.", false);
  }
  return entries;
}

function runtimeArguments(value: unknown): readonly string[] {
  const args = exactArgv(value, "Podman replacement runtime arguments");
  for (const argument of args) {
    const flag = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
    if (FORBIDDEN_RUNTIME_FLAGS.has(flag)) {
      return failure(`Podman replacement runtime arguments cannot set '${flag}'.`, false);
    }
  }
  return args;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function stagingName(originalName: string, bootstrapIdentity: string): string {
  const suffix = `-nemoclaw-bootstrap-${bootstrapIdentity.slice(0, 12)}`;
  const prefixLength = 253 - suffix.length;
  const value = `${originalName.slice(0, prefixLength)}${suffix}`;
  if (!SAFE_NAME.test(value) || value === originalName) {
    return failure("Podman bootstrap staging name is invalid.", false);
  }
  return value;
}

function normalizePlan(plan: PodmanBootstrapReplacementPlan): NormalizedReplacementPlan {
  if (
    !plan ||
    typeof plan !== "object" ||
    plan.schemaVersion !== PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION ||
    !BOOTSTRAP_IDENTITY.test(plan.bootstrapIdentity)
  ) {
    return failure("Podman bootstrap replacement plan identity is invalid.", false);
  }
  const held = plan.heldWorkload;
  if (!held || typeof held !== "object" || held.running !== true) {
    return failure("Podman bootstrap replacement requires one running held workload.", false);
  }
  const runtimeId = fullRuntimeId(held.runtimeId, "Podman held-workload runtime ID");
  const originalImageContentId = imageContentId(
    held.imageContentId,
    "Podman held-workload image content ID",
  );
  const labels = canonicalLabels(held);
  const originalContainerName = safeString(
    held.containerName,
    "Podman held-workload container name",
  );
  if (!SAFE_NAME.test(originalContainerName)) {
    return failure("Podman held-workload container name is malformed.", false);
  }
  const entrypointArgv = exactArgv(plan.entrypointArgv, "Podman replacement entrypoint", false);
  if (!entrypointArgv[0]?.startsWith("/")) {
    return failure("Podman replacement entrypoint must begin with an absolute path.", false);
  }
  const commandArgv = exactArgv(plan.commandArgv, "Podman replacement command");
  const runtimeArgs = runtimeArguments(plan.runtimeArgs);
  const environment = environmentEntries(plan.environment);
  const replacementImageContentId = imageContentId(
    plan.replacementImageContentId,
    "Podman replacement image content ID",
  );
  const replacementStagingName = stagingName(originalContainerName, plan.bootstrapIdentity);
  const normalizedHeld = Object.freeze({
    ...held,
    runtimeId,
    imageContentId: originalImageContentId,
    labels,
  });
  return Object.freeze({
    schemaVersion: PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION,
    bootstrapIdentity: plan.bootstrapIdentity,
    heldWorkload: normalizedHeld,
    runtimeArgs,
    environment,
    entrypointArgv,
    commandArgv,
    replacementImageContentId,
    replacementStagingName,
    originalSpecFingerprint: stableHash({
      runtimeId,
      originalContainerName,
      originalImageContentId,
      labels,
      supervisorArgv: held.supervisorArgv,
      heldWorkloadArgv: held.heldWorkloadArgv,
    }),
    replacementSpecFingerprint: stableHash({
      replacementStagingName,
      replacementImageContentId,
      labels,
      runtimeArgs,
      environment,
      entrypointArgv,
      commandArgv,
    }),
  });
}

function assertAuthority(authority: PodmanBootstrapReplacementAuthority): void {
  if (
    authority.engine.engineId !== "podman" ||
    authority.engine.operation !== "managed-bootstrap" ||
    !/^podman-sha256:[a-f0-9]{64}$/u.test(authority.engine.authorityId)
  ) {
    failure("Podman bootstrap requires one authority-bound managed-bootstrap engine.", false);
  }
  if (
    authority.watcherLease.record.phase !== "stopped" ||
    typeof authority.watcherLease.assertStillStopped !== "function"
  ) {
    failure("Podman bootstrap requires one durable stopped-watcher lease.", false);
  }
}

function captureWhileWatcherStopped(
  authority: PodmanBootstrapReplacementAuthority,
  args: readonly string[],
  timeoutMs?: number,
): ContainerEngineCommandResult {
  authority.watcherLease.assertStillStopped();
  let result: ContainerEngineCommandResult | undefined;
  let commandFailure: unknown;
  try {
    result = authority.engine.capture(args, timeoutMs);
  } catch (error) {
    commandFailure = error;
  }
  try {
    authority.watcherLease.assertStillStopped();
  } catch (error) {
    if (commandFailure === undefined) commandFailure = error;
  }
  if (commandFailure !== undefined) throw commandFailure;
  return result as ContainerEngineCommandResult;
}

function requireZero(result: ContainerEngineCommandResult, action: string): void {
  if (result.status === 0) return;
  const processError = result.error?.message.trim().slice(0, 400);
  failure(
    `${action} failed with status ${String(result.status)}${processError ? `: ${processError}` : "."}`,
  );
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return failure(`${label} returned unreadable JSON.`);
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function parsedStringArray(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  return exactArgv(typeof value === "string" ? [value] : value, label);
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameMap(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inspectExactContainer(
  authority: PodmanBootstrapReplacementAuthority,
  expected: ExactContainerExpectation,
): ExactContainerObservation {
  const runtimeId = fullRuntimeId(expected.runtimeId, "Expected Podman runtime ID");
  const result = captureWhileWatcherStopped(authority, ["container", "inspect", runtimeId]);
  requireZero(result, "Podman bootstrap container inspect");
  const entries = parseJson(result.stdout, "Podman bootstrap container inspect");
  if (!Array.isArray(entries) || entries.length !== 1) {
    return failure("Podman bootstrap inspect must identify exactly one container.");
  }
  const inspect = record(entries[0], "Podman bootstrap inspect entry");
  const actualRuntimeId = fullRuntimeId(inspect.Id, "Podman bootstrap inspect Id");
  const name = safeString(inspect.Name, "Podman bootstrap inspect Name");
  const actualImageContentId = imageContentId(
    inspect.Image,
    "Podman bootstrap inspect image content ID",
  );
  const config = record(inspect.Config, "Podman bootstrap inspect Config");
  const labels = exactStringMap(config.Labels, "Podman bootstrap inspect labels");
  const state = record(inspect.State, "Podman bootstrap inspect State");
  if (
    typeof state.Running !== "boolean" ||
    state.Paused === true ||
    state.Restarting === true ||
    state.Dead === true
  ) {
    return failure("Podman bootstrap container is not in one stable running or stopped state.");
  }
  const entrypointArgv = parsedStringArray(
    config.Entrypoint,
    "Podman bootstrap inspect entrypoint",
  );
  const commandArgv = parsedStringArray(config.Cmd, "Podman bootstrap inspect command");
  const environment = parsedStringArray(config.Env, "Podman bootstrap inspect environment");
  if (
    actualRuntimeId !== runtimeId ||
    name !== expected.name ||
    actualImageContentId !== expected.imageContentId ||
    state.Running !== expected.running ||
    !sameMap(labels, exactStringMap(expected.labels, "Expected Podman labels"))
  ) {
    return failure("Podman bootstrap container identity or state changed after it was pinned.");
  }
  if (
    (expected.entrypointArgv && !sameArray(entrypointArgv, expected.entrypointArgv)) ||
    (expected.commandArgv && !sameArray(commandArgv, expected.commandArgv)) ||
    (expected.environment && !sameArray(environment, expected.environment)) ||
    (expected.supervisorArgv &&
      !sameArray([...entrypointArgv, ...commandArgv], expected.supervisorArgv))
  ) {
    return failure("Podman bootstrap container startup specification changed after creation.");
  }
  return Object.freeze({
    runtimeId,
    name,
    imageContentId: actualImageContentId,
    labels,
    running: state.Running,
    entrypointArgv,
    commandArgv,
    environment,
  });
}

function sameObservation(
  left: ExactContainerObservation,
  right: ExactContainerObservation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inspectStableContainer(
  authority: PodmanBootstrapReplacementAuthority,
  expected: ExactContainerExpectation,
): ExactContainerObservation {
  const first = inspectExactContainer(authority, expected);
  const second = inspectExactContainer(authority, expected);
  if (!sameObservation(first, second)) {
    return failure("Podman bootstrap container changed during stable inspection.");
  }
  return second;
}

function privateEnvironmentFile<T>(environment: readonly string[], use: (file: string) => T): T {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-bootstrap-"));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, "environment");
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, `${environment.join("\n")}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    return use(file);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

function createArgs(plan: NormalizedReplacementPlan, environmentFile: string): readonly string[] {
  const args = [
    "container",
    "create",
    "--pull=never",
    "--http-proxy=false",
    "--name",
    plan.replacementStagingName,
    "--unsetenv-all",
    "--env-file",
    environmentFile,
  ];
  for (const [key, value] of Object.entries(plan.heldWorkload.labels)) {
    args.push("--label", `${key}=${value}`);
  }
  args.push(
    ...plan.runtimeArgs,
    "--entrypoint",
    JSON.stringify(plan.entrypointArgv),
    plan.replacementImageContentId,
    ...plan.commandArgv,
  );
  return Object.freeze(args);
}

function parseCreatedRuntimeId(output: string): string {
  const lines = output.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) {
    return failure("Podman create did not return one exact replacement runtime ID.");
  }
  return fullRuntimeId(lines[0], "Podman create replacement runtime ID");
}

function createJournal(
  authority: PodmanBootstrapReplacementAuthority,
  plan: NormalizedReplacementPlan,
): PodmanBootstrapJournal {
  return Object.freeze({
    schemaVersion: PODMAN_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
    phase: "preparing-replacement",
    bootstrapIdentity: plan.bootstrapIdentity,
    engineAuthorityId: authority.engine.authorityId,
    watcherLeaseId: authority.watcherLease.record.leaseId,
    sandboxName: plan.heldWorkload.sandboxName,
    sandboxId: plan.heldWorkload.sandboxId,
    originalRuntimeId: plan.heldWorkload.runtimeId,
    originalContainerName: plan.heldWorkload.containerName,
    originalImageContentId: plan.heldWorkload.imageContentId,
    originalSpecFingerprint: plan.originalSpecFingerprint,
    replacementRuntimeId: null,
    replacementStagingName: plan.replacementStagingName,
    replacementImageContentId: plan.replacementImageContentId,
    replacementSpecFingerprint: plan.replacementSpecFingerprint,
  });
}

function assertJournalAuthority(
  authority: PodmanBootstrapReplacementAuthority,
  journal: PodmanBootstrapJournal,
): void {
  if (
    journal.engineAuthorityId !== authority.engine.authorityId ||
    journal.watcherLeaseId !== authority.watcherLease.record.leaseId
  ) {
    failure(
      "Podman bootstrap journal authority does not match the active engine and watcher lease.",
    );
  }
}

function expectedOriginal(
  journal: PodmanBootstrapJournal,
  held: PodmanHeldWorkloadObservation,
  running: boolean,
): ExactContainerExpectation {
  if (
    held.runtimeId !== journal.originalRuntimeId ||
    held.containerName !== journal.originalContainerName ||
    held.imageContentId !== journal.originalImageContentId ||
    held.sandboxId !== journal.sandboxId ||
    held.sandboxName !== journal.sandboxName
  ) {
    failure("Podman bootstrap held-workload evidence does not match the durable journal.");
  }
  return {
    runtimeId: journal.originalRuntimeId,
    name: journal.originalContainerName,
    imageContentId: journal.originalImageContentId,
    labels: held.labels,
    running,
    supervisorArgv: held.supervisorArgv,
  };
}

function expectedReplacement(
  plan: NormalizedReplacementPlan,
  runtimeId: string,
): ExactContainerExpectation {
  return {
    runtimeId,
    name: plan.replacementStagingName,
    imageContentId: plan.replacementImageContentId,
    labels: plan.heldWorkload.labels,
    running: false,
    entrypointArgv: plan.entrypointArgv,
    commandArgv: plan.commandArgv,
    environment: plan.environment,
  };
}

function replacementExpectationFromJournal(
  journal: PodmanBootstrapJournal,
  held: PodmanHeldWorkloadObservation,
  runtimeId: string,
): ExactContainerExpectation {
  return {
    runtimeId,
    name: journal.replacementStagingName,
    imageContentId: journal.replacementImageContentId,
    labels: held.labels,
    running: false,
  };
}

function listStagingRuntimeIds(
  authority: PodmanBootstrapReplacementAuthority,
  stagingContainerName: string,
): readonly string[] {
  const result = captureWhileWatcherStopped(authority, [
    "container",
    "ls",
    "--all",
    "--no-trunc",
    "--filter",
    `name=^${stagingContainerName}$`,
    "--format",
    "json",
  ]);
  requireZero(result, "Podman bootstrap staging discovery");
  const entries = parseJson(result.stdout, "Podman bootstrap staging discovery");
  if (!Array.isArray(entries)) failure("Podman bootstrap staging discovery must return an array.");
  const ids = entries.map((entry, index) => {
    const candidate = record(entry, `Podman staging discovery entry ${String(index)}`);
    return fullRuntimeId(
      candidate.Id ?? candidate.ID,
      `Podman staging discovery entry ${String(index)} ID`,
    );
  });
  if (ids.length > 1 || new Set(ids).size !== ids.length) {
    failure("Podman bootstrap staging discovery returned ambiguous replacement identities.");
  }
  return Object.freeze(ids);
}

function containerExists(
  authority: PodmanBootstrapReplacementAuthority,
  runtimeId: string,
): boolean {
  const result = captureWhileWatcherStopped(authority, ["container", "exists", runtimeId]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  requireZero(result, "Podman bootstrap container existence check");
  return false;
}

function requireJournalPhase(
  journal: PodmanBootstrapJournal | null,
  phases: readonly PodmanBootstrapJournalPhase[],
): PodmanBootstrapJournal {
  if (!journal || !phases.includes(journal.phase)) {
    failure(
      `Podman bootstrap journal requires phase ${phases.join(" or ")}; found ${journal?.phase ?? "absent"}.`,
    );
  }
  return journal;
}

export function prepareStoppedPodmanBootstrapReplacement(
  input: PrepareStoppedPodmanBootstrapReplacementInput,
): PodmanBootstrapPreparedReplacement {
  assertAuthority(input);
  const plan = normalizePlan(input.plan);
  input.watcherLease.assertStillStopped();
  input.journalStore.create(createJournal(input, plan));
  const result = privateEnvironmentFile(plan.environment, (environmentFile) =>
    captureWhileWatcherStopped(input, createArgs(plan, environmentFile), CREATE_TIMEOUT_MS),
  );
  requireZero(result, "Podman stopped bootstrap replacement creation");
  const replacementRuntimeId = parseCreatedRuntimeId(result.stdout);
  inspectStableContainer(input, expectedReplacement(plan, replacementRuntimeId));
  const journal = input.journalStore.recordReplacement(
    plan.bootstrapIdentity,
    replacementRuntimeId,
  );
  assertJournalAuthority(input, journal);
  return Object.freeze({
    schemaVersion: PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION,
    bootstrapIdentity: plan.bootstrapIdentity,
    originalRuntimeId: plan.heldWorkload.runtimeId,
    replacementRuntimeId,
    replacementStagingName: plan.replacementStagingName,
    replacementImageContentId: plan.replacementImageContentId,
    replacementSpecFingerprint: plan.replacementSpecFingerprint,
    journal,
  });
}

export function stopExactPodmanBootstrapOriginal(
  input: StopExactPodmanBootstrapOriginalInput,
): PodmanBootstrapPreparedReplacement {
  assertAuthority(input);
  const journal = requireJournalPhase(input.journalStore.load(input.prepared.bootstrapIdentity), [
    "replacement-created",
  ]);
  assertJournalAuthority(input, journal);
  if (
    input.prepared.originalRuntimeId !== journal.originalRuntimeId ||
    input.prepared.replacementRuntimeId !== journal.replacementRuntimeId ||
    input.prepared.replacementSpecFingerprint !== journal.replacementSpecFingerprint
  ) {
    failure("Podman bootstrap prepared replacement does not match the durable journal.");
  }
  inspectStableContainer(input, expectedOriginal(journal, input.heldWorkload, true));
  inspectStableContainer(
    input,
    replacementExpectationFromJournal(
      journal,
      input.heldWorkload,
      input.prepared.replacementRuntimeId,
    ),
  );
  const stop = captureWhileWatcherStopped(input, ["container", "stop", journal.originalRuntimeId]);
  requireZero(stop, "Podman bootstrap original-container stop");
  inspectStableContainer(input, expectedOriginal(journal, input.heldWorkload, false));
  inspectStableContainer(
    input,
    replacementExpectationFromJournal(
      journal,
      input.heldWorkload,
      input.prepared.replacementRuntimeId,
    ),
  );
  const stopped = input.journalStore.recordOriginalStopped(journal.bootstrapIdentity);
  return Object.freeze({ ...input.prepared, journal: stopped });
}

export function rollbackPodmanBootstrapBeforeCommit(
  input: RollbackPodmanBootstrapBeforeCommitInput,
): PodmanBootstrapRollbackReceipt {
  assertAuthority(input);
  const current = requireJournalPhase(input.journalStore.load(input.bootstrapIdentity), [
    "preparing-replacement",
    "replacement-created",
    "original-stopped",
    "rollback-authorized",
  ]);
  assertJournalAuthority(input, current);
  expectedOriginal(current, input.heldWorkload, current.phase !== "original-stopped");
  const journal = input.journalStore.authorizeRollback(input.bootstrapIdentity, [
    "preparing-replacement",
    "replacement-created",
    "original-stopped",
  ]);
  assertJournalAuthority(input, journal);

  const discoveredIds = listStagingRuntimeIds(input, journal.replacementStagingName);
  const runtimeIds = new Set<string>(discoveredIds);
  if (journal.replacementRuntimeId) runtimeIds.add(journal.replacementRuntimeId);
  if (runtimeIds.size > 1) {
    failure("Podman bootstrap rollback found conflicting replacement runtime identities.");
  }
  const replacementRuntimeId = [...runtimeIds][0] ?? null;
  let replacementRemoved = false;
  if (replacementRuntimeId && containerExists(input, replacementRuntimeId)) {
    inspectStableContainer(
      input,
      replacementExpectationFromJournal(journal, input.heldWorkload, replacementRuntimeId),
    );
    const remove = captureWhileWatcherStopped(input, ["container", "rm", replacementRuntimeId]);
    requireZero(remove, "Podman bootstrap replacement rollback removal");
    if (containerExists(input, replacementRuntimeId)) {
      failure("Podman bootstrap replacement remained after exact rollback removal.");
    }
    replacementRemoved = true;
  }
  if (listStagingRuntimeIds(input, journal.replacementStagingName).length !== 0) {
    failure("Podman bootstrap replacement staging name remained after rollback.");
  }

  const originalWasRunning = inspectStableContainer(
    input,
    expectedOriginal(journal, input.heldWorkload, current.phase !== "original-stopped"),
  ).running;
  let originalStarted = false;
  if (!originalWasRunning) {
    const start = captureWhileWatcherStopped(input, [
      "container",
      "start",
      journal.originalRuntimeId,
    ]);
    requireZero(start, "Podman bootstrap original-container rollback start");
    originalStarted = true;
  }
  inspectStableContainer(input, expectedOriginal(journal, input.heldWorkload, true));
  input.journalStore.removeAfterRollback(input.bootstrapIdentity);
  input.watcherLease.assertStillStopped();
  return Object.freeze({
    bootstrapIdentity: input.bootstrapIdentity,
    originalRuntimeId: journal.originalRuntimeId,
    originalStarted,
    replacementRemoved,
  });
}
