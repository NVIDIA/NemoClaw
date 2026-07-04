// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ROOT } from "../../runner";
import {
  preflightRebuildImage,
  type RebuildImagePreflightResult,
} from "./rebuild-custom-image-preflight";
import {
  disposePreparedBuildContext,
  verifyPreparedBuildContext,
} from "./rebuild-prepared-image-context";

type SuccessfulPreflight = Extract<RebuildImagePreflightResult, { ok: true }>;

function successful(result: RebuildImagePreflightResult): SuccessfulPreflight {
  expect(result.ok).toBe(true);
  return result as SuccessfulPreflight;
}

function input(fromDockerfile: string | null) {
  return {
    agent: null,
    fromDockerfile,
    model: "model",
    provider: "ollama-local",
    preferredInferenceApi: null,
    compatibleEndpointReasoning: null,
    webSearchConfig: null,
    toolDisclosure: "progressive" as const,
    hermesToolGateways: [],
    sandboxGpuConfig: {
      mode: "0" as const,
      hostGpuDetected: false,
      hostGpuPlatform: null,
      sandboxGpuEnabled: false,
      sandboxGpuDevice: null,
      errors: [],
    },
    gatewayPort: 8080,
    chatUiUrl: "http://127.0.0.1:18789",
  };
}

describe("preflightRebuildImage", () => {
  it("prebuilds the managed OpenClaw image instead of deferring its first build until delete", async () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-preflight-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const buildImage = vi.fn(() => ({ status: 0 }) as never);
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    });
    const stageBuildContext = vi.fn(() => ({
      buildCtx,
      stagedDockerfile,
      cleanupBuildCtx,
      origin: "generated" as const,
    }));
    try {
      const result = successful(
        await preflightRebuildImage(input(null), {
          stageBuildContext,
          prepareDockerfilePatch: vi.fn(async () => ({ buildId: "1", resolvedBaseImage: null })),
          buildImage,
          removeImage: vi.fn(() => ({ status: 0 }) as never),
        }),
      );

      expect(stageBuildContext).toHaveBeenCalledWith(
        expect.objectContaining({ root: ROOT, agent: null }),
      );
      expect(buildImage).toHaveBeenCalledOnce();
      expect(cleanupBuildCtx).not.toHaveBeenCalled();
      expect(verifyPreparedBuildContext(result.prepared)).toBe(true);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
      expect(cleanupBuildCtx).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked build-context root before the preflight build",
    async () => {
      const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preflight-root-link-"));
      const targetBuildCtx = path.join(testRoot, "target");
      const linkedBuildCtx = path.join(testRoot, "context");
      fs.mkdirSync(targetBuildCtx);
      fs.writeFileSync(path.join(targetBuildCtx, "Dockerfile"), "FROM scratch\n");
      fs.symlinkSync(targetBuildCtx, linkedBuildCtx, "dir");
      const cleanupBuildCtx = vi.fn(() => {
        fs.rmSync(linkedBuildCtx, { force: true });
        return true;
      });
      const buildImage = vi.fn(() => ({ status: 0 }) as never);

      try {
        await expect(
          preflightRebuildImage(input(null), {
            stageBuildContext: vi.fn(() => ({
              buildCtx: linkedBuildCtx,
              stagedDockerfile: path.join(linkedBuildCtx, "Dockerfile"),
              cleanupBuildCtx,
              origin: "generated" as const,
            })),
            prepareDockerfilePatch: vi.fn(async () => ({
              buildId: "root-link",
              resolvedBaseImage: null,
            })),
            buildImage,
            removeImage: vi.fn(() => ({ status: 0 }) as never),
          }),
        ).resolves.toEqual({
          ok: false,
          detail: "build-context root must be a real directory",
        });
        expect(buildImage).not.toHaveBeenCalled();
        expect(cleanupBuildCtx).toHaveBeenCalledOnce();
      } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["malformed syntax", "THIS IS NOT A DOCKERFILE"],
    ["missing COPY context", "FROM scratch\nCOPY missing.txt /missing.txt\n"],
  ])("fails before delete for %s", async (_label, dockerfileContents) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-"));
    const dockerfile = path.join(dir, "Dockerfile.custom");
    fs.writeFileSync(dockerfile, dockerfileContents);
    const removeImage = vi.fn(() => ({ status: 0 }) as never);
    try {
      const result = await preflightRebuildImage(input(dockerfile), {
        prepareDockerfilePatch: vi.fn(async () => ({ buildId: "1", resolvedBaseImage: null })),
        buildImage: vi.fn(() => ({ status: 1, stderr: "dockerfile validation failed" }) as never),
        removeImage,
      });
      expect(result).toEqual({ ok: false, detail: "dockerfile validation failed" });
      expect(removeImage).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds and removes the exact staged custom context on success", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-"));
    const dockerfile = path.join(dir, "Dockerfile.custom");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    const buildImage = vi.fn(() => ({ status: 0 }) as never);
    const removeImage = vi.fn(() => ({ status: 0 }) as never);
    try {
      const result = successful(
        await preflightRebuildImage(input(dockerfile), {
          prepareDockerfilePatch: vi.fn(async () => ({ buildId: "1", resolvedBaseImage: null })),
          buildImage,
          removeImage,
        }),
      );
      expect(buildImage).toHaveBeenCalledWith(
        expect.stringContaining("Dockerfile"),
        expect.stringMatching(/^nemoclaw-rebuild-preflight:/),
        expect.any(String),
        expect.objectContaining({ ignoreError: true }),
      );
      expect(removeImage).toHaveBeenCalledOnce();
      expect(fs.existsSync(result.prepared.buildCtx)).toBe(true);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins a symlinked Dockerfile before the source link can be swapped", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-link-"));
    const dockerfile = path.join(dir, "Dockerfile");
    fs.writeFileSync(path.join(dir, "Dockerfile.safe"), "FROM scratch\n# safe\n");
    fs.writeFileSync(path.join(dir, "Dockerfile.changed"), "FROM scratch\n# changed\n");
    fs.symlinkSync("Dockerfile.safe", dockerfile);
    const builtDockerfiles: string[] = [];
    try {
      const result = successful(
        await preflightRebuildImage(input(dockerfile), {
          prepareDockerfilePatch: vi.fn(async () => ({ buildId: "1", resolvedBaseImage: null })),
          buildImage: vi.fn((stagedDockerfile) => {
            builtDockerfiles.push(fs.readFileSync(stagedDockerfile, "utf8"));
            return { status: 0 } as never;
          }),
          removeImage: vi.fn(() => ({ status: 0 }) as never),
        }),
      );

      fs.unlinkSync(dockerfile);
      fs.symlinkSync("Dockerfile.changed", dockerfile);

      expect(builtDockerfiles).toEqual(["FROM scratch\n# safe\n"]);
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      const stagedFd = fs.openSync(
        result.prepared.stagedDockerfile,
        fs.constants.O_RDONLY | noFollow,
      );
      try {
        expect(fs.fstatSync(stagedFd).isFile()).toBe(true);
        expect(fs.readFileSync(stagedFd, "utf8")).toBe("FROM scratch\n# safe\n");
      } finally {
        fs.closeSync(stagedFd);
      }
      expect(verifyPreparedBuildContext(result.prepared)).toBe(true);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns and retries at process exit when a built preflight image cannot be removed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-cleanup-"));
    const dockerfile = path.join(dir, "Dockerfile.custom");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    const removeImage = vi
      .fn()
      .mockReturnValueOnce({ status: 1 } as never)
      .mockReturnValueOnce({ status: 0 } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const processOnce = vi.spyOn(process, "once").mockImplementation((event, listener) => {
      expect(event).toBe("exit");
      listener(0);
      return process;
    });
    try {
      const result = successful(
        await preflightRebuildImage(input(dockerfile), {
          prepareDockerfilePatch: vi.fn(async () => ({ buildId: "1", resolvedBaseImage: null })),
          buildImage: vi.fn(() => ({ status: 0 }) as never),
          removeImage,
        }),
      );

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("failed to remove temporary rebuild preflight image"),
      );
      expect(processOnce).toHaveBeenCalledWith("exit", expect.any(Function));
      expect(removeImage).toHaveBeenCalledTimes(2);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      processOnce.mockRestore();
      warn.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
