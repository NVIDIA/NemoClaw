// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";

import { captureLinuxHostProcessIdentity } from "../host-process-identity";
import {
  createPodmanManagedGatewayWatcherController,
  type PodmanGatewayWatcherSnapshot,
  type PodmanManagedGatewayWatcherControllerDeps,
} from "./watcher-controller";

const PORT_SCAN_TIMEOUT_MS = 5_000;

interface CommandResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly stderr?: Buffer | string | null;
  readonly stdout?: Buffer | string | null;
}

export type RunPodmanWatcherRuntimeCommand = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => CommandResult;

export interface PodmanManagedServiceWatcherDescriptor {
  readonly launchIdentity: string;
  readonly ownerIdentity: string;
  readonly pid: number;
  readonly processStartIdentity: string;
}

export interface PodmanManagedServiceWatcherLifecycle<TReceipt> {
  assertInactive(receipt: TReceipt): void;
  captureActive(): TReceipt | null;
  describe(receipt: TReceipt): PodmanManagedServiceWatcherDescriptor;
  resumeAndProve(receipt: TReceipt): TReceipt;
  stopAndProveInactive(receipt: TReceipt): void;
}

export interface PodmanStandaloneWatcherLifecycle {
  readonly launchIdentity: string;
  readonly ownerIdentity: string;
  readOwnedPid(): number | null;
  resume(): number;
  stop(pid: number): void;
}

export interface PodmanProductionWatcherControllerOptions<TServiceReceipt> {
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly getRuntimeDrift: (pid: number) => { readonly reason: string } | null;
  readonly isGatewayHealthy: () => boolean;
  readonly service?: PodmanManagedServiceWatcherLifecycle<TServiceReceipt>;
  readonly standalone: PodmanStandaloneWatcherLifecycle;
  readonly deps?: {
    readonly captureListenerPids?: (port: number) => readonly number[];
    readonly captureProcessStartIdentity?: (pid: number) => string | null;
    readonly run?: RunPodmanWatcherRuntimeCommand;
  };
  readonly readiness?: Pick<
    PodmanManagedGatewayWatcherControllerDeps,
    "now" | "resumePollIntervalMs" | "resumeTimeoutMs" | "sleep"
  >;
}

function output(value: Buffer | string | null | undefined): string {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

function defaultRun(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
): CommandResult {
  return spawnSync(command, [...args], options);
}

function parseListenerPids(text: string): number[] {
  const pids = text
    .split(/\r?\n/u)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  return [...new Set(pids)].sort((left, right) => left - right);
}

function proveIpv4PortFree(port: number, run: RunPodmanWatcherRuntimeCommand): boolean {
  const script =
    "const net=require('node:net');const s=net.createServer();s.unref();" +
    "s.once('error',()=>process.exit(1));" +
    "s.listen({host:'0.0.0.0',port:Number(process.argv[1])}," +
    "()=>s.close(()=>process.exit(0)));";
  const result = run(process.execPath, ["-e", script, String(port)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PORT_SCAN_TIMEOUT_MS,
  });
  return result.status === 0;
}

/**
 * Complete synchronous listener proof for the create-stream polling boundary.
 * An empty lsof result is accepted only when an independent wildcard bind also
 * proves the target port is free.
 */
export function capturePodmanGatewayListenerPids(
  port: number,
  deps: { readonly run?: RunPodmanWatcherRuntimeCommand } = {},
): readonly number[] {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Podman watcher listener scan requires a valid gateway port.");
  }
  const run = deps.run ?? defaultRun;
  const result = run("lsof", ["-nP", "-tiTCP:" + String(port), "-sTCP:LISTEN"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PORT_SCAN_TIMEOUT_MS,
  });
  if (result.status === 0) {
    const pids = parseListenerPids(output(result.stdout));
    if (pids.length > 0) return pids;
    throw new Error("Podman watcher listener scan returned success without a process ID.");
  }
  if (result.status === 1 && proveIpv4PortFree(port, run)) return [];
  const detail = `${output(result.stderr)} ${result.error?.message ?? ""}`.trim();
  throw new Error(
    `Podman watcher could not completely enumerate gateway port ${String(port)}${
      detail ? `: ${detail}` : "."
    }`,
  );
}

/**
 * Capture Linux `/proc/<pid>/stat` field 22 while handling spaces and closing
 * parentheses in the process name. Two identical samples exclude a PID reuse
 * race across the read boundary.
 */
export function captureLinuxProcessStartIdentity(pid: number): string | null {
  return process.platform === "linux"
    ? (captureLinuxHostProcessIdentity(pid)?.startIdentity ?? null)
    : null;
}

function exactStartIdentity(pid: number, capture: (pid: number) => string | null): string {
  const identity = capture(pid);
  if (!identity) {
    throw new Error(
      `Podman watcher could not prove the process-start identity for PID ${String(pid)}.`,
    );
  }
  return identity;
}

function sameDescriptor(
  left: Pick<PodmanManagedServiceWatcherDescriptor, "launchIdentity" | "ownerIdentity">,
  right: Pick<PodmanManagedServiceWatcherDescriptor, "launchIdentity" | "ownerIdentity">,
): boolean {
  return left.launchIdentity === right.launchIdentity && left.ownerIdentity === right.ownerIdentity;
}

/**
 * Bind the strict watcher lease to either the installed package service or the
 * exact standalone launch slot NemoClaw owns.
 */
export function createPodmanProductionWatcherController<TServiceReceipt>(
  options: PodmanProductionWatcherControllerOptions<TServiceReceipt>,
) {
  const captureListeners =
    options.deps?.captureListenerPids ??
    ((port: number) => capturePodmanGatewayListenerPids(port, options.deps));
  const captureStart =
    options.deps?.captureProcessStartIdentity ?? captureLinuxProcessStartIdentity;
  const target = { gatewayName: options.gatewayName, gatewayPort: options.gatewayPort };
  const serviceLifecycle = options.service ?? null;
  let serviceReceipt: TServiceReceipt | null = null;
  let serviceDescriptor: PodmanManagedServiceWatcherDescriptor | null = null;
  let selectedOwner: "managed-service" | "standalone" | null = null;
  let ownerStopped = false;

  const assertRuntime = (pid: number): void => {
    const drift = options.getRuntimeDrift(pid);
    if (drift) {
      throw new Error(`Podman watcher runtime identity drifted: ${drift.reason}`);
    }
  };

  const snapshot = (
    pid: number,
    ownerKind: PodmanGatewayWatcherSnapshot["ownerKind"],
    ownerIdentity: string,
    launchIdentity: string,
    expectedStartIdentity?: string,
  ): PodmanGatewayWatcherSnapshot => {
    assertRuntime(pid);
    const processStartIdentity = exactStartIdentity(pid, captureStart);
    if (expectedStartIdentity !== undefined && processStartIdentity !== expectedStartIdentity) {
      throw new Error("Podman watcher process-start identity changed during capture.");
    }
    return {
      ...target,
      launchIdentity,
      ownerIdentity,
      ownerKind,
      pid,
      processStartIdentity,
    };
  };

  const requireOneListener = (): number => {
    const pids = captureListeners(options.gatewayPort);
    if (pids.length !== 1) {
      throw new Error(
        `Podman watcher requires exactly one gateway listener; found ${String(pids.length)}.`,
      );
    }
    return pids[0] as number;
  };

  const captureService = (
    receipt: TServiceReceipt,
    listenerPid: number,
  ): PodmanGatewayWatcherSnapshot => {
    if (!serviceLifecycle) throw new Error("Podman watcher service lifecycle is unavailable.");
    if (options.standalone.readOwnedPid() !== null) {
      throw new Error(
        "Podman watcher found both package-service and standalone lifecycle receipts.",
      );
    }
    const descriptor = serviceLifecycle.describe(receipt);
    if (listenerPid !== descriptor.pid) {
      throw new Error("Podman watcher package service does not own the exact gateway listener.");
    }
    const current = snapshot(
      descriptor.pid,
      "managed-service",
      descriptor.ownerIdentity,
      descriptor.launchIdentity,
      descriptor.processStartIdentity,
    );
    serviceReceipt = receipt;
    serviceDescriptor = descriptor;
    selectedOwner = "managed-service";
    return current;
  };

  const captureStandalone = (listenerPid: number): PodmanGatewayWatcherSnapshot => {
    selectedOwner = "standalone";
    return snapshot(
      listenerPid,
      "standalone",
      options.standalone.ownerIdentity,
      options.standalone.launchIdentity,
    );
  };

  const captureCurrent = (): PodmanGatewayWatcherSnapshot => {
    const listenerPid = requireOneListener();
    const receipt = serviceLifecycle?.captureActive() ?? null;
    if (receipt) return captureService(receipt, listenerPid);
    const standalonePid = options.standalone.readOwnedPid();
    if (standalonePid !== null) {
      if (standalonePid !== listenerPid) {
        throw new Error("Podman watcher standalone PID receipt does not own the exact listener.");
      }
      return captureStandalone(listenerPid);
    }
    throw new Error("Podman watcher could not prove a lifecycle owner for the exact listener.");
  };

  const listCurrent = (): readonly PodmanGatewayWatcherSnapshot[] => {
    const pids = captureListeners(options.gatewayPort);
    if (ownerStopped) {
      if (selectedOwner === "managed-service" && serviceLifecycle && serviceReceipt) {
        serviceLifecycle.assertInactive(serviceReceipt);
      }
      if (pids.length !== 0) {
        throw new Error("A gateway listener appeared while the Podman watcher owner was stopped.");
      }
      return [];
    }
    if (pids.length === 0) return [];
    if (pids.length !== 1) {
      throw new Error("Podman watcher observed multiple target-bound gateway listeners.");
    }
    if (selectedOwner === null) {
      throw new Error("Podman watcher lifecycle owner was not captured.");
    }
    if (selectedOwner === "standalone") {
      if (options.standalone.readOwnedPid() !== pids[0]) {
        throw new Error("Podman watcher standalone PID receipt drifted.");
      }
      return [
        snapshot(
          pids[0] as number,
          "standalone",
          options.standalone.ownerIdentity,
          options.standalone.launchIdentity,
        ),
      ];
    }
    if (!serviceLifecycle) {
      throw new Error("Podman watcher service lifecycle is unavailable.");
    }
    const receipt = serviceLifecycle.captureActive();
    if (!receipt) {
      throw new Error("Podman watcher package service became inactive before cutover.");
    }
    const descriptor = serviceLifecycle.describe(receipt);
    if (
      !serviceDescriptor ||
      !sameDescriptor(serviceDescriptor, descriptor) ||
      descriptor.pid !== pids[0]
    ) {
      throw new Error("Podman watcher package-service launch authority drifted.");
    }
    serviceReceipt = receipt;
    return [
      snapshot(
        descriptor.pid,
        "managed-service",
        descriptor.ownerIdentity,
        descriptor.launchIdentity,
        descriptor.processStartIdentity,
      ),
    ];
  };

  return createPodmanManagedGatewayWatcherController({
    captureCurrent,
    listTargetWatchers: () => listCurrent(),
    isProcessInstanceAlive: (receipt) => {
      const current = captureStart(receipt.pid);
      return current !== null && current === receipt.processStartIdentity;
    },
    isOwnerStopped: () => {
      if (!ownerStopped) return false;
      if (selectedOwner === "managed-service" && serviceLifecycle && serviceReceipt) {
        serviceLifecycle.assertInactive(serviceReceipt);
      }
      return true;
    },
    stopExactOwner: (receipt) => {
      if (selectedOwner === "managed-service") {
        if (!serviceLifecycle || !serviceReceipt) {
          throw new Error("Podman watcher service receipt is missing.");
        }
        try {
          serviceLifecycle.stopAndProveInactive(serviceReceipt);
          ownerStopped = true;
        } catch (error) {
          try {
            serviceLifecycle.assertInactive(serviceReceipt);
            ownerStopped = true;
          } catch {
            ownerStopped = false;
          }
          throw error;
        }
        return;
      }
      options.standalone.stop(receipt.pid);
      if (
        captureStart(receipt.pid) !== null ||
        captureListeners(options.gatewayPort).length !== 0
      ) {
        throw new Error("Podman watcher standalone process stop could not be proven.");
      }
      ownerStopped = true;
    },
    resumeSameOwner: () => {
      if (!ownerStopped) {
        throw new Error("Podman watcher lifecycle owner is not proven stopped.");
      }
      if (captureListeners(options.gatewayPort).length !== 0) {
        throw new Error("Podman watcher target listener appeared before resume.");
      }
      if (selectedOwner === "managed-service") {
        if (!serviceLifecycle || !serviceReceipt || !serviceDescriptor) {
          throw new Error("Podman watcher service receipt is missing.");
        }
        const resumed = serviceLifecycle.resumeAndProve(serviceReceipt);
        const resumedDescriptor = serviceLifecycle.describe(resumed);
        if (!sameDescriptor(serviceDescriptor, resumedDescriptor)) {
          throw new Error("Resumed Podman watcher service launch authority drifted.");
        }
        serviceReceipt = resumed;
      } else {
        const pid = options.standalone.resume();
        exactStartIdentity(pid, captureStart);
      }
      ownerStopped = false;
    },
    isHealthy: (receipt) => {
      const current = captureStart(receipt.pid);
      if (current !== receipt.processStartIdentity) return false;
      assertRuntime(receipt.pid);
      return options.isGatewayHealthy();
    },
    ...options.readiness,
  });
}
