// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { startTestProgress } from "../fixtures/progress.ts";

import { runRawCommand } from "../live/bedrock-runtime-compatible-anthropic-raw-command.ts";

const temporaryRoots: string[] = [];

function progressProbe() {
  const lines: string[] = [];
  const timers: Array<() => void> = [];
  const progress = startTestProgress(
    "Bedrock command support",
    ["run Bedrock command", "verify Bedrock result"],
    {
      clearTimer: () => undefined,
      logLine: (line) => lines.push(line),
      setTimer: (callback) => {
        timers.push(callback);
        return {};
      },
    },
  );
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

  it("bounds captured child output before redaction and artifact publication", async () => {
    const artifacts = await artifactSink("bedrock-progress-bounded-output");
    const observation = progressProbe();
    const { progress } = observation;

    const result = await runRawCommand(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.alloc(10 * 1024 * 1024 + 1, 97))"],
      {
        artifactName: "bedrock-progress-bounded-output",
        artifacts,
        progress,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[raw command output truncated at safe capture limit]");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(10 * 1024 * 1024 + 100);
    await expect(
      fs.readFile(
        path.join(artifacts.rootDir, "raw-shell/bedrock-progress-bounded-output.stdout.txt"),
        "utf8",
      ),
    ).resolves.toContain("[raw command output truncated at safe capture limit]");
    progress.stop();
  });
});
