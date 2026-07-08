// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, vi } from "vitest";
import {
  disposePreparedDcodeRebuildImage,
  type ManagedDcodeRebuildImageInput,
  type ManagedDcodeRebuildImageResult,
  type PreparedDcodeRebuildImage,
  prepareManagedDcodeRebuildImage,
} from "../../src/lib/actions/sandbox/rebuild-managed-image-preflight";
import { loadAgent } from "../../src/lib/agent/defs";

export const NO_FOLLOW_FLAG =
  typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
export const NON_BLOCK_FLAG =
  typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;

export function expectPreparedImage(
  result: ManagedDcodeRebuildImageResult,
): PreparedDcodeRebuildImage {
  expect(result.ok).toBe(true);
  return (result as Extract<ManagedDcodeRebuildImageResult, { ok: true }>).prepared;
}

export function dcodeInput(
  overrides: Partial<ManagedDcodeRebuildImageInput> = {},
): ManagedDcodeRebuildImageInput {
  return {
    agent: loadAgent("langchain-deepagents-code"),
    model: "nvidia/nemotron-3-super-120b-a12b",
    provider: "compatible-endpoint",
    preferredInferenceApi: "openai-completions",
    compatibleEndpointReasoning: "false",
    dcodeAutoApprovalMode: "disabled",
    toolDisclosure: "progressive",
    webSearchConfig: null,
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

export async function createPreparedDcodeImageFixture(
  overrides: Partial<ManagedDcodeRebuildImageInput> = {},
) {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-rebuild-context-"));
  const buildCtx = path.join(testRoot, "context");
  fs.mkdirSync(buildCtx);
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  const originalDockerfile = path.join(testRoot, "Dockerfile.original");
  const replacementDockerfile = path.join(testRoot, "Dockerfile.replacement");
  fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
  const stableDockerfileTime = new Date("2026-01-01T00:00:00.000Z");
  fs.utimesSync(stagedDockerfile, stableDockerfileTime, stableDockerfileTime);
  fs.writeFileSync(replacementDockerfile, "FROM attacker-controlled\n");
  fs.utimesSync(buildCtx, stableDockerfileTime, stableDockerfileTime);
  const cleanupBuildCtx = vi.fn(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    return true;
  });
  const stageBuildContext = vi.fn(() => ({
    buildCtx,
    stagedDockerfile,
    cleanupBuildCtx,
    origin: "generated" as const,
  }));
  const prepareDockerfilePatch = vi.fn(async () => ({
    buildId: "dcode-build-1",
    resolvedBaseImage: null,
  }));
  const buildImage = vi.fn(() => ({ status: 0 }) as never);
  const removeImage = vi.fn(() => ({ status: 0 }) as never);
  const result = await prepareManagedDcodeRebuildImage(dcodeInput(overrides), {
    stageBuildContext,
    prepareDockerfilePatch,
    buildImage,
    removeImage,
    createImageTag: () => "nemoclaw-rebuild-preflight:dcode-success",
  });
  return {
    testRoot,
    buildCtx,
    stagedDockerfile,
    originalDockerfile,
    replacementDockerfile,
    stableDockerfileTime,
    cleanupBuildCtx,
    stageBuildContext,
    prepareDockerfilePatch,
    buildImage,
    removeImage,
    result,
    prepared: expectPreparedImage(result),
  };
}

export function cleanupPreparedDcodeImageFixture(
  fixture: Awaited<ReturnType<typeof createPreparedDcodeImageFixture>>,
): void {
  disposePreparedDcodeRebuildImage(fixture.prepared);
  fs.rmSync(fixture.testRoot, { recursive: true, force: true });
}
