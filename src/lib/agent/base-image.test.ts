// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeAgent, withMockedDocker } from "../../../test/helpers/base-image-test-harness";
import {
  createSandboxBaseImageBuildProvenanceKey,
  type SandboxBaseImageResolutionMetadata,
} from "../sandbox-base-image";

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

function makeDifferingImageInspection(
  format: string,
  imageRef: string,
  localRef: string,
  pinnedRef: string,
): string {
  return format === "{{json .}}"
    ? JSON.stringify({
        Id: imageRef === localRef ? `sha256:${"a".repeat(64)}` : `sha256:${"b".repeat(64)}`,
        Os: "linux",
        Architecture: "amd64",
        RepoDigests: [pinnedRef],
      })
    : "";
}

describe("agent base image provisioning", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("binds an identical local Hermes alias to its tracked pinned provenance (#7144)", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    withMockedDocker(
      ({
        bindLocalAgentBaseImageToPinnedProvenance,
        dockerCaptureMock,
        dockerImageInspectFormatMock,
      }) => {
        const agent = makeAgent();
        const localRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";
        const dockerfile = fs.readFileSync(agent.dockerfilePath as string, "utf8");
        const pinnedRef = dockerfile.match(/^ARG BASE_IMAGE=(\S+)$/m)?.[1] as string;
        const imageId = `sha256:${"a".repeat(64)}`;
        dockerCaptureMock.mockImplementation((args: string[]) =>
          args.includes("/usr/bin/ldd")
            ? "ldd (Debian GLIBC 2.41-12) 2.41"
            : "nemoclaw-hermes-mcp-runtime-ok",
        );
        dockerImageInspectFormatMock.mockImplementation((format: string, imageRef: string) =>
          format === "{{json .}}"
            ? JSON.stringify({
                Id: imageId,
                Os: "linux",
                Architecture: "amd64",
                RepoDigests: [pinnedRef],
              })
            : imageId,
        );

        vi.stubEnv("NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF", "");
        const canonicalMetadata = bindLocalAgentBaseImageToPinnedProvenance(agent, localRef);
        vi.stubEnv("NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF", localRef);
        const reboundMetadata = bindLocalAgentBaseImageToPinnedProvenance(agent, localRef);

        expect(reboundMetadata).toMatchObject({
          ref: pinnedRef,
          digest: pinnedRef.slice(pinnedRef.indexOf("@") + 1),
          source: "pinned",
          pinnedRemoteRef: pinnedRef,
          imageId,
          os: "linux",
          architecture: "amd64",
          glibcVersion: "2.41",
        });
        expect(reboundMetadata?.key).toBe(canonicalMetadata?.key);
      },
    );
  });

  it("refuses provenance when a local Hermes alias differs from the tracked image (#7144)", () => {
    withMockedDocker(
      ({ bindLocalAgentBaseImageToPinnedProvenance, dockerImageInspectFormatMock }) => {
        const agent = makeAgent();
        const localRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";
        const dockerfile = fs.readFileSync(agent.dockerfilePath as string, "utf8");
        const pinnedRef = dockerfile.match(/^ARG BASE_IMAGE=(\S+)$/m)?.[1] as string;
        dockerImageInspectFormatMock.mockImplementation((format: string, imageRef: string) =>
          makeDifferingImageInspection(format, imageRef, localRef, pinnedRef),
        );

        expect(bindLocalAgentBaseImageToPinnedProvenance(agent, localRef)).toBeNull();
      },
    );
  });

  it("binds Docker's normalized Hermes platform digest to the tracked pin (#7144)", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    withMockedDocker(
      ({
        bindLocalAgentBaseImageToPinnedProvenance,
        dockerCaptureMock,
        dockerImageInspectFormatMock,
      }) => {
        const agent = makeAgent();
        const localRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";
        const dockerfile = fs.readFileSync(agent.dockerfilePath as string, "utf8");
        const pinnedRef = dockerfile.match(/^ARG BASE_IMAGE=(\S+)$/m)?.[1] as string;
        const imageName = pinnedRef.slice(0, pinnedRef.indexOf("@"));
        const platformDigest = `sha256:${"c".repeat(64)}`;
        const platformRef = `${imageName}@${platformDigest}`;
        const imageId = `sha256:${"a".repeat(64)}`;
        dockerCaptureMock.mockImplementation((args: string[]) =>
          args.includes("/usr/bin/ldd")
            ? "ldd (Debian GLIBC 2.41-12) 2.41"
            : "nemoclaw-hermes-mcp-runtime-ok",
        );
        dockerImageInspectFormatMock.mockImplementation((format: string) =>
          format === "{{json .}}"
            ? JSON.stringify({
                Id: imageId,
                Os: "linux",
                Architecture: "amd64",
                RepoDigests: [platformRef],
              })
            : imageId,
        );

        expect(bindLocalAgentBaseImageToPinnedProvenance(agent, localRef)).toMatchObject({
          ref: platformRef,
          digest: platformDigest,
          source: "pinned",
          pinnedRemoteRef: pinnedRef,
          imageId,
        });
      },
    );
  });

  it("refuses a local digest that differs from Docker's canonical pinned digest (#7144)", () => {
    withMockedDocker(
      ({ bindLocalAgentBaseImageToPinnedProvenance, dockerImageInspectFormatMock }) => {
        const agent = makeAgent();
        const localRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";
        const dockerfile = fs.readFileSync(agent.dockerfilePath as string, "utf8");
        const pinnedRef = dockerfile.match(/^ARG BASE_IMAGE=(\S+)$/m)?.[1] as string;
        const imageName = pinnedRef.slice(0, pinnedRef.indexOf("@"));
        const firstRef = `${imageName}@sha256:${"b".repeat(64)}`;
        const secondRef = `${imageName}@sha256:${"c".repeat(64)}`;
        const imageId = `sha256:${"a".repeat(64)}`;
        dockerImageInspectFormatMock.mockImplementation((format: string, imageRef: string) =>
          format === "{{json .}}"
            ? JSON.stringify({
                Id: imageId,
                Os: "linux",
                Architecture: "amd64",
                RepoDigests: imageRef === localRef ? [secondRef] : [firstRef, secondRef],
              })
            : imageId,
        );

        expect(bindLocalAgentBaseImageToPinnedProvenance(agent, localRef)).toBeNull();
      },
    );
  });

  it("refuses pinned provenance when the local Hermes runtime probe fails (#7144)", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    withMockedDocker(
      ({
        bindLocalAgentBaseImageToPinnedProvenance,
        dockerCaptureMock,
        dockerImageInspectFormatMock,
      }) => {
        const agent = makeAgent();
        const localRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";
        const dockerfile = fs.readFileSync(agent.dockerfilePath as string, "utf8");
        const pinnedRef = dockerfile.match(/^ARG BASE_IMAGE=(\S+)$/m)?.[1] as string;
        const imageId = `sha256:${"a".repeat(64)}`;
        dockerCaptureMock.mockImplementation((args: string[]) =>
          args.includes("/usr/bin/ldd") ? "ldd (Debian GLIBC 2.41-12) 2.41" : "",
        );
        dockerImageInspectFormatMock.mockImplementation((format: string) =>
          format === "{{json .}}"
            ? JSON.stringify({
                Id: imageId,
                Os: "linux",
                Architecture: "amd64",
                RepoDigests: [pinnedRef],
              })
            : imageId,
        );

        expect(bindLocalAgentBaseImageToPinnedProvenance(agent, localRef)).toBeNull();
      },
    );
  });

  it("refuses provenance when a local Hermes alias lacks the tracked repository digest (#7144)", () => {
    withMockedDocker(
      ({ bindLocalAgentBaseImageToPinnedProvenance, dockerImageInspectFormatMock }) => {
        const agent = makeAgent();
        const localRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";
        const imageId = `sha256:${"a".repeat(64)}`;
        dockerImageInspectFormatMock.mockImplementation((format: string) =>
          format === "{{json .}}"
            ? JSON.stringify({
                Id: imageId,
                Os: "linux",
                Architecture: "amd64",
                RepoDigests: [],
              })
            : imageId,
        );

        expect(bindLocalAgentBaseImageToPinnedProvenance(agent, localRef)).toBeNull();
      },
    );
  });

  it.each([
    ["operating system", "linux", "windows", "amd64", "amd64"],
    ["architecture", "linux", "linux", "amd64", "arm64"],
  ])("refuses provenance when a local Hermes alias has a different %s (#7144)", (_difference, localOs, pinnedOs, localArchitecture, pinnedArchitecture) => {
    withMockedDocker(
      ({ bindLocalAgentBaseImageToPinnedProvenance, dockerImageInspectFormatMock }) => {
        const agent = makeAgent();
        const localRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";
        const dockerfile = fs.readFileSync(agent.dockerfilePath as string, "utf8");
        const pinnedRef = dockerfile.match(/^ARG BASE_IMAGE=(\S+)$/m)?.[1] as string;
        const imageId = `sha256:${"a".repeat(64)}`;
        dockerImageInspectFormatMock.mockImplementation((format: string, imageRef: string) =>
          format === "{{json .}}"
            ? JSON.stringify({
                Id: imageId,
                Os: imageRef === localRef ? localOs : pinnedOs,
                Architecture: imageRef === localRef ? localArchitecture : pinnedArchitecture,
                RepoDigests: [pinnedRef],
              })
            : imageId,
        );

        expect(bindLocalAgentBaseImageToPinnedProvenance(agent, localRef)).toBeNull();
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
        const buildOptions = dockerBuildMock.mock.calls[0]?.[3] as {
          labels?: Record<string, string>;
        };
        const provenance = buildOptions.labels?.["com.nvidia.nemoclaw.base-build-provenance"];
        const expectedProvenanceKey = createSandboxBaseImageBuildProvenanceKey({
          imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
          dockerfilePath: "/test/root/agents/hermes/Dockerfile.base",
          localTag: "unused-by-build-provenance",
          rootDir: root,
        });

        expect(result.imageTag).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`);
        expect(result.built).toBe(true);
        expect(result.trustedLocalOverride).toEqual({
          ref: result.imageTag,
          provenance,
        });
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
            trustedLocalOverride: { ref: result.imageTag, provenance },
          }),
        );
        expect(dockerImageInspectMock).not.toHaveBeenCalled();
        expect(dockerBuildMock).toHaveBeenCalledWith(
          "/test/root/agents/hermes/Dockerfile.base",
          expect.stringMatching(/^nemoclaw-hermes-sandbox-base-local:build-\d+-[0-9a-f]{16}$/),
          root,
          {
            ignoreError: true,
            labels: {
              "com.nvidia.nemoclaw.base-build-provenance": expect.stringMatching(
                new RegExp(`^${expectedProvenanceKey}\\.[0-9a-f]{64}$`),
              ),
            },
            stdio: ["ignore", "inherit", "inherit"],
          },
        );
        expect(dockerImageInspectFormatMock).toHaveBeenCalledWith(
          "{{.Id}}",
          expect.stringMatching(/^nemoclaw-hermes-sandbox-base-local:build-\d+-[0-9a-f]{16}$/),
          { ignoreError: true },
        );
        expect(dockerTagMock).toHaveBeenCalledWith(`sha256:${"a".repeat(64)}`, result.imageTag, {
          ignoreError: true,
        });
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
        const inspectedIds = [
          `sha256:${"a".repeat(64)}`,
          `sha256:${"a".repeat(64)}`,
          `sha256:${"b".repeat(64)}`,
          `sha256:${"b".repeat(64)}`,
        ];
        dockerImageInspectFormatMock.mockImplementation((format: string) =>
          format === "{{.Id}}" ? (inspectedIds.shift() ?? "") : "",
        );
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
        expect(dockerTagMock).toHaveBeenCalledWith(`sha256:${"c".repeat(64)}`, pinned, {
          ignoreError: true,
        });
      },
    );
  });

  it("creates a local immutable handoff for a resolved remote digest (#7144)", () => {
    withMockedDocker(
      ({ pinAgentSandboxBaseImageRef, dockerImageInspectFormatMock, dockerTagMock }) => {
        const remoteRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`;
        dockerImageInspectFormatMock.mockReturnValue(`sha256:${"c".repeat(64)}`);

        const pinned = pinAgentSandboxBaseImageRef("hermes", remoteRef, { forceLocal: true });

        expect(pinned).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"c".repeat(64)}`);
        expect(dockerTagMock).toHaveBeenCalledWith(`sha256:${"c".repeat(64)}`, pinned, {
          ignoreError: true,
        });
      },
    );
  });

  it("creates a unique temporary handoff for a disposable rebuild pin (#7144)", () => {
    withMockedDocker(
      ({ pinAgentSandboxBaseImageRef, dockerImageInspectFormatMock, dockerTagMock }) => {
        const remoteRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`;
        const imageId = `sha256:${"c".repeat(64)}`;
        dockerImageInspectFormatMock.mockReturnValue(imageId);

        const firstPinned = pinAgentSandboxBaseImageRef("hermes", remoteRef, {
          forceLocal: true,
          temporary: true,
        });
        const secondPinned = pinAgentSandboxBaseImageRef("hermes", remoteRef, {
          forceLocal: true,
          temporary: true,
        });

        const temporaryRefPattern = new RegExp(
          `^nemoclaw-hermes-sandbox-base-local:rebuild-[1-9][0-9]*-[0-9a-f]{16}-image-${"c".repeat(64)}$`,
        );
        expect(firstPinned).toMatch(temporaryRefPattern);
        expect(secondPinned).toMatch(temporaryRefPattern);
        expect(secondPinned).not.toBe(firstPinned);
        expect(dockerTagMock).toHaveBeenCalledWith(imageId, firstPinned, { ignoreError: true });
        expect(dockerTagMock).toHaveBeenCalledWith(imageId, secondPinned, { ignoreError: true });
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
        expect(dockerTagMock).toHaveBeenCalledWith(`sha256:${"d".repeat(64)}`, pinned, {
          ignoreError: true,
        });
      },
    );
  });

  it("fails closed when the immutable handoff does not retain the inspected image ID", () => {
    withMockedDocker(({ pinAgentSandboxBaseImageRef, dockerImageInspectFormatMock }) => {
      dockerImageInspectFormatMock
        .mockReturnValueOnce(`sha256:${"a".repeat(64)}`)
        .mockReturnValueOnce(`sha256:${"b".repeat(64)}`);

      expect(() =>
        pinAgentSandboxBaseImageRef("hermes", "nemoclaw-hermes-sandbox-base-local:caller"),
      ).toThrow("Pinned hermes base image did not retain its inspected image ID");
    });
  });

  it("removes a temporary handoff that fails image-ID verification (#7144)", () => {
    withMockedDocker(
      ({ pinAgentSandboxBaseImageRef, dockerImageInspectFormatMock, dockerRmiMock }) => {
        dockerImageInspectFormatMock
          .mockReturnValueOnce(`sha256:${"a".repeat(64)}`)
          .mockReturnValueOnce(`sha256:${"b".repeat(64)}`);

        expect(() =>
          pinAgentSandboxBaseImageRef("hermes", "nemoclaw-hermes-sandbox-base-local:caller", {
            temporary: true,
          }),
        ).toThrow("Pinned hermes base image did not retain its inspected image ID");
        expect(dockerRmiMock).toHaveBeenCalledWith(
          expect.stringMatching(
            new RegExp(
              `^nemoclaw-hermes-sandbox-base-local:rebuild-[1-9][0-9]*-[0-9a-f]{16}-image-${"a".repeat(64)}$`,
            ),
          ),
          { ignoreError: true, suppressOutput: true },
        );
      },
    );
  });
});
