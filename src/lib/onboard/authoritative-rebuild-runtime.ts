// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getGatewayClusterImageDrift } from "../adapters/openshell/gateway-drift";
import * as authoritativeRebuildTarget from "./authoritative-rebuild-target";
import * as dockerDriverGatewayEnv from "./docker-driver-gateway-env";
import * as dockerDriverGatewayLaunch from "./docker-driver-gateway-launch";
import * as dockerDriverGatewayLocalTls from "./docker-driver-gateway-local-tls";
import { isLinuxDockerDriverGatewayEnabled } from "./docker-driver-platform";
import * as fatalRuntimePreflight from "./fatal-runtime-preflight";
import * as gatewayBinding from "./gateway-binding";
import { verifyGatewayContainerRunning } from "./gateway-container-running";
import { gatewayCliSupportsLifecycleCommands } from "./gateway-lifecycle";
import type { PortProbeResult } from "./preflight";
import { preflightAuthoritativeResourceProfile } from "./resource-profile-selection";

type RuntimeState = {
  dashboardPort: number | null;
  gatewayName: string;
  gatewayPort: number;
  nonInteractive: boolean;
};

export type AuthoritativeRebuildRuntimeDeps = {
  getRuntimeState(): RuntimeState;
  setRuntimeState(state: RuntimeState): void;
  ensureOpenshell(exitProcess: (code: number) => never): unknown | Promise<unknown>;
  getOpenshellBinary(): string;
  runCaptureOpenshell(args: string[], options?: { ignoreError?: boolean }): string;
  isGatewayHttpReady(): Promise<boolean>;
  isDockerDriverGatewayHttpReady(): Promise<boolean>;
  inferenceRouteReady(provider: string, model: string): boolean;
  checkPort(port: number): Promise<PortProbeResult>;
  resolveOpenShellGatewayBinary(): string | null;
  resolveOpenShellSandboxBinary(): string | null;
  getDockerDriverGatewayStateDir(): string;
  getDockerDriverGatewayEnv(openshellVersionOutput: string): Record<string, string>;
  getDockerDriverGatewayPid(): number | null;
  isDockerDriverGatewayProcessAlive(): boolean;
  getDockerDriverGatewayRuntimeDrift(
    pid: number,
    desiredEnv: Record<string, string>,
    gatewayBin: string | null | undefined,
  ): { reason: string } | null;
  env?: NodeJS.ProcessEnv;
};

export function createAuthoritativeRebuildRuntimePreflight(deps: AuthoritativeRebuildRuntimeDeps) {
  const env = deps.env ?? process.env;
  return async function preflightAuthoritativeRebuildTarget(
    opts: authoritativeRebuildTarget.AuthoritativeRebuildPreflightOptions,
  ): Promise<fatalRuntimePreflight.FatalRuntimePreflightResult> {
    const authoritativeGateway =
      authoritativeRebuildTarget.resolveAuthoritativeOnboardGatewayBinding(opts);
    if (!authoritativeGateway) throw new Error("Authoritative rebuild preflight has no gateway");
    const previous = deps.getRuntimeState();
    deps.setRuntimeState({
      dashboardPort: opts.controlUiPort ?? null,
      gatewayName: authoritativeGateway.name,
      gatewayPort: authoritativeGateway.port,
      nonInteractive: true,
    });
    let runtimeResult: fatalRuntimePreflight.FatalRuntimePreflightResult | null = null;
    const fail = (message: string): never => {
      throw new Error(message);
    };
    try {
      await authoritativeRebuildTarget.preflightAuthoritativeRebuildTarget(
        { ...opts, controlUiPort: opts.controlUiPort ?? null },
        {
          runFatalRuntimePreflight: () => {
            runtimeResult = fatalRuntimePreflight.runFatalOnboardRuntimePreflight(
              {
                authoritativeResumeConfig: true,
                sandboxGpu: opts.sandboxGpu,
                sandboxGpuDevice: opts.sandboxGpuDevice,
                gpu: opts.gpu,
                noGpu: opts.noGpu,
                optedOutGpuPassthrough: opts.optedOutGpuPassthrough,
              },
              {
                nonInteractive: true,
                exitProcess: (code) =>
                  fail(`onboard runtime preflight exited with code ${String(code)}`),
              },
            );
          },
          ensureOpenshell: () =>
            deps.ensureOpenshell((code) =>
              fail(`OpenShell component preflight exited with code ${String(code)}`),
            ),
          preflightResourceProfile: (profile) =>
            preflightAuthoritativeResourceProfile(profile, deps.getOpenshellBinary()),
          prepareGatewayTransport: async () => {
            if (!isLinuxDockerDriverGatewayEnabled()) {
              if (gatewayCliSupportsLifecycleCommands(deps.runCaptureOpenshell)) {
                const containerState = verifyGatewayContainerRunning(authoritativeGateway.name);
                if (containerState !== "running") {
                  fail(
                    `Target gateway '${authoritativeGateway.name}' legacy container state is '${containerState}'.`,
                  );
                }
                const imageDrift = getGatewayClusterImageDrift({
                  gatewayName: authoritativeGateway.name,
                });
                if (imageDrift) {
                  fail(
                    `Target gateway '${authoritativeGateway.name}' image ${imageDrift.currentVersion} does not match OpenShell ${imageDrift.expectedVersion}.`,
                  );
                }
              }
              if (!(await deps.isGatewayHttpReady())) {
                fail(`Target gateway '${authoritativeGateway.name}' is not HTTP-ready.`);
              }
              return;
            }
            const gatewayBin =
              deps.resolveOpenShellGatewayBinary() ||
              fail("OpenShell gateway binary is unavailable for mTLS preflight.");
            const stateDir = deps.getDockerDriverGatewayStateDir();
            dockerDriverGatewayLocalTls.ensureDockerDriverGatewayLocalTlsBundle({
              gatewayBin,
              stateDir,
            });
            const gatewayEnv = deps.getDockerDriverGatewayEnv(
              deps.runCaptureOpenshell(["--version"], { ignoreError: true }),
            );
            dockerDriverGatewayEnv.assertDockerDriverGatewayAuthConfigSafe(gatewayEnv);
            const runtimeIdentity =
              dockerDriverGatewayLaunch.buildDockerDriverGatewayRuntimeIdentity({
                gatewayBin,
                gatewayEnv,
                stateDir,
                sandboxBin: deps.resolveOpenShellSandboxBinary(),
                compatContainerName: gatewayBinding.resolveGatewayCompatContainerName(
                  authoritativeGateway.port,
                ),
              });
            const gatewayPid = deps.getDockerDriverGatewayPid();
            if (gatewayPid === null || !deps.isDockerDriverGatewayProcessAlive()) {
              fail(`Target gateway '${authoritativeGateway.name}' has no live recorded runtime.`);
            }
            const verifiedGatewayPid = gatewayPid ?? fail("Target gateway runtime PID is missing.");
            const drift = deps.getDockerDriverGatewayRuntimeDrift(
              verifiedGatewayPid,
              runtimeIdentity.desiredEnv,
              dockerDriverGatewayLaunch.resolveDriftGatewayBin(runtimeIdentity, gatewayBin),
            );
            if (drift) {
              fail(`Target gateway '${authoritativeGateway.name}' runtime drift: ${drift.reason}`);
            }
            const localTlsDir =
              gatewayEnv.OPENSHELL_LOCAL_TLS_DIR?.trim() ||
              fail("Target gateway mTLS directory is unavailable.");
            env.OPENSHELL_LOCAL_TLS_DIR = localTlsDir;
            if (!(await deps.isDockerDriverGatewayHttpReady())) {
              fail(`Target gateway '${authoritativeGateway.name}' is not HTTPS/mTLS-ready.`);
            }
          },
          inferenceRouteReady: deps.inferenceRouteReady,
          captureForwardList: () =>
            deps.runCaptureOpenshell(["forward", "list"], { ignoreError: true }),
          checkPort: deps.checkPort,
          env,
        },
      );
      if (!runtimeResult) {
        throw new Error("Authoritative runtime preflight did not return a result");
      }
      return runtimeResult;
    } finally {
      deps.setRuntimeState(previous);
    }
  };
}
