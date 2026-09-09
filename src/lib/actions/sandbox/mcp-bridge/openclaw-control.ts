// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import type { AgentDefinition } from "../../../agent/defs";
import { captureSanitizedResolvedOpenshell } from "../../../adapters/openshell/sanitized-capture";
import { buildOpenShellRuntimeSelectionEnv } from "../../../adapters/openshell/runtime-selection";
import { buildOpenShellSubprocessEnv } from "../../../adapters/openshell/resolve-shared";
import { openExistingGatewayConfigAuthority } from "../../../onboard/docker-driver-gateway-config";
import { readDockerDriverGatewayProcessEnvironment } from "../../../onboard/docker-driver-gateway-process-identity";
import {
  getDockerDriverGatewayRuntimeMarkerPath,
  parseDockerDriverGatewayRuntimeMarker,
  readOwnedDockerDriverGatewayRuntimeFile,
} from "../../../onboard/docker-driver-gateway-runtime-marker";
import { scopedHostGatewayProcessOwnershipFailure } from "../../../onboard/host-gateway-process";
import { resolveGatewayCredentialMutationAuthority } from "../../../onboard/gateway-teardown-authority";
import { sameGatewayOwner } from "../../../onboard/gateway-ownership";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../../../onboard/runtime-provider/current";
import {
  createDockerOperationAuthority,
  captureDockerOperationCommand,
} from "../../../onboard/runtime-provider/docker-operation-authority";
import { createLiveDockerPrivilegedSandboxControl } from "../../../onboard/runtime-provider/docker-privileged-sandbox-control";
import type { SandboxConfigExecutionContext } from "../../../sandbox/config";
import { getSandboxAgent, type McpOperationTarget } from "../mcp-bridge-state";

function refuse(): never {
  throw new Error(
    "The live OpenClaw MCP target has no unchanged, qualified privileged runtime authority.",
  );
}

function inspectDriver(target: McpOperationTarget): string {
  const result = captureSanitizedResolvedOpenshell(
    ["gateway", "info", "-g", target.runtimeSelection.gatewayName, "-o", "json"],
    {
      ignoreError: true,
      includeStreams: true,
      includeStderr: true,
      timeout: 20_000,
      maxBuffer: 64 * 1024,
      env: buildOpenShellRuntimeSelectionEnv(
        buildOpenShellSubprocessEnv() as Record<string, string>,
        target.runtimeSelection,
      ),
      replaceEnv: true,
    },
  );
  let value;
  try {
    value = JSON.parse(result.stdout ?? result.output);
  } catch {
    refuse();
  }
  const drivers = value?.compute_drivers;
  if (
    result.status !== 0 ||
    result.error ||
    value.gateway !== target.runtimeSelection.gatewayName ||
    !Array.isArray(drivers) ||
    drivers.length !== 1 ||
    drivers[0]?.name !== "docker" ||
    drivers[0]?.capabilities?.driver_name !== "docker"
  )
    refuse();
  return drivers[0].name;
}

export interface McpOpenClawControl {
  readonly config: SandboxConfigExecutionContext;
  readonly agentConfigDependencies: {
    getSandbox: () => { agent: string };
    loadAgent: (name: string) => AgentDefinition;
  };
  readonly agent: AgentDefinition;
  close(): void;
}

/** Bind live OpenShell identity to the existing config guard and root controller. */
function openLiveMcpOpenClawControl(target?: McpOperationTarget): McpOpenClawControl | undefined {
  if (!target?.liveIdentity) return undefined;
  const live = target.liveIdentity;
  const assertRuntimeResource = live.assertRuntimeResource;
  if (!assertRuntimeResource) refuse();
  live.assertCurrent();
  const { sandbox, runtimeSelection } = target;
  if (
    sandbox.agent !== "openclaw" ||
    !sandbox.gatewayPort ||
    !runtimeSelection.localTlsDir ||
    runtimeSelection.workspace !== "default"
  )
    refuse();
  const gatewayTarget = {
    gatewayName: runtimeSelection.gatewayName,
    gatewayPort: sandbox.gatewayPort,
  };
  const owner = resolveGatewayCredentialMutationAuthority(gatewayTarget);
  if (owner.mode !== "nemoclaw-managed") refuse();
  const stateDir = owner.stateDir ?? path.dirname(runtimeSelection.localTlsDir);
  if (runtimeSelection.localTlsDir !== path.join(stateDir, "tls")) refuse();
  const driver = inspectDriver(target);
  const provider = CURRENT_RUNTIME_PROVIDER_BUNDLES[driver];
  if (!provider?.gateway.supported || !provider.lifecycle.supported) refuse();
  const uid = process.getuid?.();
  if (uid === undefined) refuse();
  const markerPath = getDockerDriverGatewayRuntimeMarkerPath(stateDir);
  const markerBytes = readOwnedDockerDriverGatewayRuntimeFile(markerPath, uid);
  const marker = markerBytes ? parseDockerDriverGatewayRuntimeMarker(markerBytes) : null;
  if (!marker || marker.driver !== driver || marker.pid <= 0) refuse();
  const dockerHost = marker.dockerHost ?? "unix:///var/run/docker.sock";
  if (!/^unix:\/\/\/[^\s\u0000-\u001f\u007f]+$/u.test(dockerHost)) refuse();
  const environment: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: dockerHost };
  delete environment.DOCKER_CONTEXT;
  delete environment.DOCKER_TLS;
  delete environment.DOCKER_TLS_VERIFY;
  delete environment.DOCKER_CERT_PATH;
  const runtime = provider.gateway.observeHostRuntime({ environment, platform: process.platform });
  const configProof = openExistingGatewayConfigAuthority(stateDir, runtime);
  const assertCurrent = () => {
    live.assertCurrent();
    configProof.assertCurrent();
    if (
      !sameGatewayOwner(owner, resolveGatewayCredentialMutationAuthority(gatewayTarget)) ||
      readOwnedDockerDriverGatewayRuntimeFile(markerPath, uid) !== markerBytes ||
      scopedHostGatewayProcessOwnershipFailure(
        { env: environment },
        {
          stateDir,
          gatewayBin: marker.gatewayBin,
          openShellGatewayName: gatewayTarget.gatewayName,
          openShellGatewayPort: gatewayTarget.gatewayPort,
        },
      )
    )
      refuse();
    const loaded = readDockerDriverGatewayProcessEnvironment(marker.pid);
    if (
      !loaded ||
      loaded.OPENSHELL_GATEWAY_CONFIG !== configProof.configPath ||
      (loaded.DOCKER_HOST?.trim() || null) !== marker.dockerHost
    )
      refuse();
  };
  try {
    assertCurrent();
    if (
      !configProof.sandboxNamespace ||
      configProof.driver !== driver ||
      configProof.socketPath !== null
    )
      refuse();
    const authority = createDockerOperationAuthority("sandbox-lifecycle", environment);
    const assertAuthority = () => {
      assertCurrent();
      authority.assertAuthority();
    };
    const control = createLiveDockerPrivilegedSandboxControl({
      engine: authority.engine,
      captureCommand: (args, options) => {
        const result = captureDockerOperationCommand(authority, args, options);
        return {
          status: result.status,
          signal: result.signal,
          stdout: result.stdout ?? Buffer.alloc(0),
          stderr: result.stderr ?? Buffer.alloc(0),
          ...(result.error ? { error: result.error } : {}),
        };
      },
      sandboxName: sandbox.name,
      sandboxId: live.sandboxId,
      workspace: runtimeSelection.workspace,
      sandboxNamespace: configProof.sandboxNamespace,
      assertCurrent: assertAuthority,
    });
    const selectedResource = control.resolveTarget({
      sandbox,
      sandboxName: sandbox.name,
      registeredSandboxNames: [sandbox.name],
    });
    assertRuntimeResource(selectedResource.providerId, selectedResource.resourceHandle);
    const privileged = {
      sandbox: { ...sandbox, openshellDriver: driver },
      control,
      assertCurrent: () => {
        const current = control.resolveTarget({
          sandbox,
          sandboxName: sandbox.name,
          registeredSandboxNames: [sandbox.name],
        });
        assertRuntimeResource(current.providerId, current.resourceHandle);
      },
    };
    const agent = getSandboxAgent(sandbox);
    return {
      config: {
        runtimeSelection,
        privileged,
        commandEnvironment: Object.freeze(
          buildOpenShellRuntimeSelectionEnv(
            buildOpenShellSubprocessEnv() as Record<string, string>,
            runtimeSelection,
          ),
        ),
      },
      agent,
      agentConfigDependencies: {
        getSandbox: () => ({ agent: agent.name }),
        loadAgent: (name) => (name === agent.name ? agent : refuse()),
      },
      close: () => configProof.close(),
    };
  } catch (error) {
    configProof.close();
    throw error;
  }
}

/** Never expose private gateway config/parser content in command diagnostics. */
export function openMcpOpenClawControl(
  target?: McpOperationTarget,
): McpOpenClawControl | undefined {
  try {
    return openLiveMcpOpenClawControl(target);
  } catch {
    return refuse();
  }
}
