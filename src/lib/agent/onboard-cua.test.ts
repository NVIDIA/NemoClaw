// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type CuaRuntimeTestFixture,
  createCuaRuntimeTestFixture,
} from "../cua/runtime-test-fixture";
import { loadAgent } from "./defs";
import { getAgentPolicyPath, handleAgentSetup, type OnboardContext, resolveAgent } from "./onboard";

const fixtures: CuaRuntimeTestFixture[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

describe("NemoCUA agent onboarding", () => {
  it("cannot consume the external policy after the CUA gate is disabled (#7755)", () => {
    const runtime = createCuaRuntimeTestFixture();
    fixtures.push(runtime);
    const agent = loadAgent("nemocua", runtime.env);
    vi.stubEnv("NEMOCLAW_CUA_ENABLED", "");

    expect(() => getAgentPolicyPath(agent)).toThrow(
      "use the controlled Brev Launchable activation",
    );
  });

  it("refuses candidate onboarding before loading the agent without qualification authority (#7755)", () => {
    const runtime = createCuaRuntimeTestFixture();
    fixtures.push(runtime);
    Object.entries(runtime.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ).forEach(([key, value]) => {
      vi.stubEnv(key, value);
    });
    vi.stubEnv("NEMOCLAW_CUA_QUALIFICATION", "");

    expect(() => resolveAgent({ agentFlag: "nemocua" })).toThrow(
      "candidate onboarding requires exact qualification authority",
    );
  });

  it("records candidate readiness on the existing standalone sandbox after terminal checks (#7755)", async () => {
    const runtime = createCuaRuntimeTestFixture();
    fixtures.push(runtime);
    const env = { ...runtime.env, NEMOCLAW_CUA_QUALIFICATION: "1" };
    const agent = loadAgent("nemocua", env);
    const calls: string[][] = [];
    const runCaptureOpenshell = vi.fn((args: string[]) => {
      calls.push(args);
      const command = args.at(-1) ?? "";
      switch (true) {
        case command.includes("NEMOCLAW_AGENT_BINARY_CHECK"):
          return "NEMOCLAW_AGENT_BINARY_CHECK:ok";
        case args.at(-2) === "nemoclaw-agent-smoke":
          return "nemocua 1.0.0\nNEMOCLAW_AGENT_SMOKE_EXIT:0";
        case command === "nemocua version":
          return "nemocua 1.0.0";
        default:
          return "";
      }
    });
    const updateSandbox = vi.fn(() => true);
    const context: OnboardContext = {
      step: vi.fn(),
      runCaptureOpenshell,
      openshellShellCommand: vi.fn(() => "openshell sandbox connect worker"),
      openshellBinary: runtime.openshellPath,
      startRecordedStep: vi.fn(async () => undefined),
      recordStepComplete: vi.fn(async () => undefined),
      recordStepFailed: vi.fn(async () => undefined),
      skippedStepMessage: vi.fn(),
      getSandboxInferenceSelection: () => ({
        name: "existing-worker",
        agent: "nemocua",
        provider: "provider-x",
        model: "model-x",
        gatewayName: "nemoclaw-18080",
        gatewayPort: 18080,
      }),
      updateSandbox,
      cuaRuntimeEnvironment: env,
      cuaBuildIdentity: {
        schemaVersion: 1,
        sourceRevision: runtime.candidateCommit,
        sourceClean: true,
      },
      cuaObserveLiveInference: () => ({
        provider: "provider-x",
        model: "model-x",
        providerAuthorityDigest: `sha256:${"8".repeat(64)}`,
      }),
      cuaObserveLiveAppliedPolicy: () => ({
        revision: 7,
        digest: `sha256:${"9".repeat(64)}`,
      }),
      cuaWithGatewayRouteMutationLock: async (gatewayName, operation) => {
        expect(gatewayName).toBe("nemoclaw-18080");
        return await operation();
      },
    };

    await handleAgentSetup("existing-worker", "model-x", "provider-x", agent, false, null, context);

    expect(updateSandbox).toHaveBeenCalledWith("existing-worker", {
      cuaRuntimeReadiness: expect.objectContaining({
        agent: "nemocua",
        mode: "standalone",
        status: "candidate",
        sourceRevision: runtime.candidateCommit,
      }),
    });
    expect(context.recordStepComplete).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "existing-worker",
      provider: "provider-x",
      model: "model-x",
    });
    expect(context.recordStepFailed).not.toHaveBeenCalled();
    expect(calls.length).toBeGreaterThan(0);
    expect(
      calls.every((args) => args.slice(0, 4).join(" ") === "sandbox exec -n existing-worker"),
    ).toBe(true);
    expect(calls.some((args) => args.includes("create"))).toBe(false);
  });
});
