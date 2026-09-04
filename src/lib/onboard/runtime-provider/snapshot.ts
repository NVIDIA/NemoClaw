// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { captureOpenshell } from "../../adapters/openshell/runtime";
import type { SandboxEntry } from "../../state/registry/types";
import { resolveSandboxGatewayName } from "../gateway-binding";
import {
  type OpenShellDockerSandboxRuntimeSnapshotQuery,
  queryOpenShellDockerSandboxRuntimeSnapshot,
} from "../openshell-docker-sandbox-containers";
import {
  RUNTIME_PROVIDER_SNAPSHOT_CONTRACT_VERSION,
  RUNTIME_PROVIDER_SNAPSHOT_PREFLIGHT_SCHEMA_VERSION,
  type RuntimeProviderCommandCapture,
  type RuntimeProviderManagedProfileRestoreAuthority,
  type RuntimeProviderRuntimeReceipt,
  type RuntimeProviderSnapshotLifecycleState,
  type RuntimeProviderSnapshotOperation,
  type RuntimeProviderSnapshotPreflightReceipt,
  type RuntimeProviderSnapshotRestoreReceipt,
  type RuntimeProviderSnapshotRestoreSource,
  type RuntimeProviderSnapshotSurface,
} from "./contract";
import {
  normalizeRuntimeProviderIdentity,
  normalizeRuntimeProviderManagedProfileRestoreAuthority,
  normalizeRuntimeProviderRuntimeReceipt,
  normalizeRuntimeProviderSnapshotPreflightReceipt,
  normalizeRuntimeProviderSnapshotRestoreSource,
} from "./registry";

const SANDBOX_ID_PATTERN = /^[A-Za-z0-9._-]{1,512}$/u;
const DOCKER_CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/u;
const MANAGED_STARTUP_RUNTIME_EXECUTABLE =
  "/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs";
// Dockerfile copies and validates this exact final-image path; the managed
// startup hold and bootstrap trampoline invoke the same 0444 runtime through it.
const MANAGED_STARTUP_NODE_EXECUTABLE = "/usr/local/bin/node";
const LIFECYCLE_GENERATION_PATTERN = /^[A-Za-z0-9._:/=-]{1,512}$/u;
const ANSI_PATTERN = /\u001b\[[0-9;]*m/gu;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTROL_CHARACTERS_GLOBAL = /[\u0000-\u001f\u007f-\u009f]/gu;
const TERMINAL_CONTROL_SEQUENCE =
  /(?:\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)|\u001b[ -/]*[@-~])/gu;

export interface RuntimeProviderSnapshotObservation {
  readonly lifecycleState: RuntimeProviderSnapshotLifecycleState;
  readonly lifecycleGeneration: string;
  readonly runtime: RuntimeProviderRuntimeReceipt;
}

export type RuntimeProviderSnapshotObserver = (
  sandbox: SandboxEntry,
  providerId: string,
) => RuntimeProviderSnapshotObservation;

export type RuntimeProviderManagedProfileRestorer = (
  sandbox: SandboxEntry,
  authority: RuntimeProviderManagedProfileRestoreAuthority,
  runtime: RuntimeProviderRuntimeReceipt,
) => string;

export interface RuntimeProviderSnapshotDriver {
  readonly observe: RuntimeProviderSnapshotObserver;
  readonly restoreManagedProfile: RuntimeProviderManagedProfileRestorer;
  readonly canRepresentAcceleration?: (
    source: RuntimeProviderRuntimeReceipt["acceleration"],
    target: RuntimeProviderRuntimeReceipt["acceleration"],
  ) => boolean;
}

export interface OpenShellRuntimeSnapshotDependencies {
  readonly capture: typeof captureOpenshell;
  /**
   * The owning provider must supply acceleration observed from its live
   * runtime. Durable registry intent is deliberately not accepted here.
   */
  readonly observeAcceleration: (
    sandbox: SandboxEntry,
    runtimeId: string,
  ) => RuntimeProviderRuntimeReceipt["acceleration"];
}

export interface DockerRuntimeSnapshotDependencies {
  readonly captureHostCommand: (
    command: string,
    args: string[],
    timeout?: number,
  ) => RuntimeProviderCommandCapture;
  readonly queryRuntimeSnapshot: (
    sandboxName: string,
  ) => OpenShellDockerSandboxRuntimeSnapshotQuery;
}

export class RuntimeProviderSnapshotError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Runtime snapshot provider failed: ${message}`, options);
    this.name = "RuntimeProviderSnapshotError";
  }
}

function gatewayScopedSandboxGetArgs(sandbox: SandboxEntry): string[] {
  const gatewayName = resolveSandboxGatewayName(sandbox);
  return gatewayName
    ? ["sandbox", "get", "-g", gatewayName, sandbox.name]
    : ["sandbox", "get", sandbox.name];
}

function cleanOutput(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function cleanDiagnostic(value: string): string {
  return value.replace(TERMINAL_CONTROL_SEQUENCE, "").replace(CONTROL_CHARACTERS_GLOBAL, "");
}

function managedProfileVerificationFailureDetail(result: RuntimeProviderCommandCapture): string {
  // This command accepts only a validated agent and secret-free profile hash;
  // bound its fixed-runtime diagnostic so restore failures remain actionable.
  const output = cleanDiagnostic([result.stderr, result.stdout].filter(Boolean).join("\n"))
    .replace(/\s+/gu, " ")
    .trim();
  const error = cleanDiagnostic(result.error?.message ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return [
    `status=${result.status}`,
    ...(error ? [`error=${error}`] : []),
    ...(output ? [`output=${output}`] : []),
  ]
    .join("; ")
    .slice(0, 1024);
}

function parseSandboxId(output: string): string | null {
  const match = cleanOutput(output).match(/^\s*(?:Id|ID):\s*([A-Za-z0-9._-]+)\s*$/mu);
  return match && SANDBOX_ID_PATTERN.test(match[1] ?? "") ? (match[1] ?? null) : null;
}

function parseLifecycleState(
  output: string,
  sandboxName: string,
): RuntimeProviderSnapshotLifecycleState | null {
  const clean = cleanOutput(output);
  const field = clean.match(/^\s*(?:State|Phase|Status):\s*([A-Za-z][A-Za-z0-9_-]*)\s*$/imu)?.[1];
  const row = clean
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .find((columns) => columns[0] === sandboxName);
  const phase = field ?? row?.slice(1).find((value) => /^[A-Za-z][A-Za-z0-9_-]*$/u.test(value));
  if (phase === "Ready" || phase === "Running") return "running";
  if (phase === "Paused") return "paused";
  if (phase === "Stopped" || phase === "Exited" || phase === "Created") return "stopped";
  return null;
}

function parseLifecycleGeneration(output: string): string | null {
  const match = cleanOutput(output).match(
    /^\s*(?:Generation|ResourceVersion|Resource Version):\s*([A-Za-z0-9._:/=-]+)\s*$/imu,
  );
  const generation = match?.[1] ?? "";
  return LIFECYCLE_GENERATION_PATTERN.test(generation) ? generation : null;
}

/**
 * Observe an OpenShell-owned runtime without exposing its CLI shape to the
 * snapshot action. Exact live identity, lifecycle generation, and provider
 * acceleration evidence are all mandatory; durable fallbacks fail closed.
 */
export function observeOpenShellRuntimeSnapshot(
  sandbox: SandboxEntry,
  providerId: string,
  dependencies: Partial<OpenShellRuntimeSnapshotDependencies> = {},
): RuntimeProviderSnapshotObservation {
  if (normalizeRuntimeProviderIdentity(sandbox.openshellDriver) !== providerId) {
    throw new RuntimeProviderSnapshotError(
      `sandbox '${sandbox.name}' belongs to another runtime provider`,
    );
  }
  const capture = dependencies.capture ?? captureOpenshell;
  const result = capture(gatewayScopedSandboxGetArgs(sandbox), {
    ignoreError: true,
    includeStderr: true,
    timeout: 10_000,
  });
  if (result.status !== 0 || result.error || result.signal) {
    throw new RuntimeProviderSnapshotError(
      `sandbox '${sandbox.name}' runtime identity could not be inspected`,
    );
  }
  const output = result.output || "";
  const sandboxId = parseSandboxId(output);
  if (!sandboxId) {
    throw new RuntimeProviderSnapshotError(
      `sandbox '${sandbox.name}' exact live runtime identity cannot be represented`,
    );
  }
  const lifecycleState = parseLifecycleState(output, sandbox.name);
  const lifecycleGeneration = parseLifecycleGeneration(output);
  if (!lifecycleState || !lifecycleGeneration) {
    throw new RuntimeProviderSnapshotError(
      `sandbox '${sandbox.name}' lifecycle generation cannot be represented`,
    );
  }
  if (!dependencies.observeAcceleration) {
    throw new RuntimeProviderSnapshotError(
      `provider '${providerId}' did not supply live acceleration evidence`,
    );
  }
  return {
    lifecycleState,
    lifecycleGeneration,
    runtime: {
      schemaVersion: 1,
      providerId,
      runtime: {
        kind: "openshell-sandbox",
        handle: sandboxId,
      },
      acceleration: dependencies.observeAcceleration(sandbox, sandboxId),
    },
  };
}

function dockerNvidiaGpuRequestSelectors(
  request: NonNullable<
    Extract<OpenShellDockerSandboxRuntimeSnapshotQuery, { ok: true }>["deviceRequests"]
  >[number],
): readonly string[] | null {
  const driver = request.Driver.trim().toLowerCase();
  const deviceIds = request.DeviceIDs ?? [];
  const hasGpuCapability =
    request.Capabilities?.some((group) =>
      group.some((capability) => capability.trim().toLowerCase() === "gpu"),
    ) === true;
  const hasNvidiaCdiSelector = deviceIds.some((device) =>
    /^nvidia[.]com\/gpu=/iu.test(device.trim()),
  );
  if (driver !== "nvidia" && !hasNvidiaCdiSelector && !hasGpuCapability) return null;

  if (deviceIds.length > 0) {
    if (driver === "nvidia") return deviceIds;
    if (
      ["", "cdi"].includes(driver) &&
      deviceIds.every((device) => /^nvidia[.]com\/gpu=/iu.test(device.trim()))
    ) {
      return deviceIds;
    }
    throw new RuntimeProviderSnapshotError(
      "Docker GPU attachment does not prove NVIDIA acceleration authority",
    );
  }
  if (request.Count === -1 && ["", "nvidia"].includes(driver)) return ["all"];
  throw new RuntimeProviderSnapshotError(
    driver && !["nvidia", "cdi"].includes(driver)
      ? "Docker GPU attachment does not prove NVIDIA acceleration authority"
      : "Docker GPU attachment does not expose exact live device selectors",
  );
}

function canonicalNvidiaGpuSelector(device: string): string {
  const value = device.trim();
  const cdiPrefix = /^nvidia[.]com\/gpu=/iu;
  const identifier = cdiPrefix.test(value) ? value.replace(cdiPrefix, "") : value;
  if (!identifier || CONTROL_CHARACTERS.test(identifier)) {
    throw new RuntimeProviderSnapshotError(
      "Docker GPU attachment does not expose exact live device selectors",
    );
  }
  return identifier.toLowerCase() === "all" ? "nvidia.com/gpu=all" : `nvidia.com/gpu=${identifier}`;
}

function canonicalDockerGpuSelection(devices: readonly string[]): readonly string[] {
  const selectors = [...new Set(devices.map(canonicalNvidiaGpuSelector))].sort();
  if (selectors.includes("nvidia.com/gpu=all") && selectors.length !== 1) {
    throw new RuntimeProviderSnapshotError(
      "Docker GPU attachment exposes conflicting live device selectors",
    );
  }
  return selectors;
}

function canonicalDockerAcceleration(
  acceleration: RuntimeProviderRuntimeReceipt["acceleration"],
): RuntimeProviderRuntimeReceipt["acceleration"] | null {
  if (acceleration.kind === "none") return acceleration;
  if (acceleration.vendor.toLowerCase() !== "nvidia") return null;
  const gpuSelectors: string[] = [];
  const pathSelectors: string[] = [];
  for (const selector of acceleration.devices) {
    if (selector.startsWith("docker-device-path:")) {
      pathSelectors.push(selector);
      continue;
    }
    if (selector === "docker-nvidia-visible-devices:all") {
      gpuSelectors.push("all");
      continue;
    }
    if (/^docker-device-request:[^:]+:count=-1$/u.test(selector)) {
      gpuSelectors.push("all");
      continue;
    }
    const legacyDevice = selector.match(/^docker-(?:device-id|nvidia-visible-device):(.+)$/u)?.[1];
    if (legacyDevice) {
      gpuSelectors.push(legacyDevice);
      continue;
    }
    if (/^nvidia[.]com\/gpu=/iu.test(selector)) {
      gpuSelectors.push(selector);
      continue;
    }
    return null;
  }
  try {
    const devices = [
      ...canonicalDockerGpuSelection(gpuSelectors),
      ...new Set(pathSelectors),
    ].sort();
    return devices.length > 0 ? { kind: "gpu", vendor: "nvidia", devices } : null;
  } catch {
    return null;
  }
}

function dockerCanRepresentAcceleration(
  source: RuntimeProviderRuntimeReceipt["acceleration"],
  target: RuntimeProviderRuntimeReceipt["acceleration"],
): boolean {
  const canonicalSource = canonicalDockerAcceleration(source);
  const canonicalTarget = canonicalDockerAcceleration(target);
  return Boolean(
    canonicalSource && canonicalTarget && isDeepStrictEqual(canonicalSource, canonicalTarget),
  );
}

function dockerGpuSelectors(
  snapshot: Extract<OpenShellDockerSandboxRuntimeSnapshotQuery, { ok: true }>,
): RuntimeProviderRuntimeReceipt["acceleration"] {
  if (snapshot.nativeGpuAttachmentState === "absent") return { kind: "none" };
  if (snapshot.nativeGpuAttachmentState !== "present") {
    throw new RuntimeProviderSnapshotError("Docker returned ambiguous live acceleration evidence");
  }

  const selections: string[][] = [];
  if (snapshot.runtime.trim().toLowerCase() === "nvidia") {
    const visibleDevices = snapshot.nvidiaVisibleDevices;
    if (visibleDevices === "all") {
      selections.push(["all"]);
    } else if (visibleDevices && !["none", "void"].includes(visibleDevices)) {
      selections.push(visibleDevices.split(","));
    }
  }
  const requestedDevices: string[] = [];
  for (const request of snapshot.deviceRequests ?? []) {
    const selectors = dockerNvidiaGpuRequestSelectors(request);
    if (selectors) requestedDevices.push(...selectors);
  }
  if (requestedDevices.length > 0) selections.push(requestedDevices);
  const canonicalSelections = selections.map(canonicalDockerGpuSelection);
  const selectedDevices = canonicalSelections[0] ?? [];
  if (canonicalSelections.some((selection) => !isDeepStrictEqual(selection, selectedDevices))) {
    throw new RuntimeProviderSnapshotError(
      "Docker GPU attachment exposes conflicting live device selectors",
    );
  }
  const selectors = [...selectedDevices];
  for (const mapping of snapshot.devices ?? []) {
    const rendered =
      `docker-device-path:${mapping.PathOnHost}=>${mapping.PathInContainer}` +
      `:${mapping.CgroupPermissions}`;
    if (
      /^\/dev\/(?:nvidia|dri|nvhost|nvmap|tegra)/iu.test(mapping.PathOnHost.trim()) ||
      /^\/dev\/(?:nvidia|dri|nvhost|nvmap|tegra)/iu.test(mapping.PathInContainer.trim())
    ) {
      selectors.push(rendered);
    }
  }
  const devices = [...new Set(selectors)].sort();
  if (
    devices.length === 0 ||
    devices.some(
      (device) =>
        device.trim() === "" ||
        Buffer.byteLength(device, "utf8") > 512 ||
        CONTROL_CHARACTERS.test(device),
    )
  ) {
    throw new RuntimeProviderSnapshotError(
      "Docker GPU attachment does not expose exact live device selectors",
    );
  }
  return { kind: "gpu", vendor: "nvidia", devices };
}

function parseDockerLifecycle(
  result: RuntimeProviderCommandCapture,
  expectedContainerId: string,
): {
  readonly state: RuntimeProviderSnapshotLifecycleState;
  readonly generation: string;
} {
  if (result.status !== 0 || result.error) {
    throw new RuntimeProviderSnapshotError("Docker lifecycle state could not be inspected");
  }
  let fields: unknown;
  try {
    fields = JSON.parse(result.stdout.trim());
  } catch {
    throw new RuntimeProviderSnapshotError("Docker returned malformed lifecycle state");
  }
  if (
    !Array.isArray(fields) ||
    fields.length !== 6 ||
    fields[0] !== expectedContainerId ||
    typeof fields[1] !== "string" ||
    typeof fields[2] !== "boolean" ||
    typeof fields[3] !== "string" ||
    typeof fields[4] !== "string" ||
    !Number.isSafeInteger(fields[5]) ||
    fields[5] < 0
  ) {
    throw new RuntimeProviderSnapshotError("Docker returned malformed lifecycle state");
  }
  const status = fields[1].trim().toLowerCase();
  let state: RuntimeProviderSnapshotLifecycleState;
  if (status === "running") state = fields[2] ? "paused" : "running";
  else if (status === "paused" && fields[2] === true) state = "paused";
  else if (["created", "exited", "dead"].includes(status) && fields[2] === false) state = "stopped";
  else {
    throw new RuntimeProviderSnapshotError(
      `Docker lifecycle '${status || "unknown"}' cannot be represented`,
    );
  }
  const generation = createHash("sha256")
    .update(
      JSON.stringify({
        containerId: fields[0],
        status,
        paused: fields[2],
        startedAt: fields[3],
        finishedAt: fields[4],
        restartCount: fields[5],
      }),
      "utf8",
    )
    .digest("hex");
  return { state, generation };
}

export function observeDockerRuntimeSnapshot(
  sandbox: SandboxEntry,
  providerId: string,
  dependencies: Pick<
    DockerRuntimeSnapshotDependencies,
    "captureHostCommand" | "queryRuntimeSnapshot"
  >,
): RuntimeProviderSnapshotObservation {
  if (normalizeRuntimeProviderIdentity(sandbox.openshellDriver) !== providerId) {
    throw new RuntimeProviderSnapshotError(
      `sandbox '${sandbox.name}' belongs to another runtime provider`,
    );
  }
  const snapshot = dependencies.queryRuntimeSnapshot(sandbox.name);
  if (!snapshot.ok || !DOCKER_CONTAINER_ID_PATTERN.test(snapshot.containerId)) {
    throw new RuntimeProviderSnapshotError(
      `sandbox '${sandbox.name}' exact Docker runtime identity could not be inspected`,
    );
  }
  const lifecycle = parseDockerLifecycle(
    dependencies.captureHostCommand(
      "docker",
      [
        "inspect",
        "--type",
        "container",
        "--format",
        "[{{json .Id}},{{json .State.Status}},{{json .State.Paused}},{{json .State.StartedAt}},{{json .State.FinishedAt}},{{json .RestartCount}}]",
        snapshot.containerId,
      ],
      10_000,
    ),
    snapshot.containerId,
  );
  return {
    lifecycleState: lifecycle.state,
    lifecycleGeneration: lifecycle.generation,
    runtime: {
      schemaVersion: 1,
      providerId,
      runtime: { kind: "docker-container", handle: snapshot.containerId },
      acceleration: dockerGpuSelectors(snapshot),
    },
  };
}

export function verifyDockerManagedProfileRestore(
  sandbox: SandboxEntry,
  authorityValue: RuntimeProviderManagedProfileRestoreAuthority,
  runtimeValue: RuntimeProviderRuntimeReceipt,
  dependencies: Pick<DockerRuntimeSnapshotDependencies, "captureHostCommand">,
): string {
  const authority = normalizeRuntimeProviderManagedProfileRestoreAuthority(authorityValue);
  if (!authority) {
    throw new RuntimeProviderSnapshotError("managed profile restore authority is invalid");
  }
  const runtime = normalizeRuntimeProviderRuntimeReceipt(runtimeValue);
  if (
    !runtime ||
    runtime.runtime.kind !== "docker-container" ||
    !DOCKER_CONTAINER_ID_PATTERN.test(runtime.runtime.handle)
  ) {
    throw new RuntimeProviderSnapshotError(
      `sandbox '${sandbox.name}' exact Docker runtime identity could not be inspected`,
    );
  }
  // The completion handoff is deliberately root-owned under /run/nemoclaw and
  // therefore outside an ordinary Landlock-confined sandbox exec. The Docker
  // provider pins this fixed verifier to the exact live container ID, runs no
  // user-supplied command, and clears the inherited host environment.
  const result = dependencies.captureHostCommand(
    "docker",
    [
      "exec",
      "--user",
      "root",
      runtime.runtime.handle,
      "/usr/bin/env",
      "-i",
      "HOME=/root",
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      MANAGED_STARTUP_NODE_EXECUTABLE,
      MANAGED_STARTUP_RUNTIME_EXECUTABLE,
      "--verify-completion",
      "--agent",
      authority.agent,
      "--profile-fingerprint",
      authority.profileFingerprint,
    ],
    15_000,
  );
  if (result.status !== 0 || result.error) {
    throw new RuntimeProviderSnapshotError(
      `sandbox '${sandbox.name}' managed profile restoration could not be proven (${managedProfileVerificationFailureDetail(result)})`,
    );
  }
  return createHash("sha256")
    .update(sandbox.name, "utf8")
    .update("\0", "utf8")
    .update(authority.agent, "utf8")
    .update("\0", "utf8")
    .update(authority.profileFingerprint, "utf8")
    .update("\0", "utf8")
    .update(cleanOutput(result.stdout), "utf8")
    .digest("hex");
}

function opaqueProviderHandle(
  providerId: string,
  observation: RuntimeProviderSnapshotObservation,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        providerId,
        lifecycleState: observation.lifecycleState,
        lifecycleGeneration: observation.lifecycleGeneration,
        runtime: observation.runtime,
      }),
      "utf8",
    )
    .digest("hex");
}

function observeAndNormalize(
  observer: RuntimeProviderSnapshotObserver,
  sandbox: SandboxEntry,
  providerId: string,
): RuntimeProviderSnapshotObservation {
  const observed = observer(sandbox, providerId);
  const runtime = normalizeRuntimeProviderRuntimeReceipt(observed.runtime);
  if (!runtime || runtime.providerId !== providerId) {
    throw new RuntimeProviderSnapshotError(
      `provider '${providerId}' returned an invalid runtime receipt`,
    );
  }
  if (
    !["running", "paused", "stopped"].includes(observed.lifecycleState) ||
    !LIFECYCLE_GENERATION_PATTERN.test(observed.lifecycleGeneration)
  ) {
    throw new RuntimeProviderSnapshotError(
      `provider '${providerId}' returned invalid lifecycle authority`,
    );
  }
  return {
    lifecycleState: observed.lifecycleState,
    lifecycleGeneration: observed.lifecycleGeneration,
    runtime,
  };
}

function requireStablePreflight(
  value: RuntimeProviderSnapshotPreflightReceipt,
  providerId: string,
  operation: RuntimeProviderSnapshotOperation,
  sandbox: SandboxEntry,
): RuntimeProviderSnapshotPreflightReceipt {
  const normalized = normalizeRuntimeProviderSnapshotPreflightReceipt(value);
  if (
    !normalized ||
    normalized.providerId !== providerId ||
    normalized.operation !== operation ||
    normalized.sandboxName !== sandbox.name
  ) {
    throw new RuntimeProviderSnapshotError(
      `provider '${providerId}' received stale snapshot preflight authority`,
    );
  }
  return normalized;
}

function assertUnchanged(
  providerId: string,
  expected: RuntimeProviderSnapshotPreflightReceipt,
  observed: RuntimeProviderSnapshotObservation,
): void {
  if (
    opaqueProviderHandle(providerId, observed) !== expected.providerHandle ||
    observed.lifecycleState !== expected.lifecycleState ||
    observed.lifecycleGeneration !== expected.lifecycleGeneration
  ) {
    throw new RuntimeProviderSnapshotError(
      `sandbox '${expected.sandboxName}' runtime changed after snapshot preflight`,
    );
  }
}

function restoreProviderHandle(
  preflight: RuntimeProviderSnapshotPreflightReceipt,
  source: RuntimeProviderSnapshotRestoreSource,
  authority: RuntimeProviderManagedProfileRestoreAuthority,
  providerProof: string,
  observed: RuntimeProviderSnapshotObservation,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        preflight,
        source,
        authority,
        providerProof,
        observed,
      }),
      "utf8",
    )
    .digest("hex");
}

function validateRestoreRequest(
  providerId: string,
  driver: RuntimeProviderSnapshotDriver,
  sandbox: SandboxEntry,
  preflightValue: RuntimeProviderSnapshotPreflightReceipt,
  sourceValue: RuntimeProviderSnapshotRestoreSource,
  managedProfileValue: RuntimeProviderManagedProfileRestoreAuthority,
): {
  readonly expected: RuntimeProviderSnapshotPreflightReceipt;
  readonly source: RuntimeProviderSnapshotRestoreSource;
  readonly managedProfile: RuntimeProviderManagedProfileRestoreAuthority;
  readonly observed: RuntimeProviderSnapshotObservation;
} {
  const expected = requireStablePreflight(preflightValue, providerId, "restore", sandbox);
  const source = normalizeRuntimeProviderSnapshotRestoreSource(sourceValue);
  if (!source || source.providerId !== providerId) {
    throw new RuntimeProviderSnapshotError(
      "source runtime authority is invalid or belongs to another provider",
    );
  }
  const sourceObservation = {
    lifecycleState: source.lifecycleState,
    lifecycleGeneration: source.lifecycleGeneration,
    runtime: source.runtime,
  };
  if (opaqueProviderHandle(providerId, sourceObservation) !== source.providerHandle) {
    throw new RuntimeProviderSnapshotError(
      "source runtime receipt does not match its provider handle",
    );
  }
  // A recovery may legitimately follow a runtime restart. Preserve the exact
  // current handle/generation and bind them into the restore receipt rather
  // than requiring them to equal the historical source identity.
  if (source.lifecycleState !== expected.lifecycleState) {
    throw new RuntimeProviderSnapshotError(
      `sandbox '${sandbox.name}' cannot represent the snapshot lifecycle state`,
    );
  }
  const managedProfile =
    normalizeRuntimeProviderManagedProfileRestoreAuthority(managedProfileValue);
  if (!managedProfile) {
    throw new RuntimeProviderSnapshotError("managed profile restore authority is invalid");
  }
  const observed = observeAndNormalize(driver.observe, sandbox, providerId);
  assertUnchanged(providerId, expected, observed);
  const canRepresentAcceleration = driver.canRepresentAcceleration ?? isDeepStrictEqual;
  if (!canRepresentAcceleration(source.runtime.acceleration, observed.runtime.acceleration)) {
    throw new RuntimeProviderSnapshotError(
      `sandbox '${sandbox.name}' cannot represent the snapshot acceleration state`,
    );
  }
  return { expected, source, managedProfile, observed };
}

export function createRuntimeProviderSnapshotSurface(
  providerId: string,
  driver: RuntimeProviderSnapshotDriver,
): RuntimeProviderSnapshotSurface {
  const capabilities = {
    backup: true,
    restore: true,
    managedProfileRestore: true,
  } as const;
  return {
    providerId,
    supported: true,
    contractVersion: RUNTIME_PROVIDER_SNAPSHOT_CONTRACT_VERSION,
    capabilities,
    preflight(operation, sandbox) {
      const observed = observeAndNormalize(driver.observe, sandbox, providerId);
      return {
        schemaVersion: RUNTIME_PROVIDER_SNAPSHOT_PREFLIGHT_SCHEMA_VERSION,
        providerId,
        operation,
        sandboxName: sandbox.name,
        providerHandle: opaqueProviderHandle(providerId, observed),
        lifecycleState: observed.lifecycleState,
        lifecycleGeneration: observed.lifecycleGeneration,
      };
    },
    capture(sandbox, preflight) {
      const expected = requireStablePreflight(preflight, providerId, "backup", sandbox);
      const observed = observeAndNormalize(driver.observe, sandbox, providerId);
      assertUnchanged(providerId, expected, observed);
      return observed.runtime;
    },
    canRepresentAcceleration(source, target) {
      return (driver.canRepresentAcceleration ?? isDeepStrictEqual)(source, target);
    },
    validateRestore(sandbox, preflight, source, managedProfile) {
      validateRestoreRequest(providerId, driver, sandbox, preflight, source, managedProfile);
    },
    restore(sandbox, preflight, sourceValue, managedProfileValue) {
      const { expected, source, managedProfile, observed } = validateRestoreRequest(
        providerId,
        driver,
        sandbox,
        preflight,
        sourceValue,
        managedProfileValue,
      );
      const providerProof = driver.restoreManagedProfile(sandbox, managedProfile, observed.runtime);
      if (
        typeof providerProof !== "string" ||
        providerProof.trim() === "" ||
        Buffer.byteLength(providerProof, "utf8") > 4096 ||
        CONTROL_CHARACTERS.test(providerProof)
      ) {
        throw new RuntimeProviderSnapshotError(
          `provider '${providerId}' returned invalid managed profile restore proof`,
        );
      }
      const after = observeAndNormalize(driver.observe, sandbox, providerId);
      assertUnchanged(providerId, expected, after);
      const receipt = {
        schemaVersion: 1 as const,
        providerId,
        sandboxName: sandbox.name,
        providerHandle: restoreProviderHandle(
          expected,
          source,
          managedProfile,
          providerProof,
          after,
        ),
        lifecycleState: after.lifecycleState,
        lifecycleGeneration: after.lifecycleGeneration,
        runtime: after.runtime,
        managedProfile,
      } satisfies RuntimeProviderSnapshotRestoreReceipt;
      return receipt;
    },
  };
}

export function createDockerRuntimeProviderSnapshotSurface(
  providerId: string,
  dependencies: Partial<DockerRuntimeSnapshotDependencies> &
    Pick<DockerRuntimeSnapshotDependencies, "captureHostCommand">,
): RuntimeProviderSnapshotSurface {
  const resolved = {
    captureHostCommand: dependencies.captureHostCommand,
    queryRuntimeSnapshot:
      dependencies.queryRuntimeSnapshot ?? queryOpenShellDockerSandboxRuntimeSnapshot,
  };
  return createRuntimeProviderSnapshotSurface(providerId, {
    observe: (sandbox, id) => observeDockerRuntimeSnapshot(sandbox, id, resolved),
    canRepresentAcceleration: dockerCanRepresentAcceleration,
    restoreManagedProfile: (sandbox, authority, runtime) =>
      verifyDockerManagedProfileRestore(sandbox, authority, runtime, resolved),
  });
}
