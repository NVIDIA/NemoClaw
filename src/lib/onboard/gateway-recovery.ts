// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { dockerContainerInspectFormat } from "../adapters/docker";
import { getGatewayClusterContainerName } from "../adapters/openshell/gateway-drift";
import {
  type OpenShellRuntimeSelection,
  withSelectedOpenShellCommandOptions,
} from "../adapters/openshell/command-argv";
import { getGatewayHttpEndpoint } from "../core/gateway-address";
import {
  BEDROCK_RUNTIME_ADAPTER_PORT,
  DASHBOARD_PORT,
  DASHBOARD_PORT_RANGE_END,
  DASHBOARD_PORT_RANGE_START,
  GATEWAY_PORT,
  HTTPS_PIN_RUNTIME_ADAPTER_PORT,
  OLLAMA_PORT,
  OLLAMA_PROXY_PORT,
  OPENROUTER_RUNTIME_ADAPTER_PORT,
  VLLM_PORT,
  validateGatewayPort,
} from "../core/ports";
import { sleepSeconds, waitUntilAsync } from "../core/wait";
import { gatewayStartGuidance } from "../gateway-start-guidance";
import { shouldPatchCoredns } from "../platform";
import { run, SCRIPTS } from "../runner";
import { isGatewayHealthy } from "../state/gateway";
import { isLinuxDockerDriverGatewayEnabled } from "./docker-driver-platform";
import { envInt } from "./env";
import { resolveGatewayName, resolveGatewayPortFromName } from "./gateway-binding";
import { formatGatewayHealthWaitLimit } from "./gateway-health-wait";
import { isGatewayHttpReady } from "./gateway-http-readiness";
import { getContainerRuntime } from "./local-inference-topology";
import {
  createReadinessWaitOptions,
  formatReadinessDeadline,
  getLegacyPollDeadlineBudgetMs,
} from "./readiness-wait";

export type StartGatewayForRecoveryOptions = {
  gatewayName?: string;
  gatewayPort?: number;
  runtimeSelection?: OpenShellRuntimeSelection;
};

type RunOpenshellOptions = {
  ignoreError?: boolean;
  env?: Record<string, string>;
  replaceEnv?: boolean;
  suppressOutput?: boolean;
};

type RunCaptureOpenshellOptions = {
  ignoreError?: boolean;
  env?: Record<string, string>;
  replaceEnv?: boolean;
};

type GatewayStartResult = {
  status?: number | null;
};

export type GatewayRecoveryDeps = {
  /**
   * Fail closed before any recovery branch starts a gateway process an external
   * supervisor owns (#6576).
   */
  assertGatewayStartAllowed(
    exitOnFailure: boolean,
    target: { gatewayName: string; gatewayPort: number },
  ): void;
  getGatewayClusterContainerState?(gatewayName: string): string;
  runCaptureOpenshell(args: string[], opts?: RunCaptureOpenshellOptions): string;
  runOpenshell(args: string[], opts?: RunOpenshellOptions): GatewayStartResult;
  startGatewayWithOptions(
    gpu: never,
    options: {
      exitOnFailure: false;
      runtimeSelection?: OpenShellRuntimeSelection;
    },
  ): Promise<void>;
  isLinuxDockerDriverGatewayEnabled?(): boolean;
  sleepSeconds?(seconds: number): void;
  // Injected so caller-level tests can exercise the success + retry-success
  // paths at unit-test speed without standing up a real gateway. Defaults
  // to the production implementations.
  isGatewayHealthy?: typeof isGatewayHealthy;
  isGatewayHttpReady?: typeof isGatewayHttpReady;
  getContainerRuntime?: typeof getContainerRuntime;
  shouldPatchCoredns?: typeof shouldPatchCoredns;
  runCorednsPatch?(gatewayName: string): void;
  // Injected clock reader for deadline-driven tests. Defaults to Date.now.
  // A test can pair a virtual sleeper (that advances a captured value) with
  // this reader to drive deterministic deadline expiration without real
  // wall-clock waits or global fake-timer state.
  now?(): number;
};

function isValidGatewayRecoveryPort(port: number | null | undefined): port is number {
  return Number.isInteger(port) && Number(port) >= 1024 && Number(port) <= 65535;
}

function resolveDefaultGatewayName(): string {
  return resolveGatewayName(GATEWAY_PORT);
}

function resolveGatewayRecoveryTarget(options: StartGatewayForRecoveryOptions = {}) {
  const gatewayName =
    options.gatewayName ||
    (isValidGatewayRecoveryPort(options.gatewayPort)
      ? resolveGatewayName(options.gatewayPort)
      : resolveDefaultGatewayName());
  const portFromName = resolveGatewayPortFromName(gatewayName);
  if (portFromName === null) {
    throw new Error(`Invalid NemoClaw gateway name '${gatewayName}'`);
  }
  const gatewayPort = options.gatewayPort ?? portFromName;
  if (gatewayPort !== portFromName) {
    throw new Error(`Gateway '${gatewayName}' does not match port ${gatewayPort}`);
  }
  if (!isValidGatewayRecoveryPort(gatewayPort)) {
    throw new Error(`Invalid gateway recovery port ${gatewayPort}`);
  }
  validateGatewayPort("NEMOCLAW_GATEWAY_PORT", gatewayPort, {
    dashboardPort: DASHBOARD_PORT,
    dashboardRangeStart: DASHBOARD_PORT_RANGE_START,
    dashboardRangeEnd: DASHBOARD_PORT_RANGE_END,
    vllmPort: VLLM_PORT,
    ollamaPort: OLLAMA_PORT,
    ollamaProxyPort: OLLAMA_PROXY_PORT,
    bedrockRuntimeAdapterPort: BEDROCK_RUNTIME_ADAPTER_PORT,
    openrouterRuntimeAdapterPort: OPENROUTER_RUNTIME_ADAPTER_PORT,
    httpsPinRuntimeAdapterPort: HTTPS_PIN_RUNTIME_ADAPTER_PORT,
  });
  return { gatewayName, gatewayPort };
}

function getDefaultGatewayClusterContainerState(gatewayName: string): string {
  const state = dockerContainerInspectFormat(
    "{{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{end}}",
    getGatewayClusterContainerName(gatewayName),
    { ignoreError: true },
  )
    .trim()
    .toLowerCase();
  return state || "missing";
}

function getGatewayHealthWaitConfig(_startStatus = 0, containerState = "") {
  const isArm64 = process.arch === "arm64";
  const standardCount = envInt("NEMOCLAW_HEALTH_POLL_COUNT", isArm64 ? 30 : 12);
  const standardInterval = envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", isArm64 ? 10 : 5);
  const extendedCount = envInt("NEMOCLAW_GATEWAY_START_POLL_COUNT", standardCount);
  const extendedInterval = envInt("NEMOCLAW_GATEWAY_START_POLL_INTERVAL", standardInterval);
  const normalizedState = String(containerState || "")
    .trim()
    .toLowerCase();
  const normalizedContainerState = normalizedState || "missing";
  const useExtendedWait = normalizedContainerState !== "missing";

  return {
    count: useExtendedWait ? extendedCount : standardCount,
    interval: useExtendedWait ? extendedInterval : standardInterval,
    extended: useExtendedWait,
    containerState: normalizedContainerState,
  };
}

function getGatewayRecoveryWaitBudgetMs(pollCount: number, pollIntervalSeconds: number): number {
  return getLegacyPollDeadlineBudgetMs(pollCount, pollIntervalSeconds);
}

async function startTargetGatewayForRecovery(
  { gatewayName, gatewayPort }: { gatewayName: string; gatewayPort: number },
  deps: GatewayRecoveryDeps,
  runtimeSelection?: OpenShellRuntimeSelection,
): Promise<void> {
  const runtimeOptions = withSelectedOpenShellCommandOptions({}, runtimeSelection);
  deps.runOpenshell(["gateway", "select", gatewayName], {
    ...runtimeOptions,
    ignoreError: true,
  });

  const recoveryWait = getGatewayHealthWaitConfig(
    0,
    (deps.getGatewayClusterContainerState ?? getDefaultGatewayClusterContainerState)(gatewayName),
  );
  const recoveryPollCount = recoveryWait.extended
    ? recoveryWait.count
    : envInt("NEMOCLAW_HEALTH_POLL_COUNT", 10);
  const recoveryPollInterval = recoveryWait.extended
    ? recoveryWait.interval
    : envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
  const targetGatewayUrl = `${getGatewayHttpEndpoint(gatewayPort)}/`;
  const waitBudgetMs = getGatewayRecoveryWaitBudgetMs(recoveryPollCount, recoveryPollInterval);
  const sleeper = deps.sleepSeconds ?? sleepSeconds;
  const gatewayHealthyImpl = deps.isGatewayHealthy ?? isGatewayHealthy;
  const gatewayHttpReadyImpl = deps.isGatewayHttpReady ?? isGatewayHttpReady;
  const nowImpl = deps.now ?? Date.now;
  const waitOptions = createReadinessWaitOptions({
    budgetMs: waitBudgetMs,
    maxIntervalMs: Math.max(0, recoveryPollInterval * 1000),
    zeroBudgetAttempts: recoveryPollCount,
    now: nowImpl,
    sleep: (ms) => sleeper(ms / 1000),
  });
  const healthy =
    waitOptions !== null &&
    (await waitUntilAsync(async () => {
      const status = deps.runCaptureOpenshell(["status"], {
        ...runtimeOptions,
        ignoreError: true,
      });
      const namedInfo = deps.runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
        ...runtimeOptions,
        ignoreError: true,
      });
      const currentInfo = deps.runCaptureOpenshell(["gateway", "info"], {
        ...runtimeOptions,
        ignoreError: true,
      });
      return (
        status.includes("Connected") &&
        gatewayHealthyImpl(status, namedInfo, currentInfo, gatewayName) &&
        (await gatewayHttpReadyImpl(undefined, targetGatewayUrl))
      );
    }, waitOptions));

  if (healthy) {
    process.env.OPENSHELL_GATEWAY = gatewayName;
    const runtime = (deps.getContainerRuntime ?? getContainerRuntime)();
    if ((deps.shouldPatchCoredns ?? shouldPatchCoredns)(runtime)) {
      const runCorednsPatch =
        deps.runCorednsPatch ??
        ((targetGatewayName: string) =>
          run(["bash", path.join(SCRIPTS, "fix-coredns.sh"), targetGatewayName], {
            ignoreError: true,
          }));
      runCorednsPatch(gatewayName);
    }
    return;
  }

  const waitLimit =
    recoveryPollInterval === 0 && recoveryPollCount > 0
      ? formatGatewayHealthWaitLimit(recoveryPollCount, recoveryPollInterval)
      : `${formatReadinessDeadline(waitBudgetMs)} recovery deadline (${recoveryPollInterval}s poll interval)`;
  throw new Error(
    `Gateway '${gatewayName}' did not become ready within the configured ${waitLimit}. ${gatewayStartGuidance(gatewayName)}`,
  );
}

export async function startGatewayForRecovery(
  options: StartGatewayForRecoveryOptions,
  deps: GatewayRecoveryDeps,
): Promise<void> {
  const target = resolveGatewayRecoveryTarget(options);
  if (options.runtimeSelection && options.runtimeSelection.gatewayName !== target.gatewayName) {
    throw new Error(
      `Gateway recovery target '${target.gatewayName}' does not match runtime selection '${options.runtimeSelection.gatewayName}'`,
    );
  }
  // Guard every recovery branch. The cross-port / non-default-name path below
  // bypasses startGatewayWithOptions. It reselects an already-running gateway
  // and waits for health instead of starting a gateway process. Resolve and
  // bind the requested target first, because the process-global gateway can
  // name a different port during sandbox recovery.
  deps.assertGatewayStartAllowed(false, target);
  const linuxDockerDriverEnabled = (
    deps.isLinuxDockerDriverGatewayEnabled ?? isLinuxDockerDriverGatewayEnabled
  )();
  // The Docker-driver Linux startup path (startGatewayWithOptions →
  // startDockerDriverGateway) restores the runtime-marker, package-managed
  // registration, and sandbox-bridge reachability, and it is the only path
  // that starts a gateway process at all. Route through it whenever the
  // recovery target matches the current process's GATEWAY_PORT (the common
  // case where the user re-runs with the same NEMOCLAW_GATEWAY_PORT).
  if (target.gatewayPort === GATEWAY_PORT) {
    if (target.gatewayName === resolveDefaultGatewayName() || linuxDockerDriverEnabled) {
      return deps.startGatewayWithOptions(undefined as never, {
        exitOnFailure: false,
        ...(options.runtimeSelection ? { runtimeSelection: options.runtimeSelection } : {}),
      });
    }
  }
  // Cross-port recovery on a Linux Docker-driver gateway cannot share this
  // process's module-globals: startDockerDriverGateway captures the port at
  // load time, so the reselect path below would skip the runtime-marker /
  // package registration / sandbox-bridge setup and leave the host in a
  // half-recovered state. Fail closed instead and direct the operator to
  // re-run with the matching NEMOCLAW_GATEWAY_PORT so the docker-driver path
  // re-stamps the per-port artefacts.
  if (linuxDockerDriverEnabled && target.gatewayPort !== GATEWAY_PORT) {
    throw new Error(
      `Cross-port recovery for Linux Docker-driver gateway '${target.gatewayName}' is not safe from a process bound to port ${GATEWAY_PORT}. ` +
        `Re-run with NEMOCLAW_GATEWAY_PORT=${target.gatewayPort} so the docker-driver setup can restamp the runtime marker, registration, and sandbox bridge.`,
    );
  }
  return startTargetGatewayForRecovery(target, deps, options.runtimeSelection);
}
