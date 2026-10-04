// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { waitUntilAsync } from "../core/wait";
import { createGatewayHealthWaitOptions } from "./gateway-health-wait";

export type DockerDriverGatewayStartupResult = "healthy" | "exited" | "timeout";

export async function waitForStandaloneDockerDriverGateway(options: {
  observer: import("../adapters/openshell/gateway-reuse").OpenShellGatewayReuseObserver;
  childExited: () => boolean;
  childPid: number;
  gatewayName: string;
  healthPollCount: number;
  healthPollIntervalSeconds: number;
  isGatewayTcpReady: () => boolean | Promise<boolean>;
  isPidAlive: (pid: number) => boolean;
  onHealthy: () => void | Promise<void>;
  registerGatewayEndpoint: () => boolean | Promise<boolean>;
  sleepSeconds: (seconds: number) => void;
  now?: () => number;
}): Promise<DockerDriverGatewayStartupResult> {
  let result: DockerDriverGatewayStartupResult = "timeout";
  const waitOptions = createGatewayHealthWaitOptions(
    options.healthPollCount,
    options.healthPollIntervalSeconds,
    options.now ?? Date.now,
    (ms) => options.sleepSeconds(ms / 1000),
  );
  if (!waitOptions) return result;

  let registrationAttempt: Promise<boolean> | undefined;
  await waitUntilAsync(async () => {
    if (options.childExited() || !options.isPidAlive(options.childPid)) {
      result = "exited";
      return true;
    }
    if (!(await (registrationAttempt ??= Promise.resolve(options.registerGatewayEndpoint()))))
      return false;

    const observation = await options.observer.observeGatewayReuse({
      target: { kind: "named", gatewayName: options.gatewayName },
    });
    // Probes take real wall-clock time. Reconfirm process liveness afterward
    // so a gateway that exits during migration cannot be reported as healthy.
    if (
      !observation.error &&
      observation.healthy &&
      observation.namedMetadata &&
      (await options.isGatewayTcpReady()) &&
      !options.childExited() &&
      options.isPidAlive(options.childPid)
    ) {
      await options.onHealthy();
      result = "healthy";
      return true;
    }
    return false;
  }, waitOptions);

  return result;
}
