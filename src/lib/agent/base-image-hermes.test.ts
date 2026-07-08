// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeAgent, withMockedDocker } from "../../../test/helpers/base-image-test-harness";

describe("agent base image provisioning", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("probes resolved Hermes bases for the native MCP Streamable HTTP runtime", () => {
    withMockedDocker(({ ensureAgentBaseImage, dockerCaptureMock, resolveSandboxBaseImageMock }) => {
      ensureAgentBaseImage(makeAgent());
      const options = resolveSandboxBaseImageMock.mock.calls[0]?.[0] as {
        validateImage?: (imageRef: string) => boolean;
      };

      expect(options.validateImage?.("hermes-base:test")).toBe(true);
      expect(dockerCaptureMock).toHaveBeenCalledWith(
        [
          "run",
          "--rm",
          "--entrypoint",
          "/opt/hermes/.venv/bin/python",
          "hermes-base:test",
          "-c",
          expect.stringContaining("_MCP_HTTP_AVAILABLE"),
        ],
        { ignoreError: true, timeout: 20_000 },
      );

      dockerCaptureMock.mockReturnValue("");
      expect(options.validateImage?.("hermes-base:stale")).toBe(false);
    });
  });

  it("accepts only the tracked published Hermes base digest", () => {
    const dockerfilePath = path.resolve(import.meta.dirname, "../../../agents/hermes/Dockerfile");
    const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
    const trackedRef = dockerfile.match(
      /^ARG BASE_IMAGE=(ghcr\.io\/nvidia\/nemoclaw\/hermes-sandbox-base@(sha256:[0-9a-f]{64}))$/m,
    );
    expect(trackedRef).not.toBeNull();

    withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
      resolveSandboxBaseImageMock.mockReturnValue({
        ref: trackedRef?.[1],
        digest: trackedRef?.[2],
        source: "source-sha",
        glibcVersion: "2.41",
      });

      expect(ensureAgentBaseImage(makeAgent({ dockerfilePath }))).toEqual({
        imageTag: trackedRef?.[1],
        built: false,
      });
      expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          pinnedRemoteRef: trackedRef?.[1],
          preferPinnedRemoteRef: true,
        }),
      );

      const platformDigest =
        "sha256:c0c149ed03b3e8fcd3e395558b22e871cd27c9966ea6faf04c0d2b94d0a821b9";
      const platformDigestRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${platformDigest}`;
      resolveSandboxBaseImageMock.mockReturnValue({
        ref: platformDigestRef,
        digest: platformDigest,
        source: "pinned",
        pinnedRemoteRef: trackedRef?.[1],
        glibcVersion: "2.41",
      });
      expect(ensureAgentBaseImage(makeAgent({ dockerfilePath }))).toEqual({
        imageTag: platformDigestRef,
        built: false,
      });

      const wrongNamespaceRef = `ghcr.io/nvidia/nemoclaw/other-hermes-base@${platformDigest}`;
      resolveSandboxBaseImageMock.mockReturnValue({
        ref: wrongNamespaceRef,
        digest: platformDigest,
        source: "pinned",
        pinnedRemoteRef: trackedRef?.[1],
        glibcVersion: "2.41",
      });
      expect(() => ensureAgentBaseImage(makeAgent({ dockerfilePath }))).toThrow(
        "Hermes final image does not accept base image ref",
      );

      resolveSandboxBaseImageMock.mockReturnValue({
        ref: platformDigestRef,
        digest: platformDigest,
        source: "latest",
        glibcVersion: "2.41",
      });
      expect(() => ensureAgentBaseImage(makeAgent({ dockerfilePath }))).toThrow(
        "Hermes final image does not accept base image ref",
      );

      resolveSandboxBaseImageMock.mockReturnValue({
        ref: platformDigestRef,
        digest: platformDigest,
        source: "pinned",
        pinnedRemoteRef: `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"2".repeat(64)}`,
        glibcVersion: "2.41",
      });
      expect(() => ensureAgentBaseImage(makeAgent({ dockerfilePath }))).toThrow(
        "Hermes final image does not accept base image ref",
      );

      const differentRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"0".repeat(64)}`;
      resolveSandboxBaseImageMock.mockReturnValue({
        ref: differentRef,
        digest: `sha256:${"0".repeat(64)}`,
        source: "source-sha",
        glibcVersion: "2.41",
      });
      expect(() => ensureAgentBaseImage(makeAgent({ dockerfilePath }))).toThrow(
        "Hermes final image does not accept base image ref",
      );
    });
  });

  it("fails before candidate resolution when the Hermes final Dockerfile is unreadable", () => {
    withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
      expect(() =>
        ensureAgentBaseImage(makeAgent({ dockerfilePath: "/missing/hermes/Dockerfile" })),
      ).toThrow("Failed to read Hermes final Dockerfile");
      expect(resolveSandboxBaseImageMock).not.toHaveBeenCalled();
    });
  });

  it("fails a forced rebuild before deletion when the built base fails validation", () => {
    withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
      resolveSandboxBaseImageMock.mockReturnValue(null);

      expect(() => ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true })).toThrow(
        "failed the required runtime compatibility checks",
      );
    });
  });

  it("validates an explicit override strictly instead of falling back", () => {
    const envVar = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";
    const prior = process.env[envVar];
    process.env[envVar] = "localhost:5000/custom/hermes:latest";
    try {
      withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
        resolveSandboxBaseImageMock.mockReturnValue({
          ref: process.env[envVar],
          digest: null,
          source: "override",
          glibcVersion: "2.41",
        });

        expect(() => ensureAgentBaseImage(makeAgent())).toThrow(
          "Hermes final image does not accept base image ref",
        );
        expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            localTag: "localhost:5000/custom/hermes:latest",
            env: expect.objectContaining({
              [envVar]: "localhost:5000/custom/hermes:latest",
              NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
            }),
          }),
        );
      });
    } finally {
      prior === undefined ? delete process.env[envVar] : (process.env[envVar] = prior);
    }
  });

  it("fails closed when no MCP-capable Hermes base image can be resolved", () => {
    withMockedDocker(
      ({
        ensureAgentBaseImage,
        dockerBuildMock,
        dockerImageInspectMock,
        resolveSandboxBaseImageMock,
      }) => {
        resolveSandboxBaseImageMock.mockReturnValue(null);
        dockerImageInspectMock.mockReturnValue({ status: 1 });

        expect(() => ensureAgentBaseImage(makeAgent())).toThrow(
          "No compatible Hermes Agent sandbox base image found",
        );
        expect(dockerBuildMock).not.toHaveBeenCalled();
        expect(dockerImageInspectMock).not.toHaveBeenCalled();
      },
    );
  });
});
