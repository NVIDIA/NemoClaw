// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { observeSwitchyardPreflight } from "../../../onboard/switchyard/preflight";
import type { OpenShellSandboxBufferedCommandExecutor } from "../../../adapters/openshell/sandbox-command";
import { executeSandboxExecCommand } from "../../../adapters/sandbox/command-transport";
import { probeSandboxInferenceInvocation } from "../inference-invocation-probe";
import {
  runSandboxInferenceInvocationProbe,
  verifyRegisteredStatusAttachment,
} from "../inference-route-health";
import type { LaunchReadinessHealthDeps, LaunchReadinessBoundCapture } from "./health";

import { createSynchronousCliOpenShellInferenceRouteObserver } from "../../../adapters/openshell/inference-route-cli";
import type { OpenShellInferenceRouteObserver } from "../../../adapters/openshell/inference-route";
import type { SandboxRecreateObserver } from "../../../onboard/sandbox-recreate-probe";

import {
  buildSandboxInferenceRouteProbeRequest,
  parseSandboxInferenceRouteProbeResult,
  type InferenceRouteProbeAgent,
} from "../connect-inference-route-probe";

/** Retain the caller's command owner for registered-provider readiness. */
function createBoundRegisteredReadinessDeps(
  capture: LaunchReadinessBoundCapture,
  commandExecutor: OpenShellSandboxBufferedCommandExecutor,
  timeoutMs: number,
): Pick<LaunchReadinessHealthDeps, "verifyRegisteredAttachment" | "inferenceInvocationProbe"> {
  const boundExecutor: OpenShellSandboxBufferedCommandExecutor = {
    runBuffered: ({ environment: _ambientEnvironment, ...request }) =>
      commandExecutor.runBuffered(request),
  };
  return {
    verifyRegisteredAttachment: (input) =>
      verifyRegisteredStatusAttachment(input, undefined, {
        run: capture,
        defaultTimeoutMs: timeoutMs,
      }),
    inferenceInvocationProbe: (input) =>
      runSandboxInferenceInvocationProbe(
        input,
        input.registeredInferenceProviderAttachment
          ? (request, _deps, timeout) =>
              probeSandboxInferenceInvocation(
                request,
                {
                  commandExecutor: boundExecutor,
                  execute: (name, command, deadline, options) =>
                    executeSandboxExecCommand(name, command, deadline, {
                      ...options,
                      honorCallerTimeout: true,
                      commandExecutor: boundExecutor,
                    }),
                },
                timeout,
              )
          : probeSandboxInferenceInvocation,
      ),
  };
}

/** Bind the route observer to the caller capture owner. */
export function createLaunchReadinessInferenceRouteObserver(
  capture: LaunchReadinessBoundCapture,
): OpenShellInferenceRouteObserver {
  return createSynchronousCliOpenShellInferenceRouteObserver(capture);
}

/** Route readiness observations through the caller command owner. */
type BoundObservationOwners = {
  capture: LaunchReadinessBoundCapture;
  commandExecutor: OpenShellSandboxBufferedCommandExecutor;
  observeSandbox: SandboxRecreateObserver;
  gatewayHealth: NonNullable<LaunchReadinessHealthDeps["gatewayHealth"]>;
  forwardsHealthy: NonNullable<LaunchReadinessHealthDeps["forwardsHealthy"]>;
  timeoutMs: number;
  inferenceTimeoutMs: number;
};

export function createBoundReadinessObservations(
  owners: BoundObservationOwners,
): LaunchReadinessHealthDeps & { observeSandbox: SandboxRecreateObserver } {
  const { capture, commandExecutor } = owners;
  return {
    ...createBoundRegisteredReadinessDeps(capture, commandExecutor, owners.timeoutMs),
    capture: (args, options) =>
      capture(args, {
        ...options,
        ignoreError: options?.ignoreError ?? true,
        timeout: options?.timeout ?? owners.timeoutMs,
      }),
    inferenceRouteObserver: createLaunchReadinessInferenceRouteObserver(capture),
    switchyardPreflight: (entry, sandboxName) =>
      observeSwitchyardPreflight(entry, sandboxName, {
        providerCommand: capture,
      }),
    observeSandbox: owners.observeSandbox,
    gatewayHealth: owners.gatewayHealth,
    forwardsHealthy: owners.forwardsHealthy,
    inferenceProbe: (name, agent, gateway) =>
      probeInferenceRoute(name, agent, gateway, commandExecutor, owners.inferenceTimeoutMs),
    commandExecutor,
  };
}

export async function probeInferenceRoute(
  sandboxName: string,
  agent: InferenceRouteProbeAgent,
  gatewayName: string,
  commandExecutor: OpenShellSandboxBufferedCommandExecutor,
  timeoutMs: number,
): Promise<ReturnType<typeof parseSandboxInferenceRouteProbeResult>> {
  const completed = await commandExecutor.runBuffered(
    buildSandboxInferenceRouteProbeRequest(sandboxName, agent, gatewayName, timeoutMs),
  );
  return parseSandboxInferenceRouteProbeResult({
    status: completed.outcome.kind === "completed" ? completed.outcome.exitCode : null,
    output: completed.stdout,
    stderr:
      completed.outcome.kind === "completed"
        ? completed.stderr
        : completed.stderr || completed.outcome.error.message,
  });
}
