// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as docker from "../adapters/docker";
import type { NvidiaPlatform } from "../inference/nim";
import type { GatewayReuseState } from "../state/gateway";
import * as registry from "../state/registry";
import { isLinuxDockerDriverGatewayEnabled } from "./docker-driver-platform";
import { destroyGatewayForReuse } from "./gateway-cleanup";
import { reportGpuPassthroughRecovery } from "./gpu-recovery";

export type LegacyGatewayGpuInspection = "gpu-enabled" | "cpu-only" | "not-found" | "unknown";

export type GatewayGpuReuseDecision = "reuse" | "restart-gateway" | "abort-with-recovery";

type GatewayGpuDeviceRequestInspection = {
  status: number | null | undefined;
  stdout?: unknown;
  stderr?: unknown;
};

export type GatewayGpuReuseReconcileOptions = {
  gatewayReuseState: GatewayReuseState;
  gpuPassthrough: boolean;
  gatewayName: string;
  currentSandboxName: string | null;
  hostGpuPlatform?: NvidiaPlatform | null;
  recreateSandbox: boolean;
  confirmedDockerDriverGateway: boolean;
  stopDashboardForwards: () => void;
  retireLegacyGatewayForDockerDriverUpgrade: () => void;
  destroyGatewayRuntimeForGpuReuse: () => boolean;
};

// Docker-driver/package-managed gateways do not expose reusable GPU state
// through the legacy openshell-cluster-* container's DeviceRequests field.
export function shouldInspectLegacyGatewayGpuPassthrough(
  gatewayReuseState: GatewayReuseState,
  gpuPassthrough: boolean,
  confirmedDockerDriverGateway: boolean,
): boolean {
  return gatewayReuseState === "healthy" && gpuPassthrough && !confirmedDockerDriverGateway;
}

export function inspectLegacyGatewayGpuPassthroughResult(
  status: number | null | undefined,
  stdout: unknown,
  stderr: unknown = "",
): LegacyGatewayGpuInspection {
  if (status !== 0) {
    const error = String(stderr ?? "");
    return /\bNo such (object|container)\b|not found/i.test(error) ? "not-found" : "unknown";
  }
  const output = String(stdout ?? "").trim();
  if (output === "null" || output === "[]") return "cpu-only";
  if (!output) return "unknown";
  return "gpu-enabled";
}

export function decideGatewayGpuReuseForGpuIntent({
  gatewayReuseState,
  gpuPassthrough,
  confirmedDockerDriverGateway,
  legacyGatewayGpuInspection,
  cpuOnlyGatewayRestartSafe,
}: {
  gatewayReuseState: GatewayReuseState;
  gpuPassthrough: boolean;
  confirmedDockerDriverGateway: boolean;
  legacyGatewayGpuInspection: LegacyGatewayGpuInspection;
  cpuOnlyGatewayRestartSafe: boolean;
}): GatewayGpuReuseDecision {
  if (gatewayReuseState !== "healthy" || !gpuPassthrough) return "reuse";
  if (confirmedDockerDriverGateway) return "reuse";
  if (legacyGatewayGpuInspection === "gpu-enabled" || legacyGatewayGpuInspection === "not-found") {
    return "reuse";
  }
  if (legacyGatewayGpuInspection !== "cpu-only") return "abort-with-recovery";
  return cpuOnlyGatewayRestartSafe ? "restart-gateway" : "abort-with-recovery";
}

export function canRestartCpuOnlyGatewayForGpuIntent(
  registeredSandboxNames: readonly string[],
  currentSandboxName: string | null,
  recreateSandbox: boolean,
): boolean {
  const names = registeredSandboxNames.map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return true;
  return (
    recreateSandbox &&
    currentSandboxName !== null &&
    names.length === 1 &&
    names[0] === currentSandboxName
  );
}

function readRegisteredSandboxNamesForGatewayGpuReuse(): string[] | null {
  try {
    return registry
      .listSandboxes()
      .sandboxes.map((s) => s.name)
      .filter((name) => typeof name === "string" && name.trim().length > 0);
  } catch {
    return null;
  }
}

function reportUnreadableSandboxRegistryForGpuGatewayReuse(
  error: (line: string) => void,
  exit: (code: number) => never,
  gatewayName: string,
): never {
  error("  Existing gateway was started without GPU passthrough.");
  error(
    "  Could not read the local sandbox registry, so automatic gateway cleanup would be unsafe.",
  );
  error(
    "  Fix the registry read error and rerun, or manually verify no sandboxes depend on the gateway before running:",
  );
  error(`    openshell gateway remove ${gatewayName}`);
  error("    # For OpenShell releases that still expose lifecycle commands:");
  error(`    openshell gateway destroy -g ${gatewayName}`);
  error("    sudo pkill -f openshell-gateway  # if a privileged host gateway process remains");
  error("    nemoclaw onboard --gpu");
  exit(1);
}

function inspectLegacyGatewayDeviceRequests(
  containerName: string,
): GatewayGpuDeviceRequestInspection {
  return docker.dockerInspect(
    ["--type", "container", "--format", "{{json .HostConfig.DeviceRequests}}", containerName],
    { ignoreError: true, suppressOutput: true },
  );
}

export function reconcileGatewayGpuReuseForGpuIntent({
  gatewayReuseState,
  gpuPassthrough,
  gatewayName,
  currentSandboxName,
  recreateSandbox,
  confirmedDockerDriverGateway,
  stopDashboardForwards,
  retireLegacyGatewayForDockerDriverUpgrade,
  destroyGatewayRuntimeForGpuReuse,
}: GatewayGpuReuseReconcileOptions): GatewayReuseState {
  if (
    !shouldInspectLegacyGatewayGpuPassthrough(
      gatewayReuseState,
      gpuPassthrough,
      confirmedDockerDriverGateway,
    )
  ) {
    return gatewayReuseState;
  }

  const container = `openshell-cluster-${gatewayName}`;
  const gpuCheck = inspectLegacyGatewayDeviceRequests(container);
  const legacyGatewayGpuInspection = inspectLegacyGatewayGpuPassthroughResult(
    gpuCheck.status,
    gpuCheck.stdout,
    gpuCheck.stderr,
  );

  if (legacyGatewayGpuInspection === "unknown") {
    console.error("  Existing gateway GPU passthrough could not be verified.");
    console.error(
      "  Refusing automatic gateway cleanup without a clear Docker signal; restart Docker and rerun onboard.",
    );
    process.exit(1);
  }

  const registeredSandboxNames =
    legacyGatewayGpuInspection === "cpu-only" ? readRegisteredSandboxNamesForGatewayGpuReuse() : [];
  if (registeredSandboxNames === null) {
    reportUnreadableSandboxRegistryForGpuGatewayReuse(console.error, process.exit, gatewayName);
  }

  const gatewayGpuReuseDecision = decideGatewayGpuReuseForGpuIntent({
    gatewayReuseState,
    gpuPassthrough,
    confirmedDockerDriverGateway,
    legacyGatewayGpuInspection,
    cpuOnlyGatewayRestartSafe: canRestartCpuOnlyGatewayForGpuIntent(
      registeredSandboxNames,
      currentSandboxName,
      recreateSandbox,
    ),
  });

  if (gatewayGpuReuseDecision === "restart-gateway") {
    console.log(
      "  Existing gateway was started without GPU passthrough; recreating it for GPU onboarding...",
    );
    stopDashboardForwards();
    if (isLinuxDockerDriverGatewayEnabled()) {
      retireLegacyGatewayForDockerDriverUpgrade();
      gatewayReuseState = "missing";
      console.log("  ✓ Previous CPU-only gateway cleaned up");
    } else {
      gatewayReuseState = destroyGatewayForReuse(
        destroyGatewayRuntimeForGpuReuse,
        "  ✓ Previous CPU-only gateway cleaned up",
        "  ! Previous CPU-only gateway cleanup failed; leaving registry state intact.",
      );
    }
    if (gatewayReuseState !== "missing") {
      reportGpuPassthroughRecovery(console.error, () => registeredSandboxNames);
      process.exit(1);
    }
  } else if (gatewayGpuReuseDecision === "abort-with-recovery") {
    reportGpuPassthroughRecovery(console.error, () => registeredSandboxNames);
    process.exit(1);
  }
  return gatewayReuseState;
}
