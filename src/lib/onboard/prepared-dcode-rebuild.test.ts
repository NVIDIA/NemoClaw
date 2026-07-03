// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../agent/defs";
import type { PreparedSandboxBuildContext } from "./build-context-stage";
import {
  createPreparedDcodeRebuildRuntime,
  type PreparedDcodeRebuildOptions,
  resolveSandboxBuildContext,
  resolveSandboxBuildId,
} from "./prepared-dcode-rebuild";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

const dcodeAgent = { name: "langchain-deepagents-code" } as AgentDefinition;
const preparedBuildContext: PreparedSandboxBuildContext = {
  buildCtx: "/tmp/prepared-dcode",
  stagedDockerfile: "/tmp/prepared-dcode/Dockerfile",
  buildId: "6195-prepared",
  cleanupBuildCtx: () => true,
};
const preparedOptions: PreparedDcodeRebuildOptions = {
  resume: true,
  recreateSandbox: true,
  agent: dcodeAgent.name,
  preparedDcodeRebuild: {
    buildContext: preparedBuildContext,
    gatewayName: " nemoclaw ",
  },
};
const sandboxGpuConfig: SandboxGpuConfig = {
  mode: "0",
  hostGpuDetected: false,
  hostGpuPlatform: null,
  sandboxGpuEnabled: false,
  sandboxGpuDevice: null,
  errors: [],
};
const preparedBuildIdInput = {
  preparedBuildContext,
  agent: dcodeAgent,
  fromDockerfile: null,
  stagedDockerfile: preparedBuildContext.stagedDockerfile,
  model: "nvidia/test-model",
  chatUiUrl: "",
  provider: "nvidia-prod",
  preferredInferenceApi: null,
  webSearchConfig: null,
  hermesToolGateways: [],
  sandboxGpuConfig,
};

describe("prepared DCode rebuild adapter", () => {
  it.each([
    ["resume", { ...preparedOptions, resume: false }],
    ["recreation", { ...preparedOptions, recreateSandbox: false }],
    ["agent", { ...preparedOptions, agent: "openclaw" }],
  ])("rejects a prepared handoff without matching %s intent", (_label, options) => {
    expect(() => createPreparedDcodeRebuildRuntime(options, "nemoclaw")).toThrow(
      /only be used by DCode resume recreation/,
    );
  });

  it("normalizes the exact gateway and clears ordinary ambient selection", () => {
    const preparedEnv: NodeJS.ProcessEnv = { OPENSHELL_GATEWAY: "ambient" };
    createPreparedDcodeRebuildRuntime(preparedOptions, "nemoclaw").applyGatewayEnv(preparedEnv);
    expect(preparedEnv.OPENSHELL_GATEWAY).toBe("nemoclaw");

    const ordinaryEnv: NodeJS.ProcessEnv = { OPENSHELL_GATEWAY: "ambient" };
    createPreparedDcodeRebuildRuntime({}, "nemoclaw").applyGatewayEnv(ordinaryEnv);
    expect(ordinaryEnv.OPENSHELL_GATEWAY).toBeUndefined();
  });

  it("rejects malformed or mismatched gateway names", () => {
    const malformed = {
      ...preparedOptions,
      preparedDcodeRebuild: {
        ...preparedOptions.preparedDcodeRebuild!,
        gatewayName: 6195 as unknown as string,
      },
    };
    expect(() => createPreparedDcodeRebuildRuntime(malformed, "nemoclaw")).toThrow(
      /missing or invalid/,
    );
    expect(() =>
      createPreparedDcodeRebuildRuntime(
        {
          ...preparedOptions,
          preparedDcodeRebuild: {
            ...preparedOptions.preparedDcodeRebuild!,
            gatewayName: "nemoclaw-18080",
          },
        },
        "nemoclaw",
      ),
    ).toThrow(/does not match 'nemoclaw'/);
  });

  it("consumes the prepared context before the first create attempt", async () => {
    const contexts: Array<PreparedSandboxBuildContext | null> = [];
    const create = vi.fn(
      async (attempt: number, context: PreparedSandboxBuildContext | null): Promise<number> => {
        contexts.push(context);
        return attempt === 1 ? Promise.reject(new Error("first attempt failed")) : attempt;
      },
    );
    const bound = createPreparedDcodeRebuildRuntime(preparedOptions, "nemoclaw").bindCreateSandbox(
      create,
    );

    await expect(bound(1)).rejects.toThrow("first attempt failed");
    await expect(bound(2)).resolves.toBe(2);
    expect(contexts).toEqual([preparedBuildContext, null]);
  });

  it("keeps prepared cleanup with rebuild and registers ordinary staged cleanup", () => {
    const stage = vi.fn(() => ({
      buildCtx: "/tmp/ordinary",
      stagedDockerfile: "/tmp/ordinary/Dockerfile",
      cleanupBuildCtx: () => true,
    }));
    const onExit = vi.fn();

    expect(
      resolveSandboxBuildContext(
        { preparedBuildContext, agent: dcodeAgent, fromDockerfile: null },
        { stageCreateSandboxBuildContext: stage, onExit },
      ),
    ).toBe(preparedBuildContext);
    expect(stage).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();

    const ordinary = resolveSandboxBuildContext(
      { preparedBuildContext: null, agent: dcodeAgent, fromDockerfile: null },
      {
        stageCreateSandboxBuildContext: stage,
        createAgentSandbox: vi.fn(),
        onExit,
      },
    );
    expect(ordinary.buildCtx).toBe("/tmp/ordinary");
    expect(stage).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledWith(ordinary.cleanupBuildCtx);
  });

  it.each([
    ["another agent", { agent: { name: "openclaw" } as AgentDefinition, fromDockerfile: null }],
    ["a custom Dockerfile", { agent: dcodeAgent, fromDockerfile: "/tmp/custom/Dockerfile" }],
  ])("rejects a prepared context for %s before staging or patching", async (_label, target) => {
    const stage = vi.fn();
    const patch = vi.fn();
    expect(() =>
      resolveSandboxBuildContext(
        {
          preparedBuildContext,
          ...target,
        },
        { stageCreateSandboxBuildContext: stage },
      ),
    ).toThrow(/cannot be used for this sandbox target/);
    await expect(
      resolveSandboxBuildId(
        { ...preparedBuildIdInput, ...target },
        { prepareSandboxDockerfilePatch: patch },
      ),
    ).rejects.toThrow(/cannot be used for this sandbox target/);
    expect(stage).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("uses the prepared build ID without patching and patches ordinary contexts", async () => {
    const patch = vi.fn(async () => ({ buildId: "fresh-build", resolvedBaseImage: null }));

    await expect(
      resolveSandboxBuildId(preparedBuildIdInput, { prepareSandboxDockerfilePatch: patch }),
    ).resolves.toBe(preparedBuildContext.buildId);
    expect(patch).not.toHaveBeenCalled();

    await expect(
      resolveSandboxBuildId(
        { ...preparedBuildIdInput, preparedBuildContext: null },
        { prepareSandboxDockerfilePatch: patch },
      ),
    ).resolves.toBe("fresh-build");
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
        sandboxBaseTag: "latest",
        stagedDockerfile: preparedBuildContext.stagedDockerfile,
      }),
    );
  });
});
