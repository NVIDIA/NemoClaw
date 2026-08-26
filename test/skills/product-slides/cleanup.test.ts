// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { pptxCleanupTestOnly } from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/build-pptx.mts";

type FileIdentity = {
  dev: bigint;
  ino: bigint;
};

function missingPathFailure(label: string): NodeJS.ErrnoException {
  return Object.assign(new Error(label), { code: "ENOENT" });
}

function statAction(
  actions: ReadonlyMap<string, () => Promise<FileIdentity>>,
  filePath: string,
): Promise<FileIdentity> {
  return (
    actions.get(filePath) ??
    (() => Promise.reject(new Error(`Unexpected lstat path ${JSON.stringify(filePath)}`)))
  )();
}

function finalizationArtifact(label: string) {
  return {
    temporaryPath: path.join(os.tmpdir(), `nemoclaw-cleanup-${label}.temporary`),
    targetPath: path.join(os.tmpdir(), `nemoclaw-cleanup-${label}.target`),
  };
}

describe("PowerPoint private artifact cleanup", () => {
  it("reports every unresolved path and preserves the primary and cleanup failures", async () => {
    const unresolvedPaths = [
      path.join(os.tmpdir(), "nemoclaw-cleanup-output"),
      path.join(os.tmpdir(), "nemoclaw-cleanup-readback"),
    ];
    const primaryFailure = new Error("Synthetic finalization failure");
    const removalFailures = unresolvedPaths.map(
      (unresolvedPath) => new Error(`Cannot remove ${unresolvedPath}`),
    );
    const attemptedPaths: string[] = [];

    const failure = (await pptxCleanupTestOnly
      .requirePrivateCleanup({
        context: "Synthetic private cleanup failed",
        cause: primaryFailure,
        operations: unresolvedPaths.map((unresolvedPath, index) => ({
          path: unresolvedPath,
          remove: async () => {
            attemptedPaths.push(unresolvedPath);
            throw removalFailures[index];
          },
        })),
      })
      .catch((error: unknown) => error)) as Error;

    expect(failure.message).toBe(
      `Synthetic private cleanup failed. Unresolved private temporary paths: ${unresolvedPaths
        .map((unresolvedPath) => JSON.stringify(unresolvedPath))
        .join(", ")}`,
    );
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors).toEqual([primaryFailure, ...removalFailures]);
    expect(attemptedPaths).toEqual(unresolvedPaths);
  });

  it("rolls back a target before removing its temporary hard-link witness", async () => {
    const artifact = finalizationArtifact("ordered");
    const identity = { dev: 7n, ino: 11n };
    const events: string[] = [];
    const statActions = new Map<string, () => Promise<FileIdentity>>([
      [artifact.targetPath, async () => identity],
      [artifact.temporaryPath, async () => identity],
    ]);

    const failures = await pptxCleanupTestOnly.failedFinalizationCleanupFailures({
      createdArtifacts: [artifact],
      allArtifacts: [artifact],
      dependencies: {
        lstat: async (filePath) => {
          events.push(`lstat:${filePath}`);
          return statAction(statActions, filePath);
        },
        unlink: async (filePath) => {
          events.push(`unlink:${filePath}`);
        },
        removeTemporary: async (filePath) => {
          events.push(`remove:${filePath}`);
        },
      },
    });

    expect(failures).toEqual([]);
    expect(events).toEqual([
      `lstat:${artifact.targetPath}`,
      `lstat:${artifact.temporaryPath}`,
      `unlink:${artifact.targetPath}`,
      `remove:${artifact.temporaryPath}`,
    ]);
  });

  it("reports an existing target when its temporary hard-link witness is missing", async () => {
    const artifact = finalizationArtifact("missing-witness");
    const events: string[] = [];
    const statActions = new Map<string, () => Promise<FileIdentity>>([
      [artifact.targetPath, async () => ({ dev: 7n, ino: 11n })],
      [artifact.temporaryPath, async () => Promise.reject(missingPathFailure("missing witness"))],
    ]);

    const failures = await pptxCleanupTestOnly.failedFinalizationCleanupFailures({
      createdArtifacts: [artifact],
      allArtifacts: [artifact],
      dependencies: {
        lstat: async (filePath) => {
          events.push(`lstat:${filePath}`);
          return statAction(statActions, filePath);
        },
        unlink: async (filePath) => {
          events.push(`unlink:${filePath}`);
        },
        removeTemporary: async (filePath) => {
          events.push(`remove:${filePath}`);
        },
      },
    });

    expect(failures.map((failure) => failure.path)).toEqual([artifact.targetPath]);
    expect(failures.map((failure) => String(failure.reason))).toEqual([
      expect.stringContaining("Temporary hard-link witness is missing"),
    ]);
    expect(events).toEqual([
      `lstat:${artifact.targetPath}`,
      `lstat:${artifact.temporaryPath}`,
      `remove:${artifact.temporaryPath}`,
    ]);
  });

  it("preserves and reports a target that no longer matches its temporary hard link", async () => {
    const artifact = finalizationArtifact("swapped-target");
    const events: string[] = [];
    const statActions = new Map<string, () => Promise<FileIdentity>>([
      [artifact.targetPath, async () => ({ dev: 7n, ino: 12n })],
      [artifact.temporaryPath, async () => ({ dev: 7n, ino: 11n })],
    ]);

    const failures = await pptxCleanupTestOnly.failedFinalizationCleanupFailures({
      createdArtifacts: [artifact],
      allArtifacts: [artifact],
      dependencies: {
        lstat: async (filePath) => {
          events.push(`lstat:${filePath}`);
          return statAction(statActions, filePath);
        },
        unlink: async (filePath) => {
          events.push(`unlink:${filePath}`);
        },
        removeTemporary: async (filePath) => {
          events.push(`remove:${filePath}`);
        },
      },
    });

    expect(failures.map((failure) => failure.path)).toEqual([artifact.targetPath]);
    expect(failures.map((failure) => String(failure.reason))).toEqual([
      expect.stringContaining("no longer matches its invocation-created hard link"),
    ]);
    expect(events).toEqual([
      `lstat:${artifact.targetPath}`,
      `lstat:${artifact.temporaryPath}`,
      `remove:${artifact.temporaryPath}`,
    ]);
  });

  it("treats only an absent target as already rolled back", async () => {
    const artifact = finalizationArtifact("missing-target");
    const events: string[] = [];
    const statActions = new Map<string, () => Promise<FileIdentity>>([
      [artifact.targetPath, async () => Promise.reject(missingPathFailure("missing target"))],
      [
        artifact.temporaryPath,
        async () => Promise.reject(new Error("Temporary witness must not be inspected")),
      ],
    ]);

    const failures = await pptxCleanupTestOnly.failedFinalizationCleanupFailures({
      createdArtifacts: [artifact],
      allArtifacts: [artifact],
      dependencies: {
        lstat: async (filePath) => {
          events.push(`lstat:${filePath}`);
          return statAction(statActions, filePath);
        },
        unlink: async (filePath) => {
          events.push(`unlink:${filePath}`);
        },
        removeTemporary: async (filePath) => {
          events.push(`remove:${filePath}`);
        },
      },
    });

    expect(failures).toEqual([]);
    expect(events).toEqual([`lstat:${artifact.targetPath}`, `remove:${artifact.temporaryPath}`]);
  });
});
