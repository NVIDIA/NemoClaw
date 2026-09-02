// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import { MANAGED_BOOTSTRAP_IDENTITY_ENV } from "./adapter";

// OpenShell v0.0.106 Podman ownership contract. Keep the legacy managed marker,
// but bind sandbox identity to the same labels and default-workspace name that
// the pinned OpenShell release emits.
export const PODMAN_MANAGED_LABEL = "openshell.managed";
export const PODMAN_OPENSHELL_MANAGED_BY_LABEL = "openshell.ai/managed-by";
export const PODMAN_OPENSHELL_MANAGED_BY_VALUE = "openshell";
export const PODMAN_SANDBOX_ID_LABEL = "openshell.ai/sandbox-id";
export const PODMAN_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";
export const PODMAN_SANDBOX_NAMESPACE_LABEL = "openshell.ai/sandbox-namespace";
export const PODMAN_SANDBOX_WORKSPACE_LABEL = "openshell.ai/sandbox-workspace";
export const PODMAN_SANDBOX_NAMESPACE = "";
export const PODMAN_SANDBOX_WORKSPACE = "default";
export const PODMAN_SANDBOX_CONTAINER_PREFIX = `openshell-${PODMAN_SANDBOX_WORKSPACE}--`;

const FULL_ID = /^(?:sha256:)?([0-9a-f]{64})$/iu;
const BOOTSTRAP_IDENTITY = /^[0-9a-f]{64}$/u;
const SAFE_SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const SAFE_SANDBOX_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_ARGV_BYTES = 128 * 1024;
const MAX_CONTAINER_NAME_BYTES = 255;
const OPENSHELL_DRIVER_IDLE_COMMAND = "sleep infinity";

type JsonRecord = Record<string, unknown>;

export interface PodmanHeldWorkloadObservation {
  readonly containerName: string;
  readonly heldWorkloadArgv: readonly string[];
  readonly imageContentId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly runtimeId: string;
  readonly running: true;
  readonly sandboxId: string;
  readonly sandboxName: string;
  readonly supervisorArgv: readonly string[];
}

export interface InspectPodmanHeldWorkloadInput {
  readonly bootstrapIdentity: string;
  readonly engine: ContainerEngine;
  readonly expectedHeldWorkloadArgv: readonly string[];
  readonly expectedImageContentId?: string;
  readonly expectedSupervisorArgv: readonly string[];
  readonly sandboxId: string;
  readonly sandboxName: string;
  readonly sandboxNamespace: string;
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function safeString(value: unknown, label: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES ||
    value !== value.trim() ||
    value.includes("\0") ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error(`${label} must be a bounded${allowEmpty ? "" : " non-empty"} string.`);
  }
  return value;
}

function safeSandboxName(value: string): string {
  if (!SAFE_SANDBOX_NAME.test(value)) {
    throw new Error("Managed bootstrap Podman sandbox name is invalid.");
  }
  return value;
}

function safeSandboxId(value: string): string {
  if (!SAFE_SANDBOX_ID.test(value)) {
    throw new Error("Managed bootstrap Podman sandbox ID is invalid.");
  }
  return value;
}

function exactContainerName(sandboxName: string, sandboxId: string): string {
  const name = `${PODMAN_SANDBOX_CONTAINER_PREFIX}${sandboxName}-${sandboxId}`;
  if (Buffer.byteLength(name, "utf8") > MAX_CONTAINER_NAME_BYTES) {
    throw new Error("Managed bootstrap Podman sandbox container name exceeds OpenShell's limit.");
  }
  return name;
}

function fullId(value: unknown, label: string): string {
  const match = safeString(value, label).match(FULL_ID);
  if (!match?.[1]) throw new Error(`${label} must be a full immutable SHA-256 identifier.`);
  return match[1].toLowerCase();
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  const values = typeof value === "string" ? [value] : array(value, label);
  const normalized = values.map((entry, index) =>
    safeString(entry, `${label}[${String(index)}]`, true),
  );
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_ARGV_BYTES) {
    throw new Error(`${label} exceeds the bounded argv transport.`);
  }
  return Object.freeze(normalized);
}

function stringMap(value: unknown, label: string): Readonly<Record<string, string>> {
  const source = record(value, label);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(source)) {
    result[safeString(key, `${label} key`)] = safeString(entry, `${label}.${key}`, true);
  }
  return Object.freeze(result);
}

function assertBootstrapEngine(engine: ContainerEngine): void {
  if (engine.engineId !== "podman" || engine.operation !== "managed-bootstrap") {
    throw new Error("Managed bootstrap requires a Podman 'managed-bootstrap' command adapter.");
  }
}

function commandFailure(result: ContainerEngineCommandResult, action: string): never {
  const processError = result.error?.message.trim().slice(0, 400);
  throw new Error(
    `${action} failed with status ${String(result.status)}${processError ? `: ${processError}` : "."}`,
  );
}

function capture(
  engine: ContainerEngine,
  args: readonly string[],
  action: string,
): ContainerEngineCommandResult {
  const result = engine.capture(args);
  if (result.status !== 0) return commandFailure(result, action);
  return result;
}

function parseJson(output: string, label: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} returned unreadable JSON.`);
  }
}

function listEntryId(value: unknown, index: number): string {
  const entry = record(value, `Podman managed container list entry ${String(index)}`);
  const id = entry.Id ?? entry.ID;
  if (entry.Id !== undefined && entry.ID !== undefined && entry.Id !== entry.ID) {
    throw new Error("Podman managed container list returned conflicting identifier fields.");
  }
  return fullId(id, `Podman managed container list entry ${String(index)} ID`);
}

function discoverRuntimeId(
  engine: ContainerEngine,
  identity: {
    readonly sandboxId: string;
    readonly sandboxName: string;
  },
): string {
  const output = capture(
    engine,
    [
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--filter",
      `label=${PODMAN_MANAGED_LABEL}=true`,
      "--filter",
      `label=${PODMAN_SANDBOX_ID_LABEL}=${identity.sandboxId}`,
      "--filter",
      `label=${PODMAN_SANDBOX_NAME_LABEL}=${identity.sandboxName}`,
      "--filter",
      `label=${PODMAN_SANDBOX_WORKSPACE_LABEL}=${PODMAN_SANDBOX_WORKSPACE}`,
      "--format",
      "json",
    ],
    "Managed bootstrap Podman discovery",
  ).stdout;
  const entries = array(parseJson(output, "Podman managed container discovery"), "Podman list");
  const ids = entries.map(listEntryId);
  if (ids.length !== 1 || new Set(ids).size !== 1) {
    throw new Error(
      `Managed bootstrap requires exactly one Podman workload for sandbox '${identity.sandboxName}'; found ${String(ids.length)}.`,
    );
  }
  return ids[0] as string;
}

function exactEnvironmentValue(environment: readonly string[], key: string): string {
  const prefix = `${key}=`;
  const values = environment.filter((entry) => entry.startsWith(prefix));
  if (values.length !== 1) {
    throw new Error(`Podman held workload must contain one exact ${key} binding.`);
  }
  return (values[0] as string).slice(prefix.length);
}

function exactArrayEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseObservation(
  output: string,
  input: Omit<InspectPodmanHeldWorkloadInput, "engine">,
  runtimeId: string,
): PodmanHeldWorkloadObservation {
  const entries = array(parseJson(output, "Podman container inspect"), "Podman inspect response");
  if (entries.length !== 1) {
    throw new Error("Podman container inspect must identify exactly one container.");
  }
  const inspect = record(entries[0], "Podman inspect entry");
  if (fullId(inspect.Id, "Podman inspect Id") !== runtimeId) {
    throw new Error("Podman held workload identity changed after discovery.");
  }
  const containerName = safeString(inspect.Name, "Podman inspect Name");
  const expectedContainerName = exactContainerName(input.sandboxName, input.sandboxId);
  if (containerName !== expectedContainerName) {
    throw new Error("Podman held workload name does not match its OpenShell sandbox identity.");
  }
  const config = record(inspect.Config, "Podman inspect Config");
  const labels = stringMap(config.Labels, "Podman inspect Config.Labels");
  if (
    labels[PODMAN_MANAGED_LABEL] !== "true" ||
    labels[PODMAN_SANDBOX_NAME_LABEL] !== input.sandboxName ||
    labels[PODMAN_SANDBOX_ID_LABEL] !== input.sandboxId ||
    labels[PODMAN_SANDBOX_NAMESPACE_LABEL] !== input.sandboxNamespace ||
    labels[PODMAN_SANDBOX_WORKSPACE_LABEL] !== PODMAN_SANDBOX_WORKSPACE
  ) {
    throw new Error("Podman held workload labels do not match its exact OpenShell ownership.");
  }
  const state = record(inspect.State, "Podman inspect State");
  if (state.Running !== true || state.Paused === true || state.Restarting === true) {
    throw new Error("Podman held workload must be stably running before bootstrap preparation.");
  }
  const configuredUser = String(config.User ?? "")
    .trim()
    .toLowerCase();
  if (!["", "0", "0:0", "root", "root:root"].includes(configuredUser)) {
    throw new Error("Podman held workload does not use the image-owned root supervisor boundary.");
  }
  const supervisorArgv = Object.freeze([
    ...stringArray(config.Entrypoint, "Podman inspect Config.Entrypoint"),
    ...stringArray(config.Cmd, "Podman inspect Config.Cmd"),
  ]);
  if (supervisorArgv.length === 0 || !supervisorArgv[0]?.startsWith("/")) {
    throw new Error("Podman held workload supervisor argv must begin with an absolute path.");
  }
  if (!exactArrayEqual(supervisorArgv, input.expectedSupervisorArgv)) {
    throw new Error("Podman held workload supervisor argv changed before bootstrap preparation.");
  }
  const environment = stringArray(config.Env, "Podman inspect Config.Env");
  if (
    exactEnvironmentValue(environment, MANAGED_BOOTSTRAP_IDENTITY_ENV) !== input.bootstrapIdentity
  ) {
    throw new Error("Podman held workload bootstrap identity binding changed before preparation.");
  }
  if (
    exactEnvironmentValue(environment, "OPENSHELL_SANDBOX_COMMAND") !==
    OPENSHELL_DRIVER_IDLE_COMMAND
  ) {
    throw new Error("Podman held workload left the OpenShell idle hold boundary.");
  }
  const imageContentId = `sha256:${fullId(inspect.Image, "Podman inspect Image")}`;
  if (
    input.expectedImageContentId &&
    imageContentId !== `sha256:${fullId(input.expectedImageContentId, "Expected image content ID")}`
  ) {
    throw new Error("Podman held workload image content changed before bootstrap preparation.");
  }
  return Object.freeze({
    containerName,
    heldWorkloadArgv: Object.freeze([...input.expectedHeldWorkloadArgv]),
    imageContentId,
    labels,
    runtimeId,
    running: true,
    sandboxId: input.sandboxId,
    sandboxName: input.sandboxName,
    supervisorArgv,
  });
}

function sameObservation(
  left: PodmanHeldWorkloadObservation,
  right: PodmanHeldWorkloadObservation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Resolve and inspect one OpenShell v0.0.106 Podman workload twice. The caller
 * receives only immutable ownership and startup evidence; replacement planning
 * remains in the provider transaction that owns the complete launch spec.
 */
export function inspectExactPodmanHeldWorkload(
  input: InspectPodmanHeldWorkloadInput,
): PodmanHeldWorkloadObservation {
  assertBootstrapEngine(input.engine);
  if (
    !BOOTSTRAP_IDENTITY.test(input.bootstrapIdentity) ||
    !input.expectedHeldWorkloadArgv.includes(input.bootstrapIdentity)
  ) {
    throw new Error("Managed bootstrap Podman held command has an invalid bootstrap identity.");
  }
  const sandboxName = safeSandboxName(input.sandboxName);
  const sandboxId = safeSandboxId(input.sandboxId);
  if (input.sandboxNamespace !== PODMAN_SANDBOX_NAMESPACE) {
    throw new Error("Managed bootstrap Podman sandbox namespace must match OpenShell v0.0.106.");
  }
  const sandboxNamespace = PODMAN_SANDBOX_NAMESPACE;
  exactContainerName(sandboxName, sandboxId);
  const runtimeId = discoverRuntimeId(input.engine, {
    sandboxId,
    sandboxName,
  });
  const inspectArgs = ["container", "inspect", runtimeId] as const;
  const values = { ...input, sandboxId, sandboxName, sandboxNamespace };
  const first = parseObservation(
    capture(input.engine, inspectArgs, "Managed bootstrap Podman inspect").stdout,
    values,
    runtimeId,
  );
  const second = parseObservation(
    capture(input.engine, inspectArgs, "Managed bootstrap Podman stable re-inspect").stdout,
    values,
    runtimeId,
  );
  if (!sameObservation(first, second)) {
    throw new Error("Podman held workload changed during stable identity capture.");
  }
  return second;
}
