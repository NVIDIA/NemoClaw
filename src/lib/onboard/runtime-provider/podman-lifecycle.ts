// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import { isValidName } from "../../name-validation";

export const PODMAN_MANAGED_LABEL = "openshell.managed";
export const PODMAN_SANDBOX_ID_LABEL = "openshell.ai/sandbox-id";
export const PODMAN_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";
export const PODMAN_SANDBOX_NAMESPACE_LABEL = "openshell.ai/sandbox-namespace";
export const PODMAN_SANDBOX_WORKSPACE_LABEL = "openshell.ai/sandbox-workspace";
export const PODMAN_SANDBOX_NAMESPACE = "";
export const PODMAN_SANDBOX_WORKSPACE = "default";
export const PODMAN_SANDBOX_CONTAINER_PREFIX = `openshell-${PODMAN_SANDBOX_WORKSPACE}--`;

const PROBE_TIMEOUT_MS = 5000;
export const PODMAN_LIFECYCLE_MUTATION_TIMEOUT_MS = 75_000;
const FULL_CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

type JsonRecord = Record<string, unknown>;

export interface PodmanManagedContainer {
  readonly containerId: string;
  readonly inspect: Readonly<JsonRecord>;
  readonly labels: Readonly<Record<string, string>>;
  readonly name: string;
  readonly paused: boolean;
  readonly running: boolean;
  readonly sandboxId: string;
  readonly sandboxNamespace: string;
  readonly status: string;
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function safeText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error(`${label} must be a safe non-empty string.`);
  }
  return value;
}

function safeLabelValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim() || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${label} must be a safe string.`);
  }
  return value;
}

function fullContainerId(value: unknown, label: string): string {
  const candidate = safeText(value, label).toLowerCase();
  const normalized = candidate.startsWith("sha256:") ? candidate.slice(7) : candidate;
  if (!FULL_CONTAINER_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a full immutable container ID.`);
  }
  return normalized;
}

function labels(value: unknown): Readonly<Record<string, string>> {
  const source = record(value, "Podman inspect Config.Labels");
  const result: Record<string, string> = Object.create(null);
  for (const [key, entry] of Object.entries(source)) {
    result[safeText(key, "Podman inspect label key")] = safeLabelValue(
      entry,
      `Podman inspect label '${key}'`,
    );
  }
  return result;
}

function sameStringMap(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  );
}

function parsePodmanManagedContainer(
  output: string,
  expected: {
    readonly sandboxName: string;
    readonly containerId: string;
    readonly previous?: PodmanManagedContainer;
  },
): PodmanManagedContainer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Podman container inspect returned unreadable JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Podman container inspect must identify exactly one container.");
  }
  const entry = record(parsed[0], "Podman container inspect entry");
  const containerId = fullContainerId(entry.Id, "Podman inspect Id");
  if (containerId !== expected.containerId) {
    throw new Error("Podman managed sandbox identity changed after it was pinned.");
  }
  const name = safeText(entry.Name, "Podman inspect Name");
  const config = record(entry.Config, "Podman inspect Config");
  const containerLabels = labels(config.Labels);
  if (containerLabels[PODMAN_MANAGED_LABEL] !== "true") {
    throw new Error(`Podman sandbox is missing exact label ${PODMAN_MANAGED_LABEL}=true.`);
  }
  if (containerLabels[PODMAN_SANDBOX_NAME_LABEL] !== expected.sandboxName) {
    throw new Error(
      `Podman sandbox is missing exact label ${PODMAN_SANDBOX_NAME_LABEL}=${expected.sandboxName}.`,
    );
  }
  const sandboxId = safeText(
    containerLabels[PODMAN_SANDBOX_ID_LABEL],
    `Podman label ${PODMAN_SANDBOX_ID_LABEL}`,
  );
  const sandboxNamespace = safeLabelValue(
    containerLabels[PODMAN_SANDBOX_NAMESPACE_LABEL],
    `Podman label ${PODMAN_SANDBOX_NAMESPACE_LABEL}`,
  );
  if (sandboxNamespace !== PODMAN_SANDBOX_NAMESPACE) {
    throw new Error(
      `Podman sandbox is missing exact OpenShell v0.0.106 label ${PODMAN_SANDBOX_NAMESPACE_LABEL}=<empty>.`,
    );
  }
  if (containerLabels[PODMAN_SANDBOX_WORKSPACE_LABEL] !== PODMAN_SANDBOX_WORKSPACE) {
    throw new Error(
      `Podman sandbox is missing exact label ${PODMAN_SANDBOX_WORKSPACE_LABEL}=${PODMAN_SANDBOX_WORKSPACE}.`,
    );
  }
  const expectedName = `${PODMAN_SANDBOX_CONTAINER_PREFIX}${expected.sandboxName}-${sandboxId}`;
  if (name !== expectedName) {
    throw new Error(
      `Podman managed sandbox name '${name}' does not match its exact OpenShell identity.`,
    );
  }
  if (
    expected.previous &&
    (expected.previous.name !== name ||
      expected.previous.sandboxId !== sandboxId ||
      expected.previous.sandboxNamespace !== sandboxNamespace ||
      !sameStringMap(expected.previous.labels, containerLabels))
  ) {
    throw new Error("Podman managed sandbox ownership changed after it was pinned.");
  }
  const state = record(entry.State, "Podman inspect State");
  if (typeof state.Running !== "boolean") {
    throw new Error("Podman inspect State.Running must be a boolean.");
  }
  if (state.Paused !== undefined && state.Paused !== null && typeof state.Paused !== "boolean") {
    throw new Error("Podman inspect State.Paused must be a boolean.");
  }
  return {
    containerId,
    inspect: entry,
    labels: containerLabels,
    name,
    running: state.Running,
    paused: state.Paused === true,
    sandboxId,
    sandboxNamespace,
    status: safeText(state.Status, "Podman inspect State.Status").toLowerCase(),
  };
}

function commandDetail(result: ContainerEngineCommandResult): string {
  return (result.stderr || result.stdout || result.error?.message || "unknown failure")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-500);
}

function commandFailure(operation: string, result: ContainerEngineCommandResult): Error {
  return new Error(
    `podman ${operation} failed (exit ${String(result.status)}): ${commandDetail(result)}`,
  );
}

function requireObservationEngine(engine: ContainerEngine): void {
  if (
    engine.engineId !== "podman" ||
    (engine.operation !== "sandbox-lifecycle" && engine.operation !== "gateway-inspection")
  ) {
    throw new Error("Podman runtime observation requires an operation-scoped Podman engine.");
  }
}

function inspectExactContainer(
  engine: ContainerEngine,
  expected: {
    readonly sandboxName: string;
    readonly containerId: string;
    readonly previous?: PodmanManagedContainer;
  },
): PodmanManagedContainer {
  const inspected = engine.capture(
    ["container", "inspect", expected.containerId],
    PROBE_TIMEOUT_MS,
  );
  if (inspected.status !== 0 || inspected.error) {
    throw commandFailure("container inspect", inspected);
  }
  return parsePodmanManagedContainer(inspected.stdout, expected);
}

export function observePodmanManagedContainer(
  engine: ContainerEngine,
  sandboxName: string,
): PodmanManagedContainer | null {
  requireObservationEngine(engine);
  if (!isValidName(sandboxName)) {
    throw new Error("Podman lifecycle requires a valid sandbox name.");
  }
  const lookup = engine.capture(
    [
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      `label=${PODMAN_MANAGED_LABEL}=true`,
      "--filter",
      `label=${PODMAN_SANDBOX_NAME_LABEL}=${sandboxName}`,
      "--filter",
      `label=${PODMAN_SANDBOX_WORKSPACE_LABEL}=${PODMAN_SANDBOX_WORKSPACE}`,
      "--format",
      "{{.ID}}",
    ],
    PROBE_TIMEOUT_MS,
  );
  if (lookup.status !== 0 || lookup.error) throw commandFailure("container lookup", lookup);
  const rows = lookup.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1) {
    throw new Error(
      `Refusing Podman lifecycle mutation: sandbox '${sandboxName}' has ${String(rows.length)} managed containers.`,
    );
  }
  const containerId = fullContainerId(rows[0], "Podman managed container ID");
  return inspectExactContainer(engine, { sandboxName, containerId });
}
