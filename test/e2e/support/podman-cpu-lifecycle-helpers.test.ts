// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { startTestProgress, type TestProgress } from "../fixtures/progress.ts";
import { ShellProbe } from "../fixtures/shell-probe.ts";
import { runCommand, startPinnedGateway } from "../live/podman-cpu-lifecycle-helpers.ts";

const PHASES = ["exercise the Podman lifecycle helper", "verify helper cleanup"] as const;

function testProgress(logLines: string[]): TestProgress {
  return startTestProgress("Podman CPU lifecycle helper", PHASES, {
    logLine: (line) => logLines.push(line),
  });
}

async function processId(pathname: string): Promise<number | null> {
  try {
    const pid = Number.parseInt(await fs.readFile(pathname, "utf8"), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    switch ((error as NodeJS.ErrnoException).code) {
      case "ENOENT":
        return null;
      default:
        throw error;
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    switch ((error as NodeJS.ErrnoException).code) {
      case "ESRCH":
        return false;
      default:
        throw error;
    }
  }
}

function killProcessIfAlive(pid: number | null): void {
  switch (pid !== null && processIsAlive(pid)) {
    case true:
      process.kill(pid as number, "SIGKILL");
  }
}

describe("Podman CPU lifecycle helper", () => {
  test("reports CLI child lifecycle through the canonical ShellProbe boundary (#8497)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-podman-command-test-"));
    const logLines: string[] = [];
    const progress = testProgress(logLines);
    try {
      const shellProbe = new ShellProbe({
        artifacts: new ArtifactSink(path.join(root, "artifacts")),
        progress,
        redact: (text) => text,
        signal: new AbortController().signal,
      });

      const stdout = await runCommand(
        shellProbe,
        process.execPath,
        ["-e", 'process.stdout.write("podman-command-ok")'],
        { artifactName: "podman-command-progress", timeoutMs: 10_000 },
      );
      progress.phase(PHASES[1]);

      expect(stdout).toBe("podman-command-ok");
      expect(logLines).toEqual(
        expect.arrayContaining([
          expect.stringContaining("child lifecycle 1: started"),
          expect.stringContaining("child lifecycle 1: exited-zero"),
        ]),
      );
      expect(progress.summary().phases[0]?.outputEvents).toBeGreaterThan(0);
    } finally {
      progress.stop();
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  test("rejects a timed-out command even when SIGTERM produces exit zero (#8497)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-podman-timeout-test-"));
    const progress = testProgress([]);
    try {
      const shellProbe = new ShellProbe({
        artifacts: new ArtifactSink(path.join(root, "artifacts")),
        progress,
        redact: (text) => text,
        signal: new AbortController().signal,
      });

      await expect(
        runCommand(
          shellProbe,
          process.execPath,
          [
            "-e",
            'process.on("SIGTERM", () => process.exit(0)); setInterval(() => undefined, 1_000);',
          ],
          { artifactName: "podman-command-timeout", timeoutMs: 1_000 },
        ),
      ).rejects.toThrow("timed out true");
      const result = JSON.parse(
        await fs.readFile(
          path.join(root, "artifacts", "shell", "podman-command-timeout.result.json"),
          "utf8",
        ),
      ) as { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean };
      expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: true });
      progress.phase(PHASES[1]);
    } finally {
      progress.stop();
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  test("escalates a rejected gateway child to SIGKILL before returning (#8497)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-podman-gateway-test-"));
    const artifactDir = path.join(root, "artifacts");
    const bootstrapPath = path.join(root, "gateway-bootstrap.cjs");
    const pidPath = path.join(root, "gateway.pid");
    const progress = testProgress([]);
    const nativeSetTimeout = globalThis.setTimeout;
    const timerSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((callback, delay, ...args) =>
        nativeSetTimeout(callback, delay === 5_000 ? 25 : delay, ...args)) as typeof setTimeout);
    await fs.writeFile(
      bootstrapPath,
      [
        'const fs = require("node:fs");',
        "fs.writeFileSync(process.env.TEST_GATEWAY_PID_PATH, String(process.pid));",
        'process.on("SIGTERM", () => undefined);',
        'process.stdout.write("configuration error\\nOPENAI_API_KEY=nvapi-gateway-secret\\n");',
        "setInterval(() => undefined, 1_000);",
      ].join("\n"),
      "utf8",
    );

    try {
      const rejected = startPinnedGateway(
        process.execPath,
        {
          NODE_OPTIONS: `--require=${bootstrapPath}`,
          TEST_GATEWAY_PID_PATH: pidPath,
        },
        progress,
        artifactDir,
      );
      await expect(rejected).rejects.toThrow("rejected the Podman configuration");
      await expect(rejected).rejects.not.toThrow("nvapi-gateway-secret");

      const gatewayArtifact = await fs.readFile(
        path.join(artifactDir, "openshell-podman-gateway.log"),
        "utf8",
      );
      expect(gatewayArtifact).toContain("<REDACTED>");
      expect(gatewayArtifact).not.toContain("nvapi-gateway-secret");
      expect(gatewayArtifact.length).toBeLessThanOrEqual(32 * 1024);

      const pid = await processId(pidPath);
      expect(pid).not.toBeNull();
      expect(processIsAlive(pid as number)).toBe(false);
      progress.phase(PHASES[1]);
    } finally {
      timerSpy.mockRestore();
      killProcessIfAlive(await processId(pidPath));
      progress.stop();
      await fs.rm(root, { force: true, recursive: true });
    }
  }, 15_000);
});
