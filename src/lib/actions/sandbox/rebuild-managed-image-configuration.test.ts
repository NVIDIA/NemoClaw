// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { restoreEnv } from "../../../../test/helpers/env-test-helpers";
import {
  dcodeInput,
  expectPreparedImage,
  writeDcodeRebuildDockerfile,
} from "../../../../test/helpers/rebuild-managed-image-preflight-harness";
import {
  disposePreparedDcodeRebuildImage,
  prepareManagedDcodeRebuildImage,
} from "./rebuild-managed-image-preflight";
import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";

describe("managed DCode rebuild image configuration", () => {
  it("pins recorded reasoning and web search while restoring ambient state (#6195)", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-rebuild-fidelity-"));
    const stagedDockerfile = path.join(testRoot, "Dockerfile");
    writeDcodeRebuildDockerfile(stagedDockerfile);
    const previousReasoning = process.env.NEMOCLAW_REASONING;
    process.env.NEMOCLAW_REASONING = "false";
    let reasoningDuringPatch: string | undefined;
    const prepareDockerfilePatch = vi.fn(async () => {
      reasoningDuringPatch = process.env.NEMOCLAW_REASONING;
      return {
        buildId: "dcode-fidelity",
        dashboardRemoteBindPrepared: false,
        resolvedBaseImage: null,
      };
    });

    try {
      const result = await prepareManagedDcodeRebuildImage(
        dcodeInput({
          compatibleEndpointReasoning: "true",
          webSearchConfig: { fetchEnabled: true, provider: "tavily" },
        }),
        {
          stageBuildContext: () => ({
            buildCtx: testRoot,
            stagedDockerfile,
            origin: "generated" as const,
            cleanupBuildCtx: () => {
              fs.rmSync(testRoot, { recursive: true, force: true });
              return true;
            },
          }),
          prepareDockerfilePatch,
          buildImage: () => ({ status: 0 }) as never,
          removeImage: () => ({ status: 0 }) as never,
        },
      );

      expect(result.ok).toBe(true);
      expect(reasoningDuringPatch).toBe("true");
      expect(prepareDockerfilePatch).toHaveBeenCalledWith(
        expect.objectContaining({
          webSearchConfig: { fetchEnabled: true, provider: "tavily" },
        }),
      );
      expect(process.env.NEMOCLAW_REASONING).toBe("false");
      disposePreparedDcodeRebuildImage(expectPreparedImage(result));
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
      restoreEnv("NEMOCLAW_REASONING", previousReasoning);
    }
  });

  it("binds DCode auto-approval mode into the prepared image configuration (#6478)", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-rebuild-auto-approval-"));
    const stagedDockerfile = path.join(testRoot, "Dockerfile");
    writeDcodeRebuildDockerfile(stagedDockerfile);
    const prepareDockerfilePatch = vi.fn(async () => ({
      buildId: "dcode-auto-approval",
      dashboardRemoteBindPrepared: false,
      resolvedBaseImage: null,
    }));

    try {
      const result = await prepareManagedDcodeRebuildImage(
        dcodeInput({ dcodeAutoApprovalMode: "thread-opt-in" }),
        {
          stageBuildContext: () => ({
            buildCtx: testRoot,
            stagedDockerfile,
            origin: "generated" as const,
            cleanupBuildCtx: () => {
              fs.rmSync(testRoot, { recursive: true, force: true });
              return true;
            },
          }),
          prepareDockerfilePatch,
          buildImage: () => ({ status: 0 }) as never,
          removeImage: () => ({ status: 0 }) as never,
        },
      );

      expect(result.ok).toBe(true);
      expect(prepareDockerfilePatch).toHaveBeenCalledWith(
        expect.objectContaining({ dcodeAutoApprovalMode: "thread-opt-in" }),
      );
      expect(expectPreparedImage(result).dcodeAutoApprovalMode).toBe("thread-opt-in");
      disposePreparedDcodeRebuildImage(expectPreparedImage(result));
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("passes pinned base-image resolution metadata to DCode Dockerfile patching (#9386)", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-rebuild-base-resolution-"));
    const stagedDockerfile = path.join(testRoot, "Dockerfile");
    const digest = `sha256:${"a".repeat(64)}`;
    const metadata = {
      schema: 1,
      key: "dcode-platform-base",
      imageName: "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
      ref: `ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base@${digest}`,
      digest,
      source: "override",
      imageId: `sha256:${"b".repeat(64)}`,
      os: "linux",
      architecture: "amd64",
      glibcVersion: "2.41",
      requireOpenshellSandboxAbi: true,
      minGlibcVersion: "2.39",
    } satisfies SandboxBaseImageResolutionMetadata;
    writeDcodeRebuildDockerfile(stagedDockerfile, metadata);
    const prepareDockerfilePatch = vi.fn(async () => ({
      buildId: "dcode-base-resolution",
      dashboardRemoteBindPrepared: false,
      resolvedBaseImage: null,
    }));

    try {
      const result = await prepareManagedDcodeRebuildImage(
        dcodeInput({
          dcodeAutoApprovalMode: "thread-opt-in",
          preResolvedBaseImageMetadata: metadata,
        }),
        {
          stageBuildContext: () => ({
            buildCtx: testRoot,
            stagedDockerfile,
            origin: "generated" as const,
            cleanupBuildCtx: () => {
              fs.rmSync(testRoot, { recursive: true, force: true });
              return true;
            },
          }),
          prepareDockerfilePatch,
          buildImage: () => ({ status: 0 }) as never,
          removeImage: () => ({ status: 0 }) as never,
        },
      );

      expect(result.ok).toBe(true);
      expect(prepareDockerfilePatch).toHaveBeenCalledWith(
        expect.objectContaining({
          dcodeAutoApprovalMode: "thread-opt-in",
          preResolvedBaseImageMetadata: metadata,
        }),
      );
      disposePreparedDcodeRebuildImage(expectPreparedImage(result));
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("rejects a staged DCode base image that differs from pinned base-image resolution metadata (#9386)", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-rebuild-base-mismatch-"));
    const stagedDockerfile = path.join(testRoot, "Dockerfile");
    const input = dcodeInput();
    writeDcodeRebuildDockerfile(stagedDockerfile, {
      ...input.preResolvedBaseImageMetadata,
      ref: `ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base@sha256:${"c".repeat(64)}`,
    });
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(testRoot, { recursive: true, force: true });
      return true;
    });
    const prepareDockerfilePatch = vi.fn();
    const buildImage = vi.fn();

    try {
      await expect(
        prepareManagedDcodeRebuildImage(input, {
          stageBuildContext: () => ({
            buildCtx: testRoot,
            stagedDockerfile,
            origin: "generated" as const,
            cleanupBuildCtx,
          }),
          prepareDockerfilePatch,
          buildImage,
          removeImage: () => ({ status: 0 }) as never,
        }),
      ).resolves.toEqual({
        ok: false,
        detail:
          "managed DCode staged base image does not match pinned base-image resolution metadata",
      });
      expect(prepareDockerfilePatch).not.toHaveBeenCalled();
      expect(buildImage).not.toHaveBeenCalled();
      expect(cleanupBuildCtx).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("preserves remote dashboard bind preparation from the managed Dockerfile patch (#6024)", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-rebuild-remote-bind-"));
    const stagedDockerfile = path.join(testRoot, "Dockerfile");
    writeDcodeRebuildDockerfile(stagedDockerfile);

    try {
      const result = await prepareManagedDcodeRebuildImage(dcodeInput(), {
        stageBuildContext: () => ({
          buildCtx: testRoot,
          stagedDockerfile,
          origin: "generated" as const,
          cleanupBuildCtx: () => {
            fs.rmSync(testRoot, { recursive: true, force: true });
            return true;
          },
        }),
        prepareDockerfilePatch: async () => ({
          buildId: "dcode-remote-bind",
          dashboardRemoteBindPrepared: true,
          resolvedBaseImage: null,
        }),
        buildImage: () => ({ status: 0 }) as never,
        removeImage: () => ({ status: 0 }) as never,
      });

      const prepared = expectPreparedImage(result);
      expect(prepared.dashboardRemoteBindPrepared).toBe(true);
      disposePreparedDcodeRebuildImage(prepared);
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("defaults missing compatible-endpoint reasoning without borrowing ambient state (#6195)", async () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-rebuild-reasoning-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    writeDcodeRebuildDockerfile(stagedDockerfile);
    const previousReasoning = process.env.NEMOCLAW_REASONING;
    process.env.NEMOCLAW_REASONING = "true";
    let reasoningDuringPatch: string | undefined;

    try {
      const result = await prepareManagedDcodeRebuildImage(
        dcodeInput({ compatibleEndpointReasoning: null }),
        {
          stageBuildContext: () => ({
            buildCtx,
            stagedDockerfile,
            origin: "generated" as const,
            cleanupBuildCtx: () => {
              fs.rmSync(buildCtx, { recursive: true, force: true });
              return true;
            },
          }),
          prepareDockerfilePatch: async () => {
            reasoningDuringPatch = process.env.NEMOCLAW_REASONING;
            return {
              buildId: "dcode-reasoning-default",
              dashboardRemoteBindPrepared: false,
              resolvedBaseImage: null,
            };
          },
          buildImage: () => ({ status: 0 }) as never,
          removeImage: () => ({ status: 0 }) as never,
        },
      );

      expect(result.ok).toBe(true);
      expect(reasoningDuringPatch).toBe("false");
      expect(process.env.NEMOCLAW_REASONING).toBe("true");
      disposePreparedDcodeRebuildImage(expectPreparedImage(result));
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      restoreEnv("NEMOCLAW_REASONING", previousReasoning);
    }
  });
});
