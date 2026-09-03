// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../state/registry/types";
import {
  RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION,
  RUNTIME_PROVIDER_NATIVE_ARTIFACT_BOOTSTRAP_CONTRACT_VERSION,
  RUNTIME_PROVIDER_SNAPSHOT_CONTRACT_VERSION,
  RUNTIME_PROVIDER_SNAPSHOT_PREFLIGHT_SCHEMA_VERSION,
  RUNTIME_PROVIDER_STATE_MUTATION_CONTRACT_VERSION,
  type RuntimeProviderBundle,
  type RuntimeProviderBundleRegistry,
  type RuntimeProviderChannelStopTransport,
  type RuntimeProviderContainerEngineOperation,
  type RuntimeProviderManagedProfileRestoreAuthority,
  type RuntimeProviderMutationOperation,
  type RuntimeProviderRuntimeReceipt,
  type RuntimeProviderSnapshotLifecycleState,
  type RuntimeProviderSnapshotPreflightReceipt,
  type RuntimeProviderSnapshotRestoreReceipt,
  type RuntimeProviderSnapshotRestoreSource,
} from "./contract";
import type {
  HostLocalInferenceOperation,
  HostLocalInferenceOperationInput,
  HostLocalInferenceService,
} from "./host-local-inference";

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const RESERVED_PROVIDER_IDS = new Set(["constructor", "prototype"]);
const BUNDLE_SURFACES = [
  "plan",
  "capabilities",
  "preflightDoctor",
  "gateway",
  "workload",
  "hostLocalInference",
  "lifecycle",
  "mutationAuthority",
  "stateMutation",
  "bootstrap",
  "snapshot",
  "recovery",
  "cleanup",
  "containerEngine",
] as const;
const MAX_RECEIPT_HANDLE_BYTES = 4096;
const MAX_RECEIPT_DEVICES = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MANAGED_PROFILE_AGENT_PATTERN = /^[a-z][a-z0-9-]{0,127}$/u;
const SNAPSHOT_OPERATIONS = new Set(["backup", "restore"]);
const SNAPSHOT_LIFECYCLE_STATES = new Set<RuntimeProviderSnapshotLifecycleState>([
  "running",
  "paused",
  "stopped",
]);
const GATEWAY_LAUNCHERS = new Set(["nemoclaw", "openshell"]);
const CHANNEL_STOP_TRANSPORTS: ReadonlySet<unknown> = new Set<RuntimeProviderChannelStopTransport>([
  "docker-kubectl-first",
  "openshell",
]);
const MANAGED_IMAGE_SELECTION_POLICIES = new Set(["prefer-managed", "require-managed"]);
const MANAGED_IMAGE_PLATFORMS = new Set(["linux/amd64", "linux/arm64"]);
const NATIVE_ARTIFACT_PLATFORMS = new Set(["windows/x64"]);
const NATIVE_ARTIFACT_AGENTS = new Set(["openclaw"]);
const HOST_PLATFORMS = new Set<NodeJS.Platform>([
  "aix",
  "android",
  "cygwin",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
]);
const MUTATION_OPERATIONS = new Set<RuntimeProviderMutationOperation>([
  "registration",
  "start",
  "stop",
  "inference-set",
  "rebuild",
  "clone",
  "provider-cleanup",
  "destroy",
  "workload-cleanup",
]);
const CONTAINER_ENGINE_OPERATIONS = new Set<RuntimeProviderContainerEngineOperation>([
  "host-doctor",
  "gateway-inspection",
  "host-local-inference",
  "sandbox-lifecycle",
  "state-mutation",
  "workload-cleanup",
]);
const HOST_LOCAL_INFERENCE_SERVICES = new Set<HostLocalInferenceService>([
  "ollama",
  "nim",
  "vllm",
  "llama-cpp",
]);

export class RuntimeProviderRegistrationError extends Error {
  constructor(message: string) {
    super(`Invalid runtime provider registration: ${message}`);
    this.name = "RuntimeProviderRegistrationError";
  }
}

export class RuntimeProviderSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeProviderSelectionError";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validProviderId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    PROVIDER_ID_PATTERN.test(value) &&
    !RESERVED_PROVIDER_IDS.has(value)
  );
}

function cloneAndFreeze<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  const object = value as object;
  const existing = seen.get(object);
  if (existing) return existing as T;
  if (typeof value === "function") {
    const original = value as (...args: unknown[]) => unknown;
    const copy = function (this: unknown, ...args: unknown[]) {
      return Reflect.apply(original, this, args);
    };
    seen.set(object, copy);
    const mutableCopy = copy as unknown as Record<string, unknown>;
    const originalProperties = value as unknown as Record<string, unknown>;
    for (const key of Object.keys(originalProperties)) {
      mutableCopy[key] = cloneAndFreeze(originalProperties[key], seen);
    }
    Object.freeze(copy.prototype);
    return Object.freeze(copy) as T;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(object, copy);
    for (const item of value) copy.push(cloneAndFreeze(item, seen));
    return Object.freeze(copy) as T;
  }
  if (!isPlainRecord(value)) {
    throw new RuntimeProviderRegistrationError("bundle values must be plain records or arrays");
  }
  const copy: Record<string, unknown> = Object.create(null);
  seen.set(object, copy);
  for (const key of Object.keys(value)) {
    copy[key] = cloneAndFreeze(value[key], seen);
  }
  return Object.freeze(copy) as T;
}

function requireOwnRecord(owner: Record<string, unknown>, field: string): Record<string, unknown> {
  if (!Object.hasOwn(owner, field) || !isPlainRecord(owner[field])) {
    throw new RuntimeProviderRegistrationError(`missing ${field} surface`);
  }
  return owner[field];
}

function validateBoundSurface(
  providerId: string,
  name: string,
  surface: Record<string, unknown>,
): void {
  if (surface.providerId !== providerId) {
    throw new RuntimeProviderRegistrationError(
      `${name} identity '${String(surface.providerId)}' does not match '${providerId}'`,
    );
  }
  if (typeof surface.supported !== "boolean") {
    throw new RuntimeProviderRegistrationError(`${name}.supported must be a boolean`);
  }
  if (
    surface.supported === false &&
    (typeof surface.reason !== "string" || surface.reason.trim() === "")
  ) {
    throw new RuntimeProviderRegistrationError(`${name} must explain why it is unsupported`);
  }
}

function requireSupported(name: string, surface: Record<string, unknown>): void {
  if (surface.supported !== true) {
    throw new RuntimeProviderRegistrationError(`${name} must be supported`);
  }
}

function requireBoolean(
  surface: Record<string, unknown>,
  field: string,
  surfaceName: string,
): void {
  if (typeof surface[field] !== "boolean") {
    throw new RuntimeProviderRegistrationError(`${surfaceName}.${field} must be a boolean`);
  }
}

function requireFunction(
  surface: Record<string, unknown>,
  field: string,
  surfaceName: string,
): void {
  if (typeof surface[field] !== "function") {
    throw new RuntimeProviderRegistrationError(`${surfaceName}.${field} must be a function`);
  }
}

function requireNonEmptyString(
  surface: Record<string, unknown>,
  field: string,
  surfaceName: string,
): void {
  if (typeof surface[field] !== "string" || surface[field].trim() === "") {
    throw new RuntimeProviderRegistrationError(
      `${surfaceName}.${field} must be a non-empty string`,
    );
  }
}

function validateWorkloadProfile(providerId: string, surface: Record<string, unknown>): void {
  requireFunction(surface, "acceptsReceipt", "workload");
  const profile = requireOwnRecord(surface, "profile");
  if (!MANAGED_IMAGE_SELECTION_POLICIES.has(String(profile.managedImageSelectionPolicy))) {
    throw new RuntimeProviderRegistrationError(
      `workload profile for '${providerId}' has an invalid selection policy`,
    );
  }
  if (typeof profile.legacyDockerfileBuilds !== "boolean") {
    throw new RuntimeProviderRegistrationError(
      `workload profile for '${providerId}' must declare legacyDockerfileBuilds`,
    );
  }
  if (
    !Array.isArray(profile.hostArchitectures) ||
    profile.hostArchitectures.some(
      (architecture) => typeof architecture !== "string" || architecture.trim() === "",
    ) ||
    new Set(profile.hostArchitectures).size !== profile.hostArchitectures.length
  ) {
    throw new RuntimeProviderRegistrationError(
      `workload profile for '${providerId}' has invalid host architectures`,
    );
  }
  if (profile.nativeArtifactSupport !== undefined && profile.nativeArtifactSupport !== null) {
    if (!isPlainRecord(profile.nativeArtifactSupport)) {
      throw new RuntimeProviderRegistrationError(
        `workload profile for '${providerId}' has invalid native-artifact support`,
      );
    }
    const nativeSupport = profile.nativeArtifactSupport;
    if (
      typeof nativeSupport.exactDigestReferences !== "boolean" ||
      !Array.isArray(nativeSupport.platforms) ||
      nativeSupport.platforms.length === 0 ||
      nativeSupport.platforms.some(
        (platform) => !NATIVE_ARTIFACT_PLATFORMS.has(String(platform)),
      ) ||
      new Set(nativeSupport.platforms).size !== nativeSupport.platforms.length ||
      !Array.isArray(nativeSupport.agents) ||
      nativeSupport.agents.length === 0 ||
      nativeSupport.agents.some((agent) => !NATIVE_ARTIFACT_AGENTS.has(String(agent))) ||
      new Set(nativeSupport.agents).size !== nativeSupport.agents.length
    ) {
      throw new RuntimeProviderRegistrationError(
        `workload profile for '${providerId}' has invalid native-artifact identity`,
      );
    }
    for (const field of ["contractVersions", "startupProfileContractVersions"] as const) {
      const versions = nativeSupport[field];
      if (
        !Array.isArray(versions) ||
        versions.length === 0 ||
        versions.some((version) => !Number.isSafeInteger(version) || Number(version) <= 0) ||
        new Set(versions).size !== versions.length
      ) {
        throw new RuntimeProviderRegistrationError(
          `workload profile for '${providerId}' has invalid native-artifact ${field}`,
        );
      }
    }
  }
  if (profile.support === null) return;
  if (!isPlainRecord(profile.support)) {
    throw new RuntimeProviderRegistrationError(
      `workload profile for '${providerId}' has invalid managed-image support`,
    );
  }
  const support = profile.support;
  if (
    typeof support.exactDigestReferences !== "boolean" ||
    !Array.isArray(support.platforms) ||
    support.platforms.length === 0 ||
    support.platforms.some((platform) => !MANAGED_IMAGE_PLATFORMS.has(String(platform))) ||
    new Set(support.platforms).size !== support.platforms.length
  ) {
    throw new RuntimeProviderRegistrationError(
      `workload profile for '${providerId}' has invalid managed-image platforms`,
    );
  }
  for (const field of ["startupProfileContractVersions", "capabilityContractVersions"] as const) {
    const versions = support[field];
    if (
      !Array.isArray(versions) ||
      versions.length === 0 ||
      versions.some((version) => !Number.isSafeInteger(version) || Number(version) <= 0) ||
      new Set(versions).size !== versions.length
    ) {
      throw new RuntimeProviderRegistrationError(
        `workload profile for '${providerId}' has invalid ${field}`,
      );
    }
  }
}

type RuntimeProviderSurfaceRecords = Record<
  (typeof BUNDLE_SURFACES)[number],
  Record<string, unknown>
>;

function validatePlanSurface(providerId: string, surface: Record<string, unknown>): void {
  requireSupported("plan", surface);
  if (!GATEWAY_LAUNCHERS.has(String(surface.gatewayLauncher))) {
    throw new RuntimeProviderRegistrationError(`plan for '${providerId}' has an invalid launcher`);
  }
}

function validateCapabilitiesSurface(surface: Record<string, unknown>): void {
  requireSupported("capabilities", surface);
  for (const field of [
    "hostLocalInference",
    "directLifecycle",
    "legacyGatewayContainerInspection",
    "workloadImageCleanup",
  ] as const) {
    requireBoolean(surface, field, "capabilities");
  }
  const hostMounts = requireOwnRecord(surface, "readOnlyHostMounts");
  if (typeof hostMounts.supported !== "boolean") {
    throw new RuntimeProviderRegistrationError(
      "capabilities.readOnlyHostMounts.supported must be a boolean",
    );
  }
  if (hostMounts.supported === false) {
    requireNonEmptyString(hostMounts, "reason", "capabilities.readOnlyHostMounts");
    return;
  }
  if (
    !Array.isArray(hostMounts.hostPlatforms) ||
    hostMounts.hostPlatforms.length === 0 ||
    hostMounts.hostPlatforms.some((platform) => !HOST_PLATFORMS.has(platform as NodeJS.Platform)) ||
    new Set(hostMounts.hostPlatforms).size !== hostMounts.hostPlatforms.length
  ) {
    throw new RuntimeProviderRegistrationError(
      "capabilities.readOnlyHostMounts.hostPlatforms must list unique Node.js host platforms",
    );
  }
}

function validatePreflightDoctorSurface(surface: Record<string, unknown>): void {
  requireSupported("preflightDoctor", surface);
  requireFunction(surface, "inspectHost", "preflightDoctor");
  requireFunction(surface, "preflightLifecycle", "preflightDoctor");
}

function validateGatewaySurface(providerId: string, surface: Record<string, unknown>): void {
  requireSupported("gateway", surface);
  if (!GATEWAY_LAUNCHERS.has(String(surface.launcher))) {
    throw new RuntimeProviderRegistrationError(
      `gateway for '${providerId}' has an invalid launcher`,
    );
  }
  requireBoolean(surface, "inspectLegacyContainer", "gateway");
}

function validateWorkloadSurface(providerId: string, surface: Record<string, unknown>): void {
  requireSupported("workload", surface);
  validateWorkloadProfile(providerId, surface);
}

function validateHostLocalInferenceSurface(
  providerId: string,
  surface: Record<string, unknown>,
): void {
  if (surface.supported !== true) return;
  if (
    !Array.isArray(surface.services) ||
    surface.services.length === 0 ||
    surface.services.some(
      (service) => !HOST_LOCAL_INFERENCE_SERVICES.has(String(service) as HostLocalInferenceService),
    ) ||
    new Set(surface.services).size !== surface.services.length
  ) {
    throw new RuntimeProviderRegistrationError(
      `hostLocalInference for '${providerId}' must list unique valid services`,
    );
  }
  requireFunction(surface, "createOperation", "hostLocalInference");
}

function validateLifecycleSurface(providerId: string, surface: Record<string, unknown>): void {
  if (surface.supported === true) {
    if (!CHANNEL_STOP_TRANSPORTS.has(String(surface.channelStopTransport))) {
      throw new RuntimeProviderRegistrationError(
        `lifecycle for '${providerId}' has an invalid channel-stop transport`,
      );
    }
    requireFunction(surface, "start", "lifecycle");
    requireFunction(surface, "verifyStarted", "lifecycle");
    requireFunction(surface, "stop", "lifecycle");
  }
}

function validateMutationAuthoritySurface(
  providerId: string,
  surface: Record<string, unknown>,
): void {
  if (surface.supported === true) {
    const operations = surface.operations;
    if (
      !Array.isArray(operations) ||
      operations.length === 0 ||
      operations.some((operation) => !MUTATION_OPERATIONS.has(operation)) ||
      new Set(operations).size !== operations.length
    ) {
      throw new RuntimeProviderRegistrationError(
        `mutationAuthority for '${providerId}' must list unique valid operations`,
      );
    }
  }
}

function validateStateMutationSurface(providerId: string, surface: Record<string, unknown>): void {
  if (surface.supported !== true) return;
  if (surface.contractVersion !== RUNTIME_PROVIDER_STATE_MUTATION_CONTRACT_VERSION) {
    throw new RuntimeProviderRegistrationError(
      `stateMutation for '${providerId}' has an unsupported contract version`,
    );
  }
  for (const operation of [
    "acquire",
    "assertFenced",
    "publish",
    "rollback",
    "activate",
    "release",
    "recover",
  ] as const) {
    requireFunction(surface, operation, "stateMutation");
  }
}

function validateBootstrapSurface(surface: Record<string, unknown>): void {
  if (surface.supported !== true) return;
  if (surface.bootstrapKind === "managed-image") {
    requireFunction(surface, "createAuthorityStore", "bootstrap");
    requireFunction(surface, "createLifecycle", "bootstrap");
    requireFunction(surface, "createOnboardRouting", "bootstrap");
    return;
  }
  if (surface.bootstrapKind === "native-artifact") {
    if (surface.contractVersion !== RUNTIME_PROVIDER_NATIVE_ARTIFACT_BOOTSTRAP_CONTRACT_VERSION) {
      throw new RuntimeProviderRegistrationError(
        "native-artifact bootstrap has an unsupported contract version",
      );
    }
    requireFunction(surface, "run", "bootstrap");
    requireFunction(surface, "recover", "bootstrap");
    return;
  }
  throw new RuntimeProviderRegistrationError("bootstrap has an unsupported kind");
}

function validateSnapshotSurface(providerId: string, surface: Record<string, unknown>): void {
  if (surface.supported === true) {
    if (surface.contractVersion !== RUNTIME_PROVIDER_SNAPSHOT_CONTRACT_VERSION) {
      throw new RuntimeProviderRegistrationError(
        `snapshot for '${providerId}' has an unsupported contract version`,
      );
    }
    const capabilities = requireOwnRecord(surface, "capabilities");
    for (const capability of ["backup", "restore", "managedProfileRestore"] as const) {
      requireBoolean(capabilities, capability, "snapshot capabilities");
    }
    requireFunction(surface, "preflight", "snapshot");
    requireFunction(surface, "capture", "snapshot");
    requireFunction(surface, "validateRestore", "snapshot");
    requireFunction(surface, "restore", "snapshot");
    if (capabilities.managedProfileRestore === true && capabilities.restore !== true) {
      throw new RuntimeProviderRegistrationError(
        `snapshot for '${providerId}' cannot restore managed profiles without restore support`,
      );
    }
  }
}

function validateRecoverySurface(surface: Record<string, unknown>): void {
  if (surface.supported === true) {
    requireFunction(surface, "recover", "recovery");
  }
}

function validateCleanupSurface(surface: Record<string, unknown>): void {
  if (surface.supported === true) {
    requireFunction(surface, "prepareDestroy", "cleanup");
    requireFunction(surface, "planOwnedWorkloadCleanup", "cleanup");
    requireFunction(surface, "removeOwnedWorkload", "cleanup");
  }
}

function validateContainerEngineSurface(
  providerId: string,
  surface: Record<string, unknown>,
): void {
  if (surface.supported === true) {
    const identities = surface.identities;
    if (!Array.isArray(identities)) {
      throw new RuntimeProviderRegistrationError(
        `containerEngine for '${providerId}' must list operation-scoped identities`,
      );
    }
    const operations: unknown[] = [];
    for (const identity of identities) {
      if (!isPlainRecord(identity)) {
        throw new RuntimeProviderRegistrationError(
          `containerEngine for '${providerId}' has an invalid identity`,
        );
      }
      if (
        !CONTAINER_ENGINE_OPERATIONS.has(
          identity.operation as RuntimeProviderContainerEngineOperation,
        )
      ) {
        throw new RuntimeProviderRegistrationError(
          `containerEngine for '${providerId}' has an invalid operation`,
        );
      }
      requireNonEmptyString(identity, "engineId", "containerEngine identity");
      requireNonEmptyString(identity, "displayName", "containerEngine identity");
      operations.push(identity.operation);
    }
    if (new Set(operations).size !== operations.length) {
      throw new RuntimeProviderRegistrationError(
        `containerEngine for '${providerId}' has duplicate operation identities`,
      );
    }
  }
}

function validateSupportedSurfaceSchemas(
  providerId: string,
  surfaces: RuntimeProviderSurfaceRecords,
): void {
  validatePlanSurface(providerId, surfaces.plan);
  validateCapabilitiesSurface(surfaces.capabilities);
  validatePreflightDoctorSurface(surfaces.preflightDoctor);
  validateGatewaySurface(providerId, surfaces.gateway);
  validateWorkloadSurface(providerId, surfaces.workload);
  validateHostLocalInferenceSurface(providerId, surfaces.hostLocalInference);
  validateLifecycleSurface(providerId, surfaces.lifecycle);
  validateMutationAuthoritySurface(providerId, surfaces.mutationAuthority);
  validateStateMutationSurface(providerId, surfaces.stateMutation);
  validateBootstrapSurface(surfaces.bootstrap);
  validateSnapshotSurface(providerId, surfaces.snapshot);
  validateRecoverySurface(surfaces.recovery);
  validateCleanupSurface(surfaces.cleanup);
  validateContainerEngineSurface(providerId, surfaces.containerEngine);

  if (surfaces.plan.gatewayLauncher !== surfaces.gateway.launcher) {
    throw new RuntimeProviderRegistrationError(
      `plan and gateway launcher disagree for '${providerId}'`,
    );
  }
  if (
    surfaces.capabilities.hostLocalInference !== (surfaces.hostLocalInference.supported === true) ||
    surfaces.capabilities.directLifecycle !== (surfaces.lifecycle.supported === true) ||
    surfaces.capabilities.workloadImageCleanup !== (surfaces.cleanup.supported === true) ||
    surfaces.capabilities.legacyGatewayContainerInspection !==
      surfaces.gateway.inspectLegacyContainer
  ) {
    throw new RuntimeProviderRegistrationError(
      `capabilities disagree with registered surfaces for '${providerId}'`,
    );
  }
}

function validateBundle(key: string, value: RuntimeProviderBundle): void {
  if (!validProviderId(key)) {
    throw new RuntimeProviderRegistrationError(`unsupported provider key '${key}'`);
  }
  if (!isPlainRecord(value)) {
    throw new RuntimeProviderRegistrationError(`bundle '${key}' must be a plain record`);
  }
  const identity = requireOwnRecord(value, "identity");
  if (
    identity.contractVersion !== RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION ||
    identity.id !== key ||
    typeof identity.displayName !== "string" ||
    identity.displayName.trim() === ""
  ) {
    throw new RuntimeProviderRegistrationError(
      `bundle key '${key}' does not match a valid contract-v1 identity`,
    );
  }
  const surfaces = {} as Record<(typeof BUNDLE_SURFACES)[number], Record<string, unknown>>;
  for (const name of BUNDLE_SURFACES) {
    const surface = requireOwnRecord(value, name);
    validateBoundSurface(key, name, surface);
    surfaces[name] = surface;
  }
  validateSupportedSurfaceSchemas(key, surfaces);
}

export function createRuntimeProviderBundleRegistry(
  entries: readonly (readonly [string, RuntimeProviderBundle])[],
): RuntimeProviderBundleRegistry {
  const registry: Record<string, RuntimeProviderBundle> = Object.create(null);
  for (const [key, bundle] of entries) {
    if (Object.hasOwn(registry, key)) {
      throw new RuntimeProviderRegistrationError(`duplicate provider identity '${key}'`);
    }
    validateBundle(key, bundle);
    registry[key] = cloneAndFreeze(bundle);
  }
  return Object.freeze(registry);
}

export function normalizeRuntimeProviderIdentity(driverName: string | null | undefined): string {
  const normalized = driverName?.trim().toLowerCase();
  return !normalized || normalized === "vm" ? "docker" : normalized;
}

export function resolveRuntimeProviderBundle(
  driverName: string | null | undefined,
  providers: RuntimeProviderBundleRegistry,
): RuntimeProviderBundle | null {
  const providerId = normalizeRuntimeProviderIdentity(driverName);
  if (!validProviderId(providerId) || !Object.hasOwn(providers, providerId)) return null;
  const bundle = providers[providerId];
  if (!bundle) return null;
  validateBundle(providerId, bundle);
  return bundle;
}

export function requireRuntimeProviderBundle(
  driverName: string | null | undefined,
  providers: RuntimeProviderBundleRegistry,
): RuntimeProviderBundle {
  const providerId = normalizeRuntimeProviderIdentity(driverName);
  const bundle = resolveRuntimeProviderBundle(providerId, providers);
  if (!bundle) {
    throw new RuntimeProviderSelectionError(
      `Runtime provider '${providerId}' is not registered for this operation.`,
    );
  }
  return bundle;
}

export function requireRuntimeProviderBundleForSandbox(
  sandbox: Pick<SandboxEntry, "openshellDriver">,
  providers: RuntimeProviderBundleRegistry,
): RuntimeProviderBundle {
  return requireRuntimeProviderBundle(sandbox.openshellDriver, providers);
}

export function requireRuntimeProviderReadOnlyHostMounts(
  bundle: RuntimeProviderBundle,
  platform: NodeJS.Platform,
): Extract<
  RuntimeProviderBundle["capabilities"]["readOnlyHostMounts"],
  { readonly supported: true }
> {
  const capability = bundle.capabilities.readOnlyHostMounts;
  if (capability.supported !== true) {
    throw new RuntimeProviderSelectionError(
      `Runtime provider '${bundle.identity.id}' does not support read-only host mounts: ${capability.reason}`,
    );
  }
  if (!capability.hostPlatforms.includes(platform)) {
    throw new RuntimeProviderSelectionError(
      `Runtime provider '${bundle.identity.id}' has not qualified read-only host mounts on host platform '${platform}'.`,
    );
  }
  return capability;
}

export function requireRuntimeProviderMutationAuthority(
  bundle: RuntimeProviderBundle,
  operation: RuntimeProviderMutationOperation,
): void {
  const authority = bundle.mutationAuthority;
  if (authority.supported !== true || !authority.operations.includes(operation)) {
    throw new RuntimeProviderSelectionError(
      `Runtime provider '${bundle.identity.id}' does not authorize '${operation}' mutation.`,
    );
  }
}

export function requireRuntimeProviderStateMutationSurface(
  bundle: RuntimeProviderBundle,
): Extract<RuntimeProviderBundle["stateMutation"], { readonly supported: true }> {
  const surface = bundle.stateMutation;
  if (surface.supported !== true) {
    throw new RuntimeProviderSelectionError(
      `Runtime provider '${bundle.identity.id}' has no state-mutation implementation: ${surface.reason}`,
    );
  }
  return surface;
}

export type RuntimeProviderDestructiveCleanupAuthority = {
  readonly provider: RuntimeProviderBundle & {
    readonly cleanup: Extract<RuntimeProviderBundle["cleanup"], { readonly supported: true }>;
  };
  readonly workloadAction: "retain" | "remove";
};

/**
 * Prove the complete provider/workload cleanup boundary without mutating it.
 *
 * SOURCE_OF_TRUTH
 * Invalid state: a destructive sandbox action removes the live workload before
 * NemoClaw proves that the recorded provider can retire its exact local
 * ownership state.
 * Source boundary: the selected RuntimeProviderBundle owns destroy,
 * provider-cleanup, and workload-cleanup authority plus the side-effect-free
 * workload cleanup plan.
 * Source-fix constraint: mutable sandbox names are not runtime ownership
 * receipts, and a provider may use a CLI, socket, API, or no container engine.
 * Regression proof: snapshot-restore-lifecycle.test.ts rejects unknown
 * providers and mismatched legacy workload receipts before any delete,
 * provider cleanup, shields cleanup, or replacement creation.
 * Removal condition: this guard may be replaced only by a provider-native
 * atomic replace operation that returns authenticated rollback/cleanup
 * receipts for the exact prior runtime.
 */
export function requireRuntimeProviderDestructiveCleanupAuthority(
  sandboxName: string,
  sandbox: SandboxEntry,
  providers: RuntimeProviderBundleRegistry,
): RuntimeProviderDestructiveCleanupAuthority {
  const provider = requireRuntimeProviderBundleForSandbox(sandbox, providers);
  requireRuntimeProviderMutationAuthority(provider, "destroy");
  requireRuntimeProviderMutationAuthority(provider, "provider-cleanup");
  requireRuntimeProviderMutationAuthority(provider, "workload-cleanup");
  if (provider.cleanup.supported !== true) {
    throw new RuntimeProviderSelectionError(
      `Runtime provider '${provider.identity.id}' has no cleanup implementation.`,
    );
  }
  const supportedProvider = provider as RuntimeProviderDestructiveCleanupAuthority["provider"];
  const plan = supportedProvider.cleanup.planOwnedWorkloadCleanup({ sandbox, sandboxName });
  // Shared managed images and rows with no owned image require no destructive
  // workload mutation, so malformed or legacy-dropped receipts cannot turn
  // their immutable image into a deletion candidate.
  if (plan.action === "retain") {
    return Object.freeze({ provider: supportedProvider, workloadAction: plan.action });
  }
  if (plan.action === "block") {
    throw new RuntimeProviderSelectionError(
      `Runtime provider '${provider.identity.id}' could not prove ownership of the recorded workload receipt.`,
    );
  }
  if (!provider.workload.acceptsReceipt(sandbox.workload)) {
    throw new RuntimeProviderSelectionError(
      `Runtime provider '${provider.identity.id}' rejected the durable workload receipt.`,
    );
  }
  return Object.freeze({ provider: supportedProvider, workloadAction: plan.action });
}

export function runtimeProviderContainerEngineIdentity(
  bundle: RuntimeProviderBundle,
  operation: RuntimeProviderContainerEngineOperation,
): { readonly engineId: string; readonly displayName: string } | null {
  if (bundle.containerEngine.supported !== true) return null;
  const identity = bundle.containerEngine.identities.find(
    (candidate) => candidate.operation === operation,
  );
  return identity ? { engineId: identity.engineId, displayName: identity.displayName } : null;
}

export function requireRuntimeProviderHostLocalInferenceOperation(
  bundle: RuntimeProviderBundle,
  service: HostLocalInferenceService,
  input: HostLocalInferenceOperationInput,
  candidate?: HostLocalInferenceOperation,
): HostLocalInferenceOperation {
  const surface = bundle.hostLocalInference;
  if (
    bundle.capabilities.hostLocalInference !== true ||
    surface.supported !== true ||
    !surface.services.includes(service)
  ) {
    const detail =
      surface.supported === true ? `service '${service}' is not enabled` : surface.reason;
    throw new RuntimeProviderSelectionError(
      `Runtime provider '${bundle.identity.id}' does not provide the host-local-inference capability required for ${service}: ${detail}`,
    );
  }
  const expectedEngine = runtimeProviderContainerEngineIdentity(bundle, "host-local-inference");
  if (expectedEngine === null) {
    throw new RuntimeProviderSelectionError(
      `Runtime provider '${bundle.identity.id}' does not provide an operation-scoped host-local-inference engine for ${service}.`,
    );
  }
  const operation = candidate ?? surface.createOperation(input);
  if (
    operation.providerId !== bundle.identity.id ||
    operation.engine.operation !== "host-local-inference" ||
    operation.engine.engineId !== expectedEngine.engineId ||
    operation.engine.displayName !== expectedEngine.displayName
  ) {
    throw new RuntimeProviderSelectionError(
      `Runtime provider '${bundle.identity.id}' returned mismatched host-local-inference authority for ${service}.`,
    );
  }
  return operation;
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !CONTROL_CHARACTERS.test(value)
  );
}

export function normalizeRuntimeProviderRuntimeReceipt(
  value: unknown,
): RuntimeProviderRuntimeReceipt | null {
  if (!isPlainRecord(value) || value.schemaVersion !== 1 || !validProviderId(value.providerId)) {
    return null;
  }
  if (!isPlainRecord(value.runtime)) return null;
  if (
    !boundedString(value.runtime.kind, 128) ||
    !boundedString(value.runtime.handle, MAX_RECEIPT_HANDLE_BYTES)
  ) {
    return null;
  }
  if (!isPlainRecord(value.acceleration)) return null;
  const runtime = { kind: value.runtime.kind, handle: value.runtime.handle };
  if (value.acceleration.kind === "none") {
    return {
      schemaVersion: 1,
      providerId: value.providerId,
      runtime,
      acceleration: { kind: "none" },
    };
  }
  if (
    value.acceleration.kind !== "gpu" ||
    !boundedString(value.acceleration.vendor, 128) ||
    !Array.isArray(value.acceleration.devices) ||
    value.acceleration.devices.length === 0 ||
    value.acceleration.devices.length > MAX_RECEIPT_DEVICES ||
    !value.acceleration.devices.every((device) => boundedString(device, 512)) ||
    new Set(value.acceleration.devices).size !== value.acceleration.devices.length
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    providerId: value.providerId,
    runtime,
    acceleration: {
      kind: "gpu",
      vendor: value.acceleration.vendor,
      devices: [...value.acceleration.devices],
    },
  };
}

export function normalizeRuntimeProviderManagedProfileRestoreAuthority(
  value: unknown,
): RuntimeProviderManagedProfileRestoreAuthority | null {
  if (
    !isPlainRecord(value) ||
    typeof value.agent !== "string" ||
    !MANAGED_PROFILE_AGENT_PATTERN.test(value.agent) ||
    typeof value.profileFingerprint !== "string" ||
    !SHA256_PATTERN.test(value.profileFingerprint)
  ) {
    return null;
  }
  return {
    agent: value.agent,
    profileFingerprint: value.profileFingerprint,
  };
}

export function normalizeRuntimeProviderSnapshotPreflightReceipt(
  value: unknown,
): RuntimeProviderSnapshotPreflightReceipt | null {
  if (
    !isPlainRecord(value) ||
    value.schemaVersion !== RUNTIME_PROVIDER_SNAPSHOT_PREFLIGHT_SCHEMA_VERSION ||
    !validProviderId(value.providerId) ||
    typeof value.operation !== "string" ||
    !SNAPSHOT_OPERATIONS.has(value.operation) ||
    !boundedString(value.sandboxName, 512) ||
    !boundedString(value.providerHandle, MAX_RECEIPT_HANDLE_BYTES) ||
    !SNAPSHOT_LIFECYCLE_STATES.has(value.lifecycleState as RuntimeProviderSnapshotLifecycleState) ||
    !boundedString(value.lifecycleGeneration, MAX_RECEIPT_HANDLE_BYTES)
  ) {
    return null;
  }
  return {
    schemaVersion: RUNTIME_PROVIDER_SNAPSHOT_PREFLIGHT_SCHEMA_VERSION,
    providerId: value.providerId,
    operation: value.operation as RuntimeProviderSnapshotPreflightReceipt["operation"],
    sandboxName: value.sandboxName,
    providerHandle: value.providerHandle,
    lifecycleState: value.lifecycleState as RuntimeProviderSnapshotLifecycleState,
    lifecycleGeneration: value.lifecycleGeneration,
  };
}

export function normalizeRuntimeProviderSnapshotRestoreSource(
  value: unknown,
): RuntimeProviderSnapshotRestoreSource | null {
  if (
    !isPlainRecord(value) ||
    value.schemaVersion !== 1 ||
    !validProviderId(value.providerId) ||
    !boundedString(value.providerHandle, MAX_RECEIPT_HANDLE_BYTES) ||
    !SNAPSHOT_LIFECYCLE_STATES.has(value.lifecycleState as RuntimeProviderSnapshotLifecycleState) ||
    !boundedString(value.lifecycleGeneration, MAX_RECEIPT_HANDLE_BYTES)
  ) {
    return null;
  }
  const runtime = normalizeRuntimeProviderRuntimeReceipt(value.runtime);
  if (!runtime || runtime.providerId !== value.providerId) return null;
  return {
    schemaVersion: 1,
    providerId: value.providerId,
    providerHandle: value.providerHandle,
    lifecycleState: value.lifecycleState as RuntimeProviderSnapshotLifecycleState,
    lifecycleGeneration: value.lifecycleGeneration,
    runtime,
  };
}

export function normalizeRuntimeProviderSnapshotRestoreReceipt(
  value: unknown,
): RuntimeProviderSnapshotRestoreReceipt | null {
  if (
    !isPlainRecord(value) ||
    value.schemaVersion !== 1 ||
    !validProviderId(value.providerId) ||
    !boundedString(value.sandboxName, 512) ||
    !boundedString(value.providerHandle, MAX_RECEIPT_HANDLE_BYTES) ||
    !SNAPSHOT_LIFECYCLE_STATES.has(value.lifecycleState as RuntimeProviderSnapshotLifecycleState) ||
    !boundedString(value.lifecycleGeneration, MAX_RECEIPT_HANDLE_BYTES)
  ) {
    return null;
  }
  const runtime = normalizeRuntimeProviderRuntimeReceipt(value.runtime);
  const managedProfile = normalizeRuntimeProviderManagedProfileRestoreAuthority(
    value.managedProfile,
  );
  if (!runtime || runtime.providerId !== value.providerId || !managedProfile) return null;
  return {
    schemaVersion: 1,
    providerId: value.providerId,
    sandboxName: value.sandboxName,
    providerHandle: value.providerHandle,
    lifecycleState: value.lifecycleState as RuntimeProviderSnapshotLifecycleState,
    lifecycleGeneration: value.lifecycleGeneration,
    runtime,
    managedProfile,
  };
}
