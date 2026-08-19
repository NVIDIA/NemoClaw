// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../agent/defs";
import {
  SANDBOX_BASE_RESOLUTION_LABEL,
  type DcodeSandboxBaseImageResolutionMetadata,
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

const LOCAL_IMAGE_ID = `sha256:${"a".repeat(64)}`;

function dcodeLocalMetadata(
  ref: string,
  sourceRevision: string,
): DcodeSandboxBaseImageResolutionMetadata {
  return {
    ...recordedMetadata,
    ref,
    digest: null,
    source: "local",
    imageId: LOCAL_IMAGE_ID,
    sourceRevision,
  };
}

type DcodeMetadataMutator = (
  stable: DcodeSandboxBaseImageResolutionMetadata,
  staged: DcodeSandboxBaseImageResolutionMetadata,
) => void;

const INVALID_DCODE_SOURCE_REVISION_CASES: ReadonlyArray<readonly [string, DcodeMetadataMutator]> =
  [
    ["missing stable", (stable) => Reflect.deleteProperty(stable, "sourceRevision")],
    ["malformed stable", (stable) => Object.assign(stable, { sourceRevision: "not-a-revision" })],
    ["missing staged", (_stable, staged) => Reflect.deleteProperty(staged, "sourceRevision")],
    [
      "malformed staged",
      (_stable, staged) => Object.assign(staged, { sourceRevision: "not-a-revision" }),
    ],
  ];

describe("base image resolution flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["1", "true", "YES", "on"])(
    "recognizes the %s refresh environment value (#4680)",
    (value) => {
      expect(
        isSandboxBaseImageRefreshRequested({ NEMOCLAW_SANDBOX_BASE_IMAGE_REFRESH: value }),
      ).toBe(true);
    },
  );

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

  it("retains canonical outer metadata when a bound local lease emits no metadata", () => {
    const imageId = `sha256:${"a".repeat(64)}`;
    const stableMetadata: SandboxBaseImageResolutionMetadata = {
      ...recordedMetadata,
      key: "stable-outer-key",
      ref: `nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`,
      digest: null,
      source: "local",
      imageId,
    };
    const context = createBaseImageResolutionContext({
      fresh: false,
      initialHint: stableMetadata,
      initialPreResolvedMetadata: stableMetadata,
      env: {},
    });
    const agent = { name: "hermes" } as AgentDefinition;
    const staged = {
      buildCtx: "/tmp/hermes-build",
      stagedDockerfile: "/tmp/hermes-build/Dockerfile",
      baseImageResolutionMetadata: null,
    };

    createAgentSandboxWithResolution(
      context,
      agent,
      vi.fn(() => staged),
    );

    expect(context.preResolvedMetadata).toBe(stableMetadata);
    expect(getBaseImageResolutionPatchOptions(context).preResolvedBaseImageMetadata).toBe(
      stableMetadata,
    );
    expect(context.preResolvedMetadata?.key).toBe("stable-outer-key");
  });

  it("retains stable outer metadata when inner staging uses a disposable local handoff", () => {
    const imageId = `sha256:${"a".repeat(64)}`;
    const stableMetadata: SandboxBaseImageResolutionMetadata = {
      ...recordedMetadata,
      ref: "nemoclaw-hermes-sandbox-base-local:3ef2ca87",
      digest: null,
      source: "local",
      imageId,
    };
    const disposableMetadata: SandboxBaseImageResolutionMetadata = {
      ...stableMetadata,
      ref: `nemoclaw-hermes-sandbox-base-local:rebuild-123-${"b".repeat(16)}-image-${"a".repeat(64)}`,
    };
    const context = createBaseImageResolutionContext({
      fresh: false,
      initialPreResolvedMetadata: stableMetadata,
      env: {},
    });

    createAgentSandboxWithResolution(
      context,
      { name: "hermes" } as AgentDefinition,
      vi.fn(() => ({
        buildCtx: "/tmp/hermes-build",
        stagedDockerfile: "/tmp/hermes-build/Dockerfile",
        baseImageResolutionMetadata: disposableMetadata,
      })),
    );

    expect(context.preResolvedMetadata).toBe(stableMetadata);
    expect(context.preResolvedMetadata?.ref).toBe(stableMetadata.ref);
  });

  it("rejects disposable metadata from a different outer resolution contract", () => {
    const stableMetadata: SandboxBaseImageResolutionMetadata = {
      ...recordedMetadata,
      ref: "nemoclaw-hermes-sandbox-base-local:3ef2ca87",
      digest: null,
      source: "local",
      imageId: `sha256:${"a".repeat(64)}`,
    };
    const context = createBaseImageResolutionContext({
      fresh: false,
      initialPreResolvedMetadata: stableMetadata,
      env: {},
    });

    expect(() =>
      createAgentSandboxWithResolution(
        context,
        { name: "hermes" } as AgentDefinition,
        vi.fn(() => ({
          buildCtx: "/tmp/hermes-build",
          stagedDockerfile: "/tmp/hermes-build/Dockerfile",
          baseImageResolutionMetadata: {
            ...stableMetadata,
            key: "different-resolution-key",
            ref: `nemoclaw-hermes-sandbox-base-local:rebuild-123-${"b".repeat(16)}-image-${"a".repeat(64)}`,
          },
        })),
      ),
    ).toThrow("did not match the stable outer resolution");
    expect(context.preResolvedMetadata).toBe(stableMetadata);
  });

  it("retains DCode metadata when disposable handoff source revisions match (#9386)", () => {
    const sourceRevision = "c".repeat(40);
    const stableMetadata = dcodeLocalMetadata(
      "nemoclaw-langchain-deepagents-code-sandbox-base-local:3ef2ca87",
      sourceRevision,
    );
    const context = createBaseImageResolutionContext({
      fresh: false,
      initialPreResolvedMetadata: stableMetadata,
      env: {},
    });

    createAgentSandboxWithResolution(
      context,
      { name: "langchain-deepagents-code" } as AgentDefinition,
      vi.fn(() => ({
        buildCtx: "/tmp/dcode-build",
        stagedDockerfile: "/tmp/dcode-build/Dockerfile",
        baseImageResolutionMetadata: dcodeLocalMetadata(
          `nemoclaw-langchain-deepagents-code-sandbox-base-local:rebuild-123-${"b".repeat(16)}-image-${"a".repeat(64)}`,
          sourceRevision,
        ),
      })),
    );

    expect(context.preResolvedMetadata).toBe(stableMetadata);
    expect(context.preResolvedMetadata).toMatchObject({ sourceRevision });
  });

  it("rejects a DCode disposable handoff with a different source revision (#9386)", () => {
    const stableMetadata = dcodeLocalMetadata(
      "nemoclaw-langchain-deepagents-code-sandbox-base-local:3ef2ca87",
      "c".repeat(40),
    );
    const context = createBaseImageResolutionContext({
      fresh: false,
      initialPreResolvedMetadata: stableMetadata,
      env: {},
    });

    expect(() =>
      createAgentSandboxWithResolution(
        context,
        { name: "langchain-deepagents-code" } as AgentDefinition,
        vi.fn(() => ({
          buildCtx: "/tmp/dcode-build",
          stagedDockerfile: "/tmp/dcode-build/Dockerfile",
          baseImageResolutionMetadata: dcodeLocalMetadata(
            `nemoclaw-langchain-deepagents-code-sandbox-base-local:rebuild-123-${"b".repeat(16)}-image-${"a".repeat(64)}`,
            "d".repeat(40),
          ),
        })),
      ),
    ).toThrow("did not match the stable outer resolution");
    expect(context.preResolvedMetadata).toBe(stableMetadata);
  });

  it.each(INVALID_DCODE_SOURCE_REVISION_CASES)(
    "rejects a DCode disposable handoff with a %s source revision (#9386)",
    (_scenario, mutateMetadata) => {
      const sourceRevision = "c".repeat(40);
      const stableMetadata = dcodeLocalMetadata(
        "nemoclaw-langchain-deepagents-code-sandbox-base-local:3ef2ca87",
        sourceRevision,
      );
      const stagedMetadata = dcodeLocalMetadata(
        `nemoclaw-langchain-deepagents-code-sandbox-base-local:rebuild-123-${"b".repeat(16)}-image-${"a".repeat(64)}`,
        sourceRevision,
      );
      const context = createBaseImageResolutionContext({
        fresh: false,
        initialPreResolvedMetadata: stableMetadata,
        env: {},
      });
      mutateMetadata(stableMetadata, stagedMetadata);

      expect(() =>
        createAgentSandboxWithResolution(
          context,
          { name: "langchain-deepagents-code" } as AgentDefinition,
          vi.fn(() => ({
            buildCtx: "/tmp/dcode-build",
            stagedDockerfile: "/tmp/dcode-build/Dockerfile",
            baseImageResolutionMetadata: stagedMetadata,
          })),
        ),
      ).toThrow("did not match the stable outer resolution");
      expect(context.preResolvedMetadata).toBe(stableMetadata);
    },
  );
});
