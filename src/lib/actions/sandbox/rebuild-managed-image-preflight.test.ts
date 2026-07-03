// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import { ROOT } from "../../runner";
import {
  disposePreparedDcodeRebuildImage,
  type ManagedDcodeRebuildImageInput,
  prepareManagedDcodeRebuildImage,
  verifyPreparedDcodeRebuildImage,
} from "./rebuild-managed-image-preflight";

function dcodeInput(
  overrides: Partial<ManagedDcodeRebuildImageInput> = {},
): ManagedDcodeRebuildImageInput {
  return {
    agent: loadAgent("langchain-deepagents-code"),
    model: "nvidia/nemotron-3-super-120b-a12b",
    provider: "compatible-endpoint",
    preferredInferenceApi: "openai-completions",
    sandboxGpuConfig: {
      mode: "0",
      hostGpuDetected: false,
      hostGpuPlatform: null,
      sandboxGpuEnabled: false,
      sandboxGpuDevice: null,
      errors: [],
    },
    ...overrides,
  };
}

describe("managed DCode rebuild image preflight", () => {
  it("prebuilds the recorded DCode replacement and transfers one disposable context (#6195)", async () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-rebuild-context-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    });
    const stageBuildContext = vi.fn(() => ({
      buildCtx,
      stagedDockerfile,
      cleanupBuildCtx,
    }));
    const prepareDockerfilePatch = vi.fn(async () => ({
      buildId: "dcode-build-1",
      resolvedBaseImage: null,
    }));
    const buildImage = vi.fn(() => ({ status: 0 }) as never);
    const removeImage = vi.fn(() => ({ status: 0 }) as never);

    const result = await prepareManagedDcodeRebuildImage(dcodeInput(), {
      stageBuildContext,
      prepareDockerfilePatch,
      buildImage,
      removeImage,
      createImageTag: () => "nemoclaw-rebuild-preflight:dcode-success",
    });

    expect(result).toMatchObject({
      ok: true,
      prepared: {
        buildCtx,
        stagedDockerfile,
        buildId: "dcode-build-1",
        dockerGpuPatchNetwork: null,
      },
    });
    expect(stageBuildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        root: ROOT,
        agent: expect.objectContaining({ name: "langchain-deepagents-code" }),
        fromDockerfile: null,
      }),
    );
    expect(prepareDockerfilePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ name: "langchain-deepagents-code" }),
        provider: "compatible-endpoint",
        model: "nvidia/nemotron-3-super-120b-a12b",
        preferredInferenceApi: "openai-completions",
        chatUiUrl: "",
      }),
    );
    expect(buildImage).toHaveBeenCalledWith(
      stagedDockerfile,
      "nemoclaw-rebuild-preflight:dcode-success",
      buildCtx,
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    expect(removeImage).toHaveBeenCalledWith("nemoclaw-rebuild-preflight:dcode-success", {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(cleanupBuildCtx).not.toHaveBeenCalled();

    if (!result.ok) throw new Error(result.detail);
    expect(verifyPreparedDcodeRebuildImage(result.prepared)).toBe(true);
    fs.appendFileSync(stagedDockerfile, "# changed after preflight\n");
    expect(verifyPreparedDcodeRebuildImage(result.prepared)).toBe(false);
    expect(disposePreparedDcodeRebuildImage(result.prepared)).toBe(true);
    expect(disposePreparedDcodeRebuildImage(result.prepared)).toBe(true);
    expect(cleanupBuildCtx).toHaveBeenCalledOnce();
  });

  it("retries retained-context cleanup after a transient removal failure (#6195)", async () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-rebuild-cleanup-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const cleanupBuildCtx = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(false)
      .mockImplementationOnce(() => {
        fs.rmSync(buildCtx, { recursive: true, force: true });
        return true;
      });
    const result = await prepareManagedDcodeRebuildImage(dcodeInput(), {
      stageBuildContext: vi.fn(() => ({ buildCtx, stagedDockerfile, cleanupBuildCtx })),
      prepareDockerfilePatch: vi.fn(async () => ({
        buildId: "dcode-build-cleanup",
        resolvedBaseImage: null,
      })),
      buildImage: vi.fn(() => ({ status: 0 }) as never),
      removeImage: vi.fn(() => ({ status: 0 }) as never),
      createImageTag: () => "nemoclaw-rebuild-preflight:dcode-cleanup",
    });

    if (!result.ok) throw new Error(result.detail);
    expect(disposePreparedDcodeRebuildImage(result.prepared)).toBe(false);
    expect(disposePreparedDcodeRebuildImage(result.prepared)).toBe(true);
    expect(cleanupBuildCtx).toHaveBeenCalledTimes(2);
  });

  it("redacts failed build output and cleans every temporary image input (#6195)", async () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-rebuild-failure-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    });
    const removeImage = vi.fn(() => ({ status: 0 }) as never);
    const secret = "nvapi-secret-value-that-must-not-leak";

    const result = await prepareManagedDcodeRebuildImage(dcodeInput(), {
      stageBuildContext: vi.fn(() => ({
        buildCtx,
        stagedDockerfile,
        cleanupBuildCtx,
      })),
      prepareDockerfilePatch: vi.fn(async () => ({
        buildId: "dcode-build-failure",
        resolvedBaseImage: null,
      })),
      buildImage: vi.fn(
        () =>
          ({
            status: 23,
            stderr: `provider rejected ${secret}`,
            stdout: "buffered build output",
          }) as never,
      ),
      removeImage,
      createImageTag: () => "nemoclaw-rebuild-preflight:dcode-failure",
    });

    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringContaining("provider rejected"),
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(removeImage).toHaveBeenCalledWith("nemoclaw-rebuild-preflight:dcode-failure", {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(cleanupBuildCtx).toHaveBeenCalledOnce();
  });
});
