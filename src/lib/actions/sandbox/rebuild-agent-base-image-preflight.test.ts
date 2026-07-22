// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RebuildFlowHelpersModule = typeof import("./rebuild-flow-helpers");
type AgentDefsModule = typeof import("../../agent/defs");
type AgentOnboardModule = typeof import("../../agent/onboard");
type DockerImageModule = typeof import("../../adapters/docker/image");
type SandboxBaseImageResolutionMetadata =
  import("../../sandbox-base-image").SandboxBaseImageResolutionMetadata;

const requireDist = createRequire(import.meta.url);
const rebuildFlowHelpersPath = "./rebuild-flow-helpers.js";
const agentDefsPath = "../../agent/defs.js";
const agentOnboardPath = "../../agent/onboard.js";
const dockerImagePath = "../../adapters/docker/image.js";
const overrideEnvVar = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";

function loadRebuildFlowHelpers(): RebuildFlowHelpersModule {
  delete require.cache[requireDist.resolve(rebuildFlowHelpersPath)];
  return requireDist(rebuildFlowHelpersPath);
}

// Warm the CommonJS dependency graph outside the first test's timeout. Tests
// still reload this entry module after installing dependency spies.
loadRebuildFlowHelpers();
delete require.cache[requireDist.resolve(rebuildFlowHelpersPath)];

function loadAgentDefs(): AgentDefsModule {
  return requireDist(agentDefsPath);
}

function loadAgentOnboard(): AgentOnboardModule {
  return requireDist(agentOnboardPath);
}

function loadDockerImage(): DockerImageModule {
  return requireDist(dockerImagePath);
}

function makeBail(): (msg: string, code?: number) => never {
  return (msg: string) => {
    throw new Error(`bail: ${msg}`);
  };
}

describe("ensureRebuildAgentBaseImage", () => {
  const hint = { key: "sandbox-a" } as SandboxBaseImageResolutionMetadata;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv(overrideEnvVar, "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function setup() {
    const agent = { name: "hermes", displayName: "Hermes" } as ReturnType<
      AgentDefsModule["loadAgent"]
    >;
    vi.spyOn(loadAgentDefs(), "loadAgent").mockReturnValue(agent);
    const ensureAgentBaseImage = vi
      .spyOn(loadAgentOnboard(), "ensureAgentBaseImage")
      .mockImplementation((_agent, options = {}) => ({
        imageTag: options.forceBaseImageRefresh
          ? "hermes:refreshed"
          : options.resolutionHint
            ? "hermes:cached"
            : "hermes:rebuilt",
        built: !options.resolutionHint,
      }));
    const bindLocalAgentBaseImageToPinnedProvenance = vi
      .spyOn(loadAgentOnboard(), "bindLocalAgentBaseImageToPinnedProvenance")
      .mockReturnValue(null);
    const pinAgentSandboxBaseImageRef = vi
      .spyOn(loadAgentOnboard(), "pinAgentSandboxBaseImageRef")
      .mockImplementation((_agentName, imageRef) => imageRef);
    const restoreTrustedRemoteOverride = vi.fn();
    const pinTrustedAgentRemoteBaseImageOverrideForOperation = vi
      .spyOn(loadAgentOnboard(), "pinTrustedAgentRemoteBaseImageOverrideForOperation")
      .mockReturnValue(restoreTrustedRemoteOverride);
    const dockerRmi = vi
      .spyOn(loadDockerImage(), "dockerRmi")
      .mockReturnValue({ status: 0 } as never);
    return {
      agent,
      ensureAgentBaseImage,
      bindLocalAgentBaseImageToPinnedProvenance,
      pinAgentSandboxBaseImageRef,
      pinTrustedAgentRemoteBaseImageOverrideForOperation,
      restoreTrustedRemoteOverride,
      dockerRmi,
    };
  }

  it("forwards a recorded hint for cache validation without forcing a legacy rebuild (#4680)", () => {
    const { agent, ensureAgentBaseImage } = setup();
    const { ensureRebuildAgentBaseImage } = loadRebuildFlowHelpers();

    expect(ensureRebuildAgentBaseImage("hermes", makeBail(), { resolutionHint: hint })).toEqual({
      ok: true,
      imageRef: "hermes:cached",
      overrideEnvVar,
    });
    expect(ensureAgentBaseImage).toHaveBeenCalledWith(agent, {
      forceBaseImageRebuild: false,
      resolutionHint: hint,
    });
  });

  it("preserves the forced local rebuild path for legacy sandboxes without a hint (#4680)", () => {
    const { agent, ensureAgentBaseImage } = setup();
    const { ensureRebuildAgentBaseImage } = loadRebuildFlowHelpers();

    expect(ensureRebuildAgentBaseImage("hermes", makeBail())).toEqual({
      ok: true,
      imageRef: "hermes:rebuilt",
      overrideEnvVar,
    });
    expect(ensureAgentBaseImage).toHaveBeenCalledWith(agent, {
      forceBaseImageRebuild: true,
    });
  });

  it("carries the current local-build proof into the recreate preflight", () => {
    const { ensureAgentBaseImage } = setup();
    const trustedLocalOverride = {
      ref: `nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`,
      provenance: `${"b".repeat(64)}.${"c".repeat(64)}`,
    };
    ensureAgentBaseImage.mockReturnValue({
      imageTag: trustedLocalOverride.ref,
      built: true,
      trustedLocalOverride,
    });
    const { ensureRebuildAgentBaseImage } = loadRebuildFlowHelpers();

    expect(ensureRebuildAgentBaseImage("hermes", makeBail())).toEqual({
      ok: true,
      imageRef: trustedLocalOverride.ref,
      overrideEnvVar,
      trustedLocalOverride,
    });
  });

  it("reports a forced Hermes base-image failure before rebuild can continue", () => {
    const { ensureAgentBaseImage } = setup();
    ensureAgentBaseImage.mockImplementation(() => {
      throw new Error("Failed to build Hermes Agent base image (exit 23)");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { ensureRebuildAgentBaseImage } = loadRebuildFlowHelpers();

    expect(() => ensureRebuildAgentBaseImage("hermes", makeBail())).toThrow(
      "Failed to build Hermes Agent base image (exit 23)",
    );

    const output = error.mock.calls.flat().join("\n");
    expect(output).toContain("Rebuild preflight failed");
    expect(output).toContain("agent base image could not be built");
    expect(output).toContain("Failed to build Hermes Agent base image (exit 23)");
    expect(output).toContain("Sandbox is untouched");
  });

  it("forwards force refresh with the sandbox-specific hint (#4680)", () => {
    const { agent, ensureAgentBaseImage } = setup();
    const { ensureRebuildAgentBaseImage } = loadRebuildFlowHelpers();

    expect(
      ensureRebuildAgentBaseImage("hermes", makeBail(), {
        resolutionHint: hint,
        forceBaseImageRefresh: true,
      }),
    ).toEqual({
      ok: true,
      imageRef: "hermes:refreshed",
      overrideEnvVar,
    });
    expect(ensureAgentBaseImage).toHaveBeenCalledWith(agent, {
      forceBaseImageRebuild: false,
      resolutionHint: hint,
      forceBaseImageRefresh: true,
    });
  });

  it("preserves resolved provenance with the immutable remote recreate handoff (#7144)", () => {
    const { ensureAgentBaseImage, pinAgentSandboxBaseImageRef, dockerRmi } = setup();
    const platformRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`;
    const resolutionMetadata = {
      key: "current-base",
      ref: platformRef,
      digest: `sha256:${"a".repeat(64)}`,
    } as SandboxBaseImageResolutionMetadata;
    ensureAgentBaseImage.mockReturnValue({
      imageTag: platformRef,
      built: false,
      resolutionMetadata,
    });
    const { ensureRebuildAgentBaseImage } = loadRebuildFlowHelpers();
    const exitListenersBefore = process.listenerCount("exit");

    const result = ensureRebuildAgentBaseImage("hermes", makeBail(), { resolutionHint: hint });

    expect(result).toEqual({
      ok: true,
      imageRef: platformRef,
      overrideEnvVar,
      resolutionMetadata,
      trustedRemoteOverride: { ref: platformRef, resolutionMetadata },
    });
    expect(pinAgentSandboxBaseImageRef).not.toHaveBeenCalled();
    expect(process.listenerCount("exit")).toBe(exitListenersBefore);
    expect(dockerRmi).not.toHaveBeenCalled();
  });

  it("binds an explicit local alias before resolving its official remote identity (#7144)", () => {
    vi.stubEnv(overrideEnvVar, "hermes:override");
    const {
      agent,
      ensureAgentBaseImage,
      bindLocalAgentBaseImageToPinnedProvenance,
      pinAgentSandboxBaseImageRef,
      pinTrustedAgentRemoteBaseImageOverrideForOperation,
      restoreTrustedRemoteOverride,
    } = setup();
    const immutableRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"c".repeat(64)}`;
    const resolutionMetadata = {
      key: "canonical-base",
      ref: immutableRef,
      digest: `sha256:${"c".repeat(64)}`,
    } as SandboxBaseImageResolutionMetadata;
    ensureAgentBaseImage.mockReturnValue({
      imageTag: immutableRef,
      built: false,
      resolutionMetadata,
    });
    bindLocalAgentBaseImageToPinnedProvenance.mockReturnValue(resolutionMetadata);
    const { ensureRebuildAgentBaseImage } = loadRebuildFlowHelpers();

    const result = ensureRebuildAgentBaseImage("hermes", makeBail());

    expect(result).toEqual({
      ok: true,
      imageRef: immutableRef,
      overrideEnvVar,
      resolutionMetadata,
      trustedRemoteOverride: { ref: immutableRef, resolutionMetadata },
    });
    expect(bindLocalAgentBaseImageToPinnedProvenance).toHaveBeenCalledWith(
      agent,
      "hermes:override",
    );
    expect(pinTrustedAgentRemoteBaseImageOverrideForOperation).toHaveBeenCalledWith(
      overrideEnvVar,
      { ref: "hermes:override", resolutionMetadata },
    );
    expect(ensureAgentBaseImage).toHaveBeenCalledWith(agent, {
      forceBaseImageRebuild: false,
    });
    expect(bindLocalAgentBaseImageToPinnedProvenance.mock.invocationCallOrder[0]).toBeLessThan(
      ensureAgentBaseImage.mock.invocationCallOrder[0],
    );
    expect(restoreTrustedRemoteOverride).toHaveBeenCalledOnce();
    expect(pinAgentSandboxBaseImageRef).not.toHaveBeenCalled();
  });

  it("retains exit cleanup until a failed temporary removal succeeds (#7144)", () => {
    const { ensureAgentBaseImage, pinAgentSandboxBaseImageRef, dockerRmi } = setup();
    const platformRef = "hermes:mutable-override";
    const localRef = `nemoclaw-hermes-sandbox-base-local:rebuild-123-${"b".repeat(16)}-image-${"c".repeat(64)}`;
    ensureAgentBaseImage.mockReturnValue({ imageTag: platformRef, built: false });
    pinAgentSandboxBaseImageRef.mockReturnValue(localRef);
    dockerRmi
      .mockReturnValueOnce({ status: 23 } as never)
      .mockReturnValueOnce({ status: 0 } as never);
    const { ensureRebuildAgentBaseImage } = loadRebuildFlowHelpers();
    const exitListenersBefore = process.listenerCount("exit");

    const result = ensureRebuildAgentBaseImage("hermes", makeBail(), { resolutionHint: hint });

    expect(process.listenerCount("exit")).toBe(exitListenersBefore + 1);
    expect(result.disposeImageRef?.()).toBe(false);
    expect(process.listenerCount("exit")).toBe(exitListenersBefore + 1);
    expect(result.disposeImageRef?.()).toBe(true);
    expect(process.listenerCount("exit")).toBe(exitListenersBefore);
    expect(dockerRmi).toHaveBeenCalledTimes(2);
  });
});
