// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  cleanupPreparedDcodeImageFixture,
  createPreparedDcodeImageFixture,
  dcodeInput,
  expectPreparedImage,
} from "../../../../test/helpers/rebuild-managed-image-preflight-harness";
import { ROOT } from "../../runner";
import {
  disposePreparedDcodeRebuildImage,
  prepareManagedDcodeRebuildImage,
} from "./rebuild-managed-image-preflight";

describe("managed DCode rebuild image preparation", () => {
  it("prebuilds the recorded DCode replacement and transfers one disposable context (#6195)", async () => {
    const fixture = await createPreparedDcodeImageFixture({ toolDisclosure: "direct" });
    try {
      expect(fixture.result).toMatchObject({
        ok: true,
        prepared: {
          buildCtx: fixture.buildCtx,
          stagedDockerfile: fixture.stagedDockerfile,
          origin: "generated",
          buildId: "dcode-build-1",
          dockerGpuPatchNetwork: null,
        },
      });
      expect(fixture.stageBuildContext).toHaveBeenCalledWith(
        expect.objectContaining({
          root: ROOT,
          agent: expect.objectContaining({ name: "langchain-deepagents-code" }),
          fromDockerfile: null,
        }),
      );
      expect(fixture.prepareDockerfilePatch).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: expect.objectContaining({ name: "langchain-deepagents-code" }),
          provider: "compatible-endpoint",
          model: "nvidia/nemotron-3-super-120b-a12b",
          preferredInferenceApi: "openai-completions",
          toolDisclosure: "direct",
          chatUiUrl: "",
        }),
      );
      expect(fixture.buildImage).toHaveBeenCalledWith(
        fixture.stagedDockerfile,
        "nemoclaw-rebuild-preflight:dcode-success",
        fixture.buildCtx,
        expect.objectContaining({ ignoreError: true, suppressOutput: true }),
      );
      expect(fixture.removeImage).toHaveBeenCalledWith("nemoclaw-rebuild-preflight:dcode-success", {
        ignoreError: true,
        suppressOutput: true,
      });
      expect(fixture.cleanupBuildCtx).not.toHaveBeenCalled();
      expect(disposePreparedDcodeRebuildImage(fixture.prepared)).toBe(true);
      expect(disposePreparedDcodeRebuildImage(fixture.prepared)).toBe(true);
      expect(fixture.cleanupBuildCtx).toHaveBeenCalledOnce();
    } finally {
      cleanupPreparedDcodeImageFixture(fixture);
    }
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
      stageBuildContext: vi.fn(() => ({
        buildCtx,
        stagedDockerfile,
        cleanupBuildCtx,
        origin: "generated" as const,
      })),
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
        origin: "generated" as const,
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
