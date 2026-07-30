// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import path from "node:path";

import {
  type ManagedDriverGatewayLaunch,
  openManagedDriverGatewayLog,
  spawnDockerDriverGateway,
} from "../../docker-driver-gateway-launch";
import {
  assertTrustedOpenShellGatewayUserServiceInactive,
  captureTrustedOpenShellGatewayUserServiceIfActive,
  hasOpenShellGatewayUserService,
  type OpenShellGatewayUserServiceOptions,
  resumeTrustedOpenShellGatewayUserServiceAndProveActive,
  stopTrustedOpenShellGatewayUserServiceAndProveInactive,
  type TrustedActiveOpenShellGatewayUserServiceIdentity,
} from "../../docker-driver-gateway-service";
import { stopHostGatewayProcesses } from "../../host-gateway-process";
import type { PodmanOpenShellWatcherController } from "./sandbox-recreate";
import {
  createPodmanProductionWatcherController,
  type PodmanProductionWatcherControllerOptions,
} from "./watcher-runtime";

type RuntimeDrift = { readonly reason: string } | null;
type ServiceReceipt = TrustedActiveOpenShellGatewayUserServiceIdentity;

interface SpawnedGateway {
  readonly pid?: number;
  unref(): void;
}

export interface ActivePodmanWatcherInput {
  readonly desiredEnv: Readonly<Record<string, string>>;
  readonly driftGatewayBin: string | null;
  readonly driverLabel: string;
  readonly gatewayBin: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly getRememberedGatewayPid: () => number | null;
  readonly getRuntimeDrift: (
    pid: number,
    desiredEnv: Readonly<Record<string, string>>,
    driftGatewayBin: string | null,
    trustedServicePid: number | null,
  ) => RuntimeDrift;
  readonly isGatewayHealthy: () => boolean;
  readonly isPidAlive: (pid: number) => boolean;
  readonly launch: ManagedDriverGatewayLaunch;
  readonly rememberGatewayPid: (pid: number) => void;
  readonly serviceOptions?: OpenShellGatewayUserServiceOptions;
  readonly stateDir: string;
  readonly deps?: {
    readonly assertServiceInactive?: typeof assertTrustedOpenShellGatewayUserServiceInactive;
    readonly captureService?: typeof captureTrustedOpenShellGatewayUserServiceIfActive;
    readonly hasService?: typeof hasOpenShellGatewayUserService;
    readonly openGatewayLog?: typeof openManagedDriverGatewayLog;
    readonly resumeService?: typeof resumeTrustedOpenShellGatewayUserServiceAndProveActive;
    readonly spawnGateway?: (launch: ManagedDriverGatewayLaunch, logFd: number) => SpawnedGateway;
    readonly stopHostGateways?: typeof stopHostGatewayProcesses;
    readonly stopService?: typeof stopTrustedOpenShellGatewayUserServiceAndProveInactive;
    readonly watcher?: PodmanProductionWatcherControllerOptions<ServiceReceipt>["deps"];
  };
  readonly readiness?: PodmanProductionWatcherControllerOptions<ServiceReceipt>["readiness"];
}

function identityHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sortedEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function serviceOwnerIdentity(receipt: ServiceReceipt): string {
  return receipt.manager === "systemd"
    ? identityHash({
        manager: receipt.manager,
        serviceName: receipt.serviceName,
        unitPath: receipt.unitPath,
      })
    : identityHash({
        formulaName: receipt.formulaName,
        formulaTap: receipt.formulaTap,
        manager: receipt.manager,
        serviceIdentity: receipt.serviceIdentity,
        serviceName: receipt.serviceName,
      });
}

function serviceLaunchIdentity(receipt: ServiceReceipt): string {
  return receipt.manager === "systemd"
    ? identityHash({
        execStart: receipt.execStart,
        execStartPath: receipt.execStartPath,
        manager: receipt.manager,
        processArgv: receipt.processArgv,
        serviceName: receipt.serviceName,
        unitPath: receipt.unitPath,
      })
    : identityHash({
        formulaName: receipt.formulaName,
        formulaTap: receipt.formulaTap,
        manager: receipt.manager,
        processArgv: receipt.processArgv,
        serviceIdentity: receipt.serviceIdentity,
        serviceName: receipt.serviceName,
      });
}

/**
 * Compose the exact gateway owner used by native Podman cutover.
 *
 * Package-managed gateways are stopped and resumed only through their captured
 * service authority. Standalone gateways use the immutable host launch slot.
 * PID and process-generation evidence never enter the stable authority hashes.
 */
export function createActivePodmanWatcherController(
  input: ActivePodmanWatcherInput,
): PodmanOpenShellWatcherController {
  if (input.launch.mode !== "host") {
    throw new Error("Podman watcher requires an exact host gateway launch.");
  }
  const hasService = input.deps?.hasService ?? hasOpenShellGatewayUserService;
  const captureService =
    input.deps?.captureService ?? captureTrustedOpenShellGatewayUserServiceIfActive;
  const assertServiceInactive =
    input.deps?.assertServiceInactive ?? assertTrustedOpenShellGatewayUserServiceInactive;
  const stopService =
    input.deps?.stopService ?? stopTrustedOpenShellGatewayUserServiceAndProveInactive;
  const resumeService =
    input.deps?.resumeService ?? resumeTrustedOpenShellGatewayUserServiceAndProveActive;
  const stopHostGateways = input.deps?.stopHostGateways ?? stopHostGatewayProcesses;
  const openGatewayLog = input.deps?.openGatewayLog ?? openManagedDriverGatewayLog;
  const spawnGateway = input.deps?.spawnGateway ?? spawnDockerDriverGateway;
  const serviceOptions = input.serviceOptions ?? {};
  let trustedServicePid: number | null = null;

  const rememberServicePid = (receipt: ServiceReceipt): ServiceReceipt => {
    trustedServicePid = receipt.pid;
    return receipt;
  };
  const service = {
    captureActive: () => {
      if (!hasService(serviceOptions)) return null;
      const receipt = captureService(serviceOptions);
      return receipt ? rememberServicePid(receipt) : null;
    },
    assertInactive: (receipt: ServiceReceipt) => assertServiceInactive(receipt, serviceOptions),
    stopAndProveInactive: (receipt: ServiceReceipt) => stopService(receipt, serviceOptions),
    resumeAndProve: (receipt: ServiceReceipt) =>
      rememberServicePid(resumeService(receipt, serviceOptions)),
    describe: (receipt: ServiceReceipt) => ({
      launchIdentity: serviceLaunchIdentity(receipt),
      ownerIdentity: serviceOwnerIdentity(receipt),
      pid: receipt.pid,
      processStartIdentity: receipt.processStartIdentity,
    }),
  };
  const launchIdentity = identityHash({
    args: input.launch.args,
    argv0: input.launch.argv0 ?? null,
    command: input.launch.command,
    desiredEnv: sortedEnvironment(input.desiredEnv),
  });
  const ownerIdentity = identityHash({
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
    stateDir: input.stateDir,
  });

  return createPodmanProductionWatcherController({
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
    getRuntimeDrift: (pid) =>
      input.getRuntimeDrift(pid, input.desiredEnv, input.driftGatewayBin, trustedServicePid),
    isGatewayHealthy: input.isGatewayHealthy,
    service,
    standalone: {
      launchIdentity,
      ownerIdentity,
      readOwnedPid: input.getRememberedGatewayPid,
      stop: (pid) => {
        const result = stopHostGateways(
          {},
          {
            clearRuntimeFiles: false,
            gatewayBin: input.gatewayBin,
            openShellGatewayName: input.gatewayName,
            openShellGatewayPort: input.gatewayPort,
            pids: [pid],
            stateDir: input.stateDir,
            usePidFile: false,
            usePgrepFallback: false,
          },
        );
        if (
          result.failed.length > 0 ||
          result.skippedNonMatchingPids.length > 0 ||
          (result.stopped.length === 0 && input.isPidAlive(pid))
        ) {
          throw new Error("Stopping the exact standalone Podman gateway watcher failed.");
        }
      },
      resume: () => {
        const logFd = openGatewayLog(path.join(input.stateDir, "openshell-gateway.log"), {
          driverLabel: input.driverLabel,
        });
        const child = spawnGateway(input.launch, logFd);
        child.unref();
        const pid = child.pid ?? 0;
        if (pid <= 0) {
          throw new Error("Resuming the standalone Podman gateway watcher returned no PID.");
        }
        input.rememberGatewayPid(pid);
        return pid;
      },
    },
    deps: input.deps?.watcher,
    readiness: input.readiness,
  });
}
