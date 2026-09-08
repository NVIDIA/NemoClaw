// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";

import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import {
  assertLlamaCppGgufCachePlanDigest,
  type LlamaCppGgufCachePlan,
} from "../../inference/llama-cpp/gguf-cache-plan";
import {
  assertLlamaCppVerifiedLocalModelArtifact,
  buildLlamaCppRequestGuardCommandArgv,
  buildLlamaCppRequestGuardDockerArgv,
  LLAMA_CPP_HOST_LOCAL_CONTAINER_API_KEY_PATH,
  LLAMA_CPP_HOST_LOCAL_REQUEST_GUARD_PATH,
  type LlamaCppHostLocalLaunchContract,
  type LlamaCppHostLocalRuntimeBindings,
} from "../../inference/llama-cpp/host-local-runtime";
import { formatHostServiceUnreachableMessage } from "../reachability/host-service-message";
import { validateUfwRuleOperands } from "../ufw-auto-apply";
import {
  createDockerLlamaCppPrivateBridgeController,
  type DockerLlamaCppPrivateBridgeAuthority,
  type DockerLlamaCppPrivateBridgeController,
} from "./docker-llama-cpp-private-bridge";
import {
  type HostLocalCreateJournalExecutionLease,
  type HostLocalCreateJournalRecord,
  type HostLocalCreateJournalStore,
  normalizeHostLocalCreateJournalRecord,
} from "./host-local-create-journal";
import type {
  HostLocalInferenceReceipt,
  HostLocalInferenceReceiptWriter,
  HostLocalInferenceRecoveryResult,
  HostLocalInferenceRuntime,
  HostLocalLlamaCppLifecycle,
  HostLocalLlamaCppLifecycleInput,
} from "./host-local-inference";
import {
  normalizeHostLocalInferenceImageRef,
  normalizeHostLocalInferenceReceipt,
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "./host-local-inference";
import {
  createPersistedEngineAuthority,
  type PersistedEngineAuthority,
  type PersistedEngineAuthorityStore,
  requirePersistedEngineAuthority,
} from "./persisted-engine-authority";

const PROVIDER_ID = "docker";
const SERVICE = "llama-cpp";
const ENDPOINT_HOST = "host.openshell.internal";
const OPENSHELL_DOCKER_NETWORK = "openshell-docker";
const FULL_ID = /^[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MANAGED_LABEL = "io.nvidia.nemoclaw.host-local-inference.managed";
const PROVIDER_LABEL = "io.nvidia.nemoclaw.host-local-inference.provider";
const SERVICE_LABEL = "io.nvidia.nemoclaw.host-local-inference.service";
const SPEC_LABEL = "io.nvidia.nemoclaw.host-local-inference.spec-sha256";
const TRANSACTION_LABEL = "io.nvidia.nemoclaw.host-local-inference.transaction-sha256";
const NETWORK_TRANSACTION_LABEL =
  "io.nvidia.nemoclaw.host-local-inference.network-transaction-sha256";
const INSPECT_TIMEOUT_MS = 15_000;
const MUTATION_TIMEOUT_MS = 30 * 60 * 1000;
const UNCERTAIN_CREATE_ABSENCE_GRACE_MS = MUTATION_TIMEOUT_MS + INSPECT_TIMEOUT_MS;
const STOP_GRACE_SECONDS = 30;
const AT_REST = new Set(["created", "dead", "exited"]);
const CURL_CONNECTIVITY_FAILURE_EXIT_CODES = new Set([7, 28]);

export type DockerLlamaCppManagedLifecycleOptions = HostLocalLlamaCppLifecycleInput;

export interface DockerLlamaCppManagedLifecycleDependencies {
  readonly now?: () => number;
  readonly privateBridge?: DockerLlamaCppPrivateBridgeController;
}

export type DockerLlamaCppRecoveryResult = HostLocalInferenceRecoveryResult;

export type DockerLlamaCppManagedLifecycle = HostLocalLlamaCppLifecycle;

interface DockerNetworkAuthority {
  readonly id: string;
  readonly name: string;
}

interface DockerGatewayBridgeAuthority {
  readonly gatewayIp: string;
  readonly name: typeof OPENSHELL_DOCKER_NETWORK;
  readonly subnet?: string;
}

interface DockerContainerInspection {
  readonly id: string;
  readonly name: string;
  readonly imageRef: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly running: boolean;
  readonly status: string;
  readonly networkId: string | null;
  readonly networkName: string;
  readonly containerIp: string | null;
  readonly mounts: readonly {
    readonly type: string;
    readonly source: string;
    readonly destination: string;
    readonly readOnly: boolean;
  }[];
  readonly hardening: {
    readonly user: string;
    readonly networkMode: string;
    readonly restartPolicy: string;
    readonly readOnlyRootfs: boolean;
    readonly capDrop: readonly string[];
    readonly securityOpt: readonly string[];
    readonly memory: number;
    readonly memorySwap: number;
    readonly pidsLimit: number;
    readonly gpuCount: number;
    readonly deviceAuthorityExact: boolean;
    readonly capAddEmpty: boolean;
    readonly legacyDevicesEmpty: boolean;
    readonly privileged: boolean;
    readonly entrypoint: readonly string[];
    readonly command: readonly string[];
    readonly tmpfs: Readonly<Record<string, string>>;
  };
}

type DockerContainerInspectionMode = "created" | "runtime" | "cleanup";

interface StableFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface MutationExecutionState {
  unknown: boolean;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForCanonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, nested]) => [key, normalizeForCanonicalJson(nested)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  // This hashes non-secret canonical lifecycle identity metadata for drift detection,
  // not passwords, credentials, or secret material.
  return createHash("sha256")
    .update(JSON.stringify(normalizeForCanonicalJson(value))) // codeql[js/insufficient-password-hash]
    .digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableFileIdentitySha256(identity: StableFileIdentity): string {
  return sha256({
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    size: identity.size.toString(),
    mtimeNs: identity.mtimeNs.toString(),
    ctimeNs: identity.ctimeNs.toString(),
  });
}

function readinessTimeoutSeconds(options: DockerLlamaCppManagedLifecycleOptions): number {
  const value = options.readinessTimeoutSeconds;
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400) {
    throw new Error("Docker llama.cpp readiness timeout must be 1-86400 seconds.");
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireSuccess(operation: string, result: ContainerEngineCommandResult): string {
  if (result.error || result.status !== 0) {
    throw new Error(`Docker llama.cpp ${operation} failed (exit ${String(result.status)}).`);
  }
  return result.stdout;
}

function exactId(value: unknown, label: string): string {
  if (typeof value !== "string" || !FULL_ID.test(value)) {
    throw new Error(`${label} must be one full immutable Docker ID.`);
  }
  return value;
}

function exactPrivateIpv4(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/u.test(value)) {
    throw new Error(`${label} must be one private IPv4 address.`);
  }
  const octets = value.split(".").map(Number);
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255) ||
    !(
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    )
  ) {
    throw new Error(`${label} must be one private IPv4 address.`);
  }
  return value;
}

function inspectNetworkIfPresent(
  engine: ContainerEngine,
  name: string,
  ownerLabel: LlamaCppHostLocalRuntimeBindings["ownerLabel"],
  transactionId?: string,
): DockerNetworkAuthority | null {
  const result = engine.capture(["network", "inspect", name], INSPECT_TIMEOUT_MS);
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const exactAbsent = new RegExp(
    `^(?:Error response from daemon:\\s*)?(?:No such network: ${escapedName}|network ${escapedName} not found)$`,
    "iu",
  );
  if (!result.error && result.status === 1 && exactAbsent.test(result.stderr.trim())) {
    return null;
  }
  const output = requireSuccess("network inspection", result);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Docker llama.cpp network inspection returned unreadable JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Docker llama.cpp network inspection must identify exactly one network.");
  }
  const source = record(parsed[0], "Docker llama.cpp network inspection");
  const labels = parseLabels(source.Labels);
  if (
    source.Name !== name ||
    source.Internal !== true ||
    source.Driver !== "bridge" ||
    source.Scope !== "local" ||
    labels[ownerLabel.name] !== ownerLabel.value ||
    (transactionId !== undefined && labels[NETWORK_TRANSACTION_LABEL] !== transactionId)
  ) {
    throw new Error("Docker llama.cpp requires the exact internal Docker network.");
  }
  return Object.freeze({
    id: exactId(source.Id, "Docker network identity"),
    name,
  });
}

function inspectGatewayBridge(engine: ContainerEngine): DockerGatewayBridgeAuthority {
  const output = requireSuccess(
    "OpenShell bridge inspection",
    engine.capture(["network", "inspect", OPENSHELL_DOCKER_NETWORK], INSPECT_TIMEOUT_MS),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Docker llama.cpp OpenShell bridge inspection returned unreadable JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Docker llama.cpp requires exactly one OpenShell Docker bridge.");
  }
  const source = record(parsed[0], "Docker llama.cpp OpenShell bridge inspection");
  const ipam = record(source.IPAM, "Docker llama.cpp OpenShell bridge IPAM");
  const configs = ipam.Config;
  if (
    source.Name !== OPENSHELL_DOCKER_NETWORK ||
    source.Driver !== "bridge" ||
    source.Scope !== "local" ||
    source.Internal !== false ||
    !Array.isArray(configs)
  ) {
    throw new Error("Docker llama.cpp requires the native OpenShell Docker bridge.");
  }
  const gateways = configs.flatMap((candidate) => {
    const config = record(candidate, "Docker llama.cpp OpenShell bridge IPAM entry");
    const gatewayIp = config.Gateway;
    const subnet = config.Subnet;
    return typeof gatewayIp === "string" &&
      (/^172\.(?:1[6-9]|2[0-9]|3[01])\.(?:[0-9]{1,3})\.(?:[0-9]{1,3})$/u.test(gatewayIp) ||
        /^(?:10\.|192\.168\.)/u.test(gatewayIp))
      ? [{ gatewayIp, ...(typeof subnet === "string" ? { subnet } : {}) }]
      : [];
  });
  if (gateways.length !== 1) {
    throw new Error("Docker llama.cpp requires one private IPv4 OpenShell bridge gateway.");
  }
  return Object.freeze({ ...gateways[0]!, name: OPENSHELL_DOCKER_NETWORK });
}

function inspectNetwork(
  engine: ContainerEngine,
  name: string,
  ownerLabel: LlamaCppHostLocalRuntimeBindings["ownerLabel"],
  transactionId: string,
): DockerNetworkAuthority {
  const network = inspectNetworkIfPresent(engine, name, ownerLabel, transactionId);
  if (network === null) throw new Error("Docker llama.cpp exact internal network is absent.");
  return network;
}

function parseLabels(value: unknown): Readonly<Record<string, string>> {
  const source = record(value, "Docker llama.cpp labels");
  const labels: Record<string, string> = Object.create(null);
  for (const [key, candidate] of Object.entries(source)) {
    if (typeof candidate !== "string" || candidate.includes("\0")) {
      throw new Error("Docker llama.cpp inspection returned malformed labels.");
    }
    labels[key] = candidate;
  }
  return Object.freeze(labels);
}

function parseInspection(
  output: string,
  contract: LlamaCppHostLocalLaunchContract,
  bindings: DockerLlamaCppManagedLifecycleOptions["bindings"],
  mode: DockerContainerInspectionMode,
): DockerContainerInspection {
  const networkName = bindings.network.name;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Docker llama.cpp container inspection returned unreadable JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Docker llama.cpp inspection must identify exactly one container.");
  }
  const source = record(parsed[0], "Docker llama.cpp inspection");
  const config = record(source.Config, "Docker llama.cpp container configuration");
  const hostConfig = record(source.HostConfig, "Docker llama.cpp host configuration");
  const restartPolicy = record(hostConfig.RestartPolicy, "Docker llama.cpp restart policy");
  const state = record(source.State, "Docker llama.cpp container state");
  const networkSettings = record(source.NetworkSettings, "Docker llama.cpp network settings");
  const networks = record(networkSettings.Networks, "Docker llama.cpp attached networks");
  const networkNames = Object.keys(networks);
  if (networkNames.length !== 1 || networkNames[0] !== networkName) {
    throw new Error("Docker llama.cpp container has unexpected network attachments.");
  }
  const attached = record(networks[networkName], "Docker llama.cpp network attachment");
  const attachedNetworkId = attached.NetworkID;
  const networkId =
    typeof attachedNetworkId === "string" && FULL_ID.test(attachedNetworkId)
      ? attachedNetworkId
      : mode !== "runtime" && attachedNetworkId === ""
        ? null
        : exactId(attachedNetworkId, "Docker attached network identity");
  const attachedIp = attached.IPAddress;
  const containerIp =
    typeof attachedIp === "string" && attachedIp !== ""
      ? exactPrivateIpv4(attachedIp, "Docker llama.cpp container address")
      : (mode !== "runtime" || state.Running === false) && attachedIp === ""
        ? null
        : exactPrivateIpv4(attachedIp, "Docker llama.cpp container address");
  if (mode !== "cleanup") {
    const ports = record(networkSettings.Ports, "Docker llama.cpp published ports");
    const portKey = `${String(contract.serve.port)}/tcp`;
    const configuredPorts = record(hostConfig.PortBindings, "Docker llama.cpp configured ports");
    if (Object.keys(configuredPorts).length !== 0) {
      throw new Error("Docker llama.cpp container must not configure published ports.");
    }
    const portKeys = Object.keys(ports);
    if (
      portKeys.some((key) => key !== portKey) ||
      (portKeys.includes(portKey) && ports[portKey] !== null)
    ) {
      throw new Error(
        "Docker llama.cpp container must not publish ports from its internal network.",
      );
    }
  }
  if (!Array.isArray(source.Mounts)) {
    throw new Error("Docker llama.cpp inspection returned malformed mounts.");
  }
  const mounts = source.Mounts.map((candidate) => {
    const mount = record(candidate, "Docker llama.cpp mount");
    if (typeof mount.Source !== "string" || typeof mount.Destination !== "string") {
      throw new Error("Docker llama.cpp inspection returned malformed mount paths.");
    }
    return Object.freeze({
      type: String(mount.Type ?? ""),
      source: mount.Source,
      destination: mount.Destination,
      readOnly: mount.RW === false,
    });
  });
  const rawName = typeof source.Name === "string" ? source.Name.replace(/^\//u, "") : "";
  if (!SAFE_NAME.test(rawName) || typeof state.Running !== "boolean") {
    throw new Error("Docker llama.cpp inspection returned malformed runtime state.");
  }
  const stateStatus = String(state.Status ?? "").toLowerCase();
  if (
    (state.Running && stateStatus !== "running") ||
    (!state.Running && !AT_REST.has(stateStatus)) ||
    typeof hostConfig.Privileged !== "boolean"
  ) {
    throw new Error("Docker llama.cpp inspection returned inconsistent runtime state.");
  }
  const deviceRequests = Array.isArray(hostConfig.DeviceRequests) ? hostConfig.DeviceRequests : [];
  const gpuRequest =
    deviceRequests.length === 1 ? record(deviceRequests[0], "Docker GPU request") : {};
  const gpuCapabilities = Array.isArray(gpuRequest.Capabilities) ? gpuRequest.Capabilities : [];
  const gpuDeviceIds = gpuRequest.DeviceIDs;
  const gpuOptions = gpuRequest.Options;
  const gpuCount =
    gpuRequest.Driver === "nvidia" &&
    gpuRequest.Count === 1 &&
    gpuCapabilities.some((group) => Array.isArray(group) && group.includes("gpu"))
      ? 1
      : 0;
  const deviceAuthorityExact =
    deviceRequests.length === 1 &&
    gpuRequest.Driver === "nvidia" &&
    gpuRequest.Count === 1 &&
    (gpuDeviceIds === null || (Array.isArray(gpuDeviceIds) && gpuDeviceIds.length === 0)) &&
    typeof gpuOptions === "object" &&
    gpuOptions !== null &&
    !Array.isArray(gpuOptions) &&
    Object.keys(gpuOptions).length === 0 &&
    gpuCapabilities.length === 1 &&
    Array.isArray(gpuCapabilities[0]) &&
    gpuCapabilities[0].length === 1 &&
    gpuCapabilities[0][0] === "gpu";
  const capAddEmpty =
    hostConfig.CapAdd === null ||
    (Array.isArray(hostConfig.CapAdd) && hostConfig.CapAdd.length === 0);
  const legacyDevicesEmpty =
    hostConfig.Devices === null ||
    (Array.isArray(hostConfig.Devices) && hostConfig.Devices.length === 0);
  return Object.freeze({
    id: exactId(source.Id, "Docker container identity"),
    name: rawName,
    imageRef: String(config.Image ?? ""),
    labels: parseLabels(config.Labels),
    running: state.Running,
    status: stateStatus,
    networkId,
    networkName,
    containerIp,
    mounts: Object.freeze(mounts),
    hardening: Object.freeze({
      user: String(config.User ?? ""),
      networkMode: String(hostConfig.NetworkMode ?? ""),
      restartPolicy: String(restartPolicy.Name ?? ""),
      readOnlyRootfs: hostConfig.ReadonlyRootfs === true,
      capDrop: Object.freeze(
        Array.isArray(hostConfig.CapDrop) ? hostConfig.CapDrop.map(String) : [],
      ),
      securityOpt: Object.freeze(
        Array.isArray(hostConfig.SecurityOpt) ? hostConfig.SecurityOpt.map(String) : [],
      ),
      memory: Number(hostConfig.Memory),
      memorySwap: Number(hostConfig.MemorySwap),
      pidsLimit: Number(hostConfig.PidsLimit),
      gpuCount,
      deviceAuthorityExact,
      capAddEmpty,
      legacyDevicesEmpty,
      privileged: hostConfig.Privileged,
      entrypoint: Object.freeze(
        Array.isArray(config.Entrypoint) ? config.Entrypoint.map(String) : [],
      ),
      command: Object.freeze(Array.isArray(config.Cmd) ? config.Cmd.map(String) : []),
      tmpfs: Object.freeze(
        Object.fromEntries(
          Object.entries(
            hostConfig.Tmpfs === null ? {} : record(hostConfig.Tmpfs, "Docker llama.cpp tmpfs"),
          ),
        ),
      ) as Readonly<Record<string, string>>,
    }),
  });
}

function inspectContainer(
  engine: ContainerEngine,
  target: string,
  contract: LlamaCppHostLocalLaunchContract,
  bindings: DockerLlamaCppManagedLifecycleOptions["bindings"],
  mode: DockerContainerInspectionMode = "runtime",
): DockerContainerInspection | null {
  const result = engine.capture(["container", "inspect", target], INSPECT_TIMEOUT_MS);
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const exactAbsent = new RegExp(
    `^(?:Error response from daemon:\\s*)?(?:No such container|No such object): ${escapedTarget}$`,
    "iu",
  );
  if (!result.error && result.status === 1 && exactAbsent.test(result.stderr.trim())) {
    return null;
  }
  return parseInspection(requireSuccess("container inspection", result), contract, bindings, mode);
}

function currentUid(): bigint {
  if (typeof process.getuid !== "function") {
    throw new Error("Docker llama.cpp requires current-user filesystem identity.");
  }
  return BigInt(process.getuid());
}

function secureOwner(status: BigIntStats): boolean {
  return status.uid === 0n || status.uid === currentUid();
}

function requireSecureNode(target: string, kind: "directory" | "file"): BigIntStats {
  const status = fs.lstatSync(target, { bigint: true });
  if (
    (kind === "directory" ? !status.isDirectory() : !status.isFile()) ||
    status.isSymbolicLink() ||
    (kind === "directory" ? !secureOwner(status) : status.uid !== currentUid()) ||
    (status.mode & 0o022n) !== 0n
  ) {
    throw new Error(`Docker llama.cpp ${kind} authority is not owner-controlled.`);
  }
  return status;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function assertModelFilesystemAuthority(options: DockerLlamaCppManagedLifecycleOptions): void {
  const plannedFile = options.plan.acquisition.source.file;
  if (
    plannedFile.path !== options.contract.model.file.path ||
    plannedFile.digest !== options.contract.model.file.digest ||
    plannedFile.sizeBytes !== options.contract.model.file.sizeBytes ||
    options.bindings.model.digest !== plannedFile.digest ||
    options.bindings.model.sizeBytes !== plannedFile.sizeBytes
  ) {
    throw new Error("Docker llama.cpp GGUF plan, launch contract, and verified artifact disagree.");
  }
  assertLlamaCppVerifiedLocalModelArtifact(options.contract, options.bindings.model);
  const cacheRoot = fs.realpathSync(options.cacheRootHostPath);
  const modelRoot = fs.realpathSync(
    path.join(
      cacheRoot,
      "hub",
      `models--${options.plan.acquisition.source.repository.replaceAll("/", "--")}`,
    ),
  );
  const modelPath = fs.realpathSync(options.bindings.model.hostPath);
  const snapshotEntry = path.join(
    cacheRoot,
    "hub",
    `models--${options.plan.acquisition.source.repository.replaceAll("/", "--")}`,
    "snapshots",
    options.plan.acquisition.source.revision,
    plannedFile.path,
  );
  let snapshotTarget: string;
  try {
    snapshotTarget = fs.realpathSync(snapshotEntry);
  } catch {
    throw new Error("Docker llama.cpp exact GGUF snapshot entry is unavailable.");
  }
  if (
    cacheRoot !== options.cacheRootHostPath ||
    modelPath !== options.bindings.model.hostPath ||
    !isWithin(cacheRoot, modelRoot) ||
    !isWithin(modelRoot, modelPath) ||
    snapshotTarget !== modelPath
  ) {
    throw new Error("Docker llama.cpp GGUF resolves outside its canonical model cache.");
  }
  requireSecureNode(cacheRoot, "directory");
  requireSecureNode(modelRoot, "directory");
  const relative = path.relative(cacheRoot, path.dirname(modelPath));
  let current = cacheRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    requireSecureNode(current, "directory");
  }
  requireSecureNode(modelPath, "file");
}

function sameFileIdentity(left: StableFileIdentity, right: StableFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function apiKeyIdentitySha256(identity: StableFileIdentity): string {
  return sha256({
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    size: identity.size.toString(),
    mtimeNs: identity.mtimeNs.toString(),
    ctimeNs: identity.ctimeNs.toString(),
  });
}

function apiKeyRootIdentitySha256(options: DockerLlamaCppManagedLifecycleOptions): string {
  const root = fs.realpathSync(options.apiKeyRootHostPath);
  const declaredParent = path.dirname(options.bindings.apiKeyHostPath);
  const parent = fs.realpathSync(declaredParent);
  if (root !== options.apiKeyRootHostPath || parent !== declaredParent || !isWithin(root, parent)) {
    throw new Error("Docker llama.cpp API-key path resolves outside its canonical private root.");
  }
  const identities: {
    dev: string;
    ino: string;
    uid: string;
    gid: string;
    nlink: string;
    mode: string;
    mtimeNs: string;
    ctimeNs: string;
  }[] = [];
  const relative = path.relative(root, parent);
  let current = root;
  for (const component of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (component !== "") current = path.join(current, component);
    const status = requireSecureNode(current, "directory");
    identities.push({
      dev: status.dev.toString(),
      ino: status.ino.toString(),
      uid: status.uid.toString(),
      gid: status.gid.toString(),
      nlink: status.nlink.toString(),
      mode: (status.mode & 0o777n).toString(8),
      mtimeNs: status.mtimeNs.toString(),
      ctimeNs: status.ctimeNs.toString(),
    });
  }
  return sha256({ schemaVersion: 1, identities });
}

function apiKeyIdentity(options: DockerLlamaCppManagedLifecycleOptions): StableFileIdentity {
  apiKeyRootIdentitySha256(options);
  const apiKeyPath = options.bindings.apiKeyHostPath;
  if (typeof fs.constants.O_NOFOLLOW !== "number" || typeof fs.constants.O_NONBLOCK !== "number") {
    throw new Error("Docker llama.cpp API-key validation requires O_NOFOLLOW and O_NONBLOCK.");
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      apiKeyPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch {
    throw new Error("Docker llama.cpp API-key file is unavailable.");
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const linked = fs.lstatSync(apiKeyPath, { bigint: true });
    if (
      !opened.isFile() ||
      !linked.isFile() ||
      opened.uid !== currentUid() ||
      opened.nlink !== 1n ||
      opened.size < 1n ||
      opened.size > 64n * 1024n ||
      (opened.mode & 0o777n) !== 0o600n ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino ||
      fs.realpathSync(apiKeyPath) !== apiKeyPath
    ) {
      throw new Error("Docker llama.cpp API-key file lacks exact private-file authority.");
    }
    return Object.freeze({
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      mtimeNs: opened.mtimeNs,
      ctimeNs: opened.ctimeNs,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertApiKeyIdentity(
  options: DockerLlamaCppManagedLifecycleOptions,
  expected: StableFileIdentity,
  expectedRootIdentitySha256: string,
): void {
  if (
    apiKeyRootIdentitySha256(options) !== expectedRootIdentitySha256 ||
    !sameFileIdentity(apiKeyIdentity(options), expected)
  ) {
    throw new Error("Docker llama.cpp API-key file changed during lifecycle mutation.");
  }
}

function assertApiKeyFileIdentity(
  options: DockerLlamaCppManagedLifecycleOptions,
  expected: StableFileIdentity,
): void {
  // Receipt publication may change the parent timestamp after Docker has bound the exact key inode.
  if (!sameFileIdentity(apiKeyIdentity(options), expected)) {
    throw new Error("Docker llama.cpp API-key file changed during lifecycle mutation.");
  }
}

function qualifyEngine(options: DockerLlamaCppManagedLifecycleOptions): PersistedEngineAuthority {
  if (
    options.engine.operation !== "host-local-inference" ||
    options.engine.engineId !== PROVIDER_ID ||
    !SHA256.test(options.bindingSha256)
  ) {
    throw new Error("Docker llama.cpp requires an exact host-local inference engine.");
  }
  return createPersistedEngineAuthority(PROVIDER_ID, options.engine, options.bindingSha256);
}

function authorizeEngine(
  options: DockerLlamaCppManagedLifecycleOptions,
  qualified: PersistedEngineAuthority,
  recordIfMissing: boolean,
): PersistedEngineAuthority {
  const persisted = options.authorityStore.load("host-local-inference");
  if (persisted === null) {
    if (!recordIfMissing) throw new Error("Docker llama.cpp engine authority is missing.");
    return options.authorityStore.record(qualified);
  }
  return requirePersistedEngineAuthority(
    persisted,
    PROVIDER_ID,
    options.engine,
    options.bindingSha256,
  );
}

function createArguments(
  options: DockerLlamaCppManagedLifecycleOptions,
  specSha256: string,
  transactionId: string,
): readonly string[] {
  const run = buildLlamaCppRequestGuardDockerArgv(options.contract, options.bindings);
  if (run[0] !== "run" || run[1] !== "--detach") {
    throw new Error("Docker llama.cpp materializer returned an unsupported launch operation.");
  }
  const networkIndex = run.indexOf("--network");
  if (networkIndex < 0) throw new Error("Docker llama.cpp materializer omitted its network.");
  return Object.freeze([
    "create",
    "--pull=never",
    ...run.slice(2, networkIndex),
    "--label",
    `${MANAGED_LABEL}=true`,
    "--label",
    `${PROVIDER_LABEL}=${PROVIDER_ID}`,
    "--label",
    `${SERVICE_LABEL}=${SERVICE}`,
    "--label",
    `${SPEC_LABEL}=${specSha256}`,
    "--label",
    `${TRANSACTION_LABEL}=${transactionId}`,
    ...run.slice(networkIndex),
  ]);
}

function createNetworkArguments(
  options: DockerLlamaCppManagedLifecycleOptions,
  transactionId: string,
): readonly string[] {
  return Object.freeze([
    "network",
    "create",
    "--internal",
    "--label",
    `${options.bindings.ownerLabel.name}=${options.bindings.ownerLabel.value}`,
    "--label",
    `${NETWORK_TRANSACTION_LABEL}=${transactionId}`,
    options.bindings.network.name,
  ]);
}

function expectedCommand(options: DockerLlamaCppManagedLifecycleOptions): readonly string[] {
  return buildLlamaCppRequestGuardCommandArgv(options.contract);
}

function specificationDigest(
  options: DockerLlamaCppManagedLifecycleOptions,
  apiKeyRootIdentity: string,
  receiptTargetSha256: string,
): string {
  return sha256({
    apiKeyRootIdentitySha256: apiKeyRootIdentity,
    contract: options.contract,
    containerName: options.bindings.containerName,
    imageReference: options.bindings.imageReference,
    model: {
      planDigest: options.plan.planDigest,
      recipeId: options.plan.recipeId,
      digest: options.plan.acquisition.source.file.digest,
      filesystemIdentitySha256: stableFileIdentitySha256(options.bindings.model.filesystemIdentity),
      sizeBytes: options.plan.acquisition.source.file.sizeBytes,
    },
    network: options.bindings.network,
    ownerLabel: options.bindings.ownerLabel,
    probeImageReference: options.probeImageReference,
    readinessTimeoutSeconds: options.readinessTimeoutSeconds,
    receiptTargetSha256,
    runtimeGid: options.bindings.runtimeGid,
    runtimeUid: options.bindings.runtimeUid,
  });
}

function requireOwnedContainer(
  container: DockerContainerInspection,
  options: DockerLlamaCppManagedLifecycleOptions,
  recordValue: HostLocalCreateJournalRecord,
): DockerContainerInspection {
  const record = normalizeHostLocalCreateJournalRecord(recordValue);
  const modelDestination = `/models/${options.contract.model.file.path}`;
  const expectedMounts = [
    `${options.bindings.model.hostPath}\0${modelDestination}`,
    `${options.bindings.apiKeyHostPath}\0${LLAMA_CPP_HOST_LOCAL_CONTAINER_API_KEY_PATH}`,
  ].sort();
  const actualMounts = container.mounts
    .filter((mount) => mount.type === "bind" && mount.readOnly)
    .map((mount) => `${mount.source}\0${mount.destination}`)
    .sort();
  if (
    (record.runtimeId !== null && container.id !== record.runtimeId) ||
    container.name !== record.containerName ||
    container.imageRef !== options.bindings.imageReference ||
    (container.networkId === null
      ? container.running || container.status !== "created"
      : container.networkId !== record.networkId) ||
    container.networkName !== options.bindings.network.name ||
    container.labels[MANAGED_LABEL] !== "true" ||
    container.labels[PROVIDER_LABEL] !== PROVIDER_ID ||
    container.labels[SERVICE_LABEL] !== SERVICE ||
    container.labels[SPEC_LABEL] !== record.specSha256 ||
    container.labels[TRANSACTION_LABEL] !== record.transactionId ||
    container.labels[options.bindings.ownerLabel.name] !== options.bindings.ownerLabel.value ||
    container.hardening.user !==
      `${String(options.bindings.runtimeUid)}:${String(options.bindings.runtimeGid)}` ||
    container.hardening.networkMode !== options.bindings.network.name ||
    container.hardening.restartPolicy !== options.contract.runtime.restartPolicy ||
    !container.hardening.readOnlyRootfs ||
    container.hardening.capDrop.length !== 1 ||
    container.hardening.capDrop[0] !== "ALL" ||
    container.hardening.securityOpt.length !== 1 ||
    (container.hardening.securityOpt[0] !== "no-new-privileges=true" &&
      container.hardening.securityOpt[0] !== "no-new-privileges:true") ||
    container.hardening.memory !== options.contract.runtime.resources.memoryBytes ||
    container.hardening.memorySwap !== options.contract.runtime.resources.memoryBytes ||
    container.hardening.pidsLimit !== options.contract.runtime.resources.pidsLimit ||
    container.hardening.gpuCount !== 1 ||
    !container.hardening.deviceAuthorityExact ||
    !container.hardening.capAddEmpty ||
    !container.hardening.legacyDevicesEmpty ||
    container.hardening.privileged ||
    container.hardening.entrypoint.length !== 1 ||
    container.hardening.entrypoint[0] !== LLAMA_CPP_HOST_LOCAL_REQUEST_GUARD_PATH ||
    container.hardening.command.join("\0") !== expectedCommand(options).join("\0") ||
    Object.keys(container.hardening.tmpfs).length !== 1 ||
    container.hardening.tmpfs["/tmp"] !==
      `rw,noexec,nosuid,nodev,size=${String(options.contract.runtime.resources.writableStorageBytes)},uid=${String(options.bindings.runtimeUid)},gid=${String(options.bindings.runtimeGid)},mode=1777` ||
    container.mounts.length !== expectedMounts.length ||
    actualMounts.join("\n") !== expectedMounts.join("\n")
  ) {
    throw new Error("Docker llama.cpp container does not match its exact journal authority.");
  }
  return container;
}

function captureMutation(
  options: DockerLlamaCppManagedLifecycleOptions,
  lease: HostLocalCreateJournalExecutionLease,
  execution: MutationExecutionState,
  args: readonly string[],
  timeoutMs: number,
): ContainerEngineCommandResult {
  options.journalStore.assertExecution(lease);
  execution.unknown = true;
  const result = options.engine.capture(args, timeoutMs);
  if (!result.error) execution.unknown = false;
  options.journalStore.assertExecution(lease);
  return result;
}

function probeReady(
  options: DockerLlamaCppManagedLifecycleOptions,
  lease: HostLocalCreateJournalExecutionLease,
  execution: MutationExecutionState,
): void {
  const timeoutSeconds = readinessTimeoutSeconds(options);
  requireSuccess(
    "readiness probe",
    captureMutation(
      options,
      lease,
      execution,
      [
        "run",
        "--rm",
        "--pull=never",
        "--network",
        options.bindings.network.name,
        "--entrypoint",
        "curl",
        options.probeImageReference,
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        String(timeoutSeconds),
        "--retry",
        String(timeoutSeconds),
        "--retry-delay",
        "1",
        "--retry-max-time",
        String(timeoutSeconds),
        "--retry-connrefused",
        `http://${options.bindings.containerName}:${String(options.contract.serve.port)}/health`,
      ],
      timeoutSeconds * 1_000 + INSPECT_TIMEOUT_MS,
    ),
  );
}

function privateBridgeAuthority(
  options: DockerLlamaCppManagedLifecycleOptions,
  journal: HostLocalCreateJournalRecord,
  container: DockerContainerInspection,
  gateway: DockerGatewayBridgeAuthority,
): DockerLlamaCppPrivateBridgeAuthority {
  if (container.containerIp === null) {
    throw new Error("Docker llama.cpp running container lacks an internal address.");
  }
  if (options.bindings.hostPort !== options.contract.serve.port) {
    throw new Error("Docker llama.cpp host bridge port differs from its declarative server port.");
  }
  return Object.freeze({
    transactionId: journal.transactionId,
    apiKeyPath: options.bindings.apiKeyHostPath,
    targetHost: container.containerIp,
    targetPort: options.contract.serve.port,
    listenPort: options.bindings.hostPort,
    bindAddresses: Object.freeze(["127.0.0.1", gateway.gatewayIp]) as readonly [
      "127.0.0.1",
      string,
    ],
  });
}

function probePrivateBridge(
  options: DockerLlamaCppManagedLifecycleOptions,
  bridge: DockerLlamaCppPrivateBridgeController,
  journal: HostLocalCreateJournalRecord,
  container: DockerContainerInspection,
  lease: HostLocalCreateJournalExecutionLease,
  execution: MutationExecutionState,
): void {
  const gateway = inspectGatewayBridge(options.engine);
  const authority = privateBridgeAuthority(options, journal, container, gateway);
  options.journalStore.assertExecution(lease);
  bridge.start(authority);
  options.journalStore.assertExecution(lease);
  const timeoutSeconds = Math.min(readinessTimeoutSeconds(options), 30);
  const curlArguments = (url: string): readonly string[] => [
    "--fail",
    "--silent",
    "--show-error",
    "--max-time",
    String(timeoutSeconds),
    "--retry",
    String(timeoutSeconds),
    "--retry-delay",
    "1",
    "--retry-max-time",
    String(timeoutSeconds),
    "--retry-connrefused",
    url,
  ];
  bridge.assertRunning(authority);
  options.journalStore.assertExecution(lease);
  requireSuccess(
    "private loopback bridge probe",
    captureMutation(
      options,
      lease,
      execution,
      [
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "host",
        "--entrypoint",
        "curl",
        options.probeImageReference,
        ...curlArguments(`http://127.0.0.1:${String(options.bindings.hostPort)}/health`),
      ],
      timeoutSeconds * 1_000 + INSPECT_TIMEOUT_MS,
    ),
  );
  const sandboxProbe = captureMutation(
    options,
    lease,
    execution,
    [
      "run",
      "--rm",
      "--pull=never",
      "--network",
      gateway.name,
      "--add-host",
      `${ENDPOINT_HOST}:${gateway.gatewayIp}`,
      "--entrypoint",
      "curl",
      options.probeImageReference,
      ...curlArguments(`http://${ENDPOINT_HOST}:${String(options.bindings.hostPort)}/health`),
    ],
    timeoutSeconds * 1_000 + INSPECT_TIMEOUT_MS,
  );
  if (sandboxProbe.error || sandboxProbe.status !== 0) {
    const port = options.bindings.hostPort;
    const subnet = gateway.subnet;
    if (
      !sandboxProbe.error &&
      CURL_CONNECTIVITY_FAILURE_EXIT_CODES.has(sandboxProbe.status) &&
      subnet &&
      !validateUfwRuleOperands(subnet, gateway.gatewayIp, port)
    ) {
      const remediation = formatHostServiceUnreachableMessage(
        {
          ok: false,
          reason: "tcp_failed",
          port,
          networkName: gateway.name,
          subnet,
          gatewayIp: gateway.gatewayIp,
        },
        { serviceLabel: "managed llama.cpp server", port },
      );
      throw new Error(
        [
          "Managed llama.cpp host-loopback health check passed, but the OpenShell Docker bridge health check failed.",
          `    OpenShell Docker network: ${gateway.name}`,
          `    Source subnet: ${subnet}`,
          `    Gateway IP address: ${gateway.gatewayIp}`,
          `    TCP port: ${String(port)}`,
          remediation,
        ].join("\n"),
      );
    }
    requireSuccess("private sandbox bridge probe", sandboxProbe);
  }
  bridge.assertRunning(authority);
  options.journalStore.assertExecution(lease);
}

function rollbackExact(
  options: DockerLlamaCppManagedLifecycleOptions,
  bridge: DockerLlamaCppPrivateBridgeController,
  record: HostLocalCreateJournalRecord,
  lease: HostLocalCreateJournalExecutionLease,
  execution: MutationExecutionState,
  uncertainRecoveryUnixMs?: number,
): void {
  options.journalStore.assertExecution(lease);
  bridge.stopTransaction(record.transactionId);
  options.journalStore.assertExecution(lease);
  if (record.phase === "network-creating") {
    let network = inspectNetworkIfPresent(
      options.engine,
      options.bindings.network.name,
      options.bindings.ownerLabel,
      record.transactionId,
    );
    if (network === null && uncertainRecoveryUnixMs !== undefined) {
      if (
        record.createIntentUnixMs === null ||
        uncertainRecoveryUnixMs < record.createIntentUnixMs ||
        uncertainRecoveryUnixMs - record.createIntentUnixMs < UNCERTAIN_CREATE_ABSENCE_GRACE_MS
      ) {
        throw new Error(
          "Docker llama.cpp uncertain network create remains inside its absence grace period.",
        );
      }
      options.journalStore.assertExecution(lease);
      network = inspectNetworkIfPresent(
        options.engine,
        options.bindings.network.name,
        options.bindings.ownerLabel,
        record.transactionId,
      );
    }
    if (network !== null) {
      requireSuccess(
        "exact network rollback",
        captureMutation(
          options,
          lease,
          execution,
          ["network", "rm", network.id],
          MUTATION_TIMEOUT_MS,
        ),
      );
      if (
        inspectNetworkIfPresent(
          options.engine,
          options.bindings.network.name,
          options.bindings.ownerLabel,
          record.transactionId,
        ) !== null
      ) {
        throw new Error("Docker llama.cpp exact network rollback left the network present.");
      }
    }
    options.journalStore.assertExecution(lease);
    options.journalStore.retire(record.transactionId);
    options.journalStore.assertExecution(lease);
    return;
  }
  const target = record.runtimeId ?? record.containerName;
  let container = inspectContainer(
    options.engine,
    target,
    options.contract,
    options.bindings,
    "cleanup",
  );
  if (container === null && record.phase === "creating" && uncertainRecoveryUnixMs !== undefined) {
    if (
      record.createIntentUnixMs === null ||
      uncertainRecoveryUnixMs < record.createIntentUnixMs ||
      uncertainRecoveryUnixMs - record.createIntentUnixMs < UNCERTAIN_CREATE_ABSENCE_GRACE_MS
    ) {
      throw new Error("Docker llama.cpp uncertain create remains inside its absence grace period.");
    }
    options.journalStore.assertExecution(lease);
    container = inspectContainer(
      options.engine,
      target,
      options.contract,
      options.bindings,
      "cleanup",
    );
  }
  if (container !== null) {
    const owned = requireOwnedContainer(container, options, record);
    requireSuccess(
      "exact rollback",
      captureMutation(options, lease, execution, ["rm", "--force", owned.id], MUTATION_TIMEOUT_MS),
    );
    if (
      inspectContainer(options.engine, owned.id, options.contract, options.bindings, "cleanup") !==
      null
    ) {
      throw new Error("Docker llama.cpp exact rollback left the owned runtime present.");
    }
  }
  const networkId = requireJournalNetworkId(record);
  const network = requireExactNetwork(options, networkId, record.transactionId);
  requireSuccess(
    "exact network rollback",
    captureMutation(options, lease, execution, ["network", "rm", network.id], MUTATION_TIMEOUT_MS),
  );
  if (
    inspectNetworkIfPresent(
      options.engine,
      options.bindings.network.name,
      options.bindings.ownerLabel,
      record.transactionId,
    ) !== null
  ) {
    throw new Error("Docker llama.cpp exact network rollback left the network present.");
  }
  options.journalStore.assertExecution(lease);
  options.journalStore.retire(record.transactionId);
  options.journalStore.assertExecution(lease);
}

function requireJournalNetworkId(record: HostLocalCreateJournalRecord): string {
  if (record.networkId === null) {
    throw new Error("Docker llama.cpp lifecycle journal lacks an exact network identity.");
  }
  return record.networkId;
}

function requireExactNetwork(
  options: DockerLlamaCppManagedLifecycleOptions,
  expectedId: string,
  transactionId: string,
): DockerNetworkAuthority {
  const network = inspectNetwork(
    options.engine,
    options.bindings.network.name,
    options.bindings.ownerLabel,
    transactionId,
  );
  if (network.id !== expectedId) {
    throw new Error("Docker llama.cpp internal network identity changed.");
  }
  return network;
}

function receiptFor(
  options: DockerLlamaCppManagedLifecycleOptions,
  authority: PersistedEngineAuthority,
  journal: HostLocalCreateJournalRecord,
  container: DockerContainerInspection,
): HostLocalInferenceReceipt {
  if (!container.running || container.containerIp === null) {
    throw new Error("Docker llama.cpp cannot publish a receipt for a stopped runtime.");
  }
  return normalizeHostLocalInferenceReceipt({
    schemaVersion: 1,
    providerId: PROVIDER_ID,
    service: SERVICE,
    engineAuthority: authority,
    endpoint: {
      host: ENDPOINT_HOST,
      port: options.bindings.hostPort,
      networkName: options.bindings.network.name,
    },
    runtime: {
      kind: "container",
      runtimeId: container.id,
      name: options.bindings.containerName,
      imageRef: options.bindings.imageReference,
      probeImageRef: options.probeImageReference,
      specSha256: journal.specSha256,
      model: {
        planDigest: options.plan.planDigest,
        recipeId: options.plan.recipeId,
        generation: journal.transactionId,
        digest: options.plan.acquisition.source.file.digest,
        sizeBytes: options.plan.acquisition.source.file.sizeBytes,
      },
      gpu: { vendor: "nvidia", count: 1 },
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function operationTime(dependencies: DockerLlamaCppManagedLifecycleDependencies): number {
  const value = (dependencies.now ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Docker llama.cpp operation clock is invalid.");
  }
  return value;
}

function requireReceiptWriter(
  value: HostLocalInferenceReceiptWriter,
): HostLocalInferenceReceiptWriter {
  const transactionId = value?.transactionId;
  const targetSha256 = value?.targetSha256;
  const writeExact = value?.writeExact;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof transactionId !== "string" ||
    !SHA256.test(transactionId) ||
    typeof targetSha256 !== "string" ||
    !SHA256.test(targetSha256) ||
    typeof writeExact !== "function"
  ) {
    throw new Error("Docker llama.cpp receipt writer authority is malformed.");
  }
  return Object.freeze({
    transactionId,
    targetSha256,
    writeExact: (serializedReceipt: string) => writeExact.call(value, serializedReceipt),
  });
}

function writePreparedReceipt(
  writerValue: HostLocalInferenceReceiptWriter,
  journalValue: HostLocalCreateJournalRecord,
): string {
  const writer = requireReceiptWriter(writerValue);
  const journal = normalizeHostLocalCreateJournalRecord(journalValue);
  if (
    journal.phase !== "receipt-prepared" ||
    journal.serializedReceipt === null ||
    journal.receiptSha256 === null ||
    writer.transactionId !== journal.transactionId ||
    writer.targetSha256 !== journal.receiptTargetSha256
  ) {
    throw new Error("Docker llama.cpp receipt writer differs from prepared publication authority.");
  }
  const committed = writer.writeExact(journal.serializedReceipt);
  if (committed !== journal.serializedReceipt) {
    throw new Error("Docker llama.cpp receipt writer did not acknowledge the exact receipt.");
  }
  return committed;
}

export function createDockerLlamaCppManagedLifecycle(
  options: DockerLlamaCppManagedLifecycleOptions,
  dependencies: DockerLlamaCppManagedLifecycleDependencies = {},
): DockerLlamaCppManagedLifecycle {
  assertLlamaCppGgufCachePlanDigest(options.plan);
  normalizeHostLocalInferenceImageRef(options.probeImageReference);
  readinessTimeoutSeconds(options);
  const qualifiedAuthority = qualifyEngine(options);
  const privateBridge = dependencies.privateBridge ?? createDockerLlamaCppPrivateBridgeController();

  const authorizeStaticReceipt = (value: HostLocalInferenceReceipt) => {
    const receipt = normalizeHostLocalInferenceReceipt(value);
    if (
      receipt.providerId !== PROVIDER_ID ||
      receipt.service !== SERVICE ||
      receipt.runtime.kind !== "container" ||
      receipt.runtime.model === undefined ||
      receipt.engineAuthority.authorityId !== qualifiedAuthority.authorityId
    ) {
      throw new Error("Docker llama.cpp receipt belongs to another lifecycle authority.");
    }
    authorizeEngine(options, qualifiedAuthority, false);
    requirePersistedEngineAuthority(
      receipt.engineAuthority,
      PROVIDER_ID,
      options.engine,
      options.bindingSha256,
    );
    if (
      receipt.runtime.name !== options.bindings.containerName ||
      receipt.runtime.imageRef !== options.bindings.imageReference ||
      receipt.runtime.probeImageRef !== options.probeImageReference ||
      receipt.runtime.model.planDigest !== options.plan.planDigest ||
      receipt.runtime.model.recipeId !== options.plan.recipeId ||
      receipt.runtime.model.digest !== options.plan.acquisition.source.file.digest ||
      receipt.runtime.model.sizeBytes !== options.plan.acquisition.source.file.sizeBytes ||
      receipt.endpoint.host !== ENDPOINT_HOST ||
      receipt.endpoint.networkName !== options.bindings.network.name ||
      receipt.runtime.gpu.vendor !== "nvidia" ||
      !("count" in receipt.runtime.gpu) ||
      receipt.runtime.gpu.count !== 1
    ) {
      throw new Error("Docker llama.cpp receipt differs from current declarative authority.");
    }
    return receipt;
  };

  const authorizeReceipt = (
    value: HostLocalInferenceReceipt,
    requireFinalized: boolean,
  ): {
    readonly receipt: HostLocalInferenceReceipt;
    readonly journal: HostLocalCreateJournalRecord;
  } => {
    const receipt = authorizeStaticReceipt(value);
    if (receipt.runtime.kind !== "container" || receipt.runtime.model === undefined) {
      throw new Error("Docker llama.cpp receipt lacks container model authority.");
    }
    const journal = options.journalStore.load(receipt.runtime.model.generation);
    const expectedSpecSha256 =
      journal === null
        ? null
        : specificationDigest(
            options,
            journal.apiKeyRootIdentitySha256,
            journal.receiptTargetSha256,
          );
    const serializedReceipt = serializeHostLocalInferenceReceipt(receipt);
    const publicationPrepared =
      journal?.phase === "receipt-prepared" || journal?.phase === "finalized";
    if (
      journal === null ||
      journal.providerId !== PROVIDER_ID ||
      journal.service !== SERVICE ||
      journal.containerName !== options.bindings.containerName ||
      journal.runtimeId !== receipt.runtime.runtimeId ||
      journal.specSha256 !== expectedSpecSha256 ||
      journal.specSha256 !== receipt.runtime.specSha256 ||
      JSON.stringify(journal.engineAuthority) !== JSON.stringify(qualifiedAuthority) ||
      !publicationPrepared ||
      journal.serializedReceipt !== serializedReceipt ||
      journal.receiptSha256 !== sha256Text(serializedReceipt) ||
      (requireFinalized && journal.phase !== "finalized") ||
      (journal.phase !== "receipt-prepared" && journal.phase !== "finalized")
    ) {
      throw new Error("Docker llama.cpp receipt does not match its durable create journal.");
    }
    return { receipt, journal };
  };

  const inspectAuthorized = (
    value: HostLocalInferenceReceipt,
    requireFinalized = true,
  ): {
    readonly receipt: HostLocalInferenceReceipt;
    readonly journal: HostLocalCreateJournalRecord;
    readonly container: DockerContainerInspection;
  } => {
    const authorized = authorizeReceipt(value, requireFinalized);
    requireExactNetwork(
      options,
      requireJournalNetworkId(authorized.journal),
      authorized.journal.transactionId,
    );
    if (authorized.receipt.runtime.kind !== "container") {
      throw new Error("Docker llama.cpp receipt is not a container authority.");
    }
    const inspected = inspectContainer(
      options.engine,
      authorized.receipt.runtime.runtimeId,
      options.contract,
      options.bindings,
    );
    if (inspected === null) throw new Error("Docker llama.cpp owned runtime is absent.");
    const container = requireOwnedContainer(inspected, options, authorized.journal);
    if (
      options.bindings.hostPort !== authorized.receipt.endpoint.port ||
      authorized.receipt.endpoint.host !== ENDPOINT_HOST ||
      authorized.receipt.endpoint.networkName !== options.bindings.network.name
    ) {
      throw new Error("Docker llama.cpp endpoint authority changed.");
    }
    return { ...authorized, container };
  };

  const runtime: HostLocalInferenceRuntime = Object.freeze({
    providerId: PROVIDER_ID,
    authorityId: options.engine.authorityId,
    services: Object.freeze([SERVICE] as const),
    translateContainerArgs() {
      throw new Error("Docker llama.cpp translation remains dormant behind its controller.");
    },
    qualifyOllama() {
      throw new Error("Docker llama.cpp does not qualify Ollama routes.");
    },
    startManaged() {
      throw new Error("Docker llama.cpp creation requires its declarative controller.");
    },
    inspectManaged(receipt: HostLocalInferenceReceipt) {
      assertModelFilesystemAuthority(options);
      const activeKeyIdentity = apiKeyIdentity(options);
      const inspected = inspectAuthorized(receipt);
      if (apiKeyIdentitySha256(activeKeyIdentity) !== inspected.journal.apiKeyIdentitySha256) {
        throw new Error("Docker llama.cpp API-key identity differs from its create journal.");
      }
      assertApiKeyFileIdentity(options, activeKeyIdentity);
      assertModelFilesystemAuthority(options);
      if (inspected.container.running) {
        privateBridge.assertRunning(
          privateBridgeAuthority(
            options,
            inspected.journal,
            inspected.container,
            inspectGatewayBridge(options.engine),
          ),
        );
      } else {
        privateBridge.assertStopped(inspected.journal.transactionId);
      }
      return Object.freeze({
        running: inspected.container.running,
        receipt: inspected.receipt,
      });
    },
    stopManaged(receipt: HostLocalInferenceReceipt) {
      const authorized = authorizeReceipt(receipt, true);
      const lease = options.journalStore.acquireExecution(authorized.journal.transactionId);
      const execution: MutationExecutionState = { unknown: false };
      try {
        let inspected = inspectAuthorized(receipt);
        options.journalStore.assertExecution(lease);
        privateBridge.stopTransaction(inspected.journal.transactionId);
        privateBridge.assertStopped(inspected.journal.transactionId);
        options.journalStore.assertExecution(lease);
        if (!inspected.container.running) {
          if (!AT_REST.has(inspected.container.status)) {
            throw new Error("Docker llama.cpp container is not in an exact stoppable state.");
          }
          return Object.freeze({ running: false, receipt: inspected.receipt });
        }
        requireSuccess(
          "container stop",
          captureMutation(
            options,
            lease,
            execution,
            ["stop", "--time", String(STOP_GRACE_SECONDS), inspected.container.id],
            MUTATION_TIMEOUT_MS,
          ),
        );
        inspected = inspectAuthorized(inspected.receipt);
        if (inspected.container.running || !AT_REST.has(inspected.container.status)) {
          throw new Error("Docker llama.cpp stop did not leave the exact runtime at rest.");
        }
        return Object.freeze({ running: false, receipt: inspected.receipt });
      } finally {
        if (!execution.unknown) options.journalStore.releaseExecution(lease);
      }
    },
    preserveForRebuild(receipt: HostLocalInferenceReceipt) {
      const initial = authorizeReceipt(receipt, true);
      const lease = options.journalStore.acquireExecution(initial.journal.transactionId);
      const execution: MutationExecutionState = { unknown: false };
      try {
        const authorized = authorizeReceipt(receipt, true);
        const activeKeyIdentity = apiKeyIdentity(options);
        if (apiKeyIdentitySha256(activeKeyIdentity) !== authorized.journal.apiKeyIdentitySha256) {
          throw new Error("Docker llama.cpp API-key identity differs from its create journal.");
        }
        assertModelFilesystemAuthority(options);
        assertApiKeyFileIdentity(options, activeKeyIdentity);
        const inspected = inspectAuthorized(receipt);
        if (!inspected.container.running) {
          throw new Error("Docker llama.cpp cannot preserve a stopped runtime.");
        }
        probeReady(options, lease, execution);
        probePrivateBridge(
          options,
          privateBridge,
          inspected.journal,
          inspected.container,
          lease,
          execution,
        );
        assertModelFilesystemAuthority(options);
        assertApiKeyFileIdentity(options, activeKeyIdentity);
        requireExactNetwork(
          options,
          requireJournalNetworkId(inspected.journal),
          inspected.journal.transactionId,
        );
        return inspected.receipt;
      } finally {
        if (!execution.unknown) options.journalStore.releaseExecution(lease);
      }
    },
    prepareDestroy(receipt: HostLocalInferenceReceipt) {
      const normalized = authorizeStaticReceipt(receipt);
      if (normalized.runtime.kind !== "container" || normalized.runtime.model === undefined)
        throw new Error("Docker llama.cpp destroy requires container authority.");
      const existing = inspectContainer(
        options.engine,
        normalized.runtime.runtimeId,
        options.contract,
        options.bindings,
      );
      const journal = options.journalStore.load(normalized.runtime.model.generation);
      if (existing !== null || journal !== null) authorizeReceipt(normalized, true);
      if (existing !== null) inspectAuthorized(normalized);
      return normalized;
    },
    destroy(receipt: HostLocalInferenceReceipt) {
      const normalized = authorizeStaticReceipt(receipt);
      if (normalized.runtime.kind !== "container" || normalized.runtime.model === undefined)
        throw new Error("Docker llama.cpp destroy receipt is invalid.");
      const existing = inspectContainer(
        options.engine,
        normalized.runtime.runtimeId,
        options.contract,
        options.bindings,
      );
      if (existing === null) {
        privateBridge.stopTransaction(normalized.runtime.model.generation);
        privateBridge.assertStopped(normalized.runtime.model.generation);
        const journal = options.journalStore.load(normalized.runtime.model.generation);
        if (journal !== null) {
          const lease = options.journalStore.acquireExecution(journal.transactionId);
          try {
            const authorized = authorizeReceipt(normalized, true);
            options.journalStore.assertExecution(lease);
            privateBridge.stopTransaction(authorized.journal.transactionId);
            options.journalStore.assertExecution(lease);
            options.journalStore.retire(authorized.journal.transactionId);
            options.journalStore.assertExecution(lease);
          } finally {
            options.journalStore.releaseExecution(lease);
          }
        }
        return Object.freeze({
          status: "already-absent" as const,
          receipt: normalized,
        });
      }
      const lease = options.journalStore.acquireExecution(normalized.runtime.model.generation);
      const execution: MutationExecutionState = { unknown: false };
      try {
        const inspected = inspectAuthorized(normalized);
        options.journalStore.assertExecution(lease);
        privateBridge.stopTransaction(inspected.journal.transactionId);
        options.journalStore.assertExecution(lease);
        requireSuccess(
          "container removal",
          captureMutation(
            options,
            lease,
            execution,
            ["rm", "--force", inspected.container.id],
            MUTATION_TIMEOUT_MS,
          ),
        );
        if (
          inspectContainer(
            options.engine,
            inspected.container.id,
            options.contract,
            options.bindings,
          ) !== null
        ) {
          throw new Error("Docker llama.cpp removal left the exact runtime present.");
        }
        options.journalStore.assertExecution(lease);
        options.journalStore.retire(inspected.journal.transactionId);
        options.journalStore.assertExecution(lease);
        return Object.freeze({
          status: "removed" as const,
          receipt: inspected.receipt,
        });
      } finally {
        if (!execution.unknown) options.journalStore.releaseExecution(lease);
      }
    },
  });

  return Object.freeze({
    runtime,
    resume(receipt: HostLocalInferenceReceipt) {
      const initial = authorizeReceipt(receipt, true);
      const lease = options.journalStore.acquireExecution(initial.journal.transactionId);
      const execution: MutationExecutionState = { unknown: false };
      try {
        const authorized = authorizeReceipt(receipt, true);
        const activeKeyIdentity = apiKeyIdentity(options);
        if (apiKeyIdentitySha256(activeKeyIdentity) !== authorized.journal.apiKeyIdentitySha256) {
          throw new Error("Docker llama.cpp API-key identity differs from its create journal.");
        }
        assertModelFilesystemAuthority(options);
        assertApiKeyFileIdentity(options, activeKeyIdentity);
        let inspected = inspectAuthorized(receipt);
        if (!inspected.container.running) {
          if (!AT_REST.has(inspected.container.status)) {
            throw new Error("Docker llama.cpp container is not in an exact resumable state.");
          }
          requireSuccess(
            "container resume",
            captureMutation(
              options,
              lease,
              execution,
              ["start", inspected.container.id],
              MUTATION_TIMEOUT_MS,
            ),
          );
          inspected = inspectAuthorized(receipt);
          if (!inspected.container.running) {
            throw new Error("Docker llama.cpp resume did not leave the exact runtime running.");
          }
        }
        probeReady(options, lease, execution);
        probePrivateBridge(
          options,
          privateBridge,
          inspected.journal,
          inspected.container,
          lease,
          execution,
        );
        assertModelFilesystemAuthority(options);
        assertApiKeyFileIdentity(options, activeKeyIdentity);
        requireExactNetwork(
          options,
          requireJournalNetworkId(authorized.journal),
          authorized.journal.transactionId,
        );
        return inspected.receipt;
      } finally {
        if (!execution.unknown) options.journalStore.releaseExecution(lease);
      }
    },
    start(writerValue: HostLocalInferenceReceiptWriter) {
      const writer = requireReceiptWriter(writerValue);
      assertLlamaCppGgufCachePlanDigest(options.plan);
      assertModelFilesystemAuthority(options);
      const startingApiKeyRootIdentitySha256 = apiKeyRootIdentitySha256(options);
      const startingKeyIdentity = apiKeyIdentity(options);
      const authority = authorizeEngine(options, qualifiedAuthority, true);
      const transactionId = writer.transactionId;
      const specSha256 = specificationDigest(
        options,
        startingApiKeyRootIdentitySha256,
        writer.targetSha256,
      );
      const lease = options.journalStore.acquireExecution(transactionId);
      const execution: MutationExecutionState = { unknown: false };
      let journal: HostLocalCreateJournalRecord | null = null;
      let receiptPublicationPossible = false;
      try {
        if (
          inspectContainer(
            options.engine,
            options.bindings.containerName,
            options.contract,
            options.bindings,
          ) !== null
        ) {
          throw new Error("Docker llama.cpp container name is already in use.");
        }
        if (
          inspectNetworkIfPresent(
            options.engine,
            options.bindings.network.name,
            options.bindings.ownerLabel,
          ) !== null
        ) {
          throw new Error("Docker llama.cpp network name is already in use.");
        }
        options.journalStore.assertExecution(lease);
        journal = options.journalStore.create({
          schemaVersion: 1,
          transactionId,
          phase: "network-creating",
          providerId: PROVIDER_ID,
          service: SERVICE,
          containerName: options.bindings.containerName,
          runtimeId: null,
          createIntentUnixMs: operationTime(dependencies),
          specSha256,
          networkId: null,
          engineAuthority: authority,
          apiKeyIdentitySha256: apiKeyIdentitySha256(startingKeyIdentity),
          apiKeyRootIdentitySha256: startingApiKeyRootIdentitySha256,
          receiptTargetSha256: writer.targetSha256,
          serializedReceipt: null,
          receiptSha256: null,
        });
        options.journalStore.assertExecution(lease);
        const createNetwork = captureMutation(
          options,
          lease,
          execution,
          createNetworkArguments(options, transactionId),
          MUTATION_TIMEOUT_MS,
        );
        const network = inspectNetworkIfPresent(
          options.engine,
          options.bindings.network.name,
          options.bindings.ownerLabel,
          transactionId,
        );
        if (createNetwork.error || createNetwork.status !== 0 || network === null) {
          throw new Error(
            `Docker llama.cpp network create failed (exit ${String(createNetwork.status)}).`,
          );
        }
        const networkCreateId = exactId(
          createNetwork.stdout.trim(),
          "Docker network create result",
        );
        if (network.id !== networkCreateId) {
          throw new Error(
            "Docker llama.cpp network create result disagrees with exact name inspection.",
          );
        }
        options.journalStore.assertExecution(lease);
        journal = options.journalStore.recordNetworkCreated(transactionId, network.id);
        options.journalStore.assertExecution(lease);
        requireExactNetwork(options, network.id, transactionId);
        assertModelFilesystemAuthority(options);
        assertApiKeyIdentity(options, startingKeyIdentity, startingApiKeyRootIdentitySha256);
        options.journalStore.assertExecution(lease);
        journal = options.journalStore.recordCreating(transactionId, operationTime(dependencies));
        options.journalStore.assertExecution(lease);
        const create = captureMutation(
          options,
          lease,
          execution,
          createArguments(options, specSha256, transactionId),
          MUTATION_TIMEOUT_MS,
        );
        const created = inspectContainer(
          options.engine,
          options.bindings.containerName,
          options.contract,
          options.bindings,
          "created",
        );
        if (create.error || create.status !== 0 || created === null) {
          throw new Error(
            `Docker llama.cpp container create failed (exit ${String(create.status)}).`,
          );
        }
        const createId = exactId(create.stdout.trim(), "Docker create result");
        if (created.id !== createId) {
          throw new Error("Docker llama.cpp create result disagrees with exact name inspection.");
        }
        requireOwnedContainer(created, options, journal);
        options.journalStore.assertExecution(lease);
        journal = options.journalStore.recordCreated(transactionId, created.id);
        options.journalStore.assertExecution(lease);
        requireExactNetwork(options, network.id, transactionId);
        assertModelFilesystemAuthority(options);
        assertApiKeyIdentity(options, startingKeyIdentity, startingApiKeyRootIdentitySha256);
        requireSuccess(
          "container start",
          captureMutation(options, lease, execution, ["start", created.id], MUTATION_TIMEOUT_MS),
        );
        const started = inspectContainer(
          options.engine,
          created.id,
          options.contract,
          options.bindings,
        );
        if (started === null || !started.running) {
          throw new Error("Docker llama.cpp start did not leave the exact runtime running.");
        }
        requireOwnedContainer(started, options, journal);
        options.journalStore.assertExecution(lease);
        journal = options.journalStore.recordStarted(transactionId);
        options.journalStore.assertExecution(lease);
        assertModelFilesystemAuthority(options);
        assertApiKeyIdentity(options, startingKeyIdentity, startingApiKeyRootIdentitySha256);
        requireExactNetwork(options, network.id, transactionId);
        probeReady(options, lease, execution);
        probePrivateBridge(options, privateBridge, journal, started, lease, execution);
        assertModelFilesystemAuthority(options);
        assertApiKeyIdentity(options, startingKeyIdentity, startingApiKeyRootIdentitySha256);
        requireExactNetwork(options, network.id, transactionId);
        const receipt = receiptFor(options, authority, journal, started);
        const serialized = serializeHostLocalInferenceReceipt(receipt);
        options.journalStore.assertExecution(lease);
        try {
          journal = options.journalStore.prepareReceipt(transactionId, serialized);
          receiptPublicationPossible = true;
        } catch (error) {
          try {
            const persisted = options.journalStore.load(transactionId);
            if (persisted === null) {
              receiptPublicationPossible = true;
            } else {
              journal = normalizeHostLocalCreateJournalRecord(persisted);
              receiptPublicationPossible = journal.phase !== "started";
            }
          } catch {
            receiptPublicationPossible = true;
          }
          throw error;
        }
        options.journalStore.assertExecution(lease);
        writePreparedReceipt(writer, journal);
        options.journalStore.assertExecution(lease);
        journal = options.journalStore.finalize(transactionId);
        options.journalStore.assertExecution(lease);
        return receipt;
      } catch (error) {
        let rollbackFailure: unknown;
        if (
          journal !== null &&
          !receiptPublicationPossible &&
          journal.phase !== "receipt-prepared" &&
          journal.phase !== "finalized" &&
          !execution.unknown
        ) {
          try {
            rollbackExact(options, privateBridge, journal, lease, execution);
          } catch (rollbackError) {
            rollbackFailure = rollbackError;
          }
        }
        if (rollbackFailure !== undefined) {
          throw new Error(
            `${errorMessage(error)} Exact rollback also failed: ${errorMessage(rollbackFailure)}`,
          );
        }
        throw error;
      } finally {
        if (!execution.unknown) options.journalStore.releaseExecution(lease);
      }
    },
    recoverUnfinished(writerValue: HostLocalInferenceReceiptWriter) {
      const writer = requireReceiptWriter(writerValue);
      const recovered: string[] = [];
      const failures: { transactionId: string; message: string }[] = [];
      for (const candidate of options.journalStore.list()) {
        let journal = normalizeHostLocalCreateJournalRecord(candidate);
        if (
          journal.providerId !== PROVIDER_ID ||
          journal.service !== SERVICE ||
          journal.phase === "finalized"
        ) {
          continue;
        }
        let lease: HostLocalCreateJournalExecutionLease | null = null;
        const execution: MutationExecutionState = { unknown: false };
        try {
          lease = options.journalStore.acquireExecution(journal.transactionId);
          const active = options.journalStore.load(journal.transactionId);
          if (active === null) continue;
          journal = normalizeHostLocalCreateJournalRecord(active);
          if (journal.phase === "finalized") continue;
          if (
            journal.phase === "receipt-prepared" &&
            (writer.transactionId !== journal.transactionId ||
              writer.targetSha256 !== journal.receiptTargetSha256)
          ) {
            throw new Error(
              "Docker llama.cpp receipt writer differs from prepared publication authority.",
            );
          }
          const currentAuthority = authorizeEngine(options, qualifiedAuthority, false);
          const journalAuthority = requirePersistedEngineAuthority(
            journal.engineAuthority,
            PROVIDER_ID,
            options.engine,
            options.bindingSha256,
          );
          if (JSON.stringify(journalAuthority) !== JSON.stringify(currentAuthority)) {
            throw new Error("Docker llama.cpp recovery engine authority changed.");
          }
          const expectedSpecSha256 = specificationDigest(
            options,
            journal.apiKeyRootIdentitySha256,
            journal.receiptTargetSha256,
          );
          if (journal.specSha256 !== expectedSpecSha256) {
            throw new Error(
              "Docker llama.cpp recovery journal differs from declarative authority.",
            );
          }
          if (journal.phase !== "network-creating") {
            requireExactNetwork(options, requireJournalNetworkId(journal), journal.transactionId);
          }
          if (journal.phase === "receipt-prepared") {
            if (journal.serializedReceipt === null) {
              throw new Error("Docker llama.cpp prepared receipt is missing.");
            }
            const receipt = parseHostLocalInferenceReceipt(journal.serializedReceipt);
            const activeKeyIdentity = apiKeyIdentity(options);
            if (apiKeyIdentitySha256(activeKeyIdentity) !== journal.apiKeyIdentitySha256) {
              throw new Error("Docker llama.cpp API-key identity differs from its create journal.");
            }
            assertModelFilesystemAuthority(options);
            assertApiKeyFileIdentity(options, activeKeyIdentity);
            const inspected = inspectAuthorized(receipt, false);
            if (!inspected.container.running) {
              throw new Error("Docker llama.cpp receipt publication requires a running runtime.");
            }
            probeReady(options, lease, execution);
            probePrivateBridge(
              options,
              privateBridge,
              journal,
              inspected.container,
              lease,
              execution,
            );
            assertModelFilesystemAuthority(options);
            assertApiKeyFileIdentity(options, activeKeyIdentity);
            requireExactNetwork(options, requireJournalNetworkId(journal), journal.transactionId);
            options.journalStore.assertExecution(lease);
            writePreparedReceipt(writer, journal);
            options.journalStore.assertExecution(lease);
            options.journalStore.finalize(journal.transactionId);
            options.journalStore.assertExecution(lease);
          } else {
            rollbackExact(
              options,
              privateBridge,
              journal,
              lease,
              execution,
              journal.phase === "creating" || journal.phase === "network-creating"
                ? operationTime(dependencies)
                : undefined,
            );
          }
          recovered.push(journal.transactionId);
        } catch (error) {
          failures.push({
            transactionId: journal.transactionId,
            message: errorMessage(error),
          });
        } finally {
          if (lease !== null && !execution.unknown) {
            options.journalStore.releaseExecution(lease);
          }
        }
      }
      return Object.freeze({
        recovered: Object.freeze(recovered),
        failures: Object.freeze(failures),
      });
    },
  });
}
