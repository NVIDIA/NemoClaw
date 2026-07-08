// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createBuildContextVerifier } from "../actions/sandbox/rebuild-prepared-image-context";
import { fingerprintBuildContext } from "../adapters/fs/build-context-fingerprint";
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
  origin: "generated",
};
const preparedOptions: PreparedDcodeRebuildOptions = {
  resume: true,
  recreateSandbox: true,
  agent: dcodeAgent.name,
  dcodeAutoApprovalMode: "disabled",
  preparedDcodeRebuild: {
    buildContext: preparedBuildContext,
    gatewayName: " nemoclaw ",
    dcodeAutoApprovalMode: "disabled",
  },
};
const preparedImageBuildContext: PreparedSandboxBuildContext = {
  buildCtx: "/tmp/prepared-custom",
  stagedDockerfile: "/tmp/prepared-custom/Dockerfile",
  buildId: "custom-prepared",
  cleanupBuildCtx: () => true,
  origin: "custom",
  verifyBuildCtx: () => true,
  rebuildTarget: {
    agentName: null,
    fromDockerfile: "/tmp/custom/Dockerfile",
  },
};
const preparedImageOptions: PreparedDcodeRebuildOptions = {
  resume: true,
  recreateSandbox: true,
  authoritativeResumeConfig: true,
  onboardLockAlreadyHeld: true,
  agent: null,
  fromDockerfile: "/tmp/custom/Dockerfile",
  preparedImageRebuild: {
    buildContext: preparedImageBuildContext,
    gatewayName: "nemoclaw",
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

type OneShotContextMutationPaths = {
  buildCtx: string;
  stagedDockerfile: string;
  replacementCtx: string;
  movedBuildCtx: string;
};

type OneShotContextMutation = {
  label: string;
  arrange(paths: OneShotContextMutationPaths): void;
  mutate(paths: OneShotContextMutationPaths): void;
};

const FIXED_CONTEXT_TIME = new Date("2026-01-01T00:00:00.000Z");
const oneShotContextMutations: OneShotContextMutation[] = [
  {
    label: "file special bits change",
    arrange: ({ stagedDockerfile }) => fs.chmodSync(stagedDockerfile, 0o755),
    mutate: ({ stagedDockerfile }) => fs.chmodSync(stagedDockerfile, 0o4755),
  },
  {
    label: "independent files become hardlinks",
    arrange: ({ buildCtx }) => {
      const first = path.join(buildCtx, "first.txt");
      const second = path.join(buildCtx, "second.txt");
      fs.writeFileSync(first, "identical\n");
      fs.writeFileSync(second, "identical\n");
      fs.utimesSync(first, FIXED_CONTEXT_TIME, FIXED_CONTEXT_TIME);
      fs.utimesSync(second, FIXED_CONTEXT_TIME, FIXED_CONTEXT_TIME);
      fs.utimesSync(buildCtx, FIXED_CONTEXT_TIME, FIXED_CONTEXT_TIME);
    },
    mutate: ({ buildCtx }) => {
      const first = path.join(buildCtx, "first.txt");
      const second = path.join(buildCtx, "second.txt");
      fs.unlinkSync(second);
      fs.linkSync(first, second);
      fs.utimesSync(buildCtx, FIXED_CONTEXT_TIME, FIXED_CONTEXT_TIME);
    },
  },
  {
    label: "a file mtime alone changes",
    arrange: ({ stagedDockerfile }) =>
      fs.utimesSync(stagedDockerfile, FIXED_CONTEXT_TIME, FIXED_CONTEXT_TIME),
    mutate: ({ stagedDockerfile }) =>
      fs.utimesSync(
        stagedDockerfile,
        FIXED_CONTEXT_TIME,
        new Date(FIXED_CONTEXT_TIME.getTime() + 1_000),
      ),
  },
  {
    label: "the context root is retargeted through a symlink",
    arrange: ({ stagedDockerfile, replacementCtx }) => {
      fs.mkdirSync(replacementCtx);
      fs.copyFileSync(stagedDockerfile, path.join(replacementCtx, "Dockerfile"));
    },
    mutate: ({ buildCtx, replacementCtx, movedBuildCtx }) => {
      fs.renameSync(buildCtx, movedBuildCtx);
      fs.symlinkSync(replacementCtx, buildCtx, "dir");
      fs.writeFileSync(path.join(replacementCtx, "Dockerfile"), "FROM changed-target\n");
    },
  },
];

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

  it("rejects a prepared handoff when its auto-approval mode changed (#6478)", () => {
    expect(() =>
      createPreparedDcodeRebuildRuntime(
        { ...preparedOptions, dcodeAutoApprovalMode: "thread-opt-in" },
        "nemoclaw",
      ),
    ).toThrow(/auto-approval mode does not match/);
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

  it("rejects retained-context mutation at the post-delete one-shot boundary", async () => {
    const verifyBuildCtx = vi.fn(() => false);
    const create = vi.fn(async (_context: PreparedSandboxBuildContext | null) => true);
    const bound = createPreparedDcodeRebuildRuntime(
      {
        ...preparedImageOptions,
        preparedImageRebuild: {
          ...preparedImageOptions.preparedImageRebuild!,
          buildContext: { ...preparedImageBuildContext, verifyBuildCtx },
        },
      },
      "nemoclaw",
    ).bindCreateSandbox(create);

    await expect(bound()).rejects.toThrow("context changed before use");
    expect(verifyBuildCtx).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32").each(oneShotContextMutations)(
    "rejects $label at the post-delete one-shot boundary",
    async ({ arrange, mutate, label }) => {
      const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-one-shot-seal-"));
      const buildCtx = path.join(testRoot, "context");
      const replacementCtx = path.join(testRoot, "replacement");
      const movedBuildCtx = path.join(testRoot, "context-moved");
      fs.mkdirSync(buildCtx);
      const stagedDockerfile = path.join(buildCtx, "Dockerfile");
      fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
      const mutationPaths = { buildCtx, stagedDockerfile, replacementCtx, movedBuildCtx };
      arrange(mutationPaths);
      const contextFingerprint = fingerprintBuildContext(buildCtx);
      const create = vi.fn(async (_context: PreparedSandboxBuildContext | null) => true);
      const buildContext: PreparedSandboxBuildContext = {
        ...preparedImageBuildContext,
        buildCtx,
        stagedDockerfile,
        buildId: `one-shot-${label}`,
        verifyBuildCtx: createBuildContextVerifier(buildCtx, contextFingerprint),
      };
      const bound = createPreparedDcodeRebuildRuntime(
        {
          ...preparedImageOptions,
          preparedImageRebuild: {
            ...preparedImageOptions.preparedImageRebuild!,
            buildContext,
          },
        },
        "nemoclaw",
      ).bindCreateSandbox(create);

      try {
        mutate(mutationPaths);
        await expect(bound()).rejects.toThrow("context changed before use");
        expect(create).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    },
  );

  it("treats explicit OpenClaw and the legacy null agent as the same prepared target", () => {
    const runtime = createPreparedDcodeRebuildRuntime(
      { ...preparedImageOptions, agent: "openclaw" },
      "nemoclaw",
    );

    expect(runtime.resolveDockerfileProbePath("/tmp/custom/Dockerfile")).toBe(
      preparedImageBuildContext.stagedDockerfile,
    );
  });

  it("keeps prepared cleanup with rebuild and registers ordinary staged cleanup", () => {
    const stage = vi.fn(() => ({
      buildCtx: "/tmp/ordinary",
      stagedDockerfile: "/tmp/ordinary/Dockerfile",
      cleanupBuildCtx: () => true,
      origin: "generated" as const,
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
