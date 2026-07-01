// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
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
    const trackedDigest = `sha256:${"1".repeat(64)}`;
    const trackedRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${trackedDigest}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-final-dockerfile-"));
    const dockerfilePath = path.join(tmp, "Dockerfile");
    fs.writeFileSync(dockerfilePath, `ARG NEMOCLAW_STALE_OPENCLAW_BASE_DIGEST=${trackedDigest}\n`);

    try {
      withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
        resolveSandboxBaseImageMock.mockReturnValue({
          ref: trackedRef,
          digest: trackedDigest,
          source: "source-sha",
          glibcVersion: "2.41",
        });

        expect(ensureAgentBaseImage(makeAgent({ dockerfilePath }))).toEqual({
          imageTag: trackedRef,
          built: false,
        });

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
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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
