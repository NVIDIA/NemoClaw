// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellSandboxBufferedCommandExecutor } from "../../adapters/openshell/sandbox-command";
import { loadAgent } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";
import {
  LaunchReadinessObservationError,
  requireLaunchSemanticHealth,
  type LaunchReadinessHealthDeps,
} from "./launch-readiness/health";
import { isSandboxGatewayRunningForStatus } from "./process-recovery";

describe("launch-readiness gateway health scope", () => {
  it("pins the semantic gateway probe to the owning OpenShell gateway (#8942)", async () => {
    const runBuffered = vi.fn<OpenShellSandboxBufferedCommandExecutor["runBuffered"]>(async () => ({
      outcome: { kind: "completed", exitCode: 0 },
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    }));

    await expect(
      isSandboxGatewayRunningForStatus("alpha", "nemoclaw-8091", {
        getSessionAgent: () => null,
        getHealthProbeUrl: () => "http://127.0.0.1:18789/health",
        commandExecutor: { runBuffered },
      }),
    ).resolves.toBe(true);

    expect(runBuffered).toHaveBeenCalledTimes(1);
    expect(runBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "alpha",
        target: { kind: "named", gatewayName: "nemoclaw-8091" },
        command: ["sh", "-c", expect.stringContaining("http://127.0.0.1:18789/health")],
      }),
    );
  });

  it("pins Hermes readiness checks to its recorded OpenShell gateway (#10302)", async () => {
    const gatewayHealth = vi.fn(async () => true);
    const forwardsHealthy = vi.fn(() => true);
    const inferenceProbe = vi.fn(async () => ({
      healthy: true,
      broken: false,
      httpStatus: 200,
      detail: "OK 200",
    }));
    const agent = loadAgent("hermes");
    const entry = {
      name: "alpha",
      agent: "hermes",
      provider: "ollama-local",
      model: "nemotron-3-nano:30b",
    } as SandboxEntry;

    await expect(
      requireLaunchSemanticHealth("alpha", "nemoclaw-19080", "hermes", entry, agent, true, {
        gatewayHealth,
        forwardsHealthy,
        inferenceProbe,
      }),
    ).resolves.toBeUndefined();

    expect(gatewayHealth).toHaveBeenCalledWith("alpha", "nemoclaw-19080");
    expect(gatewayHealth).toHaveBeenCalledOnce();
    expect(forwardsHealthy).toHaveBeenCalledWith("alpha", "nemoclaw-19080");
    expect(forwardsHealthy).toHaveBeenCalledOnce();
    expect(inferenceProbe).toHaveBeenCalledWith("alpha", agent, "nemoclaw-19080");
    expect(inferenceProbe).toHaveBeenCalledOnce();
  });
});

const SANDBOX = "alpha";
const GATEWAY = "nemoclaw";
const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const dcodeAgent = loadAgent("langchain-deepagents-code");

function dcodeEntry(): SandboxEntry {
  return {
    name: SANDBOX,
    agent: "langchain-deepagents-code",
    provider: "openrouter-api",
    model: MODEL,
    preferredInferenceApi: null,
  } as SandboxEntry;
}

function dcodeHealthDeps(
  invocation: Awaited<
    ReturnType<NonNullable<LaunchReadinessHealthDeps["inferenceInvocationProbe"]>>
  >,
): LaunchReadinessHealthDeps {
  return {
    smoke: vi.fn(async () => ({ ok: true }) as const),
    inferenceProbe: vi.fn(async () => ({
      healthy: true,
      broken: false,
      httpStatus: 404,
      detail: "OK 404",
    })),
    inferenceInvocationProbe: vi.fn(async () => invocation),
  };
}

describe("Deep Agents Code OpenRouter launch readiness", () => {
  it("accepts an injected terminal smoke without constructing a command executor", async () => {
    const smoke = vi.fn(async () => ({ ok: true }) as const);

    await expect(
      requireLaunchSemanticHealth(
        SANDBOX,
        GATEWAY,
        "langchain-deepagents-code",
        dcodeEntry(),
        dcodeAgent,
        false,
        { smoke },
      ),
    ).resolves.toBeUndefined();

    expect(smoke).toHaveBeenCalledWith(SANDBOX, dcodeAgent);
  });

  it("accepts readiness after an inference request succeeds (#9834)", async () => {
    const currentDeps = dcodeHealthDeps({ ok: true });

    await expect(
      requireLaunchSemanticHealth(
        SANDBOX,
        GATEWAY,
        "langchain-deepagents-code",
        dcodeEntry(),
        dcodeAgent,
        true,
        currentDeps,
      ),
    ).resolves.toBeUndefined();
    expect(currentDeps.inferenceInvocationProbe).toHaveBeenCalledWith({
      sandboxName: SANDBOX,
      gatewayName: GATEWAY,
      agentName: "langchain-deepagents-code",
      provider: "openrouter-api",
      model: MODEL,
      preferredInferenceApi: null,
    });
  });

  it("rejects readiness and names the inference request when invocation fails (#9834)", async () => {
    const currentDeps = dcodeHealthDeps({
      ok: false,
      detail: "sandbox inference invocation probe returned HTTP 401",
      httpStatus: 401,
    });

    await expect(
      requireLaunchSemanticHealth(
        SANDBOX,
        GATEWAY,
        "langchain-deepagents-code",
        dcodeEntry(),
        dcodeAgent,
        true,
        currentDeps,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LaunchReadinessObservationError>>({
        category: "health",
        failedCheck: "inference request",
      }),
    );
  });
});
