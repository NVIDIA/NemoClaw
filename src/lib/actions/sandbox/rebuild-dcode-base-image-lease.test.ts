// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  configureDcodeSession,
  makeDcodeSandboxEntry,
} from "../../../../test/helpers/rebuild-dcode-flow-helpers";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  snapshotEnv,
} from "../../../../test/helpers/rebuild-flow-dcode-harness";

const overrideEnvName = "NEMOCLAW_LANGCHAIN_DEEPAGENTS_CODE_SANDBOX_BASE_IMAGE_REF";
const trustedLocalOverride = {
  ref: `nemoclaw-langchain-deepagents-code-sandbox-base-local:image-${"a".repeat(64)}`,
  provenance: `${"b".repeat(64)}.${"c".repeat(64)}`,
};
const trustedRemoteRef = `ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base@sha256:${"d".repeat(64)}`;
const trustedLocalResolutionMetadata = {
  schema: 1,
  key: "trusted-local-dcode-base",
  imageName: "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
  ref: trustedLocalOverride.ref,
  digest: null,
  source: "local",
  imageId: `sha256:${"a".repeat(64)}`,
  os: "linux",
  architecture: "amd64",
  glibcVersion: "2.41",
  requireOpenshellSandboxAbi: true,
  minGlibcVersion: "2.39",
};
const trustedRemoteResolutionMetadata = {
  schema: 1,
  key: "trusted-remote-dcode-base",
  imageName: "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
  ref: trustedRemoteRef,
  digest: `sha256:${"d".repeat(64)}`,
  source: "source-sha",
  imageId: "sha256:dcode-base",
  os: "linux",
  architecture: "amd64",
  glibcVersion: "2.41",
  requireOpenshellSandboxAbi: true,
  minGlibcVersion: "2.39",
};

describe("rebuildSandbox DCode flow: base-image trust lease", () => {
  installRebuildFlowTestHooks({ acceptThirdPartySoftware: true });

  it("keeps the current base-image trust lease active through replacement preparation (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
    });
    configureDcodeSession(harness);
    let leaseActive = false;
    harness.restoreTrustedAgentBaseImageOverrideSpy.mockImplementation(() => {
      leaseActive = false;
    });
    harness.pinTrustedAgentBaseImageOverrideForOperationSpy.mockImplementation(() => {
      leaseActive = true;
      return harness.restoreTrustedAgentBaseImageOverrideSpy;
    });
    harness.prepareManagedDcodeRebuildImageSpy.mockImplementation(async (input) => {
      expect(leaseActive).toBe(true);
      expect(process.env[overrideEnvName]).toBe(trustedLocalOverride.ref);
      expect(input.preResolvedBaseImageMetadata).toMatchObject({
        ref: trustedLocalOverride.ref,
        imageId: `sha256:${"a".repeat(64)}`,
      });
      return { ok: true, prepared: harness.preparedDcodeBuildContext };
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.pinTrustedAgentBaseImageOverrideForOperationSpy).toHaveBeenCalledWith(
      overrideEnvName,
      trustedLocalOverride,
    );
    expect(harness.restoreTrustedAgentBaseImageOverrideSpy).toHaveBeenCalledOnce();
    expect(leaseActive).toBe(false);
  });

  it("uses the refreshed published base without recompiling native libraries (#8120)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
    });
    configureDcodeSession(harness);
    const resolutionMetadata = trustedRemoteResolutionMetadata;
    harness.ensureAgentBaseImageSpy.mockReturnValue({
      imageTag: trustedRemoteRef,
      built: false,
      resolutionMetadata,
    });
    let leaseActive = false;
    harness.restoreTrustedAgentRemoteBaseImageOverrideSpy.mockImplementation(() => {
      leaseActive = false;
    });
    harness.pinTrustedAgentRemoteBaseImageOverrideForOperationSpy.mockImplementation(() => {
      leaseActive = true;
      return harness.restoreTrustedAgentRemoteBaseImageOverrideSpy;
    });
    harness.prepareManagedDcodeRebuildImageSpy.mockImplementation(async (input) => {
      expect(leaseActive).toBe(true);
      expect(process.env[overrideEnvName]).toBe(trustedRemoteRef);
      expect(input.preResolvedBaseImageMetadata).toBe(resolutionMetadata);
      return { ok: true, prepared: harness.preparedDcodeBuildContext };
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.ensureAgentBaseImageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "langchain-deepagents-code" }),
      { forceBaseImageRefresh: true },
    );
    expect(harness.ensureAgentBaseImageSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ forceBaseImageRebuild: true }),
    );
    expect(harness.pinTrustedAgentRemoteBaseImageOverrideForOperationSpy).toHaveBeenCalledWith(
      overrideEnvName,
      { ref: trustedRemoteRef, resolutionMetadata },
    );
    expect(harness.pinTrustedAgentBaseImageOverrideForOperationSpy).not.toHaveBeenCalled();
    expect(harness.restoreTrustedAgentRemoteBaseImageOverrideSpy).toHaveBeenCalledOnce();
    expect(harness.dockerRmiSpy).not.toHaveBeenCalledWith(trustedRemoteRef, expect.anything());
    expect(leaseActive).toBe(false);
  });

  it("forces a trusted local build when refresh returns a mutable reference (#8120)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
    });
    configureDcodeSession(harness);
    harness.ensureAgentBaseImageSpy
      .mockReturnValueOnce({
        imageTag: "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest",
        built: false,
      })
      .mockReturnValueOnce({
        imageTag: trustedLocalOverride.ref,
        built: true,
        trustedLocalOverride,
        resolutionMetadata: trustedLocalResolutionMetadata,
      });
    let leaseActive = false;
    harness.restoreTrustedAgentBaseImageOverrideSpy.mockImplementation(() => {
      leaseActive = false;
    });
    harness.pinTrustedAgentBaseImageOverrideForOperationSpy.mockImplementation(() => {
      leaseActive = true;
      return harness.restoreTrustedAgentBaseImageOverrideSpy;
    });
    harness.prepareManagedDcodeRebuildImageSpy.mockImplementation(async (input) => {
      expect(leaseActive).toBe(true);
      expect(process.env[overrideEnvName]).toBe(trustedLocalOverride.ref);
      expect(input.preResolvedBaseImageMetadata).toBe(trustedLocalResolutionMetadata);
      return { ok: true, prepared: harness.preparedDcodeBuildContext };
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.ensureAgentBaseImageSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "langchain-deepagents-code" }),
      { forceBaseImageRefresh: true },
    );
    expect(harness.ensureAgentBaseImageSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "langchain-deepagents-code" }),
      { forceBaseImageRebuild: true },
    );
    expect(harness.pinTrustedAgentBaseImageOverrideForOperationSpy).toHaveBeenCalledWith(
      overrideEnvName,
      trustedLocalOverride,
    );
    expect(harness.pinTrustedAgentRemoteBaseImageOverrideForOperationSpy).not.toHaveBeenCalled();
    expect(harness.restoreTrustedAgentBaseImageOverrideSpy).toHaveBeenCalledOnce();
    expect(leaseActive).toBe(false);
  });

  it("restores the published base-image trust lease when replacement preparation throws (#8120)", async () => {
    const restoreEnv = snapshotEnv([overrideEnvName]);
    process.env[overrideEnvName] = "caller-selected-base:current";
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
    });
    configureDcodeSession(harness);
    const resolutionMetadata = trustedRemoteResolutionMetadata;
    harness.ensureAgentBaseImageSpy.mockReturnValue({
      imageTag: trustedRemoteRef,
      built: false,
      resolutionMetadata,
    });
    let leaseActive = false;
    harness.restoreTrustedAgentRemoteBaseImageOverrideSpy.mockImplementation(() => {
      leaseActive = false;
    });
    harness.pinTrustedAgentRemoteBaseImageOverrideForOperationSpy.mockImplementation(() => {
      leaseActive = true;
      return harness.restoreTrustedAgentRemoteBaseImageOverrideSpy;
    });
    harness.prepareManagedDcodeRebuildImageSpy.mockImplementation(async () => {
      expect(leaseActive).toBe(true);
      expect(process.env[overrideEnvName]).toBe(trustedRemoteRef);
      throw new Error("fixture preparation failed");
    });

    try {
      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("fixture preparation failed");

      expect(harness.pinTrustedAgentRemoteBaseImageOverrideForOperationSpy).toHaveBeenCalledWith(
        overrideEnvName,
        { ref: trustedRemoteRef, resolutionMetadata },
      );
      expect(harness.pinTrustedAgentBaseImageOverrideForOperationSpy).not.toHaveBeenCalled();
      expect(harness.restoreTrustedAgentRemoteBaseImageOverrideSpy).toHaveBeenCalledOnce();
      expect(harness.dockerRmiSpy).not.toHaveBeenCalledWith(trustedRemoteRef, expect.anything());
      expect(leaseActive).toBe(false);
      expect(process.env[overrideEnvName]).toBe("caller-selected-base:current");
    } finally {
      restoreEnv();
    }
  });

  it("restores the base-image trust lease when replacement preparation throws (#6195)", async () => {
    const restoreEnv = snapshotEnv([overrideEnvName]);
    process.env[overrideEnvName] = "caller-selected-base:current";
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
    });
    configureDcodeSession(harness);
    let leaseActive = false;
    harness.restoreTrustedAgentBaseImageOverrideSpy.mockImplementation(() => {
      leaseActive = false;
    });
    harness.pinTrustedAgentBaseImageOverrideForOperationSpy.mockImplementation(() => {
      leaseActive = true;
      return harness.restoreTrustedAgentBaseImageOverrideSpy;
    });
    harness.prepareManagedDcodeRebuildImageSpy.mockImplementation(async () => {
      expect(leaseActive).toBe(true);
      expect(process.env[overrideEnvName]).toBe(trustedLocalOverride.ref);
      throw new Error("fixture preparation failed");
    });

    try {
      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("fixture preparation failed");

      expect(harness.pinTrustedAgentBaseImageOverrideForOperationSpy).toHaveBeenCalledWith(
        overrideEnvName,
        trustedLocalOverride,
      );
      expect(harness.restoreTrustedAgentBaseImageOverrideSpy).toHaveBeenCalledOnce();
      expect(leaseActive).toBe(false);
      expect(process.env[overrideEnvName]).toBe("caller-selected-base:current");
    } finally {
      restoreEnv();
    }
  });

  it("rejects base-image resolution metadata for a different local image (#9386)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
    });
    configureDcodeSession(harness);
    harness.ensureAgentBaseImageSpy.mockReturnValue({
      imageTag: trustedLocalOverride.ref,
      built: true,
      trustedLocalOverride,
      resolutionMetadata: {
        ...trustedLocalResolutionMetadata,
        imageId: `sha256:${"e".repeat(64)}`,
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("DCode base-image resolution metadata does not match the pinned image");

    expect(harness.prepareManagedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expect(harness.dockerRmiSpy).toHaveBeenCalledWith(trustedLocalOverride.ref, {
      ignoreError: true,
      suppressOutput: true,
    });
  });
});
