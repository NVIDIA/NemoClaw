// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { dockerContainerInspectFormat } from "../adapters/docker";
import { getGatewayClusterContainerName } from "../adapters/openshell/gateway-drift";
import { getGatewayHttpEndpoint } from "../core/gateway-address";
import {
  BEDROCK_RUNTIME_ADAPTER_PORT,
  DASHBOARD_PORT,
  DASHBOARD_PORT_RANGE_END,
  DASHBOARD_PORT_RANGE_START,
  GATEWAY_PORT,
  OLLAMA_PORT,
  OLLAMA_PROXY_PORT,
  VLLM_PORT,
  validateGatewayPort,
} from "../core/ports";
import { sleepSeconds, waitUntilAsync } from "../core/wait";
import { shouldPatchCoredns } from "../platform";
import { run, SCRIPTS } from "../runner";
import { isGatewayHealthy } from "../state/gateway";
import { isLinuxDockerDriverGatewayEnabled } from "./docker-driver-platform";
import { envInt } from "./env";
import { resolveGatewayName, resolveGatewayPortFromName } from "./gateway-binding";
import { isGatewayHttpReady } from "./gateway-http-readiness";
import { getContainerRuntime } from "./local-inference-topology";

export type StartGatewayForRecoveryOptions = {
  gatewayName?: string;
  gatewayPort?: number;
};

type RunOpenshellOptions = {
  ignoreError?: boolean;
  env?: Record<string, string>;
  suppressOutput?: boolean;
};

type RunCaptureOpenshellOptions = {
  ignoreError?: boolean;
};

type GatewayStartResult = {
  status?: number | null;
};

export type GatewayRecoveryDeps = {
  getGatewayClusterContainerState?(gatewayName: string): string;
  getGatewayStartEnv(): Record<string, string>;
  runCaptureOpenshell(args: string[], opts?: RunCaptureOpenshellOptions): string;
  runOpenshell(args: string[], opts?: RunOpenshellOptions): GatewayStartResult;
  startGatewayWithOptions(gpu: never, options: { exitOnFailure: false }): Promise<void>;
  isLinuxDockerDriverGatewayEnabled?(): boolean;
  sleepSeconds?(seconds: number): void;
  // Injected so caller-level tests can exercise the success + retry-success
  // paths at unit-test speed without standing up a real gateway. Defaults
  // to the production implementations.
  isGatewayHealthy?: typeof isGatewayHealthy;
  isGatewayHttpReady?: typeof isGatewayHttpReady;
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
  });
  return { gatewayName, gatewayPort };
}

function getGatewayStartEnvForPort(
  gatewayPort: number,
  getGatewayStartEnv: GatewayRecoveryDeps["getGatewayStartEnv"],
): Record<string, string> {
  return {
    ...getGatewayStartEnv(),
    OPENSHELL_SERVER_PORT: String(gatewayPort),
    OPENSHELL_SSH_GATEWAY_PORT: String(gatewayPort),
  };
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
  const normalizedCount = Number.isFinite(pollCount) ? Math.max(0, pollCount) : 0;
  const normalizedIntervalSeconds = Number.isFinite(pollIntervalSeconds)
    ? Math.max(0, pollIntervalSeconds)
    : 0;
  return Math.max(1, normalizedCount * normalizedIntervalSeconds * 1000);
}

function formatGatewayRecoveryWaitBudget(budgetMs: number): string {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return "0s";
  if (budgetMs < 1000) return `${Math.ceil(budgetMs)}ms`;
  const seconds = budgetMs / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

async function startTargetGatewayForRecovery(
  { gatewayName, gatewayPort }: { gatewayName: string; gatewayPort: number },
  deps: GatewayRecoveryDeps,
): Promise<void> {
  const gatewayPortArg = String(gatewayPort);
  const startResult = deps.runOpenshell(
    ["gateway", "start", "--name", gatewayName, "--port", gatewayPortArg],
    {
      ignoreError: true,
      env: getGatewayStartEnvForPort(gatewayPort, deps.getGatewayStartEnv),
      suppressOutput: true,
    },
  );
  deps.runOpenshell(["gateway", "select", gatewayName], { ignoreError: true });

  const recoveryWait = getGatewayHealthWaitConfig(
    startResult.status ?? 0,
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
  const healthy =
    recoveryPollCount > 0 &&
    (await waitUntilAsync(
      async () => {
        const status = deps.runCaptureOpenshell(["status"], { ignoreError: true });
        const namedInfo = deps.runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
          ignoreError: true,
        });
        const currentInfo = deps.runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
        return (
          status.includes("Connected") &&
          gatewayHealthyImpl(status, namedInfo, currentInfo, gatewayName) &&
          (await gatewayHttpReadyImpl(undefined, targetGatewayUrl))
        );
      },
      {
        // #3768 wants a SINGLE clear deadline budget rather than the legacy
        // fixed attempt cap. Do NOT pass `maxAttempts` here: with maxAttempts
        // set, a fast-failing probe sequence would exit after `count`
        // attempts even though the deadline still permits more polling, and
        // the operator would see a timeout that under-reports the wait the
        // system was willing to spend. Let waitUntilAsync run until the
        // deadline; the interval and probe cost naturally bound the total
        // attempt count.
        deadlineMs: nowImpl() + waitBudgetMs,
        initialIntervalMs: Math.max(0, recoveryPollInterval * 1000),
        maxIntervalMs: Math.max(0, recoveryPollInterval * 1000),
        backoffFactor: 1,
        now: nowImpl,
        // waitUntilAsync passes durations in milliseconds to `sleep`, while
        // the injected sleeper (sleepSeconds) expects a second-granular
        // number. Adapt at this boundary only.
        sleep: (ms) => sleeper(ms / 1000),
      },
    ));

  if (healthy) {
    process.env.OPENSHELL_GATEWAY = gatewayName;
    const runtime = getContainerRuntime();
    if (shouldPatchCoredns(runtime)) {
      run(["bash", path.join(SCRIPTS, "fix-coredns.sh"), gatewayName], {
        ignoreError: true,
      });
    }
    return;
  }

  // Pure deadline-based semantics per #3768: report the actual budget the
  // loop was allowed to spend. Include the interval only as diagnostic
  // context so an operator scanning the message understands the poll cadence.
  throw new Error(
    `Gateway '${gatewayName}' did not become ready within the configured ${formatGatewayRecoveryWaitBudget(
      waitBudgetMs,
    )} recovery deadline (${recoveryPollInterval}s poll interval)`,
  );
}

export async function startGatewayForRecovery(
  options: StartGatewayForRecoveryOptions,
  deps: GatewayRecoveryDeps,
): Promise<void> {
  const target = resolveGatewayRecoveryTarget(options);
  const linuxDockerDriverEnabled = (
    deps.isLinuxDockerDriverGatewayEnabled ?? isLinuxDockerDriverGatewayEnabled
  )();
  // The Docker-driver Linux startup path (startGatewayWithOptions →
  // startDockerDriverGateway) restores the runtime-marker, package-managed
  // registration, and sandbox-bridge reachability — none of which a plain
  // `openshell gateway start` produces. Route through it whenever the
  // recovery target matches the current process's GATEWAY_PORT (the common
  // case where the user re-runs with the same NEMOCLAW_GATEWAY_PORT).
  if (target.gatewayPort === GATEWAY_PORT) {
    if (target.gatewayName === resolveDefaultGatewayName() || linuxDockerDriverEnabled) {
      return deps.startGatewayWithOptions(undefined as never, { exitOnFailure: false });
    }
  }
  // Cross-port recovery on a Linux Docker-driver gateway cannot share this
  // process's module-globals: startDockerDriverGateway captures the port at
  // load time, so a plain `openshell gateway start` would skip the
  // runtime-marker / package registration / sandbox-bridge setup and leave
  // the host in a half-recovered state. Fail closed instead and direct the
  // operator to re-run with the matching NEMOCLAW_GATEWAY_PORT so the
  // docker-driver path re-stamps the per-port artefacts.
  if (linuxDockerDriverEnabled && target.gatewayPort !== GATEWAY_PORT) {
    throw new Error(
      `Cross-port recovery for Linux Docker-driver gateway '${target.gatewayName}' is not safe from a process bound to port ${GATEWAY_PORT}. ` +
        `Re-run with NEMOCLAW_GATEWAY_PORT=${target.gatewayPort} so the docker-driver setup can restamp the runtime marker, registration, and sandbox bridge.`,
    );
  }
  return startTargetGatewayForRecovery(target, deps);
}
