// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import { ROOT } from "../../runner";
import {
  cleanupPreparedRebuildBuildContext,
  preflightRebuildImage,
  type RebuildImagePreflightInput,
} from "./rebuild-custom-image-preflight";

const originalReasoning = process.env.NEMOCLAW_REASONING;
const originalDockerGpuPatchNetwork = process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK;

function dcodeInput(
  overrides: Partial<RebuildImagePreflightInput> = {},
): RebuildImagePreflightInput {
  return {
    agent: loadAgent("langchain-deepagents-code"),
    fromDockerfile: null,
    model: "nvidia/nemotron-3-super-120b-a12b",
    provider: "nvidia-prod",
    preferredInferenceApi: "openai-completions",
    compatibleEndpointReasoning: null,
    webSearchConfig: null,
    hermesToolGateways: [],
    sandboxGpuConfig: {
      mode: "0",
      hostGpuDetected: false,
      hostGpuPlatform: null,
      sandboxGpuEnabled: false,
      sandboxGpuDevice: null,
      errors: [],
    },
    gatewayPort: 19080,
    chatUiUrl: "",
    ...overrides,
  };
}

afterEach(() => {
  if (originalReasoning === undefined) delete process.env.NEMOCLAW_REASONING;
  else process.env.NEMOCLAW_REASONING = originalReasoning;
  if (originalDockerGpuPatchNetwork === undefined) {
    delete process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK;
  } else {
    process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK = originalDockerGpuPatchNetwork;
  }
  vi.restoreAllMocks();
});

describe("preflightRebuildImage", () => {
  it("prebuilds the Deep Agents replacement image with the recorded model and gateway (#6195)", async () => {
    process.env.NEMOCLAW_REASONING = "true";
    const cleanupBuildCtx = vi.fn(() => true);
    const stageBuildContext = vi.fn(() => ({
      buildCtx: "/tmp/dcode-rebuild-context",
      stagedDockerfile: "/tmp/dcode-rebuild-context/Dockerfile",
      cleanupBuildCtx,
    }));
    const prepareDockerfilePatch = vi.fn(async () => {
      expect(process.env.NEMOCLAW_REASONING).toBeUndefined();
      process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK = "preserve";
      return { buildId: "1", resolvedBaseImage: null };
    });
    const buildImage = vi.fn(() => ({ status: 0 }) as never);
    const removeImage = vi.fn(() => ({ status: 0 }) as never);

    const result = await preflightRebuildImage(dcodeInput(), {
      stageBuildContext,
      prepareDockerfilePatch,
      buildImage,
      removeImage,
      createImageTag: () => "nemoclaw-rebuild-preflight:dcode-success",
    });

    expect(result).toMatchObject({
      ok: true,
      preparedBuildContext: {
        buildCtx: "/tmp/dcode-rebuild-context",
        stagedDockerfile: "/tmp/dcode-rebuild-context/Dockerfile",
        buildId: "1",
        dockerGpuPatchNetwork: "preserve",
      },
    });
    expect(stageBuildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        root: ROOT,
        agent: expect.objectContaining({ name: "langchain-deepagents-code" }),
      }),
    );
    expect(prepareDockerfilePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ name: "langchain-deepagents-code" }),
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
        gatewayPort: 19080,
        exitOnFailure: false,
        chatUiUrl: "",
      }),
    );
    expect(buildImage).toHaveBeenCalledWith(
      "/tmp/dcode-rebuild-context/Dockerfile",
      "nemoclaw-rebuild-preflight:dcode-success",
      "/tmp/dcode-rebuild-context",
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    expect(removeImage).toHaveBeenCalledWith("nemoclaw-rebuild-preflight:dcode-success", {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(cleanupBuildCtx).not.toHaveBeenCalled();
    if (result.ok) cleanupPreparedRebuildBuildContext(result.preparedBuildContext);
    expect(cleanupBuildCtx).toHaveBeenCalledOnce();
    expect(process.env.NEMOCLAW_REASONING).toBe("true");
    expect(process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK).toBe(originalDockerGpuPatchNetwork);
  });

  it("reports buffered build diagnostics and cleans temporary state on failure (#6195)", async () => {
    process.env.NEMOCLAW_REASONING = "false";
    const cleanupBuildCtx = vi.fn(() => true);
    const prepareDockerfilePatch = vi.fn(async () => {
      expect(process.env.NEMOCLAW_REASONING).toBe("true");
      process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK = "preserve";
      return { buildId: "1", resolvedBaseImage: null };
    });
    const removeImage = vi.fn(() => ({ status: 0 }) as never);

    const result = await preflightRebuildImage(
      dcodeInput({
        provider: "compatible-endpoint",
        compatibleEndpointReasoning: "true",
      }),
      {
        stageBuildContext: vi.fn(() => ({
          buildCtx: "/tmp/dcode-rebuild-failure",
          stagedDockerfile: "/tmp/dcode-rebuild-failure/Dockerfile",
          cleanupBuildCtx,
        })),
        prepareDockerfilePatch,
        buildImage: vi.fn(
          () =>
            ({
              status: null,
              error: new Error("docker spawn failed"),
              stderr: Buffer.from("buffered stderr detail"),
              stdout: Buffer.from("buffered stdout detail"),
            }) as never,
        ),
        removeImage,
        createImageTag: () => "nemoclaw-rebuild-preflight:dcode-failure",
      },
    );

    expect(result).toEqual({
      ok: false,
      detail: expect.stringContaining("docker spawn failed"),
    });
    expect(result).toEqual({
      ok: false,
      detail: expect.stringContaining("buffered stderr detail"),
    });
    expect(result).toEqual({
      ok: false,
      detail: expect.stringContaining("buffered stdout detail"),
    });
    expect(removeImage).toHaveBeenCalledWith("nemoclaw-rebuild-preflight:dcode-failure", {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(cleanupBuildCtx).toHaveBeenCalledOnce();
    expect(process.env.NEMOCLAW_REASONING).toBe("false");
    expect(process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK).toBe(originalDockerGpuPatchNetwork);
  });

  it("cleans the staged context and throwaway image before re-signaling an interrupt", async () => {
    let sigintHandler: (() => void) | null = null;
    vi.spyOn(process, "once").mockImplementation(((
      eventName: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (eventName === "SIGINT") sigintHandler = listener;
      return process;
    }) as typeof process.once);
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    const cleanupBuildCtx = vi.fn(() => true);
    const removeImage = vi.fn(() => ({ status: 0 }) as never);
    const buildImage = vi.fn(() => {
      sigintHandler?.();
      return { status: 1, stderr: "interrupted" } as never;
    });

    await preflightRebuildImage(dcodeInput(), {
      stageBuildContext: vi.fn(() => ({
        buildCtx: "/tmp/dcode-rebuild-interrupt",
        stagedDockerfile: "/tmp/dcode-rebuild-interrupt/Dockerfile",
        cleanupBuildCtx,
      })),
      prepareDockerfilePatch: vi.fn(async () => ({ buildId: "1", resolvedBaseImage: null })),
      buildImage,
      removeImage,
      createImageTag: () => "nemoclaw-rebuild-preflight:dcode-interrupt",
    });

    expect(cleanupBuildCtx).toHaveBeenCalled();
    expect(removeImage).toHaveBeenCalledWith("nemoclaw-rebuild-preflight:dcode-interrupt", {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
    expect(cleanupBuildCtx.mock.invocationCallOrder[0]).toBeLessThan(
      removeImage.mock.invocationCallOrder[0],
    );
    expect(removeImage.mock.invocationCallOrder[0]).toBeLessThan(
      killSpy.mock.invocationCallOrder[0],
    );
  });
});
