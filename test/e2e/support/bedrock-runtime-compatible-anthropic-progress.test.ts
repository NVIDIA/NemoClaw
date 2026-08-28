// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { startTestProgress } from "../fixtures/progress.ts";

import { SNAPSHOT_DATA_PREFIX } from "../live/bedrock-runtime-compatible-anthropic-leaks.ts";
import { runRawCommand } from "../live/bedrock-runtime-compatible-anthropic-raw-command.ts";

const temporaryRoots: string[] = [];

function progressProbe() {
  const lines: string[] = [];
  const timers: Array<() => void> = [];
  let clockMs = 0;
  const progress = startTestProgress(
    "Bedrock command support",
    ["run Bedrock command", "verify Bedrock result"],
    {
      clearTimer: () => undefined,
      logLine: (line) => lines.push(line),
      now: () => clockMs,
      setTimer: (callback, delayMs) => {
        timers.push(() => {
          clockMs += delayMs;
          callback();
        });
        return {};
      },
    },
  );
  onTestFinished(() => progress.stop());
  return { lines, progress, timers };
}

async function artifactSink(name: string): Promise<ArtifactSink> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `nemoclaw-${name}-`));
  temporaryRoots.push(root);
  const artifacts = new ArtifactSink(root);
  await artifacts.ensureRoot();
  return artifacts;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("Bedrock raw-command progress", () => {
  it("reports timestamp-only output activity without forwarding child payloads", async () => {
    const secret = "opaque-bedrock-progress-secret";
    const artifacts = await artifactSink("bedrock-progress-output");
    const observation = progressProbe();
    const { progress } = observation;

    const result = await runRawCommand(
      process.execPath,
      [
        "-e",
        "process.stdout.write(process.env.BEDROCK_TEST_SECRET); process.stderr.write('stderr-ready')",
      ],
      {
        artifactName: "bedrock-progress-output",
        artifacts,
        env: { ...process.env, BEDROCK_TEST_SECRET: secret },
        progress,
        redactionValues: [secret],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(secret);
    observation.timers[0]?.();
    expect(observation.lines.at(-1)).toContain("no active command");
    expect(observation.lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("event: command bedrock-progress-output started"),
        expect.stringContaining("event: command bedrock-progress-output passed"),
      ]),
    );
    progress.stop();
    expect(progress.summary().phases[0]?.outputEvents).toBe(2);
    expect(JSON.stringify({ lines: observation.lines, summary: progress.summary() })).not.toContain(
      secret,
    );
    await expect(
      fs.readFile(
        path.join(artifacts.rootDir, "raw-shell/bedrock-progress-output.stdout.txt"),
        "utf8",
      ),
    ).resolves.toBe("[REDACTED]");
  });

  it("emits an immediate content-free timeout event and closes command activity", async () => {
    const artifacts = await artifactSink("bedrock-progress-timeout");
    const observation = progressProbe();
    const { progress } = observation;

    const result = await runRawCommand(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1_000)"],
      {
        artifactName: "bedrock-progress-timeout",
        artifacts,
        progress,
        timeoutMs: 50,
      },
    );

    expect(result.timedOut).toBe(true);
    expect(observation.lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("event: command bedrock-progress-timeout started"),
        expect.stringContaining("event: command bedrock-progress-timeout timeout fired after 50ms"),
        expect.stringContaining("event: command bedrock-progress-timeout stopped after timeout"),
      ]),
    );
    observation.timers[0]?.();
    expect(observation.lines.at(-1)).toContain("no active command");
    progress.stop();
  });

  it("fails closed when command output exceeds the bounded capture limit (#7101)", async () => {
    const secret = "opaque-bedrock-capture-limit-secret";
    const artifacts = await artifactSink("bedrock-progress-output-limit");
    const observation = progressProbe();

    await expect(
      runRawCommand(
        process.execPath,
        ["-e", `process.stdout.write(${JSON.stringify(secret)}.repeat(400_000))`],
        {
          artifactName: "bedrock-progress-output-limit",
          artifacts,
          progress: observation.progress,
          redactionValues: [secret],
        },
      ),
    ).rejects.toThrow("output exceeded safe capture limit");

    expect(observation.lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "event: command bedrock-progress-output-limit output exceeded safe capture limit",
        ),
      ]),
    );
    expect(observation.lines.join("\n")).not.toContain(secret);
    const marker = "[bedrock raw-command output exceeded safe capture limit]";
    await expect(
      fs.readFile(
        path.join(artifacts.rootDir, "raw-shell/bedrock-progress-output-limit.stdout.txt"),
        "utf8",
      ),
    ).resolves.toBe(marker);
    const resultArtifact = JSON.parse(
      await fs.readFile(
        path.join(artifacts.rootDir, "raw-shell/bedrock-progress-output-limit.result.json"),
        "utf8",
      ),
    );
    expect(resultArtifact).toMatchObject({
      captureLimitExceeded: true,
      stdout: marker,
      stderr: marker,
    });
    expect(JSON.stringify(resultArtifact)).not.toContain(secret);
  });

  it("captures null-heavy snapshot framing within the bounded output limit (#7101)", async () => {
    const artifacts = await artifactSink("bedrock-progress-compact-snapshot");
    const observation = progressProbe();
    const record = `${SNAPSHOT_DATA_PREFIX}\n`;
    const recordCount = 500_000;
    const expectedBytes = Buffer.byteLength(record) * recordCount;

    const result = await runRawCommand(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(record)}.repeat(${recordCount}))`],
      {
        artifactName: "bedrock-progress-compact-snapshot",
        artifactOutputMode: "metadata-only",
        artifacts,
        progress: observation.progress,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBe(expectedBytes);
    expect(expectedBytes).toBeLessThan(10 * 1024 * 1024);
    await expect(
      fs.readFile(
        path.join(artifacts.rootDir, "raw-shell/bedrock-progress-compact-snapshot.stdout.txt"),
        "utf8",
      ),
    ).resolves.toBe(
      `${JSON.stringify({
        stream: "stdout",
        capturedBytes: expectedBytes,
        capturedLines: recordCount + 1,
        content: "omitted: inspected in memory only",
      })}\n`,
    );
  });
});
