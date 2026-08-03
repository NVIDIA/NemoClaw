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
const LIFECYCLE_GENERATION_PATTERN = /^[A-Za-z0-9._:/=-]{1,512}$/u;
const ANSI_PATTERN = /\u001b\[[0-9;]*m/gu;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

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
) => string;

export interface RuntimeProviderSnapshotDriver {
  readonly observe: RuntimeProviderSnapshotObserver;
  readonly restoreManagedProfile: RuntimeProviderManagedProfileRestorer;
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
  readonly captureOpenShell: typeof captureOpenshell;
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

function gatewayScopedManagedProfileVerifyArgs(
  sandbox: SandboxEntry,
  authority: RuntimeProviderManagedProfileRestoreAuthority,
): string[] {
  const args = ["sandbox", "exec", "--name", sandbox.name];
  const gatewayName = resolveSandboxGatewayName(sandbox);
  if (gatewayName) args.push("-g", gatewayName);
  args.push(
    "--no-tty",
    "--timeout",
    "10",
    "--",
    MANAGED_STARTUP_RUNTIME_EXECUTABLE,
    "--verify-completion",
    "--agent",
    authority.agent,
    "--profile-fingerprint",
    authority.profileFingerprint,
  );
  return args;
}

function cleanOutput(value: string): string {
  return value.replace(ANSI_PATTERN, "");
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

function dockerRequestUsesGpu(
  request: NonNullable<
    Extract<OpenShellDockerSandboxRuntimeSnapshotQuery, { ok: true }>["deviceRequests"]
  >[number],
): boolean {
  return (
    request.Driver.trim().toLowerCase() === "nvidia" ||
    request.DeviceIDs?.some((device) => /^nvidia[.]com\/gpu(?:=|$)/iu.test(device.trim())) ===
      true ||
    request.Capabilities?.some((group) =>
      group.some((capability) => capability.trim().toLowerCase() === "gpu"),
    ) === true
  );
}

function dockerGpuSelectors(
  snapshot: Extract<OpenShellDockerSandboxRuntimeSnapshotQuery, { ok: true }>,
): RuntimeProviderRuntimeReceipt["acceleration"] {
  if (snapshot.nativeGpuAttachmentState === "absent") return { kind: "none" };
  if (snapshot.nativeGpuAttachmentState !== "present") {
    throw new RuntimeProviderSnapshotError("Docker returned ambiguous live acceleration evidence");
  }

  const selectors: string[] = [];
  if (snapshot.runtime.trim().toLowerCase() === "nvidia") {
    const visibleDevices = snapshot.nvidiaVisibleDevices;
    if (visibleDevices === "all") {
      selectors.push("docker-nvidia-visible-devices:all");
    } else if (visibleDevices && !["none", "void"].includes(visibleDevices)) {
      for (const device of visibleDevices.split(",")) {
        selectors.push(`docker-nvidia-visible-device:${device}`);
      }
    }
  }
  for (const request of snapshot.deviceRequests ?? []) {
    if (!dockerRequestUsesGpu(request)) continue;
    if (request.DeviceIDs && request.DeviceIDs.length > 0) {
      for (const device of request.DeviceIDs) {
        selectors.push(`docker-device-id:${device}`);
      }
      continue;
    }
    if (request.Count === -1) {
      // Count=-1 is Docker's explicit live all-device selector. Never infer
      // this value from a durable "GPU enabled" flag.
      selectors.push(`docker-device-request:${request.Driver || "default"}:count=-1`);
      continue;
    }
    throw new RuntimeProviderSnapshotError(
      "Docker GPU attachment does not expose exact live device selectors",
    );
  }
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

export function verifyOpenShellManagedProfileRestore(
  sandbox: SandboxEntry,
  authorityValue: RuntimeProviderManagedProfileRestoreAuthority,
  dependencies: Pick<DockerRuntimeSnapshotDependencies, "captureOpenShell">,
): string {
  const authority = normalizeRuntimeProviderManagedProfileRestoreAuthority(authorityValue);
  if (!authority) {
    throw new RuntimeProviderSnapshotError("managed profile restore authority is invalid");
  }
  const result = dependencies.captureOpenShell(
    gatewayScopedManagedProfileVerifyArgs(sandbox, authority),
    {
      ignoreError: true,
      includeStderr: true,
      timeout: 15_000,
    },
  );
  if (result.status !== 0 || result.error || result.signal) {
    throw new RuntimeProviderSnapshotError(
      `sandbox '${sandbox.name}' managed profile restoration could not be proven`,
    );
  }
  return createHash("sha256")
    .update(sandbox.name, "utf8")
    .update("\0", "utf8")
    .update(authority.agent, "utf8")
    .update("\0", "utf8")
    .update(authority.profileFingerprint, "utf8")
    .update("\0", "utf8")
    .update(cleanOutput(result.output || ""), "utf8")
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
  if (!isDeepStrictEqual(source.runtime.acceleration, observed.runtime.acceleration)) {
    throw new RuntimeProviderSnapshotError(
      `sandbox '${sandbox.name}' cannot represent the snapshot acceleration state`,
    );
  }
  return { expected, source, managedProfile };
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
    validateRestore(sandbox, preflight, source, managedProfile) {
      validateRestoreRequest(providerId, driver, sandbox, preflight, source, managedProfile);
    },
    restore(sandbox, preflight, sourceValue, managedProfileValue) {
      const { expected, source, managedProfile } = validateRestoreRequest(
        providerId,
        driver,
        sandbox,
        preflight,
        sourceValue,
        managedProfileValue,
      );
      const providerProof = driver.restoreManagedProfile(sandbox, managedProfile);
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
    captureOpenShell: dependencies.captureOpenShell ?? captureOpenshell,
    queryRuntimeSnapshot:
      dependencies.queryRuntimeSnapshot ?? queryOpenShellDockerSandboxRuntimeSnapshot,
  };
  return createRuntimeProviderSnapshotSurface(providerId, {
    observe: (sandbox, id) => observeDockerRuntimeSnapshot(sandbox, id, resolved),
    restoreManagedProfile: (sandbox, authority) =>
      verifyOpenShellManagedProfileRestore(sandbox, authority, resolved),
  });
}
