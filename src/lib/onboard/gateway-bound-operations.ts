// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerContainerInspectFormat, dockerExecArgv } from "../adapters/docker";
import { getGatewayClusterImageDrift } from "../adapters/openshell/gateway-drift";
import { getGatewayHttpEndpoint, getGatewayHttpsEndpoint } from "../core/gateway-address";
import * as dockerDriverGatewayEnv from "./docker-driver-gateway-env";
import {
  isDockerDriverGatewayHttpReady as probeDockerDriverGatewayHttpReady,
  isGatewayHttpReady as probeGatewayHttpReady,
  type WaitForGatewayHttpReadyOpts,
  waitForGatewayHttpReady as waitForGatewayHttpReadyBase,
} from "./gateway-http-readiness";
import { isGatewayTcpReady as probeGatewayTcpReady } from "./gateway-tcp-readiness";
import { checkPortAvailable } from "./preflight";

export function createGatewayBoundOperations(getBinding: () => { name: string; port: number }) {
  const getDockerEndpoint = (): string =>
    dockerDriverGatewayEnv.getDockerDriverGatewayEndpoint(getBinding().port);
  const getImageDrift = () => getGatewayClusterImageDrift({ gatewayName: getBinding().name });
  const getContainerState = (): string => {
    const state = dockerContainerInspectFormat(
      "{{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{end}}",
      `openshell-cluster-${getBinding().name}`,
      { ignoreError: true },
    )
      .trim()
      .toLowerCase();
    return state || "missing";
  };
  const buildClusterExecArgv = (script: string): string[] =>
    dockerExecArgv(`openshell-cluster-${getBinding().name}`, ["sh", "-lc", script]);
  const checkPort = () =>
    checkPortAvailable(getBinding().port, dockerDriverGatewayEnv.getGatewayPortCheckOptions());
  const getLocalEndpoint = (): string =>
    dockerDriverGatewayEnv.getGatewayHttpsEndpoint(getBinding().port);
  const isHttpReady = (
    timeoutMs?: number,
    url?: string,
    method?: "GET" | "POST",
  ): Promise<boolean> =>
    probeGatewayHttpReady(
      timeoutMs,
      url ?? `${getGatewayHttpEndpoint(getBinding().port)}/`,
      method,
    );
  const isDockerHttpReady = (timeoutMs?: number, url?: string): Promise<boolean> =>
    probeDockerDriverGatewayHttpReady(
      timeoutMs,
      url ?? `${getGatewayHttpsEndpoint(getBinding().port)}/openshell.v1.OpenShell/Health`,
    );
  const waitForHttpReady = (opts: WaitForGatewayHttpReadyOpts = {}): Promise<boolean> =>
    waitForGatewayHttpReadyBase({
      ...opts,
      probe: opts.probe ?? (() => isHttpReady()),
    });
  const isTcpReady = (timeoutMs?: number): Promise<boolean> =>
    probeGatewayTcpReady(getBinding().port, timeoutMs);

  return {
    getDockerDriverGatewayEndpoint: getDockerEndpoint,
    getGatewayClusterImageDrift: getImageDrift,
    getGatewayClusterContainerState: getContainerState,
    buildGatewayClusterExecArgv: buildClusterExecArgv,
    checkGatewayPortAvailable: checkPort,
    getGatewayLocalEndpoint: getLocalEndpoint,
    isDockerDriverGatewayHttpReady: isDockerHttpReady,
    isGatewayHttpReady: isHttpReady,
    isGatewayTcpReady: isTcpReady,
    waitForGatewayHttpReady: waitForHttpReady,
  };
}
