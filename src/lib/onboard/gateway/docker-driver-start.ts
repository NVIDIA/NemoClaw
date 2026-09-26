// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildSelectedOpenShellSubprocessEnv,
  type OpenShellRuntimeSelection,
} from "../../adapters/openshell/command-argv";
import { gatewayHostRuntimeEnvironment } from "../runtime-provider/configured-runtime";
import { trackChildExit } from "../child-exit-tracker";
import * as dockerDriverGatewayCutover from "../docker-driver-gateway-cutover";
import { reportDockerDriverGatewayStartFailure } from "../docker-driver-gateway-failure";
import * as dockerDriverGatewayLaunch from "../docker-driver-gateway-launch";
import {
  reapDuplicateHostGatewaysExceptOrFail,
  reapHostGatewayBeforeLaunchOrFail,
} from "../docker-driver-gateway-prelaunch";
import { waitForStandaloneDockerDriverGateway } from "../docker-driver-gateway-readiness";
import * as dockerDriverGatewayRuntimeMarker from "../docker-driver-gateway-runtime-marker";
import {
  createDockerDriverGatewayStateOwnership,
  type DockerDriverGatewayStateOwnership,
} from "./state-ownership";
import {
  getTrustedActiveOpenShellGatewayUserServiceStopTarget,
  type TrustedActiveOpenShellGatewayUserServiceStopTarget,
} from "../docker-driver-gateway-service";
import * as gatewayStateLifecycleLock from "./state-lifecycle-lock";
import { formatGatewayHealthWaitLimit } from "../gateway-health-wait";
import { verifySandboxBridgeGatewayReachableOrExit } from "../gateway-sandbox-reachability";
import type { GatewayRecoveryOutput } from "../gateway-recovery";

type GatewayRuntimeHelpers = ReturnType<
  typeof import("../docker-driver-gateway-runtime").createDockerDriverGatewayRuntimeHelpers
>;
type DynamicGatewayHelpers = ReturnType<
  typeof import("../gateway-binding").createDynamicGatewayRuntimeHelpers
>;

export interface DockerDriverGatewayStartDeps {
  observer: import("../../adapters/openshell/gateway-reuse").OpenShellGatewayReuseObserver;
  SUPPORTED_OPENSHELL_FALLBACK_VERSION: string;
  checkGatewayPortAvailable(): Promise<import("../preflight").PortProbeResult>;
  clearDockerDriverGatewayRuntimeFiles: GatewayRuntimeHelpers["clearDockerDriverGatewayRuntimeFiles"];
  createGatewayServicePortOwnership: GatewayRuntimeHelpers["createGatewayServicePortOwnership"];
  dockerDriverGatewayEnv: typeof import("../docker-driver-gateway-env");
  envInt: typeof import("../env").envInt;
  gatewayBinding: typeof import("../gateway-binding");
  gatewayName(): string;
  gatewayPort(): number;
  getDockerDriverGatewayEndpoint: DynamicGatewayHelpers["getDockerDriverGatewayEndpoint"];
  getDockerDriverGatewayEnv: GatewayRuntimeHelpers["getDockerDriverGatewayEnv"];
  getDockerDriverGatewayPid: GatewayRuntimeHelpers["getDockerDriverGatewayPid"];
  getDockerDriverGatewayPortListenerScan: GatewayRuntimeHelpers["getDockerDriverGatewayPortListenerScan"];
  getDockerDriverGatewayRuntimeDrift: GatewayRuntimeHelpers["getDockerDriverGatewayRuntimeDrift"];
  getDockerDriverGatewayStateDir: GatewayRuntimeHelpers["getDockerDriverGatewayStateDir"];
  getGatewayPortListenerRawScan: GatewayRuntimeHelpers["getGatewayPortListenerRawScan"];
  getTrustedActiveOpenShellGatewayUserServiceStopTarget?: typeof getTrustedActiveOpenShellGatewayUserServiceStopTarget;
  getInstalledOpenshellVersion: typeof import("../openshell-version").getInstalledOpenshellVersion;
  isDockerDriverGatewayHttpReady: DynamicGatewayHelpers["isDockerDriverGatewayHttpReady"];
  isDockerDriverGatewayProcess: GatewayRuntimeHelpers["isDockerDriverGatewayProcess"];
  isDockerDriverGatewayProcessAlive: GatewayRuntimeHelpers["isDockerDriverGatewayProcessAlive"];
  isGatewayTcpReady: DynamicGatewayHelpers["isGatewayTcpReady"];
  isPidAlive: GatewayRuntimeHelpers["isPidAlive"];
  logDockerDriverGatewayRestart(reason: string): void;
  registerDockerDriverGatewayEndpoint(
    runtimeSelection?: OpenShellRuntimeSelection,
  ): Promise<boolean>;
  rememberDockerDriverGatewayPid: GatewayRuntimeHelpers["rememberDockerDriverGatewayPid"];
  resolveOpenShellGatewayBinary: GatewayRuntimeHelpers["resolveOpenShellGatewayBinary"];
  resolveOpenShellSandboxBinary: GatewayRuntimeHelpers["resolveOpenShellSandboxBinary"];
  runner: Pick<typeof import("../../runner"), "runCapture" | "runCaptureEx">;
  runCaptureOpenshell(
    args: string[],
    options?: {
      env?: Record<string, string>;
      ignoreError?: boolean;
      replaceEnv?: boolean;
    },
  ): string;
  sleepSeconds: typeof import("../../core/wait").sleepSeconds;
  verifySandboxBridgeGatewayReachableOrExit?: typeof verifySandboxBridgeGatewayReachableOrExit;
}

export interface DockerDriverGatewayStart {
  startDockerDriverGateway(options?: {
    exitOnFailure?: boolean;
    output?: GatewayRecoveryOutput;
    runtimeSelection?: OpenShellRuntimeSelection;
    skipSandboxBridgeReachability?: boolean;
  }): Promise<void>;
  verifyDockerDriverGatewaySandboxReachability(options: {
    exitOnFailure: boolean;
    skipSandboxBridgeReachability: boolean;
  }): Promise<void>;
}

export function resolveDockerDriverGatewayRuntimeMarkerEndpoint(
  desiredEnv: Readonly<Record<string, string>>,
  fallback: () => string,
): string {
  return desiredEnv.OPENSHELL_GRPC_ENDPOINT?.trim() || fallback();
}

function gatewayServiceStopTargetsMatch(
  first: TrustedActiveOpenShellGatewayUserServiceStopTarget,
  second: TrustedActiveOpenShellGatewayUserServiceStopTarget | null,
): boolean {
  return (
    second !== null &&
    second.pid === first.pid &&
    second.executablePath === first.executablePath &&
    second.stopCommand === first.stopCommand
  );
}

/** Return a stop command only when one stable service owns the selected port and state. */
export async function resolveSelectedGatewayServiceStopCommand(
  deps: Pick<
    DockerDriverGatewayStartDeps,
    | "checkGatewayPortAvailable"
    | "getGatewayPortListenerRawScan"
    | "getTrustedActiveOpenShellGatewayUserServiceStopTarget"
  > &
    Pick<DockerDriverGatewayStateOwnership, "isDockerDriverGatewayPidUsingSelectedState">,
): Promise<string | null> {
  const resolveServiceTarget =
    deps.getTrustedActiveOpenShellGatewayUserServiceStopTarget ??
    getTrustedActiveOpenShellGatewayUserServiceStopTarget;
  try {
    const serviceBefore = resolveServiceTarget();
    if (!serviceBefore) return null;
    const listenerScan = deps.getGatewayPortListenerRawScan(await deps.checkGatewayPortAvailable());
    if (
      !listenerScan.complete ||
      listenerScan.pids.length !== 1 ||
      listenerScan.pids[0] !== serviceBefore.pid ||
      !deps.isDockerDriverGatewayPidUsingSelectedState(serviceBefore.pid)
    ) {
      return null;
    }
    const serviceAfter = resolveServiceTarget();
    return gatewayServiceStopTargetsMatch(serviceBefore, serviceAfter)
      ? serviceBefore.stopCommand
      : null;
  } catch {
    return null;
  }
}

export function createDockerDriverGatewayStart(
  deps: DockerDriverGatewayStartDeps,
): DockerDriverGatewayStart {
  const verifyReachability =
    deps.verifySandboxBridgeGatewayReachableOrExit ?? verifySandboxBridgeGatewayReachableOrExit;

  async function verifyDockerDriverGatewaySandboxReachability({
    exitOnFailure,
    skipSandboxBridgeReachability,
  }: {
    exitOnFailure: boolean;
    skipSandboxBridgeReachability: boolean;
  }): Promise<void> {
    await verifyReachability(exitOnFailure, {
      port: deps.gatewayPort(),
      skip: skipSandboxBridgeReachability,
    });
  }
  const stateOwnership = createDockerDriverGatewayStateOwnership({
    getDockerDriverGatewayStateDir: deps.getDockerDriverGatewayStateDir,
    isDockerDriverGatewayProcess: deps.isDockerDriverGatewayProcess,
    isPidAlive: deps.isPidAlive,
    resolveOpenShellGatewayBinary: deps.resolveOpenShellGatewayBinary,
    runCapture: deps.runner.runCapture,
    runCaptureEx: deps.runner.runCaptureEx,
  });

  async function startDockerDriverGateway({
    exitOnFailure = true,
    output,
    runtimeSelection,
    skipSandboxBridgeReachability = false,
  }: {
    exitOnFailure?: boolean;
    output?: GatewayRecoveryOutput;
    runtimeSelection?: OpenShellRuntimeSelection;
    skipSandboxBridgeReachability?: boolean;
  } = {}): Promise<void> {
    if (runtimeSelection && runtimeSelection.gatewayName !== deps.gatewayName()) {
      throw new Error(
        `Docker-driver gateway target '${deps.gatewayName()}' does not match runtime selection '${runtimeSelection.gatewayName}'`,
      );
    }
    const selectedRuntimeEnv = runtimeSelection
      ? {
          ...buildSelectedOpenShellSubprocessEnv(runtimeSelection),
          ...gatewayHostRuntimeEnvironment(process.env),
        }
      : undefined;
    const runtimeOptions = selectedRuntimeEnv
      ? {
          env: selectedRuntimeEnv,
          replaceEnv: true,
        }
      : {};
    const runCaptureOpenshell: DockerDriverGatewayStartDeps["runCaptureOpenshell"] = (
      args,
      options = {},
    ) => deps.runCaptureOpenshell(args, { ...options, ...runtimeOptions });
    let registrationAttempt: Promise<boolean> | undefined;
    const registerDockerDriverGatewayEndpoint = () =>
      (registrationAttempt ??= deps.registerDockerDriverGatewayEndpoint(runtimeSelection));
    const observer = {
      observeGatewayReuse: (request: Parameters<typeof deps.observer.observeGatewayReuse>[0]) =>
        deps.observer.observeGatewayReuse({ ...request, runtimeSelection }),
    };
    const stateDir = deps.gatewayBinding.resolveGatewayStateDirForPort({
      configured: process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
      home: os.homedir(),
      port: deps.gatewayPort(),
    });
    const configuredStateDir = process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR?.trim();
    const stateLifecycleLock = configuredStateDir
      ? gatewayStateLifecycleLock.acquireManagedGatewayStateLifecycleLock(stateDir)
      : null;
    try {
      if (configuredStateDir) {
        deps.gatewayBinding.ensureManagedGatewayStateRoot(
          {
            gatewayName: deps.gatewayName(),
            gatewayPort: deps.gatewayPort(),
            stateDir,
          },
          {
            isLegacyManagedState: () =>
              dockerDriverGatewayLaunch.hasStateScopedSandboxNamespace(stateDir),
          },
        );
      }
      const gatewayBin = deps.resolveOpenShellGatewayBinary();
      const openshellVersionOutput = runCaptureOpenshell(["--version"], { ignoreError: true });
      const gatewayEnv = deps.getDockerDriverGatewayEnv(openshellVersionOutput);
      const runtimeIdentity = gatewayBin
        ? dockerDriverGatewayLaunch.buildDockerDriverGatewayRuntimeIdentity({
            gatewayBin,
            gatewayEnv,
            stateDir,
            sandboxBin: deps.resolveOpenShellSandboxBinary(),
            gatewayName: deps.gatewayName(),
            compatContainerName: deps.gatewayBinding.resolveGatewayCompatContainerName(
              deps.gatewayPort(),
            ),
            ...(selectedRuntimeEnv ? { env: selectedRuntimeEnv } : {}),
            ensureLocalTlsBundle: true,
          })
        : null;
      const gatewayLaunch = runtimeIdentity?.launch ?? null;
      const driftGatewayBin = dockerDriverGatewayLaunch.resolveDriftGatewayBin(
        runtimeIdentity,
        gatewayBin,
      );
      const driftGatewayEnv = runtimeIdentity?.desiredEnv ?? gatewayEnv;
      const identityGatewayBin = runtimeIdentity?.identityGatewayBin ?? gatewayBin;
      const initialPortCheck = await deps.checkGatewayPortAvailable();
      const servicePortOwnership = deps.createGatewayServicePortOwnership(initialPortCheck, {
        exitOnFailure,
        gatewayBin: identityGatewayBin,
        preparePort: (extraPids: number[]) =>
          reapHostGatewayBeforeLaunchOrFail({
            stateDir,
            gatewayBin: identityGatewayBin,
            extraPids,
            exitOnFailure,
            ...(output ? { printError: output.error } : {}),
          }),
      });
      const cutover = await dockerDriverGatewayCutover.runDockerDriverGatewayManagedFallback(
        () =>
          deps.dockerDriverGatewayEnv.startPackageManagedDockerDriverGatewayWithEnvOverride({
            clearDockerDriverGatewayRuntimeFiles: deps.clearDockerDriverGatewayRuntimeFiles,
            ...(selectedRuntimeEnv ? { env: selectedRuntimeEnv } : {}),
            exitOnFailure,
            gatewayEnv: driftGatewayEnv,
            gatewayName: deps.gatewayName(),
            ...(output ? { output } : {}),
            isDockerDriverGatewayReady: () =>
              deps.isDockerDriverGatewayHttpReady(undefined, undefined, driftGatewayEnv),
            registerDockerDriverGatewayEndpoint,
            observer,
            preparePortForOpenShellGatewayUserServiceStart: servicePortOwnership.preparePort,
            skipSandboxBridgeReachability,
            validatePortOwnerForOpenShellGatewayUserServiceStart:
              servicePortOwnership.validatePortOwner,
            verifySandboxBridgeGatewayReachableOrExit: (fail, options) =>
              verifyReachability(fail, {
                ...(options ?? {}),
                ...(output ? { output } : {}),
                port: deps.gatewayPort(),
              }),
          }),
        async () =>
          dockerDriverGatewayCutover.runDockerDriverGatewayCutover(
            {
              gatewayBin,
              identityGatewayBin,
              driftGatewayBin,
              driftGatewayEnv,
              exitOnFailure,
              skipSandboxBridgeReachability,
              stateDir,
              portListenerScan: deps.getDockerDriverGatewayPortListenerScan(
                await deps.checkGatewayPortAvailable(),
                { gatewayBin: identityGatewayBin },
              ),
              pidFileGatewayPid: deps.getDockerDriverGatewayPid(),
              initialHealth: await dockerDriverGatewayCutover.readDockerDriverGatewayHealth(
                observer,
                deps.gatewayName(),
              ),
            },
            {
              isDockerDriverGatewayProcessAlive: deps.isDockerDriverGatewayProcessAlive,
              getDockerDriverGatewayRuntimeDrift: deps.getDockerDriverGatewayRuntimeDrift,
              logDockerDriverGatewayRestart: output
                ? (reason) => output.log(`  Restarting OpenShell Docker-driver gateway: ${reason}`)
                : deps.logDockerDriverGatewayRestart,
              registerDockerDriverGatewayEndpoint,
              isDockerDriverGatewayHttpReady: () =>
                deps.isDockerDriverGatewayHttpReady(undefined, undefined, driftGatewayEnv),
              verifySandboxBridgeGatewayReachableOrExit: (fail, options) =>
                verifyReachability(fail, {
                  ...(options ?? {}),
                  ...(output ? { output } : {}),
                  port: deps.gatewayPort(),
                }),
              readGatewayHealth: () =>
                observer.observeGatewayReuse({
                  target: { kind: "named", gatewayName: deps.gatewayName() },
                }),
              rememberDockerDriverGatewayPid: deps.rememberDockerDriverGatewayPid,
              reapDuplicateHostGatewaysExceptOrFail: (
                keepPid,
                selectedGatewayBin,
                candidatePids,
                shouldExitOnFailure,
              ) =>
                reapDuplicateHostGatewaysExceptOrFail(
                  keepPid,
                  selectedGatewayBin,
                  candidatePids,
                  shouldExitOnFailure,
                  {},
                  undefined,
                  undefined,
                  output?.error,
                ),
              reapHostGatewayBeforeLaunchOrFail: (options) =>
                reapHostGatewayBeforeLaunchOrFail({
                  ...options,
                  ...(output ? { printError: output.error } : {}),
                }),
              isGatewayPortAvailable: async () => {
                const probe = await deps.checkGatewayPortAvailable();
                return probe.ok && !probe.warning;
              },
              reportUntrustedGatewayPort: servicePortOwnership.reportUntrustedGatewayPort,
              reportMissingGatewayBinary: () => {
                (output?.error ?? console.error)(
                  "  OpenShell Docker-driver gateway binary not found.",
                );
                (output?.error ?? console.error)(
                  `  Install OpenShell v${deps.SUPPORTED_OPENSHELL_FALLBACK_VERSION}, or set NEMOCLAW_OPENSHELL_GATEWAY_BIN.`,
                );
                if (exitOnFailure) process.exit(1);
                throw new Error("OpenShell gateway binary not found");
              },
              log: output?.log ?? console.log,
            },
          ),
      );
      if (cutover !== "launch") return;
      if (!gatewayBin || !gatewayLaunch) {
        throw new Error("OpenShell gateway launch missing after cutover");
      }

      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const logPath = path.join(stateDir, "openshell-gateway.log");
      const log = dockerDriverGatewayLaunch.openDockerDriverGatewayLog(logPath, {
        exitOnFailure,
        ...(output ? { printError: output.error } : {}),
      });
      (output?.log ?? console.log)("  Starting OpenShell gateway...");
      (output?.log ?? console.log)(`  Gateway log: ${logPath}`);
      dockerDriverGatewayLaunch.prepareAndLogDockerDriverGatewayLaunch(
        gatewayLaunch,
        output?.log ?? console.log,
        output?.warn ?? console.warn,
      );
      const child = dockerDriverGatewayLaunch.spawnDockerDriverGateway(gatewayLaunch, log.fd);
      const childExit = trackChildExit(child);
      child.unref();
      const childPid = child.pid ?? 0;
      if (childPid <= 0) throw new Error("OpenShell gateway process did not return a pid");
      deps.rememberDockerDriverGatewayPid(childPid);
      dockerDriverGatewayRuntimeMarker.writeDockerDriverGatewayRuntimeMarkerForStateDir(stateDir, {
        pid: childPid,
        desiredEnv: driftGatewayEnv,
        endpoint: resolveDockerDriverGatewayRuntimeMarkerEndpoint(
          driftGatewayEnv,
          deps.getDockerDriverGatewayEndpoint,
        ),
        gatewayBin: driftGatewayBin,
        openshellVersion: deps.getInstalledOpenshellVersion(openshellVersionOutput),
        dockerHost: process.env.DOCKER_HOST || null,
      });
      const pollCount = deps.envInt("NEMOCLAW_HEALTH_POLL_COUNT", 30);
      const pollInterval = deps.envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
      const startup = await waitForStandaloneDockerDriverGateway({
        childExited: () => childExit.exited,
        childPid,
        gatewayName: deps.gatewayName(),
        healthPollCount: pollCount,
        healthPollIntervalSeconds: pollInterval,
        isGatewayTcpReady: deps.isGatewayTcpReady,
        isPidAlive: deps.isPidAlive,
        onHealthy: async () => {
          await verifyReachability(exitOnFailure, {
            ...(output ? { output } : {}),
            skip: skipSandboxBridgeReachability,
            port: deps.gatewayPort(),
          });
        },
        registerGatewayEndpoint: registerDockerDriverGatewayEndpoint,
        observer,
        sleepSeconds: deps.sleepSeconds,
      });
      if (startup === "healthy") {
        (output?.log ?? console.log)("  ✓ Docker-driver gateway is healthy");
        return;
      }
      const gatewayServiceStopCommand = await resolveSelectedGatewayServiceStopCommand({
        ...deps,
        isDockerDriverGatewayPidUsingSelectedState:
          stateOwnership.isDockerDriverGatewayPidUsingSelectedState,
      });
      reportDockerDriverGatewayStartFailure(logPath, childExit, {
        exitOnFailure,
        gatewayPort: deps.gatewayPort(),
        isGatewayStateInUse: stateOwnership.isDockerDriverGatewayStateInUse,
        launchLogOffset: log.startOffset,
        resolveGatewayStopCommand: () => gatewayServiceStopCommand,
        ...(output ? { printError: (message?: string) => output.error(message ?? "") } : {}),
      });
      if (startup === "exited") {
        throw new Error("Docker-driver gateway failed to start because the process exited");
      }
      throw new Error(
        `Docker-driver gateway failed to start within ${formatGatewayHealthWaitLimit(pollCount, pollInterval)}`,
      );
    } finally {
      if (stateLifecycleLock) {
        gatewayStateLifecycleLock.releaseManagedGatewayStateLifecycleLock(stateLifecycleLock);
      }
    }
  }

  return { startDockerDriverGateway, verifyDockerDriverGatewaySandboxReachability };
}
