// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { retainOnboardFailureArtifacts } from "../fixtures/onboard-failure-artifacts.ts";

describe("onboard failure artifact retention", () => {
  it("copies only bounded regular diagnostic files through the redacting sink (#8690)", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-failure-artifacts-"));
    const homeDir = path.join(temporaryRoot, "home");
    const outputDir = path.join(temporaryRoot, "artifacts");
    const failureDir = path.join(
      homeDir,
      ".nemoclaw",
      "onboard-failures",
      "2026-08-10T00-00-00-000Z-alpha-docker-gpu-patch",
    );
    const secretCanary = "opaque-artifact-secret";
    fs.mkdirSync(failureDir, { recursive: true });
    fs.writeFileSync(path.join(failureDir, "summary.txt"), `phase=Error ${secretCanary}\n`);
    fs.writeFileSync(path.join(failureDir, "not-allowlisted.txt"), "must not publish\n");
    fs.symlinkSync(path.join(failureDir, "summary.txt"), path.join(failureDir, "forward-list.txt"));
    fs.writeFileSync(path.join(failureDir, "docker-logs.txt"), "x".repeat(512_001));
    const staleFailureDir = path.join(
      homeDir,
      ".nemoclaw",
      "onboard-failures",
      "2026-08-09T00-00-00-000Z-alpha-docker-gpu-patch",
    );
    fs.mkdirSync(staleFailureDir, { recursive: true });
    fs.writeFileSync(path.join(staleFailureDir, "summary.txt"), "stale bundle\n");
    const artifacts = new ArtifactSink(outputDir, [secretCanary]);

    try {
      const retained = await retainOnboardFailureArtifacts({
        artifacts,
        artifactName: "phase-4-rotate-discord",
        diagnosticOutput: `  Pre-cleanup diagnostics saved: ${failureDir}\n`,
        homeDir,
        sandboxName: "alpha",
      });

      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatch(/summary\.txt$/u);
      const published = fs.readFileSync(path.join(outputDir, retained[0] ?? ""), "utf8");
      expect(published).toBe("phase=Error [REDACTED]\n");
      expect(JSON.stringify(retained)).not.toContain("forward-list.txt");
      expect(JSON.stringify(retained)).not.toContain("docker-logs.txt");
      expect(JSON.stringify(retained)).not.toContain("not-allowlisted.txt");
      expect(JSON.stringify(retained)).not.toContain(path.basename(staleFailureDir));
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("caps the current reported bundle by aggregate bytes (#8690)", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-failure-bounds-"));
    const homeDir = path.join(temporaryRoot, "home");
    const outputDir = path.join(temporaryRoot, "artifacts");
    const failureDir = path.join(
      homeDir,
      ".nemoclaw",
      "onboard-failures",
      "2026-08-10T00-00-00-000Z-alpha-docker-gpu-patch",
    );
    fs.mkdirSync(failureDir, { recursive: true });
    for (const name of [
      "docker-inspect.json",
      "docker-logs.txt",
      "docker-network-summary.txt",
      "docker-ps.txt",
      "docker-top.txt",
    ]) {
      fs.writeFileSync(path.join(failureDir, name), "x".repeat(450_000));
    }
    const artifacts = new ArtifactSink(outputDir);

    try {
      const retained = await retainOnboardFailureArtifacts({
        artifacts,
        artifactName: "phase-2-rotate-discord",
        diagnosticOutput: `Pre-rollback diagnostics saved: ${failureDir}\n`,
        homeDir,
        sandboxName: "alpha",
      });

      expect(retained).toHaveLength(4);
      const totalBytes = retained.reduce(
        (total, relativePath) => total + fs.statSync(path.join(outputDir, relativePath)).size,
        0,
      );
      expect(totalBytes).toBeLessThanOrEqual(2_000_000);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("does not read bytes appended after the file bound is established (#8690)", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-failure-append-"));
    const homeDir = path.join(temporaryRoot, "home");
    const outputDir = path.join(temporaryRoot, "artifacts");
    const failureDir = path.join(
      homeDir,
      ".nemoclaw",
      "onboard-failures",
      "2026-08-10T00-00-00-000Z-alpha-docker-gpu-patch",
    );
    const summaryPath = path.join(failureDir, "summary.txt");
    fs.mkdirSync(failureDir, { recursive: true });
    fs.writeFileSync(summaryPath, "bounded snapshot\n");
    const originalReadSync = fs.readSync.bind(fs);
    let appended = false;
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((
      ...args: Parameters<typeof fs.readSync>
    ) => {
      if (!appended) {
        fs.appendFileSync(summaryPath, "must not cross the established bound\n");
        appended = true;
      }
      return originalReadSync(...args);
    }) as typeof fs.readSync);
    const artifacts = new ArtifactSink(outputDir);

    try {
      const retained = await retainOnboardFailureArtifacts({
        artifacts,
        artifactName: "phase-4-rotate-discord",
        diagnosticOutput: `Pre-cleanup diagnostics saved: ${failureDir}\n`,
        homeDir,
        sandboxName: "alpha",
      });

      expect(retained).toHaveLength(1);
      expect(fs.readFileSync(path.join(outputDir, retained[0] ?? ""), "utf8")).toBe(
        "bounded snapshot\n",
      );
    } finally {
      readSpy.mockRestore();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
