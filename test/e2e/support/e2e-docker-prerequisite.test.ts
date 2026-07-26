// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { DockerPrerequisite, DockerProbe } from "../fixtures/docker-probe.ts";

function prerequisite(
  exitCode: number,
  isCi: boolean,
  skip = vi.fn((): never => {
    throw new Error("skipped");
  }),
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-prerequisite-"));
  const probe = new DockerProbe(
    new ArtifactSink(root),
    (text) => text,
    () => ({
      pid: 1,
      output: [null, "", exitCode === 0 ? "" : "daemon unavailable"],
      stdout: "",
      stderr: exitCode === 0 ? "" : "daemon unavailable",
      status: exitCode,
      signal: null,
    }),
  );
  return { docker: new DockerPrerequisite(probe, skip, isCi), root, skip };
}

describe("Docker prerequisite", () => {
  it("returns available and optional probe results with artifacts", async () => {
    const { docker, root } = prerequisite(0, false);
    try {
      expect((await docker.probeDocker()).exitCode).toBe(0);
      expect((await docker.requireDocker()).exitCode).toBe(0);
      expect(fs.readdirSync(path.join(root, "docker")).length).toBe(6);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips locally but fails in CI when Docker is required", async () => {
    const local = prerequisite(1, false);
    const ci = prerequisite(1, true);
    try {
      await expect(local.docker.requireDocker()).rejects.toThrow("skipped");
      expect(local.skip).toHaveBeenCalledWith(expect.stringContaining("Docker is required"));
      await expect(ci.docker.requireDocker()).rejects.toThrow(/daemon unavailable/);
    } finally {
      fs.rmSync(local.root, { recursive: true, force: true });
      fs.rmSync(ci.root, { recursive: true, force: true });
    }
  });

  it("supports intentionally missing Docker", async () => {
    const missing = prerequisite(1, false);
    const available = prerequisite(0, false);
    try {
      expect((await missing.docker.expectMissingDocker()).exitCode).toBe(1);
      await expect(available.docker.expectMissingDocker()).rejects.toThrow(
        /expected to be unavailable/,
      );
    } finally {
      fs.rmSync(missing.root, { recursive: true, force: true });
      fs.rmSync(available.root, { recursive: true, force: true });
    }
  });
});
