// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoSandboxDelete } from "../../../../test/helpers/rebuild-delete-assertions";
import {
  createRebuildFlowHarness,
  resetRebuildFlowTestEnvironment,
  restoreRebuildFlowTestEnvironment,
} from "../../../../test/helpers/rebuild-flow-harness";
import { fingerprintBuildContext } from "../../adapters/fs/build-context-fingerprint";
import type {
  PreparedOpenClawLegacyImage,
  PreparedSandboxBuildContext,
} from "../../onboard/build-context-stage";

type RetainedImageFixture = {
  buildContext: PreparedSandboxBuildContext & {
    contextFingerprint: string;
    verifyBuildCtx(): boolean;
  };
  lease: PreparedOpenClawLegacyImage;
  verifyImage: ReturnType<typeof vi.fn>;
  retainForRecreate: ReturnType<typeof vi.fn>;
};

function createRetainedImageFixture(imageVerificationResults: boolean[]): RetainedImageFixture {
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-buildx-boundary-"));
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
  const contextFingerprint = fingerprintBuildContext(buildCtx);
  const verifyImage = vi.fn(() => imageVerificationResults.shift() ?? true);
  const retainForRecreate = vi.fn(() => true);
  const lease = Object.freeze({
    dockerEnv: Object.freeze({ DOCKER_CONTEXT: "verified-builder" }),
    engineId: "verified-engine",
    imageRef: "nemoclaw-sandbox-local:alpha-rebuild-preflight",
    imageId: `sha256:${"d".repeat(64)}`,
    verify: verifyImage,
    retainForRecreate,
    verifyForCreate: vi.fn(() => true),
    finalizeAfterCreate: vi.fn(() => ({
      mutableTagVerified: true,
      registryImageRef: null,
    })),
    abort: vi.fn(() => true),
    dispose: vi.fn(() => true),
  });
  let buildContext: RetainedImageFixture["buildContext"];
  buildContext = {
    buildCtx,
    stagedDockerfile,
    cleanupBuildCtx: vi.fn(() => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    }),
    origin: "generated",
    buildId: "retained-build",
    contextFingerprint,
    preparedOpenClawLegacyImage: lease,
    verifyBuildCtx(this: RetainedImageFixture["buildContext"]) {
      return (
        this === buildContext &&
        this.preparedOpenClawLegacyImage === lease &&
        fingerprintBuildContext(buildCtx) === contextFingerprint
      );
    },
    rebuildTarget: {
      agentName: null,
      fromDockerfile: null,
    },
  };
  return { buildContext, lease, verifyImage, retainForRecreate };
}

function sandboxDeleteCallOrder(runOpenshellSpy: ReturnType<typeof vi.fn>): number {
  const deleteCallIndex = runOpenshellSpy.mock.calls.findIndex(
    ([args]) => Array.isArray(args) && args.join(" ") === "sandbox delete -g nemoclaw alpha",
  );
  expect(deleteCallIndex).toBeGreaterThanOrEqual(0);
  return runOpenshellSpy.mock.invocationCallOrder[deleteCallIndex] ?? Number.POSITIVE_INFINITY;
}

describe("rebuildSandbox retained OpenClaw image mutation boundary", () => {
  beforeEach(resetRebuildFlowTestEnvironment);
  afterEach(restoreRebuildFlowTestEnvironment);

  it("keeps the sandbox intact when the retained image drifts at the final delete edge (#7253)", async () => {
    const fixture = createRetainedImageFixture([true, true, false]);
    const harness = createRebuildFlowHarness({
      rebuildImagePreflightResult: {
        ok: true,
        imageTag: fixture.lease.imageRef,
        prepared: fixture.buildContext,
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow(
      "The retained replacement image inputs changed before sandbox deletion. Retry the rebuild.",
    );

    expect(harness.preflightRebuildImageSpy).toHaveBeenCalledOnce();
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
    expect(fixture.verifyImage).toHaveBeenCalledTimes(3);
    expect(fixture.retainForRecreate).not.toHaveBeenCalled();
    expect(harness.reattachMcpProvidersAfterRebuildAbortSpy).toHaveBeenCalledOnce();
    expect(harness.relockSpy).toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.removeSandboxRegistryEntrySpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("commits the exact retained image immediately before delete and never rebuilds it afterward (#7253)", async () => {
    const fixture = createRetainedImageFixture([true, true, true]);
    const harness = createRebuildFlowHarness({
      rebuildImagePreflightResult: {
        ok: true,
        imageTag: fixture.lease.imageRef,
        prepared: fixture.buildContext,
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.preflightRebuildImageSpy).toHaveBeenCalledOnce();
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
    expect(fixture.verifyImage).toHaveBeenCalledTimes(3);
    expect(fixture.retainForRecreate).toHaveBeenCalledOnce();
    expect(fixture.verifyImage.mock.invocationCallOrder.at(-1)).toBeLessThan(
      fixture.retainForRecreate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    const deleteOrder = sandboxDeleteCallOrder(harness.runOpenshellSpy as never);
    expect(fixture.retainForRecreate.mock.invocationCallOrder[0]).toBeLessThan(deleteOrder);
    expect(deleteOrder).toBeLessThan(
      harness.onboardSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(harness.removeSandboxRegistryEntrySpy).toHaveBeenCalledOnce();
    expect(harness.onboardSpy).toHaveBeenCalledOnce();
  });
});
