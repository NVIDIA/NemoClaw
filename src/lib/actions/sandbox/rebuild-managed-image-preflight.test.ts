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
  type ManagedDcodeRebuildImageResult,
  type PreparedDcodeRebuildImage,
  prepareManagedDcodeRebuildImage,
  verifyPreparedDcodeRebuildImage,
} from "./rebuild-managed-image-preflight";

function expectPreparedImage(result: ManagedDcodeRebuildImageResult): PreparedDcodeRebuildImage {
  expect(result.ok).toBe(true);
  return (result as Extract<ManagedDcodeRebuildImageResult, { ok: true }>).prepared;
}

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

    const prepared = expectPreparedImage(result);
    expect(verifyPreparedDcodeRebuildImage(prepared)).toBe(true);

    const savedDockerfile = `${buildCtx}-saved-Dockerfile`;
    const symlinkTarget = `${buildCtx}-symlink-target`;
    fs.writeFileSync(symlinkTarget, "FROM attacker-controlled-path\n");
    const originalOpenSync = fs.openSync;
    const symlinkReadSpy = vi.spyOn(fs, "readFileSync");
    const openSpy = vi.spyOn(fs, "openSync").mockImplementationOnce(((...args: unknown[]) => {
      fs.renameSync(stagedDockerfile, savedDockerfile);
      fs.symlinkSync(symlinkTarget, stagedDockerfile);
      return Reflect.apply(originalOpenSync, fs, args);
    }) as never);
    expect(verifyPreparedDcodeRebuildImage(prepared)).toBe(false);
    expect(symlinkReadSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
    symlinkReadSpy.mockRestore();
    fs.rmSync(stagedDockerfile);
    fs.renameSync(savedDockerfile, stagedDockerfile);
    fs.rmSync(symlinkTarget);

    const openedDockerfile = `${buildCtx}-opened-Dockerfile`;
    const replacementDockerfile = `${buildCtx}-replacement-Dockerfile`;
    fs.writeFileSync(replacementDockerfile, "FROM scratch\n");
    const originalPathReadFileSync = fs.readFileSync;
    const replacedPathReadSpy = vi.spyOn(fs, "readFileSync").mockImplementationOnce(((
      ...args: unknown[]
    ) => {
      const contents = Reflect.apply(originalPathReadFileSync, fs, args) as Buffer;
      fs.renameSync(stagedDockerfile, openedDockerfile);
      fs.renameSync(replacementDockerfile, stagedDockerfile);
      return contents;
    }) as never);
    expect(verifyPreparedDcodeRebuildImage(prepared)).toBe(false);
    replacedPathReadSpy.mockRestore();
    fs.rmSync(stagedDockerfile);
    fs.renameSync(openedDockerfile, stagedDockerfile);

    const originalReadFileSync = fs.readFileSync;
    const racedReadSpy = vi.spyOn(fs, "readFileSync").mockImplementationOnce(((
      ...args: unknown[]
    ) => {
      const contents = Reflect.apply(originalReadFileSync, fs, args) as Buffer;
      fs.appendFileSync(stagedDockerfile, "# changed during fingerprinting\n");
      return contents;
    }) as never);
    expect(verifyPreparedDcodeRebuildImage(prepared)).toBe(false);
    racedReadSpy.mockRestore();
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    expect(verifyPreparedDcodeRebuildImage(prepared)).toBe(true);

    fs.appendFileSync(stagedDockerfile, "# changed after preflight\n");
    expect(verifyPreparedDcodeRebuildImage(prepared)).toBe(false);
    expect(disposePreparedDcodeRebuildImage(prepared)).toBe(true);
    expect(disposePreparedDcodeRebuildImage(prepared)).toBe(true);
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

    const prepared = expectPreparedImage(result);
    expect(disposePreparedDcodeRebuildImage(prepared)).toBe(false);
    expect(disposePreparedDcodeRebuildImage(prepared)).toBe(true);
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
