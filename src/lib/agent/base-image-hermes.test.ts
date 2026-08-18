// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeAgent, withMockedDocker } from "../../../test/helpers/base-image-test-harness";
import { dockerRunCommandBetween } from "../../../test/helpers/dockerfile-run-shell";

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

  it("reports forced-rebuild typed validation failures as compatibility diagnostics and cleans up (#6624)", () => {
    withMockedDocker(
      ({
        ensureAgentBaseImage,
        dockerBuildMock,
        resolveSandboxBaseImageMock,
        dockerRmiMock,
        SandboxBaseImageResolutionError,
      }) => {
        resolveSandboxBaseImageMock.mockImplementation(() => {
          throw new SandboxBaseImageResolutionError("exact validation failed");
        });

        let error: Error | null = null;
        try {
          ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true });
        } catch (caught) {
          error = caught as Error;
        }

        expect(error?.message).toBe(
          "Built Hermes Agent base image failed the required runtime compatibility checks",
        );
        expect(error?.message).not.toContain("exact validation failed");
        const temporaryTag = dockerBuildMock.mock.calls[0]?.[1];
        expect(temporaryTag).toEqual(
          expect.stringMatching(/^nemoclaw-hermes-sandbox-base-local:build-\d+-[0-9a-f]{16}$/),
        );
        expect(dockerRmiMock).toHaveBeenCalledWith(temporaryTag, {
          ignoreError: true,
          suppressOutput: true,
        });
      },
    );
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
