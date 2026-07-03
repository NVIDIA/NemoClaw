// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ROOT } from "../../runner";
import { preflightRebuildImage } from "./rebuild-custom-image-preflight";

function input(fromDockerfile: string | null) {
  return {
    agent: null,
    fromDockerfile,
    model: "model",
    provider: "ollama-local",
    preferredInferenceApi: null,
    compatibleEndpointReasoning: null,
    webSearchConfig: null,
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
    const buildImage = vi.fn(() => ({ status: 0 }) as never);
    const cleanupBuildCtx = vi.fn(() => true);
    const stageBuildContext = vi.fn(() => ({
      buildCtx: "/tmp/rebuild-managed-context",
      stagedDockerfile: "/tmp/rebuild-managed-context/Dockerfile",
      cleanupBuildCtx,
    }));
    const result = await preflightRebuildImage(input(null), {
      stageBuildContext,
      prepareDockerfilePatch: vi.fn(async () => ({ buildId: "1", resolvedBaseImage: null })),
      buildImage,
      removeImage: vi.fn(),
    });

    expect(result.ok).toBe(true);
    expect(stageBuildContext).toHaveBeenCalledWith(
      expect.objectContaining({ root: ROOT, agent: null }),
    );
    expect(buildImage).toHaveBeenCalledOnce();
    expect(cleanupBuildCtx).toHaveBeenCalledOnce();
  });

  it.each([
    ["malformed syntax", "THIS IS NOT A DOCKERFILE"],
    ["missing COPY context", "FROM scratch\nCOPY missing.txt /missing.txt\n"],
  ])("fails before delete for %s", async (_label, dockerfileContents) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-"));
    const dockerfile = path.join(dir, "Dockerfile.custom");
    fs.writeFileSync(dockerfile, dockerfileContents);
    const removeImage = vi.fn();
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
    const removeImage = vi.fn();
    try {
      const result = await preflightRebuildImage(input(dockerfile), {
        prepareDockerfilePatch: vi.fn(async () => ({ buildId: "1", resolvedBaseImage: null })),
        buildImage,
        removeImage,
      });
      expect(result.ok).toBe(true);
      expect(buildImage).toHaveBeenCalledWith(
        expect.stringContaining("Dockerfile"),
        expect.stringMatching(/^nemoclaw-rebuild-preflight:/),
        expect.any(String),
        expect.objectContaining({ ignoreError: true }),
      );
      expect(removeImage).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
