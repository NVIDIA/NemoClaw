// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayClient, HostCliClient, SandboxClient } from "../clients/index.ts";
import type { ShellProbeResult } from "../shell-probe.ts";
import { probesForState, requireExpectedState } from "../../scenarios/expected-states.ts";
import type { ExpectedState, StateProbeId } from "../../scenarios/types.ts";
import type { NemoClawInstance } from "./onboarding.ts";

export interface StateValidationProbeResult {
  id: StateProbeId;
  status: "passed";
  results: ShellProbeResult[];
}

export interface StateValidationResult {
  state: ExpectedState;
  probes: StateValidationProbeResult[];
}

function requireInstance(probe: StateProbeId, instance: NemoClawInstance | undefined): NemoClawInstance {
  if (!instance) {
    throw new Error(`state-validation probe '${probe}' requires a NemoClaw instance.`);
  }
  return instance;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function outputContainsSandbox(result: ShellProbeResult, sandboxName: string): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return new RegExp(`(^|\\s)${escapeRegExp(sandboxName)}(\\s|$)`, "m").test(output);
}

export class StateValidationPhaseFixture {
  constructor(
    private readonly host: HostCliClient,
    private readonly gateway: GatewayClient,
    private readonly sandbox: SandboxClient,
  ) {}

  async from(expectedStateId: string, instance?: NemoClawInstance): Promise<StateValidationResult> {
    const state = requireExpectedState(expectedStateId);
    const probes: StateValidationProbeResult[] = [];
    for (const probe of probesForState(state)) {
      probes.push(await this.runProbe(probe, instance));
    }
    return { state, probes };
  }

  private async runProbe(probe: StateProbeId, instance: NemoClawInstance | undefined): Promise<StateValidationProbeResult> {
    switch (probe) {
      case "cli-installed":
        return await this.expectCliInstalled();
      case "gateway-healthy":
        return await this.expectGatewayHealthy();
      case "gateway-absent":
        return await this.expectGatewayAbsent();
      case "sandbox-running":
        return await this.expectSandboxRunning(requireInstance(probe, instance));
      case "sandbox-absent":
        return await this.expectSandboxAbsent(requireInstance(probe, instance));
      default: {
        const _exhaustive: never = probe;
        throw new Error(`Unsupported state-validation probe '${_exhaustive}'.`);
      }
    }
  }

  private async expectCliInstalled(): Promise<StateValidationProbeResult> {
    const result = await this.host.expectNemoclawAvailable();
    return { id: "cli-installed", status: "passed", results: [result] };
  }

  private async expectGatewayHealthy(): Promise<StateValidationProbeResult> {
    const result = await this.gateway.expectHealthy({ inheritEnv: true });
    return { id: "gateway-healthy", status: "passed", results: [result] };
  }

  private async expectGatewayAbsent(): Promise<StateValidationProbeResult> {
    const result = await this.gateway.status({
      artifactName: "gateway-absent-status",
      inheritEnv: true,
    });
    if (result.exitCode === 0) {
      throw new Error("state-validation expected gateway to be absent, but 'nemoclaw gateway status' succeeded.");
    }
    return { id: "gateway-absent", status: "passed", results: [result] };
  }

  private async expectSandboxRunning(instance: NemoClawInstance): Promise<StateValidationProbeResult> {
    const result = await this.sandbox.expectRunning(instance.sandboxName, { inheritEnv: true });
    return { id: "sandbox-running", status: "passed", results: [result] };
  }

  private async expectSandboxAbsent(instance: NemoClawInstance): Promise<StateValidationProbeResult> {
    const results: ShellProbeResult[] = [];
    const nemoclawList = await this.host.nemoclaw(["list"], {
      artifactName: "sandbox-absent-nemoclaw-list",
      inheritEnv: true,
    });
    results.push(nemoclawList);
    if (nemoclawList.exitCode === 0 && outputContainsSandbox(nemoclawList, instance.sandboxName)) {
      throw new Error(`state-validation expected sandbox '${instance.sandboxName}' to be absent, but nemoclaw listed it.`);
    }

    let openshellList: ShellProbeResult | undefined;
    try {
      openshellList = await this.sandbox.list({
        artifactName: "sandbox-absent-openshell-list",
        inheritEnv: true,
      });
    } catch {
      // Bridge tolerance for negative preflight states: `nemoclaw list` is the
      // user-facing registry authority, while OpenShell may be absent before any
      // sandbox setup happens. Once the fixture has a typed OpenShell
      // availability probe, make this path fail closed.
    }
    if (openshellList) {
      results.push(openshellList);
      if (openshellList.exitCode === 0 && outputContainsSandbox(openshellList, instance.sandboxName)) {
        throw new Error(`state-validation expected sandbox '${instance.sandboxName}' to be absent, but OpenShell listed it.`);
      }
    }

    return { id: "sandbox-absent", status: "passed", results };
  }
}
