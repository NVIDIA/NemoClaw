// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import type { ArtifactSink } from "../artifacts.ts";
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

// Mirror of `src/lib/state/registry.ts::REGISTRY_FILE`. The fixture
// owns its own copy because the fixture code must not import from
// `src/lib/**` (CLI source) — that boundary keeps the live runner
// honest about probing only host-observable state.
const NEMOCLAW_REGISTRY_RELPATH = [".nemoclaw", "sandboxes.json"] as const;
const OPENSHELL_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";

export interface ProbeIO {
  readRegistry?(): { entries: Record<string, unknown> } | null;
}

function defaultRegistryPath(): string {
  const home = process.env.HOME ?? os.homedir();
  return path.join(home, ...NEMOCLAW_REGISTRY_RELPATH);
}

function defaultReadRegistry(): { entries: Record<string, unknown> } | null {
  const file = defaultRegistryPath();
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { entries: {} };
    const entries = (parsed as { sandboxes?: Record<string, unknown> }).sandboxes;
    return { entries: entries && typeof entries === "object" ? entries : {} };
  } catch {
    return { entries: {} };
  }
}

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
  private readonly io: ProbeIO;

  constructor(
    private readonly host: HostCliClient,
    private readonly gateway: GatewayClient,
    private readonly sandbox: SandboxClient,
    io: ProbeIO = {},
    private readonly artifacts?: ArtifactSink,
  ) {
    this.io = io;
  }

  async from(
    expectedState: string | ExpectedState,
    instance?: NemoClawInstance,
  ): Promise<StateValidationResult> {
    try {
      const state =
        typeof expectedState === "string" ? requireExpectedState(expectedState) : expectedState;
      const probes: StateValidationProbeResult[] = [];
      for (const probe of probesForState(state)) {
        probes.push(await this.runProbe(probe, instance));
      }
      const result = { state, probes };
      await this.writeResult("passed", state, result);
      return result;
    } catch (error) {
      const stateId = typeof expectedState === "string" ? expectedState : expectedState.id;
      await this.writeResult("failed", stateId, undefined, error);
      throw error;
    }
  }

  private async writeResult(
    status: "passed" | "failed",
    expectedState: string | ExpectedState,
    result?: StateValidationResult,
    error?: unknown,
  ): Promise<void> {
    await this.artifacts?.writeJson("state-validation.result.json", {
      phase: "state-validation",
      status,
      expectedStateId: typeof expectedState === "string" ? expectedState : expectedState.id,
      probes: result?.probes.map((probe) => probe.id) ?? [],
      ...(error ? { error: errorMessage(error) } : {}),
    });
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
      case "local-registry-entry-present":
        return this.expectLocalRegistryEntryPresent(requireInstance(probe, instance));
      case "docker-sandbox-container-present":
        return await this.expectDockerSandboxContainerPresent(requireInstance(probe, instance));
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

  private expectLocalRegistryEntryPresent(instance: NemoClawInstance): StateValidationProbeResult {
    const reader = this.io.readRegistry ?? defaultReadRegistry;
    const registry = reader();
    if (!registry) {
      throw new Error(
        `state-validation expected local registry entry for '${instance.sandboxName}', ` +
          `but ${defaultRegistryPath()} does not exist.`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(registry.entries, instance.sandboxName)) {
      const present = Object.keys(registry.entries).sort().join(", ") || "(none)";
      throw new Error(
        `state-validation expected local registry entry for '${instance.sandboxName}', ` +
          `but the registry contains: ${present}.`,
      );
    }
    return { id: "local-registry-entry-present", status: "passed", results: [] };
  }

  private async expectDockerSandboxContainerPresent(
    instance: NemoClawInstance,
  ): Promise<StateValidationProbeResult> {
    const result = await this.host.command(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${instance.sandboxName}`,
        "--format",
        "{{.Names}}",
      ],
      {
        artifactName: `docker-sandbox-container-present-${instance.sandboxName}`,
        env: statusProbeEnv(),
        timeoutMs: 15_000,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `state-validation could not query Docker for label '${OPENSHELL_SANDBOX_NAME_LABEL}=${instance.sandboxName}' ` +
          `(exit ${result.exitCode}).`,
      );
    }
    const names = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (names.length === 0) {
      throw new Error(
        `state-validation expected at least one Docker container labeled ` +
          `'${OPENSHELL_SANDBOX_NAME_LABEL}=${instance.sandboxName}' (running, stopped, or ` +
          `*-nemoclaw-gpu-backup-* sibling), but docker ps -a returned none.`,
      );
    }
    return { id: "docker-sandbox-container-present", status: "passed", results: [result] };
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
