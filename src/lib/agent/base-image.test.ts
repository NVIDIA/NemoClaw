// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeAgent, withMockedDocker } from "../../../test/helpers/base-image-test-harness";

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
        const result = ensureAgentBaseImage(makeAgent());

        expect(result).toEqual({
          imageTag: "nemoclaw-hermes-sandbox-base-local:compatible",
          built: false,
        });
        expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
            dockerfilePath: "/test/root/agents/hermes/Dockerfile.base",
            envVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
            label: "Hermes Agent sandbox base image",
            requireOpenshellSandboxAbi: process.platform === "linux",
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

        const result = ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true });

        expect(result.imageTag).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`);
        expect(result.built).toBe(true);
        expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            localTag: result.imageTag,
            env: expect.objectContaining({
              NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF: result.imageTag,
              NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
            }),
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

  it("pins different image IDs to different recreate refs at the same source revision", () => {
    withMockedDocker(
      ({ ensureAgentBaseImage, dockerImageInspectFormatMock, resolveSandboxBaseImageMock }) => {
        dockerImageInspectFormatMock
          .mockReturnValueOnce(`sha256:${"a".repeat(64)}`)
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
