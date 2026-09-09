// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  capturePodmanSocketAuthority,
  createPodmanContainerEngine,
  type PodmanBoundContainerEngine,
  type PodmanContainerEngineOptions,
} from "../../adapters/podman";
import {
  DEFAULT_GATEWAY_BIND_ADDRESS,
  WILDCARD_GATEWAY_BIND_ADDRESS,
} from "../../core/gateway-address";
import { resolveDockerDriverNetworkName } from "../experimental/docker-network-authority";
import type { SandboxEntry } from "../../state/registry/types";
import {
  type HostLocalInferenceRouteAuthority,
  type HostLocalInferenceRouteAuthorityStore,
} from "./host-local-inference";
import {
  type RuntimeProviderCleanupInput,
  type RuntimeProviderDestroyIdentityReceipt,
  type RuntimeProviderGatewayHostRuntime,
  type RuntimeProviderGatewayHostRuntimeInput,
  type RuntimeProviderRuntimeReceipt,
  RUNTIME_PROVIDER_SNAPSHOT_CONTRACT_VERSION,
  type RuntimeProviderSnapshotLifecycleState,
  type RuntimeProviderSnapshotSurface,
  type RuntimeProviderWorkloadCleanupPlan,
  type RuntimeProviderWorkloadCleanupResult,
} from "./contract";
import { observePodmanManagedContainer, type PodmanManagedContainer } from "./podman-lifecycle";
import { resolvePodmanStateRoot } from "./podman-state-root";

type SupportedSnapshotSurface = Extract<
  RuntimeProviderSnapshotSurface,
  { readonly supported: true }
>;

export const NATIVE_PODMAN_SANDBOX_HOST_ADDRESS = "169.254.2.2";
export const NATIVE_PODMAN_RESOURCE_LABEL = "openshell.managed";
export const NATIVE_PODMAN_RESOURCE_LABEL_VALUE = "true";

type NativePodmanHostCommandResult = {
  readonly status: number | null;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
  readonly error?: Error;
};

export interface NativePodmanGatewayHostPreparationDeps {
  readonly ip?: (
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => NativePodmanHostCommandResult;
  readonly sudo?: (
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => NativePodmanHostCommandResult;
}

function requireNativePodmanHostCommand(
  result: NativePodmanHostCommandResult,
  action: string,
): void {
  if (result.status === 0 && !result.error) return;
  const detail = String(
    result.stderr ?? result.stdout ?? result.error?.message ?? "unknown failure",
  )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-500);
  throw new Error(`${action} failed${detail ? `: ${detail}` : "."}`);
}

function nativePodmanHostAddressState(output: string): "absent" | "configured" | "conflicting" {
  const assignments = output
    .split(/\r?\n/u)
    .map((line) => line.match(/^\d+:\s+(\S+)\s+inet\s+169\.254\.2\.2\/(\d+)\b/u))
    .filter((match): match is RegExpMatchArray => match !== null);
  if (assignments.length === 0) return "absent";
  return assignments.length === 1 && assignments[0]?.[1] === "lo" && assignments[0]?.[2] === "32"
    ? "configured"
    : "conflicting";
}

export function ensureNativePodmanGatewayHostAddress(
  environment: NodeJS.ProcessEnv,
  deps: NativePodmanGatewayHostPreparationDeps = {},
): void {
  const ip =
    deps.ip ??
    ((args, env) =>
      spawnSync("ip", [...args], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      }));
  const sudo =
    deps.sudo ??
    ((args, env) =>
      spawnSync("sudo", [...args], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      }));
  const inspect = () => {
    const result = ip(["-o", "-4", "address", "show"], environment);
    requireNativePodmanHostCommand(result, "Inspecting the native Podman gateway address");
    return nativePodmanHostAddressState(String(result.stdout ?? ""));
  };
  const initial = inspect();
  if (initial === "configured") return;
  if (initial === "conflicting") {
    throw new Error(
      `Native Podman gateway address ${NATIVE_PODMAN_SANDBOX_HOST_ADDRESS} has a conflicting host assignment.`,
    );
  }
  requireNativePodmanHostCommand(
    sudo(
      ["--", "ip", "address", "replace", `${NATIVE_PODMAN_SANDBOX_HOST_ADDRESS}/32`, "dev", "lo"],
      environment,
    ),
    "Configuring the native Podman gateway address",
  );
  if (inspect() !== "configured") {
    throw new Error(
      `Native Podman gateway address ${NATIVE_PODMAN_SANDBOX_HOST_ADDRESS}/32 was not established on loopback.`,
    );
  }
}

type PodmanMount = Readonly<Record<string, unknown>>;
const PODMAN_CONTAINER_ID = /^[a-f0-9]{64}$/u;
const PODMAN_IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/u;
const PODMAN_STORAGE_PROBE_TIMEOUT_MS = 5_000;

function mountRecord(value: unknown): PodmanMount | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PodmanMount)
    : null;
}

function isMaterializedPodmanImageBind(
  value: PodmanMount | null,
  storageGraphRoot: string,
  containerId: string,
): boolean {
  if (value?.Type !== "bind" || value.RW !== true) return false;
  const source = String(value.Source ?? "");
  if (!path.isAbsolute(source) || path.normalize(source) !== source) return false;
  const relative = path.relative(storageGraphRoot, source);
  const segments = relative.split(path.sep);
  return (
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    segments.length === 6 &&
    segments[0] === "overlay-containers" &&
    segments[1] === containerId &&
    segments[2] === "userdata" &&
    segments[3] === "overlay" &&
    Boolean(segments[4]) &&
    segments[5] === "merge"
  );
}

/** Read the exact graphroot from the already authority-bound Podman engine. */
export function resolvePodmanStorageGraphRoot(engine: PodmanBoundContainerEngine): string {
  const result = engine.capture(
    ["info", "--format", "{{.Store.GraphRoot}}"],
    PODMAN_STORAGE_PROBE_TIMEOUT_MS,
  );
  if (result.status !== 0 || result.error) {
    throw new Error("Native Podman storage graphroot is unavailable.");
  }
  return normalizedAbsolutePath(result.stdout.trim(), "storage graphroot");
}

/**
 * Collapse one read-only image mount and its Podman storage bind into the
 * provider-owned image identity. Other duplicate destinations remain visible.
 */
export function normalizePodmanLogicalMounts(
  mounts: readonly unknown[],
  storageGraphRoot: string,
  containerId: string,
): readonly unknown[] {
  const normalizedGraphRoot = normalizedAbsolutePath(storageGraphRoot, "storage graphroot");
  if (!PODMAN_CONTAINER_ID.test(containerId)) {
    throw new Error("Native Podman container identity must be one full content ID.");
  }
  const groups = new Map<string | number, unknown[]>();
  mounts.forEach((value, index) => {
    const destination = mountRecord(value)?.Destination;
    const group = typeof destination === "string" && destination.length > 0 ? destination : index;
    const observed = groups.get(group) ?? [];
    observed.push(value);
    groups.set(group, observed);
  });

  const normalized: unknown[] = [];
  for (const observed of groups.values()) {
    if (observed.length === 1) {
      normalized.push(observed[0]);
      continue;
    }
    const records = observed.map(mountRecord);
    const imageMounts = records.filter((candidate) => candidate?.Type === "image");
    const materializedBinds = records.filter((candidate) => candidate?.Type === "bind");
    if (
      imageMounts.length === 1 &&
      materializedBinds.length === 1 &&
      observed.length === 2 &&
      imageMounts[0]?.RW === false &&
      PODMAN_IMAGE_REFERENCE.test(String(imageMounts[0]?.Source ?? "")) &&
      isMaterializedPodmanImageBind(materializedBinds[0] ?? null, normalizedGraphRoot, containerId)
    ) {
      normalized.push(imageMounts[0] as PodmanMount);
    } else {
      normalized.push(...observed);
    }
  }
  return Object.freeze(normalized);
}

const FULL_ID = /^[a-f0-9]{64}$/u;
const ROUTE_STORE_DIRECTORY = "runtime-provider-podman";
const ROUTE_STORE_FILE = "host-local-inference-route.json";

type JsonRecord = Record<string, unknown>;

class PodmanRuntimeSurfaceError extends Error {
  constructor(message: string) {
    super(`Runtime snapshot provider failed: ${message}`);
    this.name = "RuntimeProviderSnapshotError";
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PodmanRuntimeSurfaceError(`Podman ${label} must be an object`);
  }
  return value as JsonRecord;
}

function normalizedAbsolutePath(value: string, label: string): string {
  const candidate = value.trim();
  if (
    !path.isAbsolute(candidate) ||
    path.normalize(candidate) !== candidate ||
    /[\0\r\n]/u.test(candidate)
  ) {
    throw new Error(`Native Podman ${label} must be one normalized absolute path.`);
  }
  return candidate;
}

export function resolveNativePodmanSocketPath(
  environment: NodeJS.ProcessEnv = process.env,
  explicitSocketPath?: string,
): string {
  if (explicitSocketPath) return normalizedAbsolutePath(explicitSocketPath, "socket");
  const configured = environment.OPENSHELL_PODMAN_SOCKET?.trim();
  if (configured) return normalizedAbsolutePath(configured, "OPENSHELL_PODMAN_SOCKET");
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  const runtimeDirectory = environment.XDG_RUNTIME_DIR?.trim() || `/run/user/${String(uid)}`;
  return normalizedAbsolutePath(path.join(runtimeDirectory, "podman", "podman.sock"), "socket");
}

export function prepareNativePodmanGatewayHostRuntime(
  input: RuntimeProviderGatewayHostRuntimeInput,
  boundEngine?: PodmanBoundContainerEngine,
  hostPreparation?: NativePodmanGatewayHostPreparationDeps,
): RuntimeProviderGatewayHostRuntime {
  if (input.platform !== "linux") {
    throw new Error("Native Podman gateway runtime is supported only on Linux.");
  }
  const engine =
    boundEngine ?? createCurrentPodmanOperationEngine("gateway-inspection", input.environment);
  if (engine.operation !== "gateway-inspection") {
    throw new Error("Native Podman gateway runtime requires its gateway-inspection engine.");
  }
  if (hostPreparation) ensureNativePodmanGatewayHostAddress(input.environment, hostPreparation);
  const run = (args: readonly string[], timeoutMs: number) => {
    const result = engine.capture(args, timeoutMs);
    const error = result.error as NodeJS.ErrnoException | undefined;
    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      error: error?.message,
      errorCode: error?.code ?? null,
      timedOut: error?.code === "ETIMEDOUT",
    };
  };
  const inspectNetwork = (networkName: string) => {
    const result = run(["network", "inspect", networkName], 30_000);
    if (result.status !== 0) return undefined;
    try {
      const parsed = JSON.parse(String(result.stdout ?? "")) as unknown;
      const record = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
      const subnets = (record as { subnets?: unknown }).subnets;
      if (!Array.isArray(subnets)) return undefined;
      for (const subnet of subnets) {
        if (!subnet || typeof subnet !== "object" || Array.isArray(subnet)) continue;
        const values = subnet as { subnet?: unknown; gateway?: unknown };
        const subnetValue = typeof values.subnet === "string" ? values.subnet : undefined;
        const gatewayIp = typeof values.gateway === "string" ? values.gateway : undefined;
        if (gatewayIp && !gatewayIp.includes(":")) {
          return { ...(subnetValue ? { subnet: subnetValue } : {}), gatewayIp };
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  };
  return Object.freeze({
    providerId: "podman",
    openShellDriver: "podman",
    bindAddress: WILDCARD_GATEWAY_BIND_ADDRESS,
    grpcHost: NATIVE_PODMAN_SANDBOX_HOST_ADDRESS,
    sshGatewayHost: DEFAULT_GATEWAY_BIND_ADDRESS,
    portCheckHost: WILDCARD_GATEWAY_BIND_ADDRESS,
    socketPath: resolveNativePodmanSocketPath(input.environment, input.socketPath),
    requiredServerIpSans: Object.freeze([NATIVE_PODMAN_SANDBOX_HOST_ADDRESS]),
    sandboxHostAddress: NATIVE_PODMAN_SANDBOX_HOST_ADDRESS,
    usesHostGatewayRoute: false,
    resourceOwnership: Object.freeze({
      label: NATIVE_PODMAN_RESOURCE_LABEL,
      value: NATIVE_PODMAN_RESOURCE_LABEL_VALUE,
    }),
    gatewayConfig: Object.freeze({
      sandboxNamespace: "omitted" as const,
      hostGatewayIp: NATIVE_PODMAN_SANDBOX_HOST_ADDRESS,
      includeSupervisorBin: false,
      processOwnership: "runtime-marker" as const,
    }),
    network: Object.freeze({
      sandboxSourceCidrs: () => {
        const network = inspectNetwork(resolveDockerDriverNetworkName(input.environment));
        return [
          ...(network?.subnet ? [network.subnet] : []),
          `${NATIVE_PODMAN_SANDBOX_HOST_ADDRESS}/32`,
        ];
      },
      inspect: inspectNetwork,
      usesHostGatewayRoute: () => false,
      run,
      ensureProbeImageCached: (image: string) => {
        const inspect = run(["image", "inspect", image], 10_000);
        if (inspect.status === 0) return { ok: true as const, alreadyCached: true };
        if (inspect.status === null || inspect.errorCode) {
          return {
            ok: false as const,
            reason: "inspect_unavailable" as const,
            details: inspect.error ?? String(inspect.stderr ?? "").trim(),
          };
        }
        const pull = run(["pull", image], 120_000);
        if (pull.status === 0) return { ok: true as const, alreadyCached: false };
        return {
          ok: false as const,
          reason: pull.timedOut ? ("pull_timeout" as const) : ("pull_failed" as const),
          details: pull.error ?? String(pull.stderr ?? "").trim(),
        };
      },
    }),
  });
}

export type CurrentPodmanOperation = PodmanContainerEngineOptions["operation"];

export function createCurrentPodmanOperationEngine(
  operation: CurrentPodmanOperation,
  environment: NodeJS.ProcessEnv = process.env,
): PodmanBoundContainerEngine {
  const socketPath = resolveNativePodmanSocketPath(environment);
  const endpointAuthorityId = `podman-path-sha256:${createHash("sha256").update(socketPath, "utf8").digest("hex")}`;
  let bound: PodmanBoundContainerEngine | null = null;
  const resolve = (): PodmanBoundContainerEngine => {
    if (bound) return bound;
    const socketAuthority = capturePodmanSocketAuthority(socketPath);
    bound = createPodmanContainerEngine({
      operation,
      socketAuthority,
      executableSearchEnv: environment,
      commandEnvironment: Object.freeze({
        HOME: environment.HOME ?? os.homedir(),
        PATH: environment.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        ...(environment.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: environment.XDG_RUNTIME_DIR } : {}),
        ...(operation === "managed-bootstrap" && environment.CONTAINERS_CONF
          ? { CONTAINERS_CONF: environment.CONTAINERS_CONF }
          : {}),
        ...(operation === "managed-bootstrap" && environment.CONTAINERS_STORAGE_CONF
          ? { CONTAINERS_STORAGE_CONF: environment.CONTAINERS_STORAGE_CONF }
          : {}),
      }),
    });
    return bound;
  };
  return Object.freeze({
    operation,
    engineId: "podman",
    displayName: "Podman",
    endpointAuthorityId,
    get authorityId() {
      return resolve().authorityId;
    },
    capture: (
      args: Parameters<PodmanBoundContainerEngine["capture"]>[0],
      timeout?: number,
      input?: Buffer,
    ) => resolve().capture(args, timeout, input),
    captureHost: (
      args: Parameters<PodmanBoundContainerEngine["captureHost"]>[0],
      timeout?: number,
    ) => resolve().captureHost(args, timeout),
    assertAuthority: () => resolve().assertAuthority(),
    ...(operation === "managed-bootstrap"
      ? {
          prepareManagedWorkspaceRoot: (
            input: Parameters<
              NonNullable<PodmanBoundContainerEngine["prepareManagedWorkspaceRoot"]>
            >[0],
          ) => {
            const prepare = resolve().prepareManagedWorkspaceRoot;
            if (!prepare) {
              throw new Error(
                "Podman managed-bootstrap engine did not expose workspace-root preparation.",
              );
            }
            return prepare(input);
          },
          prepareManagedVolumeRoot: (
            input: Parameters<
              NonNullable<PodmanBoundContainerEngine["prepareManagedVolumeRoot"]>
            >[0],
          ) => {
            const prepare = resolve().prepareManagedVolumeRoot;
            if (!prepare) {
              throw new Error(
                "Podman managed-bootstrap engine did not expose volume-root preparation.",
              );
            }
            return prepare(input);
          },
        }
      : {}),
  });
}

function capture(engine: PodmanBoundContainerEngine, args: readonly string[], label: string) {
  const result = engine.capture(args, 30_000);
  if (result.status !== 0 || result.error) {
    throw new PodmanRuntimeSurfaceError(
      `${label} failed: ${(result.stderr || result.stdout || result.error?.message || "unknown failure").replace(/\s+/gu, " ").trim().slice(-500)}`,
    );
  }
  return result;
}

function lifecycle(inspect: JsonRecord): {
  readonly state: RuntimeProviderSnapshotLifecycleState;
  readonly generation: string;
} {
  const state = record(inspect.State, "State");
  const running = state.Running;
  const paused = state.Paused;
  const status = String(state.Status ?? "")
    .trim()
    .toLowerCase();
  let normalized: RuntimeProviderSnapshotLifecycleState;
  if (running === true && paused === true) normalized = "paused";
  else if (running === true && paused !== true) normalized = "running";
  else if (["configured", "created", "dead", "exited", "stopped"].includes(status))
    normalized = "stopped";
  else
    throw new PodmanRuntimeSurfaceError(
      `Podman lifecycle '${status || "unknown"}' cannot be represented`,
    );
  return {
    state: normalized,
    generation: createHash("sha256")
      .update(
        JSON.stringify({
          id: inspect.Id,
          status,
          paused: paused === true,
          startedAt: state.StartedAt ?? "",
          finishedAt: state.FinishedAt ?? "",
          restartCount: state.RestartCount ?? 0,
        }),
        "utf8",
      )
      .digest("hex"),
  };
}

function acceleration(inspect: JsonRecord): RuntimeProviderRuntimeReceipt["acceleration"] {
  const hostConfig = record(inspect.HostConfig ?? {}, "HostConfig");
  const selectors: string[] = [];
  for (const value of Array.isArray(hostConfig.Devices) ? hostConfig.Devices : []) {
    const device = record(value, "HostConfig.Devices entry");
    const hostPath = String(device.PathOnHost ?? "").trim();
    const containerPath = String(device.PathInContainer ?? "").trim();
    if (/^\/dev\/(?:nvidia|dri|nvhost|nvmap|tegra)/u.test(hostPath)) {
      selectors.push(`podman-device-path:${hostPath}=>${containerPath}`);
    }
  }
  const annotations = record(inspect.Annotations ?? {}, "Annotations");
  for (const [key, value] of Object.entries(annotations)) {
    if (/cdi|nvidia|gpu/iu.test(key) && typeof value === "string" && value.trim()) {
      selectors.push(`podman-annotation:${key}=${value.trim()}`);
    }
  }
  const devices = [...new Set(selectors)].sort();
  return devices.length > 0 ? { kind: "gpu", vendor: "nvidia", devices } : { kind: "none" };
}

function observePodmanRuntime(
  sandbox: SandboxEntry,
  providerId: string,
  engine: PodmanBoundContainerEngine,
) {
  if (sandbox.openshellDriver !== providerId) {
    throw new PodmanRuntimeSurfaceError(
      `sandbox '${sandbox.name}' belongs to another runtime provider`,
    );
  }
  let container: PodmanManagedContainer | null;
  try {
    container = observePodmanManagedContainer(engine, sandbox.name);
  } catch (error) {
    throw new PodmanRuntimeSurfaceError(error instanceof Error ? error.message : String(error));
  }
  if (!container) {
    throw new PodmanRuntimeSurfaceError(
      `sandbox '${sandbox.name}' exact Podman runtime identity could not be inspected`,
    );
  }
  const inspect = container.inspect;
  const id = container.containerId;
  const state = lifecycle(inspect);
  return Object.freeze({
    lifecycleState: state.state,
    lifecycleGeneration: state.generation,
    runtime: Object.freeze({
      schemaVersion: 1 as const,
      providerId,
      runtime: Object.freeze({ kind: "podman-container", handle: id }),
      acceleration: acceleration(inspect),
    }),
  });
}

function stableLabels(labels: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))),
  );
}

export function capturePodmanDestroyIdentity(
  input: RuntimeProviderCleanupInput,
  engine: PodmanBoundContainerEngine,
): RuntimeProviderDestroyIdentityReceipt {
  if (input.sandbox.openshellDriver !== "podman") {
    throw new Error(`Sandbox '${input.sandboxName}' belongs to another runtime provider.`);
  }
  return capturePodmanDestroyIdentityByName(input.sandboxName, engine);
}

export function capturePodmanDestroyIdentityByName(
  sandboxName: string,
  engine: PodmanBoundContainerEngine,
): RuntimeProviderDestroyIdentityReceipt {
  const container = observePodmanManagedContainer(engine, sandboxName);
  if (!container) {
    return Object.freeze({
      schemaVersion: 1 as const,
      providerId: "podman",
      resourceHandle: null,
      ownershipSha256: null,
    });
  }
  const ownershipSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        containerId: container.containerId,
        labels: stableLabels(container.labels),
        name: container.name,
        sandboxId: container.sandboxId,
        sandboxNamespace: container.sandboxNamespace,
      }),
      "utf8",
    )
    .digest("hex");
  return Object.freeze({
    schemaVersion: 1 as const,
    providerId: "podman",
    resourceHandle: container.containerId,
    ownershipSha256,
  });
}

function restoreManagedProfile(
  sandbox: SandboxEntry,
  authority: { readonly agent: string; readonly profileFingerprint: string },
  runtime: RuntimeProviderRuntimeReceipt,
  engine: PodmanBoundContainerEngine,
): string {
  if (runtime.runtime.kind !== "podman-container" || !FULL_ID.test(runtime.runtime.handle)) {
    throw new PodmanRuntimeSurfaceError(
      "Podman managed profile restore runtime identity is invalid",
    );
  }
  const result = capture(
    engine,
    [
      "container",
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
      "/usr/local/bin/node",
      "/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs",
      "--verify-completion",
      "--agent",
      authority.agent,
      "--profile-fingerprint",
      authority.profileFingerprint,
    ],
    "managed profile restore verification",
  );
  return createHash("sha256")
    .update(sandbox.name, "utf8")
    .update("\0", "utf8")
    .update(authority.agent, "utf8")
    .update("\0", "utf8")
    .update(authority.profileFingerprint, "utf8")
    .update("\0", "utf8")
    .update(result.stdout, "utf8")
    .digest("hex");
}

export function createPodmanRuntimeProviderSnapshotSurface(
  engine: PodmanBoundContainerEngine,
): RuntimeProviderSnapshotSurface {
  if (engine.operation !== "gateway-inspection" || engine.engineId !== "podman") {
    throw new Error("Podman snapshot requires a gateway-inspection engine.");
  }
  const surface = (): SupportedSnapshotSurface => {
    const { createRuntimeProviderSnapshotSurface } =
      require("./snapshot") as typeof import("./snapshot");
    return createRuntimeProviderSnapshotSurface("podman", {
      observe: (sandbox, providerId) => observePodmanRuntime(sandbox, providerId, engine),
      restoreManagedProfile: (sandbox, authority, runtime) =>
        restoreManagedProfile(sandbox, authority, runtime, engine),
    }) as SupportedSnapshotSurface;
  };
  return Object.freeze({
    providerId: "podman",
    supported: true,
    contractVersion: RUNTIME_PROVIDER_SNAPSHOT_CONTRACT_VERSION,
    capabilities: Object.freeze({ backup: true, restore: true, managedProfileRestore: true }),
    preflight: (...args: Parameters<SupportedSnapshotSurface["preflight"]>) =>
      surface().preflight(...args),
    capture: (...args: Parameters<SupportedSnapshotSurface["capture"]>) =>
      surface().capture(...args),
    validateRestore: (...args: Parameters<SupportedSnapshotSurface["validateRestore"]>) =>
      surface().validateRestore(...args),
    restore: (...args: Parameters<SupportedSnapshotSurface["restore"]>) =>
      surface().restore(...args),
  });
}

export function planOwnedPodmanWorkloadCleanup(
  input: RuntimeProviderCleanupInput,
): RuntimeProviderWorkloadCleanupPlan {
  const workload = input.sandbox.workload;
  if (!workload || workload.kind === "native-artifact") {
    return { action: "retain", reason: "no-owned-image" };
  }
  if (workload.kind === "managed-image") {
    return { action: "retain", reason: "shared-image" };
  }
  if (workload.reference === null) return { action: "retain", reason: "no-owned-image" };
  return { action: "block", reason: "authority-unproven" };
}

export function removeOwnedPodmanWorkload(
  input: RuntimeProviderCleanupInput,
  engine: PodmanBoundContainerEngine,
): RuntimeProviderWorkloadCleanupResult {
  const plan = planOwnedPodmanWorkloadCleanup(input);
  if (plan.action === "retain") return { status: "skipped", reason: plan.reason };
  if (plan.action === "block") return { status: "skipped", reason: "authority-unproven" };
  const result = engine.capture(["image", "rm", plan.reference], 60_000);
  return {
    status: result.status === 0 && !result.error ? "removed" : "failed",
    engineDisplayName: plan.engineDisplayName,
    reference: plan.reference,
  };
}

function routeAuthorityPath(stateRoot: string): string {
  return path.join(stateRoot, ROUTE_STORE_DIRECTORY, ROUTE_STORE_FILE);
}

export function createFilePodmanRouteAuthorityStore(
  stateRoot = resolvePodmanStateRoot(),
): HostLocalInferenceRouteAuthorityStore {
  const target = routeAuthorityPath(stateRoot);
  return Object.freeze({
    load: () => {
      try {
        return JSON.parse(fs.readFileSync(target, "utf8")) as HostLocalInferenceRouteAuthority;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    record: (authority: HostLocalInferenceRouteAuthority) => {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const serialized = `${JSON.stringify(authority)}\n`;
      const existing = (() => {
        try {
          return fs.readFileSync(target, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      })();
      if (existing !== null) {
        if (existing !== serialized)
          throw new Error("Podman route authority conflicts with its durable record.");
        return authority;
      }
      const temporary = `${target}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, target);
      fs.chmodSync(target, 0o600);
      return authority;
    },
  });
}
