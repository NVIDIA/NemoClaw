// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildPortableSandboxImageWithEvidence } from "../fixtures/portable-sandbox-build-diagnostics.ts";
import { startTestProgress } from "../fixtures/progress.ts";

it("records a fixed Podman failure category without build output (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-diagnostic-"));
  const progress = startTestProgress(
    "portable build diagnostics",
    ["prepare build", "build sandbox image"],
    {
      logLine: () => undefined,
    },
  );
  try {
    const artifacts = new ArtifactSink(path.join(directory, "portable-build"));
    const runBuild = vi.fn(async () => ({
      status: 1,
      signal: null,
      diagnostic: "Error: permission denied; credential=private-build-token",
    }));

    const status = await buildPortableSandboxImageWithEvidence(
      ["build", "-t", "localhost/test:fixed", "."],
      { env: { NEMOCLAW_DIAGNOSTIC_TEST: "1" }, stdio: "inherit" },
      artifacts,
      progress,
      runBuild,
    );

    expect(status).toBe(1);
    expect(runBuild).toHaveBeenCalledOnce();
    expect(runBuild).toHaveBeenCalledWith(
      ["build", "-t", "localhost/test:fixed", "."],
      {
        NEMOCLAW_DIAGNOSTIC_TEST: "1",
      },
      20 * 60_000,
      progress,
    );
    const published = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-build-failure.json"),
      "utf8",
    );
    expect(JSON.parse(published)).toEqual({
      schemaVersion: 1,
      status: 1,
      signal: null,
      errorCode: null,
      category: "permission",
    });
    expect(published).not.toContain("private-build-token");
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("retains a build signal and allowlisted error code without error text (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-diagnostic-"));
  const progress = startTestProgress(
    "portable build diagnostics",
    ["prepare build", "build sandbox image"],
    {
      logLine: () => undefined,
    },
  );
  try {
    const artifacts = new ArtifactSink(path.join(directory, "portable-build"));
    const status = await buildPortableSandboxImageWithEvidence(
      ["build", "-t", "localhost/test:fixed", "."],
      { env: {}, stdio: "inherit" },
      artifacts,
      progress,
      vi.fn(async () => ({
        status: null,
        signal: "SIGTERM" as const,
        diagnostic: "credential=private-build-token",
        error: Object.assign(new Error("private error text"), { code: "EACCES" }),
      })),
    );

    expect(status).toBeNull();
    const published = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-build-failure.json"),
      "utf8",
    );
    expect(JSON.parse(published)).toEqual({
      schemaVersion: 1,
      status: null,
      signal: "SIGTERM",
      errorCode: "EACCES",
      category: "unclassified",
    });
    expect(published).not.toContain("private-build-token");
    expect(published).not.toContain("private error text");
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
