// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSandboxBaseImageResolutionLabels,
  SANDBOX_BASE_RESOLUTION_LABEL,
  type SandboxBaseImageResolutionMetadata,
} from "../sandbox-base-image";
import { patchStagedDockerfile } from "./dockerfile-patch";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("managed image base-resolution metadata", () => {
  it("stamps reusable resolution metadata on the completed managed image (#4680)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-resolution-label-test-"));
    tmpRoots.push(dir);
    const dockerfilePath = path.join(dir, "Dockerfile");
    fs.writeFileSync(dockerfilePath, "FROM scratch\n", "utf8");
    const metadata: SandboxBaseImageResolutionMetadata = {
      schema: 1,
      key: "resolution-key",
      imageName: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abc",
      digest: "sha256:abc",
      source: "version-tag",
      imageId: "sha256:image",
      os: "linux",
      architecture: "amd64",
      glibcVersion: "2.41",
      requireOpenshellSandboxAbi: true,
      minGlibcVersion: "2.39",
    };

    patchStagedDockerfile(
      dockerfilePath,
      "model",
      "http://127.0.0.1:7000",
      "build",
      null,
      null,
      null,
      null,
      false,
      null,
      [],
      { baseImageResolutionMetadata: metadata },
    );

    const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
    expect(dockerfile).toContain('LABEL com.nvidia.nemoclaw.base-resolution-key="resolution-key"');
    const encoded = dockerfile.match(/base-resolution="([^"]+)"/)?.[1];
    expect(
      parseSandboxBaseImageResolutionLabels({
        [SANDBOX_BASE_RESOLUTION_LABEL]: encoded,
      }),
    ).toEqual(metadata);
  });
});
