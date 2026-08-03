// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { fingerprintBuildContext } from "../../adapters/fs/build-context-fingerprint";
import type { PreparedOpenClawLegacyImage } from "../../onboard/build-context-stage";
import { ROOT } from "../../runner";
import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";
import type { OpenClawLegacyDockerBinding } from "./rebuild/openclaw-legacy-image";
import {
  finalizePreparedRebuildImageMessagingPlan,
  type PreparedRebuildImage,
  preflightRebuildImage,
  type RebuildImagePreflightResult,
} from "./rebuild-custom-image-preflight";
import {
  createBuildContextVerifier,
  disposePreparedBuildContext,
  verifyPreparedBuildContext,
} from "./rebuild-prepared-image-context";

type SuccessfulPreflight = Extract<RebuildImagePreflightResult, { ok: true }>;
const LEGACY_IMAGE_ID = `sha256:${"d".repeat(64)}`;

function successful(result: RebuildImagePreflightResult): SuccessfulPreflight {
  expect(result.ok).toBe(true);
  return result as SuccessfulPreflight;
}

function input(fromDockerfile: string | null) {
  return {
    agent: null,
    fromDockerfile,
    model: "model",
    provider: "ollama-local",
    preferredInferenceApi: null,
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    webSearchConfig: null,
    toolDisclosure: "progressive" as const,
    hermesToolGateways: [],
    sandboxGpuConfig: {
      mode: "0" as const,
      hostGpuDetected: false,
      hostGpuPlatform: null,
      sandboxGpuEnabled: false,
      sandboxGpuDevice: null,
      errors: [],
    },
    sandboxName: "alpha",
    localPrebuildEnabled: false,
    gatewayPort: 8080,
    chatUiUrl: "http://127.0.0.1:18789",
  };
}

function createLegacyBinding(): OpenClawLegacyDockerBinding {
  return Object.freeze({
    dockerEnv: Object.freeze({
      DOCKER_CONFIG: "/home/test/.docker",
      DOCKER_CONTEXT: "verified-builder",
    }),
    engineId: "verified-engine",
  });
}

function createLegacyLease(
  binding: OpenClawLegacyDockerBinding,
  imageRef: string,
): PreparedOpenClawLegacyImage {
  return Object.freeze({
    dockerEnv: binding.dockerEnv,
    engineId: binding.engineId,
    imageRef,
    imageId: LEGACY_IMAGE_ID,
    verify: vi.fn(() => true),
    retainForRecreate: vi.fn(() => true),
    verifyForCreate: vi.fn(() => true),
    finalizeAfterCreate: vi.fn(() => ({
      mutableTagVerified: true,
      registryImageRef: null,
    })),
    abort: vi.fn(() => true),
    dispose: vi.fn(() => true),
  });
}

function hermesMessagingPlan() {
  return {
    schemaVersion: 1 as const,
    sandboxName: "alpha",
    agent: "hermes" as const,
    workflow: "rebuild" as const,
    channels: [
      {
        channelId: "slack",
        displayName: "Slack",
        authMode: "token-paste" as const,
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

describe("preflightRebuildImage", () => {
  it("carries verified base provenance into the retained managed context (#7144)", async () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-provenance-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const metadata = {
      schema: 1,
      key: "current-base",
      imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
      ref: `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`,
      digest: `sha256:${"a".repeat(64)}`,
      source: "pinned",
      pinnedRemoteRef: `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`,
      imageId: `sha256:${"b".repeat(64)}`,
      os: "linux",
      architecture: "amd64",
      glibcVersion: "2.41",
      requireOpenshellSandboxAbi: true,
      minGlibcVersion: "2.39",
    } satisfies SandboxBaseImageResolutionMetadata;
    const prepareDockerfilePatch = vi.fn(async () => ({
      buildId: "provenance",
      dashboardRemoteBindPrepared: false,
      resolvedBaseImage: null,
    }));
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    });
    try {
      const result = successful(
        await preflightRebuildImage(
          { ...input(null), preResolvedBaseImageMetadata: metadata },
          {
            stageBuildContext: vi.fn(() => ({
              buildCtx,
              stagedDockerfile,
              cleanupBuildCtx,
              origin: "generated" as const,
            })),
            prepareDockerfilePatch,
            buildImage: vi.fn(() => ({ status: 0 }) as never),
            removeImage: vi.fn(() => ({ status: 0 }) as never),
          },
        ),
      );

      expect(prepareDockerfilePatch).toHaveBeenCalledWith(
        expect.objectContaining({ preResolvedBaseImageMetadata: metadata }),
      );
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });

  it("prebuilds the managed OpenClaw image instead of deferring its first build until delete", async () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-preflight-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const buildImage = vi.fn(() => ({ status: 0 }) as never);
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    });
    const stageBuildContext = vi.fn(() => ({
      buildCtx,
      stagedDockerfile,
      cleanupBuildCtx,
      origin: "generated" as const,
    }));
    try {
      const result = successful(
        await preflightRebuildImage(input(null), {
          stageBuildContext,
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "1",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
          buildImage,
          removeImage: vi.fn(() => ({ status: 0 }) as never),
        }),
      );

      expect(stageBuildContext).toHaveBeenCalledWith(
        expect.objectContaining({ root: ROOT, agent: null }),
      );
      expect(buildImage).toHaveBeenCalledOnce();
      expect(cleanupBuildCtx).not.toHaveBeenCalled();
      expect(verifyPreparedBuildContext(result.prepared)).toBe(true);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
      expect(cleanupBuildCtx).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });

  it("removes a successful BuildKit candidate only with its captured same-engine image ID", async () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-buildkit-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const binding = createLegacyBinding();
    const buildImage = vi.fn(() => ({ status: 0 }) as never);
    const disposeLegacyImage = vi.fn(() => true);

    try {
      const result = successful(
        await preflightRebuildImage(
          { ...input(null), localPrebuildEnabled: true },
          {
            stageBuildContext: vi.fn(() => ({
              buildCtx,
              stagedDockerfile,
              cleanupBuildCtx: vi.fn(() => true),
              origin: "generated" as const,
            })),
            prepareDockerfilePatch: vi.fn(async () => ({
              buildId: "buildkit-success",
              dashboardRemoteBindPrepared: false,
              resolvedBaseImage: null,
            })),
            buildImage,
            captureLegacyDockerBinding: vi.fn(() => binding),
            inspectLegacyImageId: vi.fn(() => LEGACY_IMAGE_ID),
            disposeLegacyImage,
          },
        ),
      );

      expect(buildImage).toHaveBeenCalledWith(
        stagedDockerfile,
        result.imageTag,
        buildCtx,
        expect.objectContaining({ env: binding.dockerEnv }),
      );
      expect(result.prepared.preparedOpenClawLegacyImage).toBeUndefined();
      expect(disposeLegacyImage).toHaveBeenCalledWith(binding, result.imageTag, LEGACY_IMAGE_ID);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked build-context root before the preflight build",
    async () => {
      const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preflight-root-link-"));
      const targetBuildCtx = path.join(testRoot, "target");
      const linkedBuildCtx = path.join(testRoot, "context");
      fs.mkdirSync(targetBuildCtx);
      fs.writeFileSync(path.join(targetBuildCtx, "Dockerfile"), "FROM scratch\n");
      fs.symlinkSync(targetBuildCtx, linkedBuildCtx, "dir");
      const cleanupBuildCtx = vi.fn(() => {
        fs.rmSync(linkedBuildCtx, { force: true });
        return true;
      });
      const buildImage = vi.fn(() => ({ status: 0 }) as never);

      try {
        await expect(
          preflightRebuildImage(input(null), {
            stageBuildContext: vi.fn(() => ({
              buildCtx: linkedBuildCtx,
              stagedDockerfile: path.join(linkedBuildCtx, "Dockerfile"),
              cleanupBuildCtx,
              origin: "generated" as const,
            })),
            prepareDockerfilePatch: vi.fn(async () => ({
              buildId: "root-link",
              dashboardRemoteBindPrepared: false,
              resolvedBaseImage: null,
            })),
            buildImage,
            removeImage: vi.fn(() => ({ status: 0 }) as never),
          }),
        ).resolves.toEqual({
          ok: false,
          detail: "build-context root must be a real directory",
        });
        expect(buildImage).not.toHaveBeenCalled();
        expect(cleanupBuildCtx).toHaveBeenCalledOnce();
      } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["malformed syntax", "THIS IS NOT A DOCKERFILE"],
    ["missing COPY context", "FROM scratch\nCOPY missing.txt /missing.txt\n"],
  ])("fails before delete for %s", async (_label, dockerfileContents) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-"));
    const dockerfile = path.join(dir, "Dockerfile.custom");
    fs.writeFileSync(dockerfile, dockerfileContents);
    const removeImage = vi.fn(() => ({ status: 0 }) as never);
    try {
      const result = await preflightRebuildImage(input(dockerfile), {
        prepareDockerfilePatch: vi.fn(async () => ({
          buildId: "1",
          dashboardRemoteBindPrepared: false,
          resolvedBaseImage: null,
        })),
        buildImage: vi.fn(() => ({ status: 1, stderr: "dockerfile validation failed" }) as never),
        removeImage,
      });
      expect(result).toEqual({ ok: false, detail: "dockerfile validation failed" });
      expect(removeImage).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces redacted Buffer diagnostics when the replacement image build fails (#7111)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-diagnostic-"));
    const dockerfile = path.join(dir, "Dockerfile.custom");
    const credential = ["release", "diagnostic", "credential"].join("-");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    try {
      const result = await preflightRebuildImage(input(dockerfile), {
        prepareDockerfilePatch: vi.fn(async () => ({
          buildId: "1",
          dashboardRemoteBindPrepared: false,
          resolvedBaseImage: null,
        })),
        buildImage: vi.fn(
          () =>
            ({
              status: 1,
              stderr: Buffer.from(
                `failed to solve: build context unavailable at ${os.homedir()}/private-context\n` +
                  `Authorization: Bearer ${credential}`,
              ),
            }) as never,
        ),
        removeImage: vi.fn(() => ({ status: 0 }) as never),
      });

      expect(result).toEqual({
        ok: false,
        detail:
          "failed to solve: build context unavailable at ~/private-context\n" +
          "Authorization: Bearer <REDACTED>",
      });
      expect(JSON.stringify(result)).not.toContain(credential);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["error string", "error", false],
    ["error buffer", "error", true],
    ["stderr string", "stderr", false],
    ["stderr buffer", "stderr", true],
    ["stdout string", "stdout", false],
    ["stdout buffer", "stdout", true],
  ] as const)("retains one exact generated OpenClaw legacy image when %s contains the diagnostic (#7111)", async (_case, stream, buffered) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-buildx-fallback-"));
    const dockerfile = path.join(dir, "Dockerfile");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    const diagnostic = "ERROR: BuildKit is enabled but the buildx component is missing or broken.";
    const buildImage = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        [stream]: buffered ? Buffer.from(diagnostic) : diagnostic,
      } as never)
      .mockReturnValueOnce({ status: 0 } as never);
    const cleanupBuildCtx = vi.fn(() => true);
    const binding = createLegacyBinding();
    let lease: PreparedOpenClawLegacyImage | null = null;
    const createLegacyImage = vi.fn((_binding: OpenClawLegacyDockerBinding, imageRef: string) => {
      lease = createLegacyLease(binding, imageRef);
      return lease;
    });
    const removeImage = vi.fn(() => ({ status: 0 }) as never);
    const disposeLegacyImage = vi.fn(() => true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = successful(
        await preflightRebuildImage(
          { ...input(null), localPrebuildEnabled: true },
          {
            stageBuildContext: vi.fn(() => ({
              buildCtx: dir,
              stagedDockerfile: dockerfile,
              cleanupBuildCtx,
              origin: "generated" as const,
            })),
            prepareDockerfilePatch: vi.fn(async () => ({
              buildId: "buildx-fallback",
              dashboardRemoteBindPrepared: false,
              resolvedBaseImage: null,
            })),
            buildImage,
            removeImage,
            buildxAvailable: vi.fn(() => false),
            captureLegacyDockerBinding: vi.fn(() => binding),
            inspectLegacyImageId: vi.fn(() => LEGACY_IMAGE_ID),
            createLegacyImage,
            disposeLegacyImage,
          },
        ),
      );

      expect(buildImage).toHaveBeenCalledTimes(2);
      expect(buildImage.mock.calls[0]?.slice(0, 3)).toEqual(buildImage.mock.calls[1]?.slice(0, 3));
      expect(buildImage.mock.calls[0]?.[3]).toEqual(
        expect.objectContaining({ cwd: ROOT, env: binding.dockerEnv }),
      );
      expect(buildImage.mock.calls[1]?.[3]).toEqual(
        expect.objectContaining({
          cwd: ROOT,
          env: { ...binding.dockerEnv, DOCKER_BUILDKIT: "0" },
        }),
      );
      expect(result.imageTag).toMatch(/^nemoclaw-sandbox-local:/);
      expect(result.prepared.preparedOpenClawLegacyImage).toBe(lease);
      expect(createLegacyImage).toHaveBeenCalledWith(binding, result.imageTag, LEGACY_IMAGE_ID);
      expect(removeImage).not.toHaveBeenCalled();
      expect(disposeLegacyImage).not.toHaveBeenCalled();
      expect(cleanupBuildCtx).not.toHaveBeenCalled();
      expect(verifyPreparedBuildContext(result.prepared)).toBe(true);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      warn.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "the independent Buildx probe succeeds",
      agent: null,
      fromDockerfile: null,
      origin: "generated" as const,
      localPrebuildEnabled: true,
      buildxAvailable: true,
      capturesBinding: true,
    },
    {
      label: "the generated target is Hermes",
      agent: { name: "hermes" },
      fromDockerfile: null,
      origin: "generated" as const,
      localPrebuildEnabled: true,
      buildxAvailable: false,
      capturesBinding: false,
    },
    {
      label: "local image consumption is unavailable",
      agent: null,
      fromDockerfile: null,
      origin: "generated" as const,
      localPrebuildEnabled: false,
      buildxAvailable: false,
      capturesBinding: false,
    },
    {
      label: "the Dockerfile is user supplied",
      agent: null,
      fromDockerfile: "/tmp/Dockerfile.custom",
      origin: "custom" as const,
      localPrebuildEnabled: true,
      buildxAvailable: false,
      capturesBinding: false,
    },
  ])("does not retry when $label (#7111)", async (testCase) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-buildx-no-fallback-"));
    const dockerfile = path.join(dir, "Dockerfile");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    const diagnostic = "ERROR: BuildKit is enabled but the buildx component is missing or broken.";
    const buildImage = vi.fn(() => ({ status: 1, stderr: diagnostic }) as never);
    const cleanupBuildCtx = vi.fn(() => true);
    const binding = createLegacyBinding();
    const captureLegacyDockerBinding = vi.fn(() => binding);
    const buildxAvailable = vi.fn(() => testCase.buildxAvailable);

    try {
      const result = await preflightRebuildImage(
        {
          ...input(testCase.fromDockerfile),
          agent: testCase.agent as never,
          localPrebuildEnabled: testCase.localPrebuildEnabled,
        },
        {
          stageBuildContext: vi.fn(() => ({
            buildCtx: dir,
            stagedDockerfile: dockerfile,
            cleanupBuildCtx,
            origin: testCase.origin,
          })),
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "no-fallback",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
          buildImage,
          removeImage: vi.fn(() => ({ status: 0 }) as never),
          buildxAvailable,
          captureLegacyDockerBinding,
          disposeLegacyImage: vi.fn(() => true),
        },
      );

      expect(result).toEqual({ ok: false, detail: diagnostic });
      expect(buildImage).toHaveBeenCalledOnce();
      expect(captureLegacyDockerBinding.mock.calls).toEqual(
        testCase.capturesBinding
          ? [
              [
                {
                  buildDockerEnv: expect.any(Function),
                  cwd: ROOT,
                },
              ],
            ]
          : [],
      );
      expect(buildxAvailable).toHaveBeenCalledTimes(testCase.capturesBinding ? 1 : 0);
      expect(cleanupBuildCtx).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects generated build-context drift before the legacy retry (#7111)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-buildx-drift-"));
    const dockerfile = path.join(dir, "Dockerfile");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    const buildImage = vi.fn(() => {
      fs.writeFileSync(path.join(dir, "mutated"), "changed\n");
      return {
        status: 1,
        stderr: "ERROR: BuildKit is enabled but the buildx component is missing or broken.",
      } as never;
    });
    const cleanupBuildCtx = vi.fn(() => true);

    try {
      await expect(
        preflightRebuildImage(
          { ...input(null), localPrebuildEnabled: true },
          {
            stageBuildContext: vi.fn(() => ({
              buildCtx: dir,
              stagedDockerfile: dockerfile,
              cleanupBuildCtx,
              origin: "generated" as const,
            })),
            prepareDockerfilePatch: vi.fn(async () => ({
              buildId: "buildx-drift",
              dashboardRemoteBindPrepared: false,
              resolvedBaseImage: null,
            })),
            buildImage,
            buildxAvailable: vi.fn(() => false),
            captureLegacyDockerBinding: vi.fn(() => createLegacyBinding()),
            disposeLegacyImage: vi.fn(() => true),
          },
        ),
      ).resolves.toEqual({
        ok: false,
        detail: "replacement build context changed during preflight",
      });
      expect(buildImage).toHaveBeenCalledOnce();
      expect(cleanupBuildCtx).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a unique GC-visible tag when legacy image identity cannot be established (#7253)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-buildx-identity-failure-"));
    const dockerfile = path.join(dir, "Dockerfile");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    const binding = createLegacyBinding();
    const buildImage = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stderr: "ERROR: BuildKit is enabled but the buildx component is missing or broken.",
      } as never)
      .mockReturnValueOnce({ status: 0 } as never);
    const disposeLegacyImage = vi.fn(() => true);
    const removeImage = vi.fn(() => ({ status: 0 }) as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await preflightRebuildImage(
        { ...input(null), localPrebuildEnabled: true },
        {
          stageBuildContext: vi.fn(() => ({
            buildCtx: dir,
            stagedDockerfile: dockerfile,
            cleanupBuildCtx: vi.fn(() => true),
            origin: "generated" as const,
          })),
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "identity-failure",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
          buildImage,
          removeImage,
          buildxAvailable: vi.fn(() => false),
          captureLegacyDockerBinding: vi.fn(() => binding),
          inspectLegacyImageId: vi.fn(() => {
            throw new Error("OpenClaw legacy-image identity could not be verified.");
          }),
          disposeLegacyImage,
        },
      );

      expect(result).toEqual({
        ok: false,
        detail: "OpenClaw legacy-image identity could not be verified.",
      });
      expect(disposeLegacyImage).not.toHaveBeenCalled();
      expect(removeImage).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /nemoclaw-sandbox-local:.*no verified immutable cleanup identity.*maintenance cleanup/,
        ),
      );
    } finally {
      warn.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not retry an unrelated generated-image build failure (#7111)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-no-retry-"));
    const dockerfile = path.join(dir, "Dockerfile");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    const buildImage = vi.fn(() => ({ status: 1, stderr: "registry timeout" }) as never);
    const buildxAvailable = vi.fn(() => false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        preflightRebuildImage(
          { ...input(null), localPrebuildEnabled: true },
          {
            stageBuildContext: vi.fn(() => ({
              buildCtx: dir,
              stagedDockerfile: dockerfile,
              cleanupBuildCtx: vi.fn(() => true),
              origin: "generated" as const,
            })),
            prepareDockerfilePatch: vi.fn(async () => ({
              buildId: "unrelated-build-failure",
              dashboardRemoteBindPrepared: false,
              resolvedBaseImage: null,
            })),
            buildImage,
            buildxAvailable,
            captureLegacyDockerBinding: vi.fn(() => createLegacyBinding()),
            disposeLegacyImage: vi.fn(() => true),
          },
        ),
      ).resolves.toEqual({ ok: false, detail: "registry timeout" });
      expect(buildImage).toHaveBeenCalledOnce();
      expect(buildxAvailable).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /nemoclaw-sandbox-local:.*no verified immutable cleanup identity.*maintenance cleanup/,
        ),
      );
    } finally {
      warn.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the redacted legacy retry failure before the BuildKit diagnostic (#7111)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-buildx-double-fail-"));
    const dockerfile = path.join(dir, "Dockerfile");
    const credential = ["legacy", "retry", "credential"].join("-");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    const buildImage = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stderr:
          "ERROR: BuildKit is enabled but the buildx component is missing or broken.\n" +
          "x".repeat(9_000),
      } as never)
      .mockReturnValueOnce({
        status: 1,
        stderr:
          `legacy build could not read ${os.homedir()}/private-context\n` +
          `Authorization: Bearer ${credential}`,
      } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await preflightRebuildImage(
        { ...input(null), localPrebuildEnabled: true },
        {
          stageBuildContext: vi.fn(() => ({
            buildCtx: dir,
            stagedDockerfile: dockerfile,
            cleanupBuildCtx: vi.fn(() => true),
            origin: "generated" as const,
          })),
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "double-failure",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
          buildImage,
          buildxAvailable: vi.fn(() => false),
          captureLegacyDockerBinding: vi.fn(() => createLegacyBinding()),
          disposeLegacyImage: vi.fn(() => true),
        },
      );

      expect(result.ok).toBe(false);
      const failure = result as Extract<RebuildImagePreflightResult, { ok: false }>;
      expect(failure.detail).toContain("Legacy-builder retry failed");
      expect(failure.detail).toContain("legacy build could not read ~/private-context");
      expect(failure.detail).toContain("Authorization: Bearer <REDACTED>");
      expect(failure.detail).not.toContain(credential);
      expect(failure.detail.length).toBeLessThan(8_100);
      expect(buildImage).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds and removes the exact staged custom context on success", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-"));
    const dockerfile = path.join(dir, "Dockerfile.custom");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    const buildImage = vi.fn(() => ({ status: 0 }) as never);
    const removeImage = vi.fn(() => ({ status: 0 }) as never);
    try {
      const result = successful(
        await preflightRebuildImage(input(dockerfile), {
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "1",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
          buildImage,
          removeImage,
        }),
      );
      expect(buildImage).toHaveBeenCalledWith(
        expect.stringContaining("Dockerfile"),
        expect.stringMatching(/^nemoclaw-sandbox-local:/),
        expect.any(String),
        expect.objectContaining({ ignoreError: true }),
      );
      expect(removeImage).toHaveBeenCalledOnce();
      expect(fs.existsSync(result.prepared.buildCtx)).toBe(true);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins a symlinked Dockerfile before the source link can be swapped", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-link-"));
    const dockerfile = path.join(dir, "Dockerfile");
    fs.writeFileSync(path.join(dir, "Dockerfile.safe"), "FROM scratch\n# safe\n");
    fs.writeFileSync(path.join(dir, "Dockerfile.changed"), "FROM scratch\n# changed\n");
    fs.symlinkSync("Dockerfile.safe", dockerfile);
    const builtDockerfiles: string[] = [];
    try {
      const result = successful(
        await preflightRebuildImage(input(dockerfile), {
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "1",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
          buildImage: vi.fn((stagedDockerfile) => {
            builtDockerfiles.push(fs.readFileSync(stagedDockerfile, "utf8"));
            return { status: 0 } as never;
          }),
          removeImage: vi.fn(() => ({ status: 0 }) as never),
        }),
      );

      fs.unlinkSync(dockerfile);
      fs.symlinkSync("Dockerfile.changed", dockerfile);

      expect(builtDockerfiles).toEqual(["FROM scratch\n# safe\n"]);
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      const stagedFd = fs.openSync(
        result.prepared.stagedDockerfile,
        fs.constants.O_RDONLY | noFollow,
      );
      try {
        expect(fs.fstatSync(stagedFd).isFile()).toBe(true);
        expect(fs.readFileSync(stagedFd, "utf8")).toBe("FROM scratch\n# safe\n");
      } finally {
        fs.closeSync(stagedFd);
      }
      expect(verifyPreparedBuildContext(result.prepared)).toBe(true);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns and retries at process exit when a built preflight image cannot be removed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-cleanup-"));
    const dockerfile = path.join(dir, "Dockerfile.custom");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    const removeImage = vi
      .fn()
      .mockReturnValueOnce({ status: 1 } as never)
      .mockReturnValueOnce({ status: 0 } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registerExitHandler = vi.fn((listener: () => void) => {
      listener();
    });
    try {
      const result = successful(
        await preflightRebuildImage(input(dockerfile), {
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "1",
            dashboardRemoteBindPrepared: true,
            resolvedBaseImage: null,
          })),
          buildImage: vi.fn(() => ({ status: 0 }) as never),
          removeImage,
          registerExitHandler,
        }),
      );

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("failed to remove temporary rebuild preflight image"),
      );
      expect(registerExitHandler).toHaveBeenCalledWith(expect.any(Function));
      expect(removeImage).toHaveBeenCalledTimes(2);
      expect(result.prepared.dashboardRemoteBindPrepared).toBe(true);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      warn.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("finalizePreparedRebuildImageMessagingPlan", () => {
  it("rebuilds and re-fingerprints the retained context with backup-captured home channels (#7803)", () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-finalize-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\nARG NEMOCLAW_MESSAGING_PLAN_B64=old\n");
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    });
    const originalFingerprint = fingerprintBuildContext(buildCtx);
    const prepared: PreparedRebuildImage = {
      buildCtx,
      stagedDockerfile,
      cleanupBuildCtx,
      buildId: "finalize",
      origin: "generated",
      contextFingerprint: originalFingerprint,
      verifyBuildCtx: createBuildContextVerifier(buildCtx, originalFingerprint),
      rebuildTarget: { agentName: "hermes", fromDockerfile: null },
    };
    const builtDockerfiles: string[] = [];
    const removeImage = vi.fn(() => ({ status: 0 }) as never);
    try {
      const result = successful(
        finalizePreparedRebuildImageMessagingPlan(
          prepared,
          hermesMessagingPlan(),
          [
            {
              path: ".env",
              assignments: ["SLACK_HOME_CHANNEL=C0123", "SLACK_HOME_CHANNEL_THREAD_ID=123.456"],
            },
          ],
          {
            buildImage: vi.fn((dockerfile) => {
              builtDockerfiles.push(fs.readFileSync(dockerfile, "utf8"));
              return { status: 0 } as never;
            }),
            removeImage,
          },
        ),
      );

      const encodedPlan = builtDockerfiles[0]
        ?.split("\n")
        .find((line) => line.startsWith("ARG NEMOCLAW_MESSAGING_PLAN_B64="))
        ?.split("=")[1];
      const imagePlan = JSON.parse(Buffer.from(encodedPlan ?? "", "base64").toString("utf8")) as {
        agentRender: Array<{ renderId?: string; lines?: string[] }>;
      };
      expect(imagePlan.agentRender[0]).toMatchObject({
        renderId: "hermes-preserved-home-channels",
        lines: ["SLACK_HOME_CHANNEL=C0123", "SLACK_HOME_CHANNEL_THREAD_ID=123.456"],
      });
      expect(result.prepared.contextFingerprint).not.toBe(originalFingerprint);
      expect(verifyPreparedBuildContext(result.prepared)).toBe(true);
      expect(removeImage).toHaveBeenCalledOnce();
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });

  it("refuses to bless a retained context that changed before backup finalization", () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-finalize-drift-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\nARG NEMOCLAW_MESSAGING_PLAN_B64=old\n");
    const contextFingerprint = fingerprintBuildContext(buildCtx);
    const prepared: PreparedRebuildImage = {
      buildCtx,
      stagedDockerfile,
      cleanupBuildCtx: () => true,
      buildId: "drift",
      origin: "generated",
      contextFingerprint,
      verifyBuildCtx: createBuildContextVerifier(buildCtx, contextFingerprint),
      rebuildTarget: { agentName: "hermes", fromDockerfile: null },
    };
    const buildImage = vi.fn();
    try {
      fs.writeFileSync(path.join(buildCtx, "changed"), "changed");

      expect(
        finalizePreparedRebuildImageMessagingPlan(
          prepared,
          hermesMessagingPlan(),
          [{ path: ".env", assignments: ["SLACK_HOME_CHANNEL=C0123"] }],
          { buildImage },
        ),
      ).toEqual({
        ok: false,
        detail: "replacement build context changed before backup finalization",
      });
      expect(buildImage).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });

  it("retries finalization image cleanup at process exit", () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-finalize-cleanup-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\nARG NEMOCLAW_MESSAGING_PLAN_B64=old\n");
    const contextFingerprint = fingerprintBuildContext(buildCtx);
    const prepared: PreparedRebuildImage = {
      buildCtx,
      stagedDockerfile,
      cleanupBuildCtx: () => true,
      buildId: "finalize-cleanup",
      origin: "generated",
      contextFingerprint,
      verifyBuildCtx: createBuildContextVerifier(buildCtx, contextFingerprint),
      rebuildTarget: { agentName: "hermes", fromDockerfile: null },
    };
    const removeImage = vi
      .fn()
      .mockReturnValueOnce({ status: 1 } as never)
      .mockReturnValueOnce({ status: 0 } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registerExitHandler = vi.fn((listener: () => void) => {
      listener();
    });
    try {
      expect(
        finalizePreparedRebuildImageMessagingPlan(
          prepared,
          hermesMessagingPlan(),
          [{ path: ".env", assignments: ["SLACK_HOME_CHANNEL=C0123"] }],
          {
            buildImage: vi.fn(() => ({ status: 0 }) as never),
            removeImage,
            registerExitHandler,
          },
        ).ok,
      ).toBe(true);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("failed to remove temporary rebuild finalization image"),
      );
      expect(registerExitHandler).toHaveBeenCalledWith(expect.any(Function));
      expect(removeImage).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });
});
