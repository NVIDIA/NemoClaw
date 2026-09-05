// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import { isValidName } from "../../name-validation";
import { cliName } from "../branding";
import type {
  RuntimeProviderLifecycleInput,
  RuntimeProviderLifecycleResult,
  RuntimeProviderLifecycleStopHooks,
  RuntimeProviderLifecycleStopOutcome,
} from "./contract";

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
const STOP_GRACE_SECONDS = 30;
const FULL_CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/u;
const AT_REST_STATES = new Set(["configured", "created", "dead", "exited", "stopped"]);
const STOPPABLE_TRANSITION_STATES = new Set(["restarting", "stopping"]);
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

function resolveManagedContainer(
  engine: ContainerEngine,
  sandboxName: string,
): PodmanManagedContainer {
  const container = observePodmanManagedContainer(engine, sandboxName);
  if (container) return container;
  throw new Error(
    `No Podman container found for sandbox '${sandboxName}'. Run '${cliName()} ${sandboxName} rebuild' if its workload was removed.`,
  );
}

function resultForFailure(error: unknown): RuntimeProviderLifecycleResult {
  return {
    exitCode: 1,
    message: `  ${error instanceof Error ? error.message : String(error)}`,
  };
}

function mutateContainer(
  engine: ContainerEngine,
  operation: "restart" | "start" | "stop" | "unpause",
  container: PodmanManagedContainer,
): void {
  const args = [
    operation,
    ...(operation === "stop" || operation === "restart"
      ? ["--time", String(STOP_GRACE_SECONDS)]
      : []),
    container.containerId,
  ];
  const result = engine.capture(args, PODMAN_LIFECYCLE_MUTATION_TIMEOUT_MS);
  if (result.status !== 0 || result.error) throw commandFailure(operation, result);
}

/** Repair a failed gateway probe without changing the pinned Podman container identity. */
export function recoverPodmanSandbox(
  input: RuntimeProviderLifecycleInput,
  engine: ContainerEngine,
): RuntimeProviderLifecycleResult {
  try {
    let container = resolveManagedContainer(engine, input.sandboxName);
    if (container.paused) {
      mutateContainer(engine, "unpause", container);
      container = inspectExactContainer(engine, {
        sandboxName: input.sandboxName,
        containerId: container.containerId,
        previous: container,
      });
    }
    const operation = container.running ? "restart" : "start";
    if (!container.running && !AT_REST_STATES.has(container.status)) {
      throw new Error(
        `Refusing Podman recovery for sandbox '${input.sandboxName}': container state '${container.status}' is not safely recoverable.`,
      );
    }
    mutateContainer(engine, operation, container);
    const verified = inspectExactContainer(engine, {
      sandboxName: input.sandboxName,
      containerId: container.containerId,
      previous: container,
    });
    if (!verified.running || verified.paused) {
      throw new Error(`Podman ${operation} did not recover the exact managed container.`);
    }
    input.log(`  Container '${container.name}' ${operation === "restart" ? "restarted" : "started"}.`);
    return { exitCode: 0 };
  } catch (error) {
    return resultForFailure(error);
  }
}

export function startPodmanSandbox(
  input: RuntimeProviderLifecycleInput,
  engine: ContainerEngine,
): RuntimeProviderLifecycleResult {
  try {
    const container = resolveManagedContainer(engine, input.sandboxName);
    if (container.running && !container.paused) {
      input.log(`  Sandbox '${input.sandboxName}' is already running.`);
      return { exitCode: 0 };
    }
    if (!container.paused && !AT_REST_STATES.has(container.status)) {
      throw new Error(
        `Refusing Podman start for sandbox '${input.sandboxName}': container state '${container.status}' is not safely restartable.`,
      );
    }
    const operation = container.paused ? "unpause" : "start";
    mutateContainer(engine, operation, container);
    const verified = inspectExactContainer(engine, {
      sandboxName: input.sandboxName,
      containerId: container.containerId,
      previous: container,
    });
    if (!verified.running || verified.paused) {
      throw new Error(`Podman ${operation} did not leave the exact managed container running.`);
    }
    input.log(
      `  Container '${container.name}' ${operation === "unpause" ? "unpaused" : "started"}.`,
    );
    return { exitCode: 0 };
  } catch (error) {
    return resultForFailure(error);
  }
}

export function stopPodmanSandbox(
  input: RuntimeProviderLifecycleInput,
  hooks: RuntimeProviderLifecycleStopHooks,
  engine: ContainerEngine,
): RuntimeProviderLifecycleStopOutcome {
  try {
    const container = resolveManagedContainer(engine, input.sandboxName);
    const stoppable =
      container.running || container.paused || STOPPABLE_TRANSITION_STATES.has(container.status);
    if (!stoppable) {
      if (AT_REST_STATES.has(container.status)) {
        return { exitCode: 0, state: "already-stopped" };
      }
      throw new Error(
        `Refusing Podman stop for sandbox '${input.sandboxName}': container state '${container.status}' is not safely stoppable.`,
      );
    }

    hooks.beforeStop();
    input.log(`  Stopping container '${container.name}'…`);
    mutateContainer(engine, "stop", container);
    const verified = inspectExactContainer(engine, {
      sandboxName: input.sandboxName,
      containerId: container.containerId,
      previous: container,
    });
    if (verified.running || verified.paused || !AT_REST_STATES.has(verified.status)) {
      throw new Error("Podman stop did not leave the exact managed container at rest.");
    }
    return { exitCode: 0, state: "stopped" };
  } catch (error) {
    return resultForFailure(error);
  }
}
