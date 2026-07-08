// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../agent/defs";
import {
  SANDBOX_BASE_RESOLUTION_LABEL,
  type SandboxBaseImageResolutionMetadata,
} from "../sandbox-base-image";
import {
  captureBaseResolution,
  createAgentSandboxWithResolution,
  createBaseImageResolutionContext,
  getBaseImageResolutionPatchOptions,
  isSandboxBaseImageRefreshRequested,
} from "./base-image-resolution-flow";

const mocks = vi.hoisted(() => ({
  dockerImageInspectFormat: vi.fn(),
}));

vi.mock("../adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker")>()),
  dockerImageInspectFormat: mocks.dockerImageInspectFormat,
}));

const recordedMetadata: SandboxBaseImageResolutionMetadata = {
  schema: 1,
  key: "recorded-key",
  imageName: "ghcr.io/nvidia/nemoclaw/sandbox-base",
  ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:recorded",
  digest: "sha256:recorded",
  source: "version-tag",
  imageId: "sha256:recorded-image",
  os: "linux",
  architecture: "amd64",
  glibcVersion: "2.41",
  requireOpenshellSandboxAbi: true,
  minGlibcVersion: "2.39",
};

describe("base image resolution flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    "1",
    "true",
    "YES",
    "on",
  ])("recognizes the %s refresh environment value (#4680)", (value) => {
    expect(isSandboxBaseImageRefreshRequested({ NEMOCLAW_SANDBOX_BASE_IMAGE_REFRESH: value })).toBe(
      true,
    );
  });

  it("captures a recorded hint for warm runs and exposes patch options (#4680)", () => {
    mocks.dockerImageInspectFormat.mockReturnValue(
      JSON.stringify({
        [SANDBOX_BASE_RESOLUTION_LABEL]: Buffer.from(
          JSON.stringify(recordedMetadata),
          "utf8",
        ).toString("base64url"),
      }),
    );
    const context = createBaseImageResolutionContext({ fresh: false, env: {} });

    captureBaseResolution(context, "nemoclaw:recorded");

    expect(getBaseImageResolutionPatchOptions(context)).toEqual({
      resolutionHint: recordedMetadata,
      preResolvedBaseImageMetadata: null,
      forceBaseImageRefresh: false,
    });
  });

  it("lets either refresh control bypass warm metadata (#4680)", () => {
    const fresh = createBaseImageResolutionContext({ fresh: true, env: {} });
    const fromEnv = createBaseImageResolutionContext({
      fresh: false,
      env: { NEMOCLAW_SANDBOX_BASE_IMAGE_REFRESH: "true" },
    });

    captureBaseResolution(fresh, "nemoclaw:recorded");
    captureBaseResolution(fromEnv, "nemoclaw:recorded");

    expect(fresh).toMatchObject({ resolutionHint: null, forceRefresh: true });
    expect(fromEnv).toMatchObject({ resolutionHint: null, forceRefresh: true });
    expect(mocks.dockerImageInspectFormat).not.toHaveBeenCalled();
  });

  it("forwards resolution options to agent staging and captures its resolved metadata (#4680)", () => {
    const resolvedMetadata = {
      ...recordedMetadata,
      key: "resolved-key",
      ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:resolved",
      digest: "sha256:resolved",
      imageId: "sha256:resolved-image",
    };
    const context = createBaseImageResolutionContext({
      fresh: true,
      initialHint: recordedMetadata,
      env: {},
    });
    const agent = { name: "hermes" } as AgentDefinition;
    const staged = {
      buildCtx: "/tmp/hermes-build",
      stagedDockerfile: "/tmp/hermes-build/Dockerfile",
      baseImageResolutionMetadata: resolvedMetadata,
    };
    const createAgentSandbox = vi.fn(() => staged);

    expect(createAgentSandboxWithResolution(context, agent, createAgentSandbox)).toBe(staged);
    expect(createAgentSandbox).toHaveBeenCalledWith(agent, {
      resolutionHint: recordedMetadata,
      forceBaseImageRefresh: true,
    });
    expect(context.preResolvedMetadata).toBe(resolvedMetadata);
  });
});
