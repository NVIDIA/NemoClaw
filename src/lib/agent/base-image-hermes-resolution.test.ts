// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

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
}));

import { createAgentSandbox } from "./base-image";

const platformDigest = "sha256:c0c149ed03b3e8fcd3e395558b22e871cd27c9966ea6faf04c0d2b94d0a821b9";
const platformRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${platformDigest}`;
const imageId = `sha256:${"b".repeat(64)}`;
const createdBuildContexts: string[] = [];
let trackedRef = "";

describe("Hermes base-image resolver integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF", "");
    sourceMocks.inputsChanged.mockReturnValue(false);
    sourceMocks.inputsDirty.mockReturnValue(false);
    dockerMocks.infoFormat.mockReturnValue("linux/aarch64\n");
    dockerMocks.pull.mockReturnValue({ status: 1 });

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
      (args: string[]) => captureByEntrypoint.get(args[3]) ?? "",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const buildCtx of createdBuildContexts.splice(0)) {
      fs.rmSync(buildCtx, { force: true, recursive: true });
    }
  });

  it("stages Hermes on aarch64 with a Dockerfile-pinned platform digest produced by the resolver path (#6313)", () => {
    const result = createAgentSandbox(makeAgent());
    createdBuildContexts.push(result.buildCtx);

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
});
