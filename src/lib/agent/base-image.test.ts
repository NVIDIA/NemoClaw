// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeAgent, withMockedDocker } from "../../../test/helpers/base-image-test-harness";
import type { SandboxBaseImageResolutionMetadata } from "../sandbox-base-image";

function makeResolutionMetadata(
  overrides: Partial<SandboxBaseImageResolutionMetadata> = {},
): SandboxBaseImageResolutionMetadata {
  return {
    schema: 1,
    key: "resolution-key",
    imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
    ref: "nemoclaw-hermes-sandbox-base-local:compatible",
    digest: null,
    source: "local",
    imageId: `sha256:${"a".repeat(64)}`,
    os: "linux",
    architecture: "amd64",
    glibcVersion: process.platform === "linux" ? "2.41" : null,
    requireOpenshellSandboxAbi: process.platform === "linux",
    minGlibcVersion: "2.39",
    ...overrides,
  };
}

describe("agent base image provisioning", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses a compatible resolved agent base image during normal onboarding", () => {
    withMockedDocker(
      ({
        ensureAgentBaseImage,
        dockerBuildMock,
        dockerImageInspectMock,
        resolveSandboxBaseImageMock,
        root,
      }) => {
        const resolutionHint = makeResolutionMetadata({ key: "cached-resolution-key" });
        const resolvedMetadata = makeResolutionMetadata({ key: "fresh-resolution-key" });
        resolveSandboxBaseImageMock.mockReturnValue({
          ref: resolvedMetadata.ref,
          digest: resolvedMetadata.digest,
          source: resolvedMetadata.source,
          glibcVersion: resolvedMetadata.glibcVersion,
          metadata: resolvedMetadata,
        });

        const result = ensureAgentBaseImage(makeAgent(), {
          resolutionHint,
          forceBaseImageRefresh: true,
        });

        expect(result).toEqual({
          imageTag: "nemoclaw-hermes-sandbox-base-local:compatible",
          built: false,
          resolutionMetadata: resolvedMetadata,
        });
        expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
            dockerfilePath: "/test/root/agents/hermes/Dockerfile.base",
            envVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
            label: "Hermes Agent sandbox base image",
            requireOpenshellSandboxAbi: process.platform === "linux",
            resolutionHint,
            forceRefresh: true,
            rootDir: root,
            validateImage: expect.any(Function),
            validationDescription: "the required MCP Streamable HTTP runtime",
          }),
        );
        expect(dockerImageInspectMock).not.toHaveBeenCalled();
        expect(dockerBuildMock).not.toHaveBeenCalled();
      },
    );
  });

  it("configures Deep Agents Code base-image validation from the manifest (#6456)", () => {
    withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
      ensureAgentBaseImage(
        makeAgent({
          name: "langchain-deepagents-code",
          displayName: "LangChain Deep Agents Code",
          expectedVersion: "0.1.34",
          dockerfileBasePath: "/test/root/agents/langchain-deepagents-code/Dockerfile.base",
          dockerfilePath: "/test/root/agents/langchain-deepagents-code/Dockerfile",
        }),
      );
      expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          inputPaths: [
            "/test/root/agents/langchain-deepagents-code/manifest.yaml",
            "/test/root/agents/langchain-deepagents-code/requirements.lock",
          ],
          validateImage: expect.any(Function),
          validationDescription: "deepagents-code==0.1.34",
        }),
      );
    });
  });

  it("fails closed when the Deep Agents Code manifest omits its base-image version", () => {
    withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
      expect(() =>
        ensureAgentBaseImage(
          makeAgent({
            name: "langchain-deepagents-code",
            displayName: "LangChain Deep Agents Code",
            expectedVersion: null,
            dockerfileBasePath: "/test/root/agents/langchain-deepagents-code/Dockerfile.base",
          }),
        ),
      ).toThrow(
        "Agent 'langchain-deepagents-code' (LangChain Deep Agents Code) manifest is missing expected_version required for base-image validation",
      );
      expect(resolveSandboxBaseImageMock).not.toHaveBeenCalled();
    });
  });

  it("rebuilds an agent base image when rebuild flow forces local Dockerfile.base refresh", () => {
    withMockedDocker(
      ({
        ensureAgentBaseImage,
        dockerBuildMock,
        dockerImageInspectFormatMock,
        dockerImageInspectMock,
        dockerRmiMock,
        dockerTagMock,
        resolveSandboxBaseImageMock,
        root,
      }) => {
        dockerImageInspectMock.mockReturnValue({ status: 0 });
        dockerImageInspectFormatMock.mockImplementation((format: string) =>
          format === "{{json .}}"
            ? JSON.stringify({
                Id: `sha256:${"a".repeat(64)}`,
                Os: "linux",
                Architecture: "amd64",
                RepoDigests: [],
              })
            : `sha256:${"a".repeat(64)}`,
        );

        const result = ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true });

        expect(result.imageTag).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`);
        expect(result.built).toBe(true);
        expect(result.resolutionMetadata).toEqual(
          expect.objectContaining({
            ref: result.imageTag,
            source: "local",
            imageId: `sha256:${"a".repeat(64)}`,
          }),
        );
        expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            localTag: result.imageTag,
            env: expect.objectContaining({
              NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF: result.imageTag,
              NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
            }),
            validateImage: expect.any(Function),
            validationDescription: "the required MCP Streamable HTTP runtime",
          }),
        );
        expect(dockerImageInspectMock).not.toHaveBeenCalled();
        expect(dockerBuildMock).toHaveBeenCalledWith(
          "/test/root/agents/hermes/Dockerfile.base",
          expect.stringMatching(/^nemoclaw-hermes-sandbox-base-local:build-\d+-[0-9a-f]{16}$/),
          root,
          { ignoreError: true, stdio: ["ignore", "inherit", "inherit"] },
        );
        expect(dockerImageInspectFormatMock).toHaveBeenCalledWith(
          "{{.Id}}",
          expect.stringMatching(/^nemoclaw-hermes-sandbox-base-local:build-\d+-[0-9a-f]{16}$/),
          { ignoreError: true },
        );
        expect(dockerTagMock).toHaveBeenCalledWith(
          expect.stringMatching(/^nemoclaw-hermes-sandbox-base-local:build-\d+-[0-9a-f]{16}$/),
          result.imageTag,
          { ignoreError: true },
        );
        expect(dockerRmiMock).toHaveBeenCalledWith(
          expect.stringMatching(/^nemoclaw-hermes-sandbox-base-local:build-\d+-[0-9a-f]{16}$/),
          { ignoreError: true, suppressOutput: true },
        );
      },
    );
  });

  it("throws when a forced agent base image rebuild fails", () => {
    withMockedDocker(({ ensureAgentBaseImage, dockerBuildMock, resolveSandboxBaseImageMock }) => {
      dockerBuildMock.mockReturnValue({ status: 23 });

      expect(() => ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true })).toThrow(
        "Failed to build Hermes Agent base image (exit 23)",
      );
      expect(resolveSandboxBaseImageMock).not.toHaveBeenCalled();
    });
  });

  it("attaches resolution metadata to non-Linux local build and cache fallbacks", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      withMockedDocker(
        ({
          ensureAgentBaseImage,
          dockerBuildMock,
          dockerImageInspectFormatMock,
          dockerImageInspectMock,
          resolveSandboxBaseImageMock,
        }) => {
          resolveSandboxBaseImageMock.mockReturnValue(null);
          dockerImageInspectMock.mockReturnValueOnce({ status: 1 }).mockReturnValue({ status: 0 });
          dockerImageInspectFormatMock.mockImplementation((format: string) =>
            format === "{{json .}}"
              ? JSON.stringify({
                  Id: `sha256:${"b".repeat(64)}`,
                  Os: "linux",
                  Architecture: "amd64",
                  RepoDigests: [],
                })
              : "",
          );
          const agent = makeAgent({ name: "custom", displayName: "Custom Agent" });

          expect(ensureAgentBaseImage(agent)).toEqual({
            imageTag: "ghcr.io/nvidia/nemoclaw/custom-sandbox-base:latest",
            built: true,
            resolutionMetadata: expect.objectContaining({ source: "local" }),
          });
          expect(ensureAgentBaseImage(agent)).toEqual({
            imageTag: "ghcr.io/nvidia/nemoclaw/custom-sandbox-base:latest",
            built: false,
            resolutionMetadata: expect.objectContaining({ source: "local" }),
          });
          expect(dockerBuildMock).toHaveBeenCalledOnce();
        },
      );
    } finally {
      platform.mockRestore();
    }
  });

  it("pins different image IDs to different recreate refs at the same source revision", () => {
    withMockedDocker(
      ({ ensureAgentBaseImage, dockerImageInspectFormatMock, resolveSandboxBaseImageMock }) => {
        dockerImageInspectFormatMock
          .mockReturnValueOnce(`sha256:${"a".repeat(64)}`)
          .mockReturnValueOnce("")
          .mockReturnValueOnce(`sha256:${"b".repeat(64)}`);
        resolveSandboxBaseImageMock.mockImplementation((options) => ({
          ref: options.env?.[options.envVar],
          digest: null,
          source: "override",
          glibcVersion: "2.41",
        }));

        const first = ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true });
        const second = ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true });

        expect(first.imageTag).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`);
        expect(second.imageTag).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"b".repeat(64)}`);
      },
    );
  });

  it("canonicalizes a mutable local override to its full image-ID ref", () => {
    withMockedDocker(
      ({ pinAgentSandboxBaseImageRef, dockerImageInspectFormatMock, dockerTagMock }) => {
        dockerImageInspectFormatMock.mockReturnValue(`sha256:${"c".repeat(64)}`);

        const pinned = pinAgentSandboxBaseImageRef(
          "hermes",
          "nemoclaw-hermes-sandbox-base-local:caller",
        );

        expect(pinned).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"c".repeat(64)}`);
        expect(dockerTagMock).toHaveBeenCalledWith(
          "nemoclaw-hermes-sandbox-base-local:caller",
          pinned,
          { ignoreError: true },
        );
      },
    );
  });

  it("does not trust a moved image-ID-shaped tag without inspecting it", () => {
    withMockedDocker(
      ({ pinAgentSandboxBaseImageRef, dockerImageInspectFormatMock, dockerTagMock }) => {
        const claimed = `nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`;
        dockerImageInspectFormatMock.mockReturnValue(`sha256:${"d".repeat(64)}`);

        const pinned = pinAgentSandboxBaseImageRef("hermes", claimed);

        expect(pinned).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"d".repeat(64)}`);
        expect(dockerTagMock).toHaveBeenCalledWith(claimed, pinned, { ignoreError: true });
      },
    );
  });
});
