// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  finalizeSparkExpressEvidence,
  readSparkExpressEvidenceTimeline,
  renderSparkExpressEvidenceReplay,
  SPARK_EXPRESS_EVIDENCE_SCENARIO,
  SPARK_EXPRESS_EVIDENCE_TARGET,
  sanitizedSparkExpressProgressEvent,
} from "../../../tools/e2e/spark-express-video-evidence.mts";

const TOOL_PATH = path.resolve("tools/e2e/spark-express-video-evidence.mts");
const PREFIX =
  `[e2e target=${JSON.stringify(SPARK_EXPRESS_EVIDENCE_TARGET)} ` +
  `scenario=${JSON.stringify(SPARK_EXPRESS_EVIDENCE_SCENARIO)}]`;

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spark-express-video-evidence-"));
}

function phaseStarted(phase: number, label: string): string {
  return `${PREFIX} [phase ${phase}/5] started: ${label} (total 0s; phase 0s)`;
}

function timelineLine(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

describe("Spark Express video evidence", () => {
  it("maps only the exact Spark Express semantic progress boundary", () => {
    expect(
      sanitizedSparkExpressProgressEvent(
        phaseStarted(
          2,
          "select Spark Express option 2 and onboard through the local-model profile",
        ),
        1_250,
      ),
    ).toEqual({ version: 1, atMs: 1_250, type: "phase-started", phase: 2 });
    expect(
      sanitizedSparkExpressProgressEvent(
        `${PREFIX} [phase 2/5] completed: select Spark Express option 2 and onboard through the local-model profile — passed in 4m (total 4m)`,
        240_000,
      ),
    ).toEqual({
      version: 1,
      atMs: 240_000,
      type: "phase-completed",
      phase: 2,
      outcome: "passed",
    });
  });

  it.each([
    "NVIDIA_INFERENCE_API_KEY=nvapi-private-value",
    "RUNNER_NAME=internal-spark-host",
    `${PREFIX} [phase 2/5] event: token=private-value (total 2s; phase 2s)`,
    `${PREFIX.replace("spark-express-vllm", "other-target")} [phase 1/5] started: qualify the physical DGX Spark host (total 0s; phase 0s)`,
    `\u001b[31m${phaseStarted(1, "qualify the physical DGX Spark host")}`,
    phaseStarted(1, "unexpected phase content"),
  ])("drops non-allowlisted or control-bearing input: %s", (line) => {
    expect(sanitizedSparkExpressProgressEvent(line, 10)).toBeNull();
  });

  it("records live timing without copying input content into the timeline", () => {
    const root = temporaryDirectory();
    const timeline = path.join(root, "timeline.jsonl");
    const input = [
      "NVIDIA_INFERENCE_API_KEY=nvapi-private-value",
      phaseStarted(1, "qualify the physical DGX Spark host"),
      `${PREFIX} [phase 1/5] completed: qualify the physical DGX Spark host — passed in 2s (total 2s)`,
      "RUNNER_NAME=internal-spark-host",
      "",
    ].join("\n");

    try {
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", TOOL_PATH, "record", "--output", timeline],
        { encoding: "utf8", input },
      );
      const source = fs.readFileSync(timeline, "utf8");
      const events = readSparkExpressEvidenceTimeline(timeline);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(input);
      expect(events.map((value) => value.type)).toEqual([
        "recording-started",
        "phase-started",
        "phase-completed",
        "recording-ended",
      ]);
      expect(source).not.toContain("nvapi-private-value");
      expect(source).not.toContain("internal-spark-host");
      expect(source).not.toContain("qualify the physical DGX Spark host");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders a bounded replay and manifest from sanitized events", () => {
    const root = temporaryDirectory();
    const timeline = path.join(root, "timeline.jsonl");
    const frames = path.join(root, "frames");
    const concat = path.join(root, "replay.ffconcat");
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(
      timeline,
      [
        { version: 1, atMs: 0, type: "recording-started" },
        { version: 1, atMs: 500, type: "phase-started", phase: 1 },
        { version: 1, atMs: 2_500, type: "phase-completed", phase: 1, outcome: "passed" },
        { version: 1, atMs: 2_500, type: "phase-started", phase: 2 },
        { version: 1, atMs: 122_500, type: "phase-completed", phase: 2, outcome: "passed" },
        { version: 1, atMs: 123_000, type: "recording-ended" },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );

    try {
      finalizeSparkExpressEvidence(timeline, "passed");
      const manifest = renderSparkExpressEvidenceReplay(timeline, frames, concat, manifestPath);
      const replay = fs.readFileSync(concat, "utf8");
      const frameFiles = fs.readdirSync(frames).sort();
      const firstFrame = fs.readFileSync(path.join(frames, frameFiles[0] as string));

      expect(manifest).toMatchObject({
        version: 1,
        kind: "nemoclaw-spark-express-video-evidence",
        eventCount: 7,
        observedDurationMs: 123_000,
        playbackRate: 12,
        outcome: "passed",
        contentBoundary: "sanitized-semantic-events-only",
      });
      expect(manifest.playbackDurationSeconds).toBe(16);
      expect(manifest.timelineSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(frameFiles).toHaveLength(4);
      expect(firstFrame.subarray(0, 16).toString("ascii")).toBe("P6\n1280 720\n255\n");
      expect(firstFrame).toHaveLength(16 + 1280 * 720 * 3);
      expect(replay).toContain("ffconcat version 1.0");
      expect(replay).toContain("frame-000.ppm");
      expect(replay).toContain("duration ");
      expect(replay).not.toContain("nvapi-");
      expect(replay).not.toContain("RUNNER_NAME");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      [
        { version: 1, atMs: 0, type: "recording-started" },
        { version: 1, atMs: 1, type: "recording-ended", text: "untrusted" },
      ],
      "unexpected field",
    ],
    [
      [
        { version: 1, atMs: 2, type: "recording-started" },
        { version: 1, atMs: 1, type: "recording-ended" },
      ],
      "moved backwards",
    ],
    [
      [
        { version: 1, atMs: 0, type: "recording-started" },
        { version: 1, atMs: 1, type: "phase-started", phase: 9 },
      ],
      "invalid phase",
    ],
    [
      [
        { version: 1, atMs: 0, type: "recording-started" },
        { version: 1, atMs: 1, type: "qualification-passed" },
      ],
      "invalid recording boundaries",
    ],
  ])("rejects malformed timeline events: %s", (events, expectedError) => {
    const root = temporaryDirectory();
    const timeline = path.join(root, "timeline.jsonl");
    fs.writeFileSync(timeline, events.map((value) => timelineLine(value)).join(""));

    try {
      expect(() => readSparkExpressEvidenceTimeline(timeline)).toThrow(expectedError);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
