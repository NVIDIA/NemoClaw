// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  finalizePptxArtifacts,
  pptxCleanupTestOnly,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/build-pptx.mts";
import { prepareProtectedOutputBoundary } from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/protected-output.mts";

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

const finalizationRoot = fsSync.mkdtempSync(
  path.join(os.tmpdir(), "nemoclaw-pptx-cleanup-contract-"),
);
fsSync.chmodSync(finalizationRoot, 0o700);

afterAll(() => {
  fsSync.rmSync(finalizationRoot, { recursive: true, force: true });
});

function finalizationArtifact(label: string) {
  const targetPath = path.join(finalizationRoot, `nemoclaw-cleanup-${label}.target`);
  return {
    boundary: prepareProtectedOutputBoundary(targetPath, "Synthetic PowerPoint output"),
    temporaryPath: path.join(finalizationRoot, `nemoclaw-cleanup-${label}.temporary`),
    targetPath,
  };
}

describe("PowerPoint private artifact cleanup", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "routes %s through the invocation cancellation controller",
    (signal) => {
      const source = new EventEmitter();
      const cancellation = pptxCleanupTestOnly.createPptxCancellationController();
      const removeHandlers = pptxCleanupTestOnly.installPptxCancellationSignalHandlers(
        cancellation,
        source,
      );

      source.emit(signal);

      expect(() => cancellation.throwIfRequested("Synthetic PowerPoint build")).toThrow(
        `Synthetic PowerPoint build interrupted by ${signal}. Partial target paths: none. Unresolved paths: none`,
      );
      removeHandlers();
      expect(source.listenerCount("SIGINT")).toBe(0);
      expect(source.listenerCount("SIGTERM")).toBe(0);
    },
  );

  it("stops an active child before removing its private authoring surface after cancellation", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-cancel-child-"));
    const skillDir = path.join(temp, "presentation-skill");
    const surfaceDirectory = path.join(temp, "authoring-surface");
    const markerDirectory = path.join(skillDir, "container_tools");
    const childReadyPath = path.join(surfaceDirectory, "child-ready");
    await fs.mkdir(markerDirectory, { recursive: true });
    await fs.mkdir(surfaceDirectory);
    await fs.writeFile(
      path.join(markerDirectory, "mark_artifact_operation_started.mjs"),
      [
        'import fs from "node:fs";',
        'process.on("SIGTERM", () => {});',
        'fs.writeFileSync(`${process.env.NEMOCLAW_PPTX_AUTHORING_DIR}/child-ready`, "ready");',
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
    );
    const cancellation = pptxCleanupTestOnly.createPptxCancellationController({
      forceKillAfterMs: 25,
    });
    try {
      const execution = pptxCleanupTestOnly.authorPowerPointWithTemporaryModule({
        runtime: {
          runtimeNode: process.execPath,
          runtimeNodeModules: temp,
          runtimeBinDir: temp,
          skillDir,
          tmpDir: temp,
        },
        workflow: {
          workspace: temp,
          frameMap: path.join(temp, "frame-map.json"),
          inspect: path.join(temp, "inspect.ndjson"),
          inspectManifest: path.join(temp, "manifest.json"),
          audit: path.join(temp, "audit.txt"),
          deviationLog: path.join(temp, "deviation.txt"),
          starterPptx: path.join(temp, "starter.pptx"),
          starterPreviewDir: path.join(temp, "starter-preview"),
          starterLayoutDir: path.join(temp, "starter-layout"),
          finalLayoutDir: path.join(temp, "final-layout"),
        },
        surface: {
          directory: surfaceDirectory,
          modulePath: path.join(surfaceDirectory, "authoring.mjs"),
        },
        frozenInputs: {
          templatePath: path.join(temp, "template.pptx"),
          modelPath: path.join(temp, "model.json"),
          roleMapPath: path.join(temp, "role-map.json"),
          frameMapPath: path.join(temp, "frame-map.json"),
          inspectPath: path.join(temp, "inspect.ndjson"),
        },
        cancellation,
      });
      await vi.waitFor(() => fs.lstat(childReadyPath), { timeout: 1_000, interval: 10 });

      cancellation.request("SIGTERM");
      const failure = (await execution.catch((error: unknown) => error)) as Error;

      expect(failure.message).toBe(
        "PowerPoint build during presentation runtime execution interrupted by SIGTERM. Partial target paths: none. Unresolved paths: none",
      );
      await expect(fs.lstat(surfaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "confirms a terminating runtime process group has no signal-ignoring descendant before cleanup",
    async () => {
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-cancel-tree-"));
      const parentScriptPath = path.join(temp, "runtime-parent.mjs");
      const descendantPidPath = path.join(temp, "descendant.pid");
      const descendantReadyPath = path.join(temp, "descendant.ready");
      const privatePath = path.join(temp, "private-authoring-surface");
      let descendantPid: number | undefined;
      await fs.mkdir(privatePath);
      await fs.writeFile(
        parentScriptPath,
        [
          'import { spawn } from "node:child_process";',
          'import fs from "node:fs";',
          "const descendantSource = [",
          "  'import fs from \"node:fs\";',",
          "  'process.on(\"SIGTERM\", () => {});',",
          "  'fs.writeFileSync(process.env.DESCENDANT_READY, \"ready\");',",
          "  'setInterval(() => {}, 1_000);',",
          '].join("\\n");',
          "const descendant = spawn(process.execPath, ['-e', descendantSource], {",
          "  env: process.env,",
          "  stdio: 'ignore',",
          "});",
          "fs.writeFileSync(process.env.DESCENDANT_PID, String(descendant.pid));",
          "setInterval(() => {}, 1_000);",
        ].join("\n"),
      );
      const cancellation = pptxCleanupTestOnly.createPptxCancellationController({
        forceKillAfterMs: 25,
      });
      try {
        const execution = pptxCleanupTestOnly.runRuntimeProcess(
          process.execPath,
          [parentScriptPath],
          {
            ...process.env,
            DESCENDANT_PID: descendantPidPath,
            DESCENDANT_READY: descendantReadyPath,
          },
          cancellation,
        );
        await vi.waitFor(() => fs.lstat(descendantReadyPath), { timeout: 1_000, interval: 10 });
        descendantPid = Number(await fs.readFile(descendantPidPath, "utf8"));
        expect(Number.isInteger(descendantPid)).toBe(true);

        cancellation.request("SIGTERM");
        const cancellationFailure = (await execution.catch((error: unknown) => error)) as Error & {
          childMayBeActive: boolean;
        };
        expect(cancellationFailure.name).toBe("PptxCancellationError");
        expect(cancellationFailure.childMayBeActive).toBe(false);
        await expect(
          pptxCleanupTestOnly.requirePrivateCleanup({
            context: "Synthetic process-tree cleanup",
            cause: cancellationFailure,
            operations: [
              {
                path: privatePath,
                remove: () => fs.rm(privatePath, { recursive: true, force: true }),
              },
            ],
          }),
        ).resolves.toBeUndefined();
        await expect(fs.lstat(privatePath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(() => process.kill(descendantPid as number, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        try {
          descendantPid === undefined || process.kill(descendantPid, "SIGKILL");
        } catch (error) {
          expect(error).toMatchObject({ code: "ESRCH" });
        }
        await fs.rm(temp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "terminates a live descendant before cleanup when its runtime leader exits normally",
    async () => {
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-normal-exit-tree-"));
      const parentScriptPath = path.join(temp, "runtime-parent.mjs");
      const descendantPidPath = path.join(temp, "descendant.pid");
      const descendantReadyPath = path.join(temp, "descendant.ready");
      const privatePath = path.join(temp, "private-authoring-surface");
      let descendantPid: number | undefined;
      await fs.mkdir(privatePath);
      await fs.writeFile(
        parentScriptPath,
        [
          'import { spawn } from "node:child_process";',
          'import fs from "node:fs";',
          "const descendantSource = [",
          "  'import fs from \"node:fs\";',",
          "  'process.on(\"SIGTERM\", () => {});',",
          "  'fs.writeFileSync(process.env.DESCENDANT_READY, \"ready\");',",
          "  'setInterval(() => {}, 1_000);',",
          '].join("\\n");',
          "const descendant = spawn(process.execPath, ['-e', descendantSource], {",
          "  env: process.env,",
          "  stdio: 'ignore',",
          "});",
          "descendant.unref();",
          "fs.writeFileSync(process.env.DESCENDANT_PID, String(descendant.pid));",
          "const readiness = setInterval(() => {",
          "  fs.existsSync(process.env.DESCENDANT_READY) &&",
          "    (clearInterval(readiness), process.exit(0));",
          "}, 5);",
        ].join("\n"),
      );
      const cancellation = pptxCleanupTestOnly.createPptxCancellationController({
        forceKillAfterMs: 25,
      });
      try {
        const execution = pptxCleanupTestOnly
          .runRuntimeProcess(
            process.execPath,
            [parentScriptPath],
            {
              ...process.env,
              DESCENDANT_PID: descendantPidPath,
              DESCENDANT_READY: descendantReadyPath,
            },
            cancellation,
          )
          .catch((error: unknown) => error);
        const failure = (await execution) as Error & {
          childMayBeActive: boolean;
        };
        descendantPid = Number(await fs.readFile(descendantPidPath, "utf8"));

        expect(failure.name).toBe("PptxCancellationError");
        expect(failure.childMayBeActive).toBe(false);
        expect(failure.cause).toEqual(
          expect.objectContaining({
            message: "Presentation runtime leader exited while descendants remained active",
          }),
        );
        await expect(
          pptxCleanupTestOnly.requirePrivateCleanup({
            context: "Synthetic normal-exit process-tree cleanup",
            cause: failure,
            operations: [
              {
                path: privatePath,
                remove: () => fs.rm(privatePath, { recursive: true, force: true }),
              },
            ],
          }),
        ).resolves.toBeUndefined();
        await expect(fs.lstat(privatePath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(() => process.kill(descendantPid as number, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        try {
          descendantPid === undefined || process.kill(descendantPid, "SIGKILL");
        } catch (error) {
          expect(error).toMatchObject({ code: "ESRCH" });
        }
        await fs.rm(temp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a standalone wrapper alive until a normally orphaned runtime descendant is terminated",
    () => {
      const temp = fsSync.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wrapper-tree-"));
      const parentScriptPath = path.join(temp, "runtime-parent.mjs");
      const descendantPidPath = path.join(temp, "descendant.pid");
      const descendantReadyPath = path.join(temp, "descendant.ready");
      const descendantSignalPath = path.join(temp, "descendant.signal");
      const wrapperCompletePath = path.join(temp, "wrapper.complete");
      let descendantPid: number | undefined;
      try {
        fsSync.writeFileSync(
          parentScriptPath,
          [
            'import { spawn } from "node:child_process";',
            'import fs from "node:fs";',
            "const descendantSource = [",
            "  'import fs from \"node:fs\";',",
            '  \'process.on("SIGTERM", () => fs.writeFileSync(process.env.DESCENDANT_SIGNAL, "SIGTERM"));\',',
            "  'fs.writeFileSync(process.env.DESCENDANT_READY, \"ready\");',",
            "  'setInterval(() => {}, 1_000);',",
            '].join("\\n");',
            "const descendant = spawn(process.execPath, ['-e', descendantSource], {",
            "  env: process.env,",
            "  stdio: 'ignore',",
            "});",
            "descendant.unref();",
            "fs.writeFileSync(process.env.DESCENDANT_PID, String(descendant.pid));",
            "const readiness = setInterval(() => {",
            "  fs.existsSync(process.env.DESCENDANT_READY) &&",
            "    (clearInterval(readiness), process.exit(0));",
            "}, 5);",
          ].join("\n"),
        );
        const buildModuleUrl = pathToFileURL(
          path.resolve(".agents/skills/nemoclaw-maintainer-product-slides/scripts/build-pptx.mts"),
        ).href;
        const wrapperSource = [
          'import assert from "node:assert/strict";',
          'import fs from "node:fs";',
          `import { pptxCleanupTestOnly } from ${JSON.stringify(buildModuleUrl)};`,
          "const cancellation = pptxCleanupTestOnly.createPptxCancellationController({ forceKillAfterMs: 75 });",
          "const failure = await pptxCleanupTestOnly.runRuntimeProcess(",
          "  process.execPath,",
          "  [process.env.RUNTIME_PARENT],",
          "  process.env,",
          "  cancellation,",
          ").then(() => new Error('runtime unexpectedly succeeded'), (error) => error);",
          "assert.equal(failure.name, 'PptxCancellationError');",
          "assert.equal(failure.childMayBeActive, false);",
          "const descendantPid = Number(fs.readFileSync(process.env.DESCENDANT_PID, 'utf8'));",
          "assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });",
          "assert.equal(fs.readFileSync(process.env.DESCENDANT_SIGNAL, 'utf8'), 'SIGTERM');",
          "fs.writeFileSync(process.env.WRAPPER_COMPLETE, 'complete');",
        ].join("\n");
        const result = spawnSync(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "--eval", wrapperSource],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
              ...process.env,
              DESCENDANT_PID: descendantPidPath,
              DESCENDANT_READY: descendantReadyPath,
              DESCENDANT_SIGNAL: descendantSignalPath,
              RUNTIME_PARENT: parentScriptPath,
              WRAPPER_COMPLETE: wrapperCompletePath,
            },
            timeout: 5_000,
          },
        );
        descendantPid = Number(fsSync.readFileSync(descendantPidPath, "utf8"));

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.signal).toBeNull();
        expect(fsSync.readFileSync(descendantSignalPath, "utf8")).toBe("SIGTERM");
        expect(fsSync.readFileSync(wrapperCompletePath, "utf8")).toBe("complete");
        expect(() => process.kill(descendantPid as number, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        try {
          descendantPid === undefined || process.kill(descendantPid, "SIGKILL");
        } catch (error) {
          expect(error).toMatchObject({ code: "ESRCH" });
        }
        fsSync.rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it("rolls back a partial target only when its hard-link witness matches after cancellation", async () => {
    const output = finalizationArtifact("cancel-matching-output");
    const readback = finalizationArtifact("cancel-matching-readback");
    const identity = { dev: 7n, ino: 11n };
    const events: string[] = [];
    const cancellation = pptxCleanupTestOnly.createPptxCancellationController();

    const failure = (await finalizePptxArtifacts({
      temporaryOutputPath: output.temporaryPath,
      outputPath: output.targetPath,
      temporaryReadbackPath: readback.temporaryPath,
      readbackPath: readback.targetPath,
      mode: "preview",
      cancellation,
      dependencies: {
        link: async (temporaryPath, targetPath) => {
          events.push(`link:${temporaryPath}:${targetPath}`);
          cancellation.request("SIGINT");
        },
        lstat: async (filePath) => {
          events.push(`lstat:${filePath}`);
          return identity;
        },
        unlink: async (filePath) => {
          events.push(`unlink:${filePath}`);
        },
        removeTemporary: async (filePath) => {
          events.push(`remove:${filePath}`);
        },
      },
    }).catch((error: unknown) => error)) as Error;

    expect(failure.message).toBe(
      `PowerPoint preview finalization interrupted by SIGINT. Partial target paths: ${JSON.stringify(readback.targetPath)}. Unresolved paths: none`,
    );
    expect(events).toEqual([
      `link:${readback.temporaryPath}:${readback.targetPath}`,
      `lstat:${readback.targetPath}`,
      `lstat:${readback.temporaryPath}`,
      `unlink:${readback.targetPath}`,
      `remove:${output.temporaryPath}`,
      `remove:${readback.temporaryPath}`,
    ]);
  });

  it("does not run private cleanup while failed termination may leave a child active", async () => {
    vi.useFakeTimers();
    try {
      const killSignals: NodeJS.Signals[] = [];
      const child = new EventEmitter() as EventEmitter & {
        kill: (signal: NodeJS.Signals) => boolean;
        unref: () => void;
      };
      let unrefCalls = 0;
      child.kill = (signal) => {
        killSignals.push(signal);
        child.emit("error", new Error(`Synthetic ${signal} failure`));
        return false;
      };
      child.unref = () => {
        unrefCalls += 1;
      };
      const cancellation = pptxCleanupTestOnly.createPptxCancellationController({
        forceKillAfterMs: 25,
      });
      let runtimeSettled = false;
      const execution = pptxCleanupTestOnly
        .runRuntimeProcess("synthetic-runtime", [], {}, cancellation, {
          spawn: () => child as unknown as ChildProcess,
        })
        .catch((error: unknown) => error)
        .finally(() => {
          runtimeSettled = true;
        });

      cancellation.request("SIGTERM");
      await Promise.resolve();
      expect(runtimeSettled).toBe(false);
      expect(killSignals).toEqual(["SIGTERM"]);

      await vi.advanceTimersByTimeAsync(25);
      expect(runtimeSettled).toBe(false);
      expect(killSignals).toEqual(["SIGTERM", "SIGKILL"]);

      await vi.advanceTimersByTimeAsync(25);
      const cancellationFailure = (await execution) as Error & {
        childMayBeActive: boolean;
      };
      expect(cancellationFailure.name).toBe("PptxCancellationError");
      expect(cancellationFailure.childMayBeActive).toBe(true);
      expect(unrefCalls).toBe(1);

      const privatePath = path.join(os.tmpdir(), "nemoclaw-active-child-private-surface");
      let cleanupRan = false;
      const cleanupFailure = (await pptxCleanupTestOnly
        .requirePrivateCleanup({
          context: "Synthetic cleanup must wait for the active child",
          cause: cancellationFailure,
          operations: [
            {
              path: privatePath,
              remove: async () => {
                cleanupRan = true;
              },
            },
          ],
        })
        .catch((error: unknown) => error)) as Error & {
        signal: NodeJS.Signals;
        unresolvedPaths: string[];
      };

      expect(cleanupRan).toBe(false);
      expect(cleanupFailure.name).toBe("PptxCancellationError");
      expect(cleanupFailure.signal).toBe("SIGTERM");
      expect(cleanupFailure.unresolvedPaths).toEqual([privatePath]);
      expect(pptxCleanupTestOnly.pptxProcessExitCode(cleanupFailure)).toBe(143);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves and reports a partial target when cancellation finds a different witness", async () => {
    const output = finalizationArtifact("cancel-mismatch-output");
    const readback = finalizationArtifact("cancel-mismatch-readback");
    const events: string[] = [];
    const cancellation = pptxCleanupTestOnly.createPptxCancellationController();

    const failure = (await finalizePptxArtifacts({
      temporaryOutputPath: output.temporaryPath,
      outputPath: output.targetPath,
      temporaryReadbackPath: readback.temporaryPath,
      readbackPath: readback.targetPath,
      mode: "publish",
      cancellation,
      dependencies: {
        link: async (temporaryPath, targetPath) => {
          events.push(`link:${temporaryPath}:${targetPath}`);
          cancellation.request("SIGTERM");
        },
        lstat: async (filePath) => {
          events.push(`lstat:${filePath}`);
          return filePath === readback.targetPath ? { dev: 7n, ino: 12n } : { dev: 7n, ino: 11n };
        },
        unlink: async (filePath) => {
          events.push(`unlink:${filePath}`);
        },
        removeTemporary: async (filePath) => {
          events.push(`remove:${filePath}`);
        },
      },
    }).catch((error: unknown) => error)) as Error;

    expect(failure.message).toBe(
      `PowerPoint publish finalization interrupted by SIGTERM. Partial target paths: ${JSON.stringify(readback.targetPath)}. Unresolved paths: ${JSON.stringify(readback.targetPath)}`,
    );
    expect(events).toEqual([
      `link:${readback.temporaryPath}:${readback.targetPath}`,
      `lstat:${readback.targetPath}`,
      `lstat:${readback.temporaryPath}`,
      `remove:${output.temporaryPath}`,
      `remove:${readback.temporaryPath}`,
    ]);
  });

  it("preserves cancellation diagnostics when private cleanup also fails", async () => {
    const output = finalizationArtifact("compound-output");
    const readback = finalizationArtifact("compound-readback");
    const privatePath = path.join(os.tmpdir(), "nemoclaw-compound-private-surface");
    const cancellation = pptxCleanupTestOnly.createPptxCancellationController();
    const finalizationFailure = await finalizePptxArtifacts({
      temporaryOutputPath: output.temporaryPath,
      outputPath: output.targetPath,
      temporaryReadbackPath: readback.temporaryPath,
      readbackPath: readback.targetPath,
      mode: "preview",
      cancellation,
      dependencies: {
        link: async () => {
          cancellation.request("SIGINT");
        },
        lstat: async (filePath) =>
          filePath === readback.targetPath ? { dev: 7n, ino: 12n } : { dev: 7n, ino: 11n },
        unlink: async () => {},
        removeTemporary: async () => {},
      },
    }).catch((error: unknown) => error);

    const failure = (await pptxCleanupTestOnly
      .requirePrivateCleanup({
        context: "Synthetic cancellation cleanup failed",
        cause: finalizationFailure,
        operations: [
          {
            path: privatePath,
            remove: async () => {
              throw new Error("Synthetic private cleanup failure");
            },
          },
        ],
      })
      .catch((error: unknown) => error)) as Error & {
      partialTargetPaths: string[];
      signal: NodeJS.Signals;
      unresolvedPaths: string[];
    };

    expect(failure.name).toBe("PptxCancellationError");
    expect(failure.signal).toBe("SIGINT");
    expect(failure.partialTargetPaths).toEqual([readback.targetPath]);
    expect(failure.unresolvedPaths).toEqual([readback.targetPath, privatePath]);
    expect(failure.message).toBe(
      `PowerPoint preview finalization interrupted by SIGINT. Partial target paths: ${JSON.stringify(readback.targetPath)}. Unresolved paths: ${JSON.stringify(readback.targetPath)}, ${JSON.stringify(privatePath)}`,
    );
    expect(pptxCleanupTestOnly.pptxProcessExitCode(failure)).toBe(130);
  });

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
