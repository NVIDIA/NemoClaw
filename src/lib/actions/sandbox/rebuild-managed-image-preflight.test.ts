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
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-rebuild-context-"));
    const buildCtx = path.join(testRoot, "context");
    fs.mkdirSync(buildCtx);
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    const originalDockerfile = path.join(testRoot, "Dockerfile.original");
    const replacementDockerfile = path.join(testRoot, "Dockerfile.replacement");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    fs.writeFileSync(replacementDockerfile, "FROM attacker-controlled\n");
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(testRoot, { recursive: true, force: true });
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
    const mutationFd = fs.openSync(stagedDockerfile, fs.constants.O_WRONLY);
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    const nonBlock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
    const stableOpen = vi.spyOn(fs, "openSync");
    const stableRead = vi.spyOn(fs, "readFileSync");
    try {
      expect(verifyPreparedDcodeRebuildImage(prepared)).toBe(true);
      const fileOpen = stableOpen.mock.calls.find(
        ([candidate]) => String(candidate) === stagedDockerfile,
      );
      const flags = Number(fileOpen?.[1] ?? 0);
      expect(flags & noFollow).toBe(noFollow);
      expect(flags & nonBlock).toBe(nonBlock);
      expect(stableRead).toHaveBeenCalledWith(expect.any(Number));
      expect(stableRead).not.toHaveBeenCalledWith(stagedDockerfile);
    } finally {
      stableRead.mockRestore();
      stableOpen.mockRestore();
    }

    const realOpen: typeof fs.openSync = fs.openSync.bind(fs);
    const preOpenSwap = new Map<string, () => void>([
      [
        stagedDockerfile,
        () => {
          fs.renameSync(stagedDockerfile, originalDockerfile);
          fs.symlinkSync(replacementDockerfile, stagedDockerfile);
        },
      ],
    ]);
    const preOpenRead = vi.spyOn(fs, "readFileSync");
    const preOpen = vi.spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
      const key = String(target);
      const swap = preOpenSwap.get(key);
      preOpenSwap.delete(key);
      swap?.();
      return realOpen(target, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(verifyPreparedDcodeRebuildImage(prepared)).toBe(false);
      expect(preOpenRead).not.toHaveBeenCalled();
    } finally {
      preOpen.mockRestore();
      preOpenRead.mockRestore();
    }
    expect(preOpenSwap.size).toBe(0);
    fs.rmSync(stagedDockerfile);
    fs.renameSync(originalDockerfile, stagedDockerfile);

    const swapOnOpen = new Map<string, () => void>([
      [
        stagedDockerfile,
        () => {
          fs.renameSync(stagedDockerfile, originalDockerfile);
          fs.symlinkSync(replacementDockerfile, stagedDockerfile);
        },
      ],
    ]);
    const racingOpen = vi.spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
      const fd = realOpen(target, flags, mode);
      const key = String(target);
      const swap = swapOnOpen.get(key);
      swapOnOpen.delete(key);
      swap?.();
      return fd;
    }) as typeof fs.openSync);
    try {
      expect(verifyPreparedDcodeRebuildImage(prepared)).toBe(false);
    } finally {
      racingOpen.mockRestore();
    }
    expect(swapOnOpen.size).toBe(0);
    expect(fs.lstatSync(stagedDockerfile).isSymbolicLink()).toBe(true);

    const fallbackRead = vi.spyOn(fs, "readFileSync");
    const fallbackOpen = vi
      .spyOn(fs, "openSync")
      .mockImplementation(((target, flags, mode) =>
        realOpen(target, Number(flags) & ~noFollow, mode)) as typeof fs.openSync);
    try {
      expect(verifyPreparedDcodeRebuildImage(prepared)).toBe(false);
      expect(fallbackRead).not.toHaveBeenCalled();
    } finally {
      fallbackOpen.mockRestore();
      fallbackRead.mockRestore();
    }

    fs.rmSync(stagedDockerfile);
    fs.renameSync(originalDockerfile, stagedDockerfile);
    fs.writeFileSync(replacementDockerfile, "FROM scratch\n");

    const originalRead: typeof fs.readFileSync = fs.readFileSync.bind(fs);
    const replaceAfterRead = vi.spyOn(fs, "readFileSync").mockImplementationOnce(((
      ...args: unknown[]
    ) => {
      const contents = Reflect.apply(originalRead, fs, args) as Buffer;
      fs.renameSync(stagedDockerfile, originalDockerfile);
      fs.renameSync(replacementDockerfile, stagedDockerfile);
      return contents;
    }) as never);
    try {
      expect(verifyPreparedDcodeRebuildImage(prepared)).toBe(false);
    } finally {
      replaceAfterRead.mockRestore();
    }
    fs.rmSync(stagedDockerfile);
    fs.renameSync(originalDockerfile, stagedDockerfile);

    const appendAfterRead = vi.spyOn(fs, "readFileSync").mockImplementationOnce(((
      ...args: unknown[]
    ) => {
      const contents = Reflect.apply(originalRead, fs, args) as Buffer;
      fs.appendFileSync(stagedDockerfile, "# changed during fingerprinting\n");
      return contents;
    }) as never);
    try {
      expect(verifyPreparedDcodeRebuildImage(prepared)).toBe(false);
    } finally {
      appendAfterRead.mockRestore();
    }
    fs.ftruncateSync(mutationFd, 0);
    fs.writeSync(mutationFd, "FROM scratch\n", 0, "utf8");
    expect(verifyPreparedDcodeRebuildImage(prepared)).toBe(true);

    fs.writeSync(mutationFd, "# changed after preflight\n", 0, "utf8");
    expect(verifyPreparedDcodeRebuildImage(prepared)).toBe(false);
    fs.closeSync(mutationFd);

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
