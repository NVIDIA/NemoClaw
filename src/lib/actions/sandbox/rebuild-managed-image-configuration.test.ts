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
} from "../../../../test/helpers/rebuild-managed-image-preflight-harness";
import {
  disposePreparedDcodeRebuildImage,
  prepareManagedDcodeRebuildImage,
} from "./rebuild-managed-image-preflight";

describe("managed DCode rebuild image configuration", () => {
  it("pins recorded reasoning and web search while restoring ambient state (#6195)", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-rebuild-fidelity-"));
    const stagedDockerfile = path.join(testRoot, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const previousReasoning = process.env.NEMOCLAW_REASONING;
    process.env.NEMOCLAW_REASONING = "false";
    let reasoningDuringPatch: string | undefined;
    const prepareDockerfilePatch = vi.fn(async () => {
      reasoningDuringPatch = process.env.NEMOCLAW_REASONING;
      return { buildId: "dcode-fidelity", resolvedBaseImage: null };
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
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const prepareDockerfilePatch = vi.fn(async () => ({
      buildId: "dcode-auto-approval",
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

  it("defaults missing compatible-endpoint reasoning without borrowing ambient state (#6195)", async () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-rebuild-reasoning-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
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
            return { buildId: "dcode-reasoning-default", resolvedBaseImage: null };
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
