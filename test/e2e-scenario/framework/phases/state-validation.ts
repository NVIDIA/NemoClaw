// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import {
  trustedProviderEndpoint,
  type GatewayClient,
  type HostCliClient,
  type SandboxClient,
} from "../clients/index.ts";
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

function requireInstance(
  probe: StateProbeId,
  instance: NemoClawInstance | undefined,
): NemoClawInstance {
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

function statusProbeEnv(): NodeJS.ProcessEnv {
  return buildAvailabilityProbeEnv();
}

function gatewayHealthEndpoint(gatewayUrl: string): string {
  return trustedProviderEndpoint(`${gatewayUrl.replace(/\/+$/, "")}/health`).url;
}

function gatewayBaseEndpoint(gatewayUrl: string): string {
  return trustedProviderEndpoint(gatewayUrl).url;
}

function resultHttpCode(result: ShellProbeResult): string {
  return result.stdout.trim();
}

function resultHasHttpCode(result: ShellProbeResult, allowedCodes: readonly string[]): boolean {
  return result.exitCode === 0 && allowedCodes.includes(resultHttpCode(result));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingOpenShellError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ENOENT" || /\bENOENT\b/.test(errorMessage(error));
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

  private async runProbe(
    probe: StateProbeId,
    instance: NemoClawInstance | undefined,
  ): Promise<StateValidationProbeResult> {
    switch (probe) {
      case "cli-installed":
        return await this.expectCliInstalled();
      case "gateway-healthy":
        return await this.expectGatewayHealthy(requireInstance(probe, instance));
      case "gateway-absent":
        return await this.expectGatewayAbsent(requireInstance(probe, instance));
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

  private curlHttpStatus(
    url: string,
    artifactName: string,
    maxTimeSeconds: string,
  ): Promise<ShellProbeResult> {
    return this.host.command(
      "curl",
      ["-fsS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", maxTimeSeconds, url],
      {
        artifactName,
        env: statusProbeEnv(),
        redactionValues: [url],
      },
    );
  }

  private async expectGatewayHealthy(
    instance: NemoClawInstance,
  ): Promise<StateValidationProbeResult> {
    const results: ShellProbeResult[] = [];
    const health = await this.curlHttpStatus(
      gatewayHealthEndpoint(instance.gatewayUrl),
      "gateway-health",
      "5",
    );
    results.push(health);
    if (resultHasHttpCode(health, ["200"])) {
      return { id: "gateway-healthy", status: "passed", results };
    }

    const base = await this.curlHttpStatus(
      gatewayBaseEndpoint(instance.gatewayUrl),
      "gateway-base",
      "5",
    );
    results.push(base);
    if (resultHasHttpCode(base, ["200", "204"])) {
      return { id: "gateway-healthy", status: "passed", results };
    }

    if ((instance.platformOs ?? "ubuntu") === "ubuntu" && instance.provider === "ollama") {
      const sandboxLocal = await this.sandbox.exec(
        instance.sandboxName,
        [
          "curl",
          "-sS",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "--max-time",
          "5",
          "http://localhost:18789/health",
        ],
        {
          artifactName: "gateway-sandbox-local-health",
          env: statusProbeEnv(),
          timeoutMs: 15_000,
        },
      );
      results.push(sandboxLocal);
      if (resultHasHttpCode(sandboxLocal, ["200", "401"])) {
        return { id: "gateway-healthy", status: "passed", results };
      }
    }

    const last = results.at(-1) ?? base;
    throw new Error(
      `state-validation expected gateway '${instance.gatewayUrl}' to be healthy, ` +
        `but HTTP probes failed (last http_code=${resultHttpCode(last) || "000"}).`,
    );
  }

  private async expectGatewayAbsent(
    instance: NemoClawInstance,
  ): Promise<StateValidationProbeResult> {
    const result = await this.gateway.status({
      artifactName: "gateway-absent-status",
      env: statusProbeEnv(),
    });
    if (result.exitCode === 0) {
      throw new Error(
        "state-validation expected gateway to be absent, but 'nemoclaw gateway status' succeeded.",
      );
    }
    const healthUrl = gatewayHealthEndpoint(instance.gatewayUrl);
    const health = await this.curlHttpStatus(healthUrl, "gateway-absent-health", "3");
    if (health.exitCode === 0) {
      throw new Error(
        `state-validation expected gateway to be absent, but ${healthUrl} responded healthy.`,
      );
    }
    return { id: "gateway-absent", status: "passed", results: [result, health] };
  }

  private async expectSandboxRunning(
    instance: NemoClawInstance,
  ): Promise<StateValidationProbeResult> {
    const result = await this.host.nemoclaw(["list"], {
      artifactName: "sandbox-running-nemoclaw-list",
      env: statusProbeEnv(),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        "state-validation expected sandbox to be running, but 'nemoclaw list' failed.",
      );
    }
    if (!outputContainsSandbox(result, instance.sandboxName)) {
      throw new Error(
        `state-validation expected sandbox '${instance.sandboxName}' to be running, but nemoclaw did not list it.`,
      );
    }
    return { id: "sandbox-running", status: "passed", results: [result] };
  }

  private async expectSandboxAbsent(
    instance: NemoClawInstance,
  ): Promise<StateValidationProbeResult> {
    const results: ShellProbeResult[] = [];
    const nemoclawList = await this.host.nemoclaw(["list"], {
      artifactName: "sandbox-absent-nemoclaw-list",
      env: statusProbeEnv(),
    });
    results.push(nemoclawList);
    if (nemoclawList.exitCode === 0 && outputContainsSandbox(nemoclawList, instance.sandboxName)) {
      throw new Error(
        `state-validation expected sandbox '${instance.sandboxName}' to be absent, but nemoclaw listed it.`,
      );
    }

    let openshellList: ShellProbeResult | undefined;
    try {
      openshellList = await this.sandbox.list({
        artifactName: "sandbox-absent-openshell-list",
        env: statusProbeEnv(),
      });
    } catch (error) {
      if (!isMissingOpenShellError(error)) {
        throw new Error(
          `state-validation could not verify OpenShell sandbox absence: ${errorMessage(error)}`,
        );
      }
      // Bridge tolerance for negative preflight states: `nemoclaw list` is the
      // user-facing registry authority, while OpenShell may be absent before any
      // sandbox setup happens. Once the fixture has a typed OpenShell
      // availability probe, make this path fail closed.
    }
    if (openshellList) {
      results.push(openshellList);
      if (
        openshellList.exitCode === 0 &&
        outputContainsSandbox(openshellList, instance.sandboxName)
      ) {
        throw new Error(
          `state-validation expected sandbox '${instance.sandboxName}' to be absent, but OpenShell listed it.`,
        );
      }
    }

    return { id: "sandbox-absent", status: "passed", results };
  }
}
