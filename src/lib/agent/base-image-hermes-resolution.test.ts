// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeAgent } from "../../../test/helpers/base-image-test-harness";

const dockerMocks = vi.hoisted(() => ({
  build: vi.fn(),
  capture: vi.fn(),
  imageInspect: vi.fn(),
  imageInspectFormat: vi.fn(),
  infoFormat: vi.fn(),
  pull: vi.fn(),
  rmi: vi.fn(),
  tag: vi.fn(),
}));
const sourceMocks = vi.hoisted(() => ({
  inputsChanged: vi.fn(),
  inputsDirty: vi.fn(),
  nearestTags: vi.fn(),
}));

vi.mock("../adapters/docker", () => ({
  dockerBuild: dockerMocks.build,
  dockerCapture: dockerMocks.capture,
  dockerImageInspect: dockerMocks.imageInspect,
  dockerImageInspectFormat: dockerMocks.imageInspectFormat,
  dockerInfoFormat: dockerMocks.infoFormat,
  dockerPull: dockerMocks.pull,
  dockerRmi: dockerMocks.rmi,
  dockerTag: dockerMocks.tag,
}));

vi.mock("../sandbox-base-image/source-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox-base-image/source-identity")>()),
  baseImageInputsChangedSinceMain: sourceMocks.inputsChanged,
  baseImageInputsDirty: sourceMocks.inputsDirty,
  getNearestVersionedBaseImageTags: sourceMocks.nearestTags,
}));

import {
  bindLocalAgentBaseImageToPinnedProvenance,
  createAgentSandbox,
  ensureAgentBaseImage,
  pinTrustedAgentRemoteBaseImageOverrideForOperation,
} from "./base-image";

const platformDigest = "sha256:c0c149ed03b3e8fcd3e395558b22e871cd27c9966ea6faf04c0d2b94d0a821b9";
const platformRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${platformDigest}`;
const imageId = `sha256:${"b".repeat(64)}`;
const createdBuildContexts: string[] = [];
let trackedRef = "";
let testRoot = "";

function stageHermesSandbox() {
  const result = createAgentSandbox(makeAgent(), { rootDir: testRoot });
  createdBuildContexts.push(result.buildCtx);
  return result;
}

describe("Hermes base-image resolver integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF", "");
    sourceMocks.inputsChanged.mockReturnValue(false);
    sourceMocks.inputsDirty.mockReturnValue(false);
    sourceMocks.nearestTags.mockReturnValue([]);
    dockerMocks.infoFormat.mockReturnValue("linux/aarch64\n");
    dockerMocks.pull.mockReturnValue({ status: 1 });
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-resolution-test-"));

    const dockerfile = fs.readFileSync(makeAgent().dockerfilePath ?? "", "utf8");
    trackedRef =
      dockerfile.match(
        /^ARG BASE_IMAGE=(ghcr\.io\/nvidia\/nemoclaw\/hermes-sandbox-base@sha256:[0-9a-f]{64})$/m,
      )?.[1] ?? "";
    expect(trackedRef).toMatch(
      /^ghcr\.io\/nvidia\/nemoclaw\/hermes-sandbox-base@sha256:[0-9a-f]{64}$/,
    );

    const inspectStatusByRef = new Map([
      [trackedRef, 0],
      [platformRef, 0],
    ]);
    const inspectOutputByKey = new Map([
      [`{{json .RepoDigests}}\0${trackedRef}`, JSON.stringify([platformRef])],
      [
        `{{json .}}\0${platformRef}`,
        JSON.stringify({
          Architecture: "arm64",
          Id: imageId,
          Os: "linux",
          RepoDigests: [platformRef],
        }),
      ],
    ]);
    const captureByEntrypoint = new Map([
      ["/opt/hermes/.venv/bin/python", "nemoclaw-hermes-mcp-runtime-ok"],
      ["/usr/bin/ldd", "ldd (GNU libc) 2.41"],
    ]);

    dockerMocks.imageInspect.mockImplementation((ref: string) => ({
      status: inspectStatusByRef.get(ref) ?? 1,
    }));
    dockerMocks.imageInspectFormat.mockImplementation((format: string, ref: string) =>
      (inspectOutputByKey.get(`${format}\0${ref}`) ?? "").trim(),
    );
    dockerMocks.capture.mockImplementation(
      (args: string[]) => captureByEntrypoint.get(args[args.indexOf("--entrypoint") + 1]) ?? "",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const buildCtx of createdBuildContexts.splice(0)) {
      fs.rmSync(buildCtx, { force: true, recursive: true });
    }
    fs.rmSync(testRoot, { force: true, recursive: true });
  });

  it("stages Hermes on aarch64 with a Dockerfile-pinned platform digest produced by the resolver path (#6313)", () => {
    const result = stageHermesSandbox();

    expect(fs.readFileSync(result.stagedDockerfile, "utf8")).toContain(
      `ARG BASE_IMAGE=${platformRef}`,
    );
    expect(result.baseImageResolutionMetadata).toMatchObject({
      architecture: "arm64",
      digest: platformDigest,
      pinnedRemoteRef: trackedRef,
      ref: platformRef,
      source: "pinned",
    });
    expect(dockerMocks.imageInspect).toHaveBeenCalledWith(trackedRef, {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(dockerMocks.imageInspectFormat).toHaveBeenCalledWith(
      "{{json .RepoDigests}}",
      trackedRef,
      { ignoreError: true },
    );
  }, 15_000);

  it("rejects an explicit platform digest override without pinned provenance", () => {
    vi.stubEnv("NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF", platformRef);

    expect(() => createAgentSandbox(makeAgent())).toThrow(
      `Hermes final image does not accept base image ref '${platformRef}'`,
    );
  });

  it("reuses an explicit digest resolution only during its trusted rebuild lease (#9386)", () => {
    dockerMocks.imageInspect.mockReturnValue({ status: 0 });
    const exactInspection = new Map([
      [`{{json .RepoDigests}}\0${trackedRef}`, JSON.stringify([trackedRef])],
      [
        `{{json .}}\0${trackedRef}`,
        JSON.stringify({
          Architecture: "arm64",
          Id: imageId,
          Os: "linux",
          RepoDigests: [trackedRef],
        }),
      ],
    ]);
    dockerMocks.imageInspectFormat.mockImplementation((format: string, ref: string) =>
      (exactInspection.get(`${format}\0${ref}`) ?? "").trim(),
    );
    vi.stubEnv("NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF", trackedRef);

    const outer = ensureAgentBaseImage(makeAgent());
    const resolutionMetadata = outer.resolutionMetadata;
    expect(resolutionMetadata).toMatchObject({ ref: trackedRef, source: "override" });
    const restore = pinTrustedAgentRemoteBaseImageOverrideForOperation(
      "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
      {
        ref: trackedRef,
        resolutionMetadata: resolutionMetadata as NonNullable<typeof resolutionMetadata>,
      },
    );

    try {
      const inner = ensureAgentBaseImage(makeAgent());
      expect(inner.imageTag).toBe(trackedRef);
      expect(inner.resolutionMetadata).toBe(resolutionMetadata);

      const missingDigestInspection = new Map([
        [
          `{{json .}}\0${trackedRef}`,
          JSON.stringify({
            Architecture: "arm64",
            Id: imageId,
            Os: "linux",
            RepoDigests: [],
          }),
        ],
      ]);
      dockerMocks.imageInspectFormat.mockImplementation((format: string, ref: string) =>
        (missingDigestInspection.get(`${format}\0${ref}`) ?? "").trim(),
      );
      const sparse = ensureAgentBaseImage(makeAgent());
      expect(sparse.imageTag).toBe(trackedRef);
      expect(sparse.resolutionMetadata).toBe(resolutionMetadata);
      expect(dockerMocks.pull).not.toHaveBeenCalled();
    } finally {
      restore();
    }

    const afterRestore = ensureAgentBaseImage(makeAgent());
    expect(afterRestore.imageTag).toBe(trackedRef);
    expect(afterRestore.resolutionMetadata).not.toBe(resolutionMetadata);
    expect(afterRestore.resolutionMetadata).toMatchObject({ ref: trackedRef, source: "override" });
  }, 30_000);

  it("reuses an outer resolver's pinned platform digest only during its rebuild lease (#7144)", () => {
    const outer = stageHermesSandbox();
    const resolutionMetadata = outer.baseImageResolutionMetadata;
    expect(resolutionMetadata).not.toBeNull();
    vi.stubEnv("NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF", platformRef);
    const restore = pinTrustedAgentRemoteBaseImageOverrideForOperation(
      "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
      {
        ref: platformRef,
        resolutionMetadata: resolutionMetadata as NonNullable<typeof resolutionMetadata>,
      },
    );

    try {
      const inner = stageHermesSandbox();
      expect(fs.readFileSync(inner.stagedDockerfile, "utf8")).toContain(
        `ARG BASE_IMAGE=${platformRef}`,
      );
      expect(inner.baseImageResolutionMetadata).toBe(resolutionMetadata);
    } finally {
      restore();
    }

    expect(() => stageHermesSandbox()).toThrow(
      `Hermes final image does not accept base image ref '${platformRef}'`,
    );
  }, 30_000);

  it("uses a proven local Hermes base-image alias only to select its remote digest during a rebuild lease (#7144)", () => {
    const localAlias = "nemoclaw-hermes-sandbox-base-local:e2e-current";
    const inspectStatusByRef = new Map([
      [localAlias, 0],
      [trackedRef, 0],
      [platformRef, 0],
    ]);
    const inspectedImage = JSON.stringify({
      Architecture: "arm64",
      Id: imageId,
      Os: "linux",
      RepoDigests: [platformRef],
    });
    const inspectOutputByKey = new Map([
      [`{{json .}}\0${localAlias}`, inspectedImage],
      [`{{json .}}\0${trackedRef}`, inspectedImage],
      [`{{json .}}\0${platformRef}`, inspectedImage],
    ]);
    dockerMocks.imageInspect.mockImplementation((ref: string) => ({
      status: inspectStatusByRef.get(ref) ?? 1,
    }));
    dockerMocks.imageInspectFormat.mockImplementation((format: string, ref: string) =>
      (inspectOutputByKey.get(`${format}\0${ref}`) ?? "").trim(),
    );
    const agent = makeAgent();
    const resolutionMetadata = bindLocalAgentBaseImageToPinnedProvenance(agent, localAlias);
    expect(resolutionMetadata).toMatchObject({ ref: platformRef, source: "pinned" });
    vi.stubEnv("NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF", localAlias);
    const restore = pinTrustedAgentRemoteBaseImageOverrideForOperation(
      "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
      {
        ref: localAlias,
        resolutionMetadata: resolutionMetadata as NonNullable<typeof resolutionMetadata>,
      },
    );

    try {
      const inner = ensureAgentBaseImage(agent);
      expect(inner.imageTag).toBe(platformRef);
      expect(inner.resolutionMetadata).toBe(resolutionMetadata);
    } finally {
      restore();
    }

    expect(() => ensureAgentBaseImage(agent)).toThrow(
      `Hermes Agent sandbox base image override '${localAlias}' is outside the trusted repository 'ghcr.io/nvidia/nemoclaw/hermes-sandbox-base'.`,
    );
  }, 30_000);
});
