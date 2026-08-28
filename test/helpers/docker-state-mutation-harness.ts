// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";
import type { ContainerEngineCommandCapture } from "../../src/lib/adapters/container-engine";
import {
  createPodmanContainerEngine,
  type PodmanExecutableAuthorityDeps,
  type PodmanExecutableStat,
  type PodmanSocketAuthority,
} from "../../src/lib/adapters/podman";
import { RUNTIME_PROVIDER_STATE_MUTATION_PLAN_SCHEMA_VERSION } from "../../src/lib/onboard/runtime-provider/contract";
import { createDockerOperationAuthority } from "../../src/lib/onboard/runtime-provider/docker-operation-authority";
import { createContainerStateMutationOwner } from "../../src/lib/onboard/runtime-provider/container-state-mutation";
import {
  createDockerStateMutationOwner,
  DOCKER_STATE_MUTATION_ACTIVATE_TIMEOUT_MS,
} from "../../src/lib/onboard/runtime-provider/docker-state-mutation";
import { createFilePersistedEngineAuthorityStore } from "../../src/lib/onboard/runtime-provider/persisted-engine-authority";
import {
  createFilePersistedEngineLifecycleStore,
  PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
  PERSISTED_ENGINE_STATE_MUTATION_INTENT_FILE,
} from "../../src/lib/onboard/runtime-provider/persisted-engine-lifecycle";
import { prepareRuntimeProviderStateMutationPlan } from "../../src/lib/onboard/runtime-provider/state-mutation";
import type { SandboxEntry } from "../../src/lib/state/registry/types";

export const DOCKER_STATE_MUTATION_RUNTIME_ID = "a".repeat(64);
export const DOCKER_STATE_MUTATION_PROJECTION_SHA256 = "b".repeat(64);
export const DOCKER_STATE_MUTATION_STATE_ROOT = "/sandbox/.hermes";
export const DOCKER_STATE_MUTATION_LIFECYCLE_GENERATION = "generation-7";
const SANDBOX_ID = "sandbox-alpha-id";
const DOCKER_EXECUTABLE_SOURCE = "#!/bin/sh\nexit 1\n";
const PODMAN_EXECUTABLE_BYTES = Buffer.from("qualified-podman-state-mutation", "utf8");
const PODMAN_SOCKET_AUTHORITY = {
  directoryChain: [],
  device: "8",
  inode: "9001",
  mode: "384",
  ownerUid: "1000",
  socketPath: "/run/user/1000/podman/podman.sock",
} as const satisfies PodmanSocketAuthority;
export const DOCKER_STATE_MUTATION_SANDBOX_FINGERPRINT = createHash("sha256")
  .update(SANDBOX_ID)
  .digest("hex");

const roots: string[] = [];

function podmanExecutableAuthorityDeps(): PodmanExecutableAuthorityDeps {
  const executable: PodmanExecutableStat = {
    dev: 8n,
    ino: 42n,
    mode: 0o100755n,
    uid: 0n,
    size: BigInt(PODMAN_EXECUTABLE_BYTES.byteLength),
    mtimeNs: 1000n,
    ctimeNs: 2000n,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const directory: PodmanExecutableStat = {
    ...executable,
    ino: 43n,
    mode: 0o40755n,
    size: 0n,
    isDirectory: () => true,
    isFile: () => false,
  };
  return {
    uid: 1000,
    lstat: (filePath) => (filePath === "/usr/bin/podman" ? executable : directory),
    readFile: () => PODMAN_EXECUTABLE_BYTES,
    realpath: (filePath) => filePath,
  };
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-state-mutation-"));
  roots.push(root);
  return root;
}

function createDockerExecutableSearchPath(root: string): string {
  const directory = path.join(root, "bin");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, "docker"), DOCKER_EXECUTABLE_SOURCE, { mode: 0o700 });
  return directory;
}

export function cleanupDockerStateMutationRoots(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
}

export function persistedDockerStateMutationIntentPath(
  root: string,
  transactionId: string,
): string {
  return path.join(
    root,
    PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
    transactionId,
    PERSISTED_ENGINE_STATE_MUTATION_INTENT_FILE,
  );
}

export function persistedDockerStateMutationRuntimeClaimPath(root: string): string {
  const identity = createHash("sha256")
    .update("docker", "utf8")
    .update("\0", "utf8")
    .update(DOCKER_STATE_MUTATION_RUNTIME_ID, "utf8")
    .digest("hex");
  return path.join(root, PERSISTED_ENGINE_LIFECYCLE_DIRECTORY, "runtime-target-claims", identity);
}

export function dockerStateMutationPlan() {
  return prepareRuntimeProviderStateMutationPlan({
    schemaVersion: RUNTIME_PROVIDER_STATE_MUTATION_PLAN_SCHEMA_VERSION,
    intent: "protection-transition",
    target: "mutable",
    rollback: "locked",
    stateRoot: DOCKER_STATE_MUTATION_STATE_ROOT,
    selectors: [{ kind: "path", path: "config.yaml" }],
    stateLockPlan: {
      version: 1,
      readOnlyRoots: ["config.yaml"],
      confidentialRoots: [],
      readOnlyPrefixes: [],
      confidentialPrefixes: [],
      writableSubpaths: [],
    },
    projectionSha256: DOCKER_STATE_MUTATION_PROJECTION_SHA256,
  });
}

export interface DockerStateMutationHarnessOptions {
  readonly mutateReceipt?: (
    receipt: Readonly<Record<string, unknown>>,
    action: string,
  ) => Readonly<Record<string, unknown>>;
  readonly afterHelper?: (action: string, state: DockerStateMutationHarnessState) => void;
  readonly deferAcquireOnce?: boolean;
  readonly failAcquire?: boolean;
  readonly failReleaseOnce?: boolean;
  readonly failResumeOnce?: boolean;
  readonly lifecycleGeneration?: string;
  readonly loseAcquireResponseOnce?: boolean;
  readonly loseReleaseResponseOnce?: boolean;
  readonly signalHelperOnce?: boolean;
  readonly stateMountType?: "bind" | "volume";
}

export interface DockerStateMutationHarnessState {
  mountDriver: string | null;
  mountName: string | null;
  runtimePid: number;
  mountSource: string;
  mountType: "bind" | "volume";
  sandboxId: string;
  pidMode: string;
  privileged: boolean;
  overlayProc: boolean;
  supervisorStopped: boolean;
}

function createContainerStateMutationHarness(
  providerId: "docker" | "podman",
  options: DockerStateMutationHarnessOptions = {},
) {
  const lifecycleGeneration =
    options.lifecycleGeneration ?? DOCKER_STATE_MUTATION_LIFECYCLE_GENERATION;
  const stateMountType = options.stateMountType ?? "bind";
  const usesManagedVolume = stateMountType === "volume";
  const state: DockerStateMutationHarnessState = {
    mountDriver: usesManagedVolume ? "local" : null,
    mountName: usesManagedVolume ? "nemoclaw-hermes-alpha-state" : null,
    runtimePid: 4812,
    mountSource: usesManagedVolume
      ? "/var/lib/docker/volumes/nemoclaw-hermes-alpha-state/_data"
      : "/var/lib/openshell/alpha/hermes",
    mountType: stateMountType,
    sandboxId: SANDBOX_ID,
    pidMode: "",
    privileged: false,
    overlayProc: false,
    supervisorStopped: false,
  };
  const helperActions: string[] = [];
  const supervisorSignals: string[] = [];
  const acquireRequests: string[] = [];
  const transportCopySourceModes: number[] = [];
  let acquireDeferralsRemaining = options.deferAcquireOnce ? 1 : 0;
  let lostAcquireResponsesRemaining = options.loseAcquireResponseOnce ? 1 : 0;
  let releaseFailuresRemaining = options.failReleaseOnce ? 1 : 0;
  let resumeFailuresRemaining = options.failResumeOnce ? 1 : 0;
  let lostReleaseResponsesRemaining = options.loseReleaseResponseOnce ? 1 : 0;
  let signalledHelpersRemaining = options.signalHelperOnce ? 1 : 0;
  let marker: Record<string, unknown> | null = null;
  let releasedMarker: Record<string, unknown> | null = null;
  let deferredAcquireRequest: string | null = null;
  let brokerActive = false;
  let brokerReleased = false;
  let brokerTransactionId: string | null = null;
  const transportFiles = new Map<string, Buffer>();

  const acquireMarker = (request: Record<string, unknown>) => {
    const candidate = {
      schemaVersion: 1,
      phase: "fenced",
      transactionId: request.transactionId,
      providerId: request.providerId,
      sandboxName: request.sandboxName,
      lifecycleGeneration: request.lifecycleGeneration,
      engineBindingSha256: request.engineBindingSha256,
      runtimeId: request.runtimeId,
      runtimePid: request.runtimePid,
      sandboxIdentitySha256: request.sandboxIdentitySha256,
      containerMountsSha256: request.containerMountsSha256,
      stateRoot: request.stateRoot,
      stateRootMountsSha256: request.stateRootMountsSha256,
      mountNamespace: "mnt:[4026533007]",
      stateRootDevice: "2050",
      stateRootInode: "94212",
      planSha256: request.planSha256,
      projectionSha256: request.projectionSha256,
      nonce: request.nonce,
      target: request.target,
      rollback: request.rollback,
    };
    if (marker !== null && JSON.stringify(marker) !== JSON.stringify(candidate)) {
      return { status: 1, stdout: "", stderr: "conflicting acquire request" };
    }
    marker = candidate;
    return null;
  };

  const capture = vi.fn<ContainerEngineCommandCapture>((_executable, args, _timeout, input) => {
    const commandStart = args.findIndex((value) => value === "ps" || value === "container");
    const command = commandStart < 0 ? [] : args.slice(commandStart);
    if (command[0] === "ps") {
      return { status: 0, stdout: `${DOCKER_STATE_MUTATION_RUNTIME_ID}\n`, stderr: "" };
    }
    if (command[0] === "container" && command[1] === "inspect") {
      return {
        status: 0,
        stdout: JSON.stringify([
          DOCKER_STATE_MUTATION_RUNTIME_ID,
          true,
          "running",
          false,
          false,
          false,
          state.runtimePid,
          "openshell",
          "alpha",
          state.sandboxId,
          state.pidMode,
          state.privileged,
          [
            {
              Type: state.mountType,
              Source: state.mountSource,
              ...(state.mountName === null ? {} : { Name: state.mountName }),
              Destination: DOCKER_STATE_MUTATION_STATE_ROOT,
              ...(state.mountDriver === null ? {} : { Driver: state.mountDriver }),
              Mode: "",
              RW: true,
              Propagation: "rprivate",
            },
            {
              Type: "bind",
              Source: "/var/lib/openshell/alpha/cache",
              Destination: `${DOCKER_STATE_MUTATION_STATE_ROOT}/cache`,
              Mode: "",
              RW: true,
              Propagation: "rprivate",
            },
            ...(state.overlayProc
              ? [
                  {
                    Type: "bind",
                    Source: "/proc",
                    Destination: "/proc",
                    Mode: "",
                    RW: true,
                    Propagation: "rprivate",
                  },
                ]
              : []),
          ],
        ]),
        stderr: "",
      };
    }
    if (command[0] === "container" && command[1] === "kill") {
      if (
        command.length !== 5 ||
        command[2] !== "--signal" ||
        !["SIGSTOP", "SIGCONT"].includes(command[3] ?? "") ||
        command[4] !== DOCKER_STATE_MUTATION_RUNTIME_ID
      ) {
        return { status: 1, stdout: "", stderr: "unauthorized supervisor command" };
      }
      const requestedSignal = command[3] as "SIGSTOP" | "SIGCONT";
      supervisorSignals.push(requestedSignal);
      if (requestedSignal === "SIGCONT" && resumeFailuresRemaining > 0) {
        resumeFailuresRemaining -= 1;
        return { status: 1, stdout: "", stderr: "supervisor resume unavailable" };
      }
      state.supervisorStopped = requestedSignal === "SIGSTOP";
      return { status: 0, stdout: `${DOCKER_STATE_MUTATION_RUNTIME_ID}\n`, stderr: "" };
    }
    if (command[0] === "container" && command[1] === "cp") {
      const source = command[2] ?? "";
      const destination = command[3] ?? "";
      const containerPrefix = `${DOCKER_STATE_MUTATION_RUNTIME_ID}:`;
      if (destination.startsWith(containerPrefix)) {
        const containerPath = destination.slice(containerPrefix.length);
        const descriptor = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let payload: Buffer;
        try {
          transportCopySourceModes.push(fs.fstatSync(descriptor).mode & 0o777);
          payload = fs.readFileSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        transportFiles.set(containerPath, payload);
        if (containerPath.endsWith(".incoming")) {
          const incoming =
            /^([a-f0-9]{64})\.(acquire|assert|publish|recover|rollback|activate|release)\.incoming$/u.exec(
              path.posix.basename(containerPath),
            );
          if (incoming) {
            const [, identity, action] = incoming;
            const request = payload;
            const envelope = JSON.parse(request.toString("utf8")) as { action?: string };
            if (envelope.action === action) {
              transportFiles.delete(containerPath);
              const helperTimeout =
                action === "acquire" || action === "assert"
                  ? 30_000
                  : action === "activate"
                    ? DOCKER_STATE_MUTATION_ACTIVATE_TIMEOUT_MS
                    : action === "release"
                      ? 5 * 60_000
                      : 15 * 60_000;
              let helperResult = capture(
                "docker",
                [
                  "container",
                  "exec",
                  "--nemoclaw-broker",
                  DOCKER_STATE_MUTATION_RUNTIME_ID,
                  "/usr/local/lib/nemoclaw/runtime-state-mutation-control.py",
                  action,
                ],
                helperTimeout,
                request,
              );
              if (helperResult.status !== null && helperResult.status < 0) {
                helperResult = capture(
                  "docker",
                  [
                    "container",
                    "exec",
                    "--nemoclaw-broker",
                    DOCKER_STATE_MUTATION_RUNTIME_ID,
                    "/usr/local/lib/nemoclaw/runtime-state-mutation-control.py",
                    action,
                  ],
                  helperTimeout,
                  request,
                );
              }
              transportFiles.set(
                `${path.posix.dirname(containerPath)}/${identity}.response`,
                Buffer.from(
                  `${JSON.stringify({
                    schemaVersion: 1,
                    action,
                    identity,
                    status: helperResult.status,
                    stdout: helperResult.stdout,
                    stderr: helperResult.stderr,
                  })}\n`,
                  "utf8",
                ),
              );
            }
          }
        } else if (containerPath.endsWith(".ack")) {
          const base = containerPath.slice(0, -4);
          const response = transportFiles.get(`${base}.response`);
          if (response) {
            const parsed = JSON.parse(response.toString("utf8")) as {
              action?: string;
              status?: number;
            };
            if (parsed.action === "release" && parsed.status === 0) brokerReleased = true;
          }
          for (const suffix of [".response", ".ack"]) {
            transportFiles.delete(`${base}${suffix}`);
          }
        } else if (
          containerPath.endsWith("/resumed") &&
          brokerReleased &&
          brokerTransactionId !== null &&
          payload.equals(Buffer.from(`${brokerTransactionId}\n`, "ascii"))
        ) {
          const session = path.posix.dirname(containerPath);
          for (const file of [...transportFiles.keys()]) {
            if (file === session || file.startsWith(`${session}/`)) transportFiles.delete(file);
          }
          brokerActive = false;
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      if (source.startsWith(containerPrefix)) {
        const containerPath = source.slice(containerPrefix.length);
        const payload = transportFiles.get(containerPath);
        if (!payload) return { status: 1, stdout: "", stderr: "transport file unavailable" };
        fs.writeFileSync(destination, payload, { mode: 0o600 });
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unauthorized transport copy" };
    }
    if (command[0] !== "container" || command[1] !== "exec") {
      return { status: 1, stdout: "", stderr: "unexpected command" };
    }
    if (command[2] === "--detach") {
      const transactionId = command.at(-1) ?? "";
      brokerActive = true;
      brokerReleased = false;
      brokerTransactionId = transactionId;
      transportFiles.set(
        `/run/nemoclaw/runtime-state-mutation/${transactionId}/ready`,
        Buffer.from(`${transactionId}\n`, "ascii"),
      );
      return { status: 0, stdout: "", stderr: "" };
    }
    const brokerInvocation = command[2] === "--nemoclaw-broker";
    if (providerId === "docker" && state.supervisorStopped && !brokerInvocation) {
      return { status: 1, stdout: "", stderr: "docker exec blocked after supervisor stop" };
    }
    const action = command.at(-1) ?? "";
    helperActions.push(action);
    const serializedRequest = input?.toString("utf8") ?? "null";
    const request = JSON.parse(serializedRequest) as Record<string, unknown>;
    if (action === "acquire") {
      if (!state.supervisorStopped) {
        return { status: 1, stdout: "", stderr: "supervisor-not-host-stopped" };
      }
      acquireRequests.push(serializedRequest);
      if (options.failAcquire) {
        return { status: 1, stdout: "", stderr: "helper marker unavailable" };
      }
      if (acquireDeferralsRemaining > 0) {
        acquireDeferralsRemaining -= 1;
        deferredAcquireRequest = serializedRequest;
        return { status: 1, stdout: "", stderr: "in-container acquire is still queued" };
      }
      const conflict = acquireMarker(request);
      if (conflict) return conflict;
    } else if (!marker) {
      if (releasedMarker && (action === "recover" || action === "release")) {
        marker = releasedMarker;
      } else {
        return { status: 1, stdout: "", stderr: "no durable marker" };
      }
    } else if (request.providerHandle !== undefined && action !== "recover") {
      const active: Record<string, unknown> = { ...marker, phase: "fenced" };
      delete active.configurationGeneration;
      delete active.listenerIdentity;
      delete active.healthSha256;
      delete active.activationProviderHandle;
      const expected = `${String(active.providerId)}-state-mutation-v1:${String(marker.transactionId)}:${createHash("sha256").update(JSON.stringify(active), "utf8").digest("hex")}`;
      if (request.providerHandle !== expected) {
        return { status: 1, stdout: "", stderr: "provider handle mismatch" };
      }
    }
    const activeMarker = marker as Record<string, unknown>;
    if (action === "publish") {
      marker = { ...activeMarker, phase: "published" };
    } else if (action === "rollback") {
      marker = { ...activeMarker, phase: "rolled-back" };
    } else if (action === "activate") {
      const configurationGeneration = "config-generation-8";
      const listenerIdentity = "tcp:18789";
      const healthSha256 = "c".repeat(64);
      const evidence = {
        schemaVersion: 1,
        providerId: activeMarker.providerId,
        sandboxName: activeMarker.sandboxName,
        lifecycleGeneration: activeMarker.lifecycleGeneration,
        runtimeId: activeMarker.runtimeId,
        nonce: activeMarker.nonce,
        configurationGeneration,
        listenerIdentity,
        healthSha256,
        fenceProviderHandle: request.providerHandle,
      };
      marker = {
        ...activeMarker,
        phase: "activation-proven",
        configurationGeneration,
        listenerIdentity,
        healthSha256,
        activationProviderHandle: `${String(activeMarker.providerId)}-state-mutation-activation-v1:${String(
          activeMarker.transactionId,
        )}:${createHash("sha256").update(JSON.stringify(evidence), "utf8").digest("hex")}`,
      };
    } else if (action === "release") {
      if (releaseFailuresRemaining > 0) {
        releaseFailuresRemaining -= 1;
        return { status: 1, stdout: "", stderr: "release unavailable" };
      }
      if (request.activationProviderHandle !== activeMarker.activationProviderHandle) {
        return { status: 1, stdout: "", stderr: "activation handle mismatch" };
      }
    }
    const response = options.mutateReceipt?.(marker as Record<string, unknown>, action) ?? marker;
    options.afterHelper?.(action, state);
    if (action === "acquire" && lostAcquireResponsesRemaining > 0) {
      lostAcquireResponsesRemaining -= 1;
      return { status: 1, stdout: "", stderr: "acquire response lost" };
    }
    if (action === "release") {
      releasedMarker = marker;
      marker = null;
      if (lostReleaseResponsesRemaining > 0) {
        lostReleaseResponsesRemaining -= 1;
        return { status: 1, stdout: "", stderr: "release response lost" };
      }
    } else if (releasedMarker === marker) {
      marker = null;
    }
    if (signalledHelpersRemaining > 0) {
      signalledHelpersRemaining -= 1;
      return { status: -15, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: `${JSON.stringify(response)}\n`, stderr: "" };
  });
  const root = temporaryRoot();
  const environment =
    providerId === "docker"
      ? {
          HOME: "/tmp/nemoclaw-home",
          DOCKER_CONFIG: "/tmp/nemoclaw-docker",
          DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
          PATH: createDockerExecutableSearchPath(root),
        }
      : { HOME: "/tmp/nemoclaw-home" };
  const dockerAuthority =
    providerId === "docker"
      ? createDockerOperationAuthority("sandbox-lifecycle", environment, capture)
      : undefined;
  const podmanEngine =
    providerId === "podman"
      ? createPodmanContainerEngine({
          operation: "state-mutation",
          socketAuthority: PODMAN_SOCKET_AUTHORITY,
          executable: "/usr/bin/podman",
          capture,
          assertAuthority: vi.fn(),
          executableAuthorityDeps: podmanExecutableAuthorityDeps(),
        })
      : undefined;
  const authority =
    dockerAuthority ??
    Object.freeze({
      assertAuthority: podmanEngine!.assertAuthority,
      engine: podmanEngine!,
    });
  const engineAuthorityStore = createFilePersistedEngineAuthorityStore(root);
  const lifecycleStore = createFilePersistedEngineLifecycleStore(root);
  const ownerOptions = {
    sandboxName: "alpha",
    lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: DOCKER_STATE_MUTATION_SANDBOX_FINGERPRINT,
    runtimeId: DOCKER_STATE_MUTATION_RUNTIME_ID,
    hostTransportRoot: root,
    authority,
    engineAuthorityStore,
    lifecycleStore,
  };
  const owner =
    providerId === "docker"
      ? createDockerStateMutationOwner({ ...ownerOptions, authority: dockerAuthority! })
      : createContainerStateMutationOwner({
          ...ownerOptions,
          providerId,
          providerDisplayName: "Podman",
          engineOperation: "state-mutation",
        });
  const sandbox: SandboxEntry = {
    name: "alpha",
    openshellDriver: providerId,
    lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: DOCKER_STATE_MUTATION_SANDBOX_FINGERPRINT,
  };
  const context = {
    environment,
    sandbox,
    sandboxName: "alpha",
  };
  const replayDeferredAcquire = () => {
    if (deferredAcquireRequest === null) throw new Error("No deferred acquire request exists.");
    const serializedRequest = deferredAcquireRequest;
    deferredAcquireRequest = null;
    helperActions.push("acquire");
    acquireRequests.push(serializedRequest);
    const request = JSON.parse(serializedRequest) as Record<string, unknown>;
    const conflict = acquireMarker(request);
    if (conflict) throw new Error(conflict.stderr);
    return marker;
  };
  return {
    acquireRequests,
    authority,
    capture,
    context,
    engineAuthorityStore,
    helperActions,
    supervisorSignals,
    transportBrokerActive: () => brokerActive,
    transportCopySourceModes,
    lifecycleStore,
    lifecycleGeneration,
    owner,
    replayDeferredAcquire,
    root,
    state,
  };
}

export function createDockerStateMutationHarness(options: DockerStateMutationHarnessOptions = {}) {
  return createContainerStateMutationHarness("docker", options);
}

export function createPodmanStateMutationHarness(options: DockerStateMutationHarnessOptions = {}) {
  return createContainerStateMutationHarness("podman", options);
}

export function createAmbiguousRuntimeCapture(
  runtime: ReturnType<typeof createDockerStateMutationHarness>,
): ReturnType<typeof vi.fn<ContainerEngineCommandCapture>> {
  return vi.fn<ContainerEngineCommandCapture>((executable, args, timeout, input) => {
    if (args.slice(4)[0] === "ps") {
      return {
        status: 0,
        stdout: `${DOCKER_STATE_MUTATION_RUNTIME_ID}\n${"c".repeat(64)}\n`,
        stderr: "",
      };
    }
    return runtime.capture(executable, args, timeout, input);
  });
}

export function createOneTimeAcquireMountDrift(): (
  action: string,
  state: DockerStateMutationHarnessState,
) => void {
  let driftOnce = true;
  return (action, state) => {
    if (action === "acquire" && driftOnce) {
      driftOnce = false;
      state.mountSource = "/var/lib/openshell/replaced/hermes";
    }
  };
}

export function throwBeforeClaimUnlink(
  originalUnlink: typeof fs.unlinkSync,
  claimPath: string,
  target: fs.PathLike,
): void {
  if (String(target) === claimPath) throw new Error("injected exit before claim unlink");
  originalUnlink(target);
}

export function createDurableReceiptUnlinkInterruption(
  originalUnlink: typeof fs.unlinkSync,
  claimPath: string,
  receiptPath: string,
): {
  readonly receiptWasDurable: () => boolean;
  readonly unlink: (target: fs.PathLike) => void;
} {
  let receiptWasDurable = false;
  return {
    receiptWasDurable: () => receiptWasDurable,
    unlink: (target) => {
      if (String(target) === claimPath) {
        receiptWasDurable = fs.existsSync(receiptPath);
        throw new Error("injected exit before claim unlink");
      }
      originalUnlink(target);
    },
  };
}
