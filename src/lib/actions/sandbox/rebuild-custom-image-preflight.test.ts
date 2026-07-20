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
    localPrebuildEnabled: true,
    gatewayPort: 8080,
    chatUiUrl: "http://127.0.0.1:18789",
  };
}

describe("preflightRebuildImage", () => {
  it("keeps the generated OpenClaw Dockerfile compatible with the legacy fallback (#7111)", () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
    for (const buildKitOnlySyntax of [
      /^\s*RUN\s+--mount=/mu,
      /^\s*(?:COPY|ADD)\s+--link(?:=|\s)/mu,
      /^\s*RUN\s+<<-?\w+/mu,
    ]) {
      expect(dockerfile).not.toMatch(buildKitOnlySyntax);
    }
  });

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
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "1",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
          buildImage,
          removeImage: vi.fn(() => ({ status: 0 }) as never),
        }),
      );

      expect(stageBuildContext).toHaveBeenCalledWith(
        expect.objectContaining({ root: ROOT, agent: null }),
      );
      expect(buildImage).toHaveBeenCalledOnce();
      expect(cleanupBuildCtx).not.toHaveBeenCalled();
      expect(result.prepared.prebuildBuilder).toBeUndefined();
      expect(result.prepared.prebuildDockerEnv).toBeUndefined();
      expect(verifyPreparedBuildContext(result.prepared)).toBe(true);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
      expect(cleanupBuildCtx).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });

  it("retries an exact generated image once with the legacy builder when Buildx is unavailable (#7111)", async () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-buildx-fallback-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    });
    const buildImage = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stderr: Buffer.from(
          "ERROR: BuildKit is enabled but the buildx component is missing or broken.",
        ),
      } as never)
      .mockReturnValueOnce({ status: 0 } as never);
    const dockerEnv = Object.freeze({
      DOCKER_CONFIG: "/home/test/.docker",
      DOCKER_CONTEXT: "verified-builder",
    });
    const buildxAvailable = vi.fn(() => false);
    const removeImage = vi.fn(() => ({ status: 0 }) as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = successful(
        await preflightRebuildImage(input(null), {
          stageBuildContext: vi.fn(() => ({
            buildCtx,
            stagedDockerfile,
            cleanupBuildCtx,
            origin: "generated" as const,
          })),
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "buildx-fallback",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
          buildImage,
          buildxAvailable,
          buildDockerEnv: () => dockerEnv,
          removeImage,
        }),
      );

      expect(buildImage).toHaveBeenCalledTimes(2);
      expect(buildImage.mock.calls[0]?.[3]).toEqual(
        expect.objectContaining({ cwd: ROOT, env: dockerEnv }),
      );
      expect(buildImage.mock.calls[1]?.[3]).toEqual(
        expect.objectContaining({
          cwd: ROOT,
          env: { ...dockerEnv, DOCKER_BUILDKIT: "0" },
        }),
      );
      expect(buildxAvailable).toHaveBeenCalledWith({ cwd: ROOT, env: dockerEnv });
      expect(removeImage).toHaveBeenCalledWith(
        expect.stringMatching(/^nemoclaw-rebuild-preflight:/),
        expect.objectContaining({ cwd: ROOT, env: dockerEnv }),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacy builder"));
      expect(result.prepared.prebuildBuilder).toBe("legacy");
      expect(result.prepared.prebuildDockerEnv).toEqual(dockerEnv);
      expect(result.prepared.prebuildDockerEnv).not.toBe(dockerEnv);
      expect(verifyPreparedBuildContext(result.prepared)).toBe(true);
      const clonedPrepared = { ...result.prepared };
      expect(clonedPrepared.verifyBuildCtx()).toBe(false);
      expect(verifyPreparedBuildContext(clonedPrepared)).toBe(false);
      (result.prepared as { prebuildBuilder?: string }).prebuildBuilder = "buildkit";
      expect(result.prepared.verifyBuildCtx()).toBe(false);
      (result.prepared as { prebuildBuilder?: string }).prebuildBuilder = "legacy";
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      warn.mockRestore();
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });

  it.each([
    ["the independent Buildx probe succeeds", null, true, true],
    ["the generated target is not managed OpenClaw", { name: "hermes" }, false, true],
    ["local image prebuild is unavailable", null, false, false],
  ])("does not downgrade the builder when %s", async (_label, agent, available, localPrebuildEnabled) => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-buildx-no-downgrade-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    });
    const buildImage = vi.fn(
      () =>
        ({
          status: 1,
          stderr: "ERROR: BuildKit is enabled but the buildx component is missing or broken.",
        }) as never,
    );

    try {
      const result = await preflightRebuildImage(
        { ...input(null), agent: agent as never, localPrebuildEnabled },
        {
          stageBuildContext: vi.fn(() => ({
            buildCtx,
            stagedDockerfile,
            cleanupBuildCtx,
            origin: "generated" as const,
          })),
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "no-builder-downgrade",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
          buildImage,
          buildxAvailable: () => available,
          removeImage: vi.fn(() => ({ status: 0 }) as never),
        },
      );

      expect(result).toEqual({
        ok: false,
        detail: "ERROR: BuildKit is enabled but the buildx component is missing or broken.",
      });
      expect(buildImage).toHaveBeenCalledOnce();
      expect(cleanupBuildCtx).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });

  it("does not retry a custom Dockerfile when Buildx is unavailable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-buildx-"));
    const dockerfile = path.join(dir, "Dockerfile.custom");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    const buildImage = vi.fn(
      () =>
        ({
          status: 1,
          stderr: "ERROR: BuildKit is enabled but the buildx component is missing or broken.",
        }) as never,
    );

    try {
      const result = await preflightRebuildImage(input(dockerfile), {
        prepareDockerfilePatch: vi.fn(async () => ({
          buildId: "custom-buildx",
          dashboardRemoteBindPrepared: false,
          resolvedBaseImage: null,
        })),
        buildImage,
        removeImage: vi.fn(() => ({ status: 0 }) as never),
      });

      expect(result).toEqual({
        ok: false,
        detail: "ERROR: BuildKit is enabled but the buildx component is missing or broken.",
      });
      expect(buildImage).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects generated build-context drift before a legacy-builder retry", async () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-buildx-drift-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    });
    const buildImage = vi.fn(() => {
      fs.writeFileSync(path.join(buildCtx, "mutated"), "changed\n");
      return {
        status: 1,
        stderr: "ERROR: BuildKit is enabled but the buildx component is missing or broken.",
      } as never;
    });

    try {
      await expect(
        preflightRebuildImage(input(null), {
          stageBuildContext: vi.fn(() => ({
            buildCtx,
            stagedDockerfile,
            cleanupBuildCtx,
            origin: "generated" as const,
          })),
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "buildx-drift",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
          buildImage,
          buildxAvailable: () => false,
          removeImage: vi.fn(() => ({ status: 0 }) as never),
        }),
      ).resolves.toEqual({
        ok: false,
        detail: "replacement build context changed during preflight",
      });
      expect(buildImage).toHaveBeenCalledOnce();
      expect(cleanupBuildCtx).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });

  it("prioritizes the redacted legacy failure when both generated-image attempts fail", async () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-buildx-double-fail-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    const credential = ["legacy", "retry", "credential"].join("-");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    });
    const buildImage = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stderr:
          "ERROR: BuildKit is enabled but the buildx component is missing or broken.\n" +
          "x".repeat(9_000),
      } as never)
      .mockReturnValueOnce({
        status: 1,
        stderr:
          `legacy build could not read ${os.homedir()}/private-context\n` +
          `Authorization: Bearer ${credential}`,
      } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await preflightRebuildImage(input(null), {
        stageBuildContext: vi.fn(() => ({
          buildCtx,
          stagedDockerfile,
          cleanupBuildCtx,
          origin: "generated" as const,
        })),
        prepareDockerfilePatch: vi.fn(async () => ({
          buildId: "buildx-double-fail",
          dashboardRemoteBindPrepared: false,
          resolvedBaseImage: null,
        })),
        buildImage,
        buildxAvailable: () => false,
        removeImage: vi.fn(() => ({ status: 0 }) as never),
      });

      expect(result.ok).toBe(false);
      const failure = result as Extract<RebuildImagePreflightResult, { ok: false }>;
      expect(failure.detail).toContain("Legacy-builder retry failed");
      expect(failure.detail).toContain("legacy build could not read ~/private-context");
      expect(failure.detail).toContain("Authorization: Bearer <REDACTED>");
      expect(failure.detail).not.toContain(credential);
      expect(failure.detail.length).toBeLessThan(8_100);
      expect(buildImage).toHaveBeenCalledTimes(2);
      expect(cleanupBuildCtx).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });

  it("does not retry an unrelated generated-image build failure", async () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-no-retry-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    });
    const buildImage = vi.fn(() => ({ status: 1, stderr: "registry timeout" }) as never);

    try {
      await expect(
        preflightRebuildImage(input(null), {
          stageBuildContext: vi.fn(() => ({
            buildCtx,
            stagedDockerfile,
            cleanupBuildCtx,
            origin: "generated" as const,
          })),
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "unrelated-build-failure",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
          buildImage,
          removeImage: vi.fn(() => ({ status: 0 }) as never),
        }),
      ).resolves.toEqual({ ok: false, detail: "registry timeout" });
      expect(buildImage).toHaveBeenCalledOnce();
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
              dashboardRemoteBindPrepared: false,
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
        prepareDockerfilePatch: vi.fn(async () => ({
          buildId: "1",
          dashboardRemoteBindPrepared: false,
          resolvedBaseImage: null,
        })),
        buildImage: vi.fn(() => ({ status: 1, stderr: "dockerfile validation failed" }) as never),
        removeImage,
      });
      expect(result).toEqual({ ok: false, detail: "dockerfile validation failed" });
      expect(removeImage).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces redacted Buffer diagnostics when the replacement image build fails (#7111)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-diagnostic-"));
    const dockerfile = path.join(dir, "Dockerfile.custom");
    const credential = ["release", "diagnostic", "credential"].join("-");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    try {
      const result = await preflightRebuildImage(input(dockerfile), {
        prepareDockerfilePatch: vi.fn(async () => ({
          buildId: "1",
          dashboardRemoteBindPrepared: false,
          resolvedBaseImage: null,
        })),
        buildImage: vi.fn(
          () =>
            ({
              status: 1,
              stderr: Buffer.from(
                `failed to solve: build context unavailable at ${os.homedir()}/private-context\n` +
                  `Authorization: Bearer ${credential}`,
              ),
            }) as never,
        ),
        removeImage: vi.fn(() => ({ status: 0 }) as never),
      });

      expect(result).toEqual({
        ok: false,
        detail:
          "failed to solve: build context unavailable at ~/private-context\n" +
          "Authorization: Bearer <REDACTED>",
      });
      expect(JSON.stringify(result)).not.toContain(credential);
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
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "1",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
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
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "1",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
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
    const dockerEnv = Object.freeze({ DOCKER_CONTEXT: "cleanup-builder" });
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
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "1",
            dashboardRemoteBindPrepared: true,
            resolvedBaseImage: null,
          })),
          buildImage: vi.fn(() => ({ status: 0 }) as never),
          buildDockerEnv: () => dockerEnv,
          removeImage,
        }),
      );

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("failed to remove temporary rebuild preflight image"),
      );
      expect(processOnce).toHaveBeenCalledWith("exit", expect.any(Function));
      expect(removeImage).toHaveBeenCalledTimes(2);
      for (const call of removeImage.mock.calls) {
        expect(call[1]).toEqual(expect.objectContaining({ cwd: ROOT, env: dockerEnv }));
      }
      expect(result.prepared.dashboardRemoteBindPrepared).toBe(true);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      processOnce.mockRestore();
      warn.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
