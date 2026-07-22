// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxBaseImageResolutionMetadata } from "../sandbox-base-image";
import { patchStagedDockerfile } from "./dockerfile-patch";

const NODE_REFRESH = "COPY --from=builder /usr/local/bin/node /usr/local/bin/node";
const tmpRoots: string[] = [];

function metadata(source: SandboxBaseImageResolutionMetadata["source"]) {
  return {
    schema: 1,
    key: "resolution-key",
    imageName: "ghcr.io/nvidia/nemoclaw/sandbox-base",
    ref:
      source === "local"
        ? "nemoclaw-sandbox-base-local:test"
        : "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abc",
    digest: source === "local" ? null : "sha256:abc",
    source,
    imageId: "sha256:image",
    os: "linux",
    architecture: "amd64",
    glibcVersion: "2.41",
    requireOpenshellSandboxAbi: true,
    minGlibcVersion: "2.39",
  } satisfies SandboxBaseImageResolutionMetadata;
}

function patchNodeRefresh(options: {
  source: SandboxBaseImageResolutionMetadata["source"];
  baseImageRef: string | null;
  trusted?: boolean;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-node-refresh-test-"));
  tmpRoots.push(dir);
  const dockerfilePath = path.join(dir, "Dockerfile");
  fs.writeFileSync(
    dockerfilePath,
    [
      "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
      "FROM node:22-trixie-slim@sha256:builder AS builder",
      "FROM ${BASE_IMAGE}",
      NODE_REFRESH,
    ].join("\n"),
  );
  patchStagedDockerfile(
    dockerfilePath,
    "model",
    "http://127.0.0.1:18789",
    "build",
    null,
    null,
    null,
    options.baseImageRef,
    false,
    null,
    [],
    {
      trustedManagedDockerfile: options.trusted ?? true,
      baseImageResolutionMetadata: metadata(options.source),
    },
  );
  return fs.readFileSync(dockerfilePath, "utf8");
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("managed OpenClaw Node runtime refresh", () => {
  it("elides the copy only for the exact trusted authoritative local base", () => {
    const localRef = metadata("local").ref;
    expect(patchNodeRefresh({ source: "local", baseImageRef: localRef })).not.toContain(
      NODE_REFRESH,
    );
    expect(patchNodeRefresh({ source: "local", baseImageRef: "local:other" })).toContain(
      NODE_REFRESH,
    );
    expect(patchNodeRefresh({ source: "local", baseImageRef: localRef, trusted: false })).toContain(
      NODE_REFRESH,
    );
    expect(patchNodeRefresh({ source: "version-tag", baseImageRef: null })).toContain(NODE_REFRESH);
  });

  it("keeps Dockerfile.base and the managed builder on the same Node image", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
    const baseDockerfile = fs.readFileSync(path.join(root, "Dockerfile.base"), "utf8");
    const builderImage = dockerfile.match(/^FROM (node:[^\s]+) AS builder$/m)?.[1];
    const baseImage = baseDockerfile.match(/^FROM (node:[^\s]+)$/m)?.[1];

    expect(builderImage).toMatch(/^node:22-trixie-slim@sha256:[0-9a-f]{64}$/);
    expect(baseImage).toBe(builderImage);
  });
});
