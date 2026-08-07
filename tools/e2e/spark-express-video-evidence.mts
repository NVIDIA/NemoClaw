// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SPARK_EXPRESS_EVIDENCE_TARGET = "spark-express-vllm";
export const SPARK_EXPRESS_EVIDENCE_SCENARIO =
  "DGX Spark Express option 2 materializes the fixed vLLM profile and routes sandbox inference";
export const SPARK_EXPRESS_EVIDENCE_PLAYBACK_RATE = 12;

const MAX_RAW_LINE_LENGTH = 16_384;
const MAX_TIMELINE_BYTES = 256 * 1024;
const MAX_TIMELINE_EVENTS = 128;
const MAX_OBSERVED_DURATION_MS = 6 * 60 * 60_000;
const TIMELINE_VERSION = 1;
const PHASES = [
  {
    source: "qualify the physical DGX Spark host",
    display: "Check the physical Spark host",
  },
  {
    source: "select Spark Express option 2 and onboard through the local-model profile",
    display: "Run Spark Express onboarding",
  },
  {
    source: "verify catalog-owned vLLM runtime configuration",
    display: "Verify the catalog-owned vLLM configuration",
  },
  {
    source: "prove sandbox inference and unrelated egress denial",
    display: "Test sandbox inference and egress policy",
  },
  {
    source: "release registered E2E resources",
    display: "Release test resources",
  },
] as const;

type PhaseNumber = 1 | 2 | 3 | 4 | 5;
type PhaseOutcome = "failed" | "passed" | "skipped";
type EvidenceEventType =
  | "recording-started"
  | "phase-started"
  | "phase-completed"
  | "recording-ended"
  | "qualification-passed"
  | "qualification-failed";

export type SparkExpressEvidenceEvent = {
  readonly version: 1;
  readonly atMs: number;
  readonly type: EvidenceEventType;
  readonly phase?: PhaseNumber;
  readonly outcome?: PhaseOutcome;
};

export type SparkExpressEvidenceManifest = {
  readonly version: 1;
  readonly kind: "nemoclaw-spark-express-video-evidence";
  readonly eventCount: number;
  readonly observedDurationMs: number;
  readonly playbackDurationSeconds: number;
  readonly playbackRate: number;
  readonly outcome: "failed" | "passed";
  readonly timelineSha256: string;
  readonly contentBoundary: "sanitized-semantic-events-only";
};

const EXPECTED_PREFIX =
  `[e2e target=${JSON.stringify(SPARK_EXPRESS_EVIDENCE_TARGET)} ` +
  `scenario=${JSON.stringify(SPARK_EXPRESS_EVIDENCE_SCENARIO)}]`;

function event(atMs: number, type: EvidenceEventType): SparkExpressEvidenceEvent {
  return { version: TIMELINE_VERSION, atMs, type };
}

function phaseEvent(
  atMs: number,
  type: "phase-started" | "phase-completed",
  phase: PhaseNumber,
  outcome?: PhaseOutcome,
): SparkExpressEvidenceEvent {
  return {
    version: TIMELINE_VERSION,
    atMs,
    type,
    phase,
    ...(outcome ? { outcome } : {}),
  };
}

export function sanitizedSparkExpressProgressEvent(
  rawLine: string,
  atMs: number,
): SparkExpressEvidenceEvent | null {
  if (
    rawLine.length > MAX_RAW_LINE_LENGTH ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(rawLine)
  ) {
    return null;
  }
  const prefix = `${EXPECTED_PREFIX} `;
  if (!rawLine.startsWith(prefix)) return null;
  const message = rawLine.slice(prefix.length);

  for (const [zeroBasedIndex, phase] of PHASES.entries()) {
    const phaseNumber = (zeroBasedIndex + 1) as PhaseNumber;
    const phasePrefix = `[phase ${phaseNumber}/${PHASES.length}]`;
    if (message.startsWith(`${phasePrefix} started: ${phase.source} (`)) {
      return phaseEvent(atMs, "phase-started", phaseNumber);
    }
    const completedPrefix = `${phasePrefix} completed: ${phase.source} — `;
    if (message.startsWith(completedPrefix)) {
      const outcome = /^(failed|passed|skipped) in /u.exec(
        message.slice(completedPrefix.length),
      )?.[1];
      return outcome
        ? phaseEvent(atMs, "phase-completed", phaseNumber, outcome as PhaseOutcome)
        : null;
    }
  }
  return null;
}

function appendTimelineEvent(filePath: string, value: SparkExpressEvidenceEvent): void {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function writeWithBackpressure(value: string): Promise<void> {
  if (process.stdout.write(value)) return;
  await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
}

export async function recordSparkExpressEvidence(
  outputPath: string,
  input: AsyncIterable<string | Buffer> = process.stdin,
  now: () => number = Date.now,
): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputPath, "", { encoding: "utf8", mode: 0o600 });
  const startedAt = now();
  appendTimelineEvent(outputPath, event(0, "recording-started"));

  let buffered = "";
  let droppingOversizedLine = false;
  const observeLine = (line: string) => {
    if (droppingOversizedLine) {
      droppingOversizedLine = false;
      return;
    }
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    const observed = sanitizedSparkExpressProgressEvent(normalized, now() - startedAt);
    if (observed) appendTimelineEvent(outputPath, observed);
  };

  for await (const rawChunk of input) {
    const chunk = rawChunk.toString();
    await writeWithBackpressure(chunk);
    const segments = chunk.split("\n");
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string;
      const lineEnded = index < segments.length - 1;
      if (!droppingOversizedLine && buffered.length + segment.length <= MAX_RAW_LINE_LENGTH) {
        buffered += segment;
      } else {
        buffered = "";
        droppingOversizedLine = true;
      }
      if (lineEnded) {
        observeLine(buffered);
        buffered = "";
      }
    }
  }
  if (buffered || droppingOversizedLine) observeLine(buffered);
  appendTimelineEvent(outputPath, event(now() - startedAt, "recording-ended"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("Spark Express evidence event has an unexpected field");
  }
}

function parseTimelineEvent(value: unknown): SparkExpressEvidenceEvent {
  if (!isRecord(value)) throw new Error("Spark Express evidence event must be an object");
  const type = value.type;
  const atMs = value.atMs;
  if (value.version !== TIMELINE_VERSION || typeof type !== "string") {
    throw new Error("Spark Express evidence event has an unsupported version or type");
  }
  if (!Number.isSafeInteger(atMs) || Number(atMs) < 0 || Number(atMs) > MAX_OBSERVED_DURATION_MS) {
    throw new Error("Spark Express evidence event has an invalid timestamp");
  }
  if (type === "phase-started" || type === "phase-completed") {
    const phase = value.phase;
    if (!Number.isInteger(phase) || Number(phase) < 1 || Number(phase) > PHASES.length) {
      throw new Error("Spark Express evidence event has an invalid phase");
    }
    if (type === "phase-started") {
      assertExactKeys(value, ["version", "atMs", "type", "phase"]);
      return phaseEvent(Number(atMs), type, Number(phase) as PhaseNumber);
    }
    if (!(["failed", "passed", "skipped"] as const).includes(value.outcome as PhaseOutcome)) {
      throw new Error("Spark Express evidence completion has an invalid outcome");
    }
    assertExactKeys(value, ["version", "atMs", "type", "phase", "outcome"]);
    return phaseEvent(
      Number(atMs),
      type,
      Number(phase) as PhaseNumber,
      value.outcome as PhaseOutcome,
    );
  }
  if (
    !(
      [
        "recording-started",
        "recording-ended",
        "qualification-passed",
        "qualification-failed",
      ] as const
    ).includes(type as "recording-started")
  ) {
    throw new Error("Spark Express evidence event has an unsupported type");
  }
  assertExactKeys(value, ["version", "atMs", "type"]);
  return event(Number(atMs), type as EvidenceEventType);
}

export function readSparkExpressEvidenceTimeline(filePath: string): SparkExpressEvidenceEvent[] {
  const source = fs.readFileSync(filePath, "utf8");
  if (Buffer.byteLength(source) > MAX_TIMELINE_BYTES) {
    throw new Error("Spark Express evidence timeline exceeds the size limit");
  }
  const lines = source.split("\n").filter(Boolean);
  if (lines.length < 2 || lines.length > MAX_TIMELINE_EVENTS) {
    throw new Error("Spark Express evidence timeline has an invalid event count");
  }
  const events = lines.map((line) => parseTimelineEvent(JSON.parse(line) as unknown));
  for (let index = 1; index < events.length; index += 1) {
    if ((events[index]?.atMs ?? 0) < (events[index - 1]?.atMs ?? 0)) {
      throw new Error("Spark Express evidence timeline timestamps moved backwards");
    }
  }
  if (events[0]?.type !== "recording-started") {
    throw new Error("Spark Express evidence timeline must start at the recording boundary");
  }
  const recordingStarts = events.filter((value) => value.type === "recording-started");
  const recordingEnds = events.filter((value) => value.type === "recording-ended");
  const finalStatuses = events.filter(
    (value) => value.type === "qualification-passed" || value.type === "qualification-failed",
  );
  if (recordingStarts.length !== 1 || recordingEnds.length !== 1 || finalStatuses.length > 1) {
    throw new Error("Spark Express evidence timeline has invalid recording boundaries");
  }
  const recordingEndIndex = events.findIndex((value) => value.type === "recording-ended");
  const finalStatusIndex = events.findIndex(
    (value) => value.type === "qualification-passed" || value.type === "qualification-failed",
  );
  const expectedRecordingEndIndex =
    finalStatusIndex === -1 ? events.length - 1 : finalStatusIndex - 1;
  if (
    recordingEndIndex !== expectedRecordingEndIndex ||
    (finalStatusIndex !== -1 && finalStatusIndex !== events.length - 1)
  ) {
    throw new Error("Spark Express evidence final status must follow the recording boundary");
  }
  return events;
}

export function finalizeSparkExpressEvidence(filePath: string, status: "failed" | "passed"): void {
  const events = readSparkExpressEvidenceTimeline(filePath);
  const last = events.at(-1);
  if (last?.type !== "recording-ended") {
    throw new Error("Spark Express evidence timeline must end at the recording boundary");
  }
  appendTimelineEvent(filePath, event(last.atMs, `qualification-${status}`));
}

const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;
const FONT_ROWS: Readonly<Record<string, readonly number[]>> = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  "-": [0, 0, 0, 31, 0, 0, 0],
  ".": [0, 0, 0, 0, 0, 12, 12],
  "/": [1, 2, 4, 8, 16, 0, 0],
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [30, 1, 1, 14, 1, 1, 30],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 16, 30, 1, 1, 30],
  "6": [14, 16, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 1, 14],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [15, 16, 16, 16, 16, 16, 15],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [15, 16, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 18, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 25, 21, 19, 19, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
};
const UNKNOWN_GLYPH = [14, 17, 1, 2, 4, 0, 4] as const;

function setPixel(
  pixels: Buffer,
  x: number,
  y: number,
  color: readonly [number, number, number],
): void {
  if (x < 0 || x >= FRAME_WIDTH || y < 0 || y >= FRAME_HEIGHT) return;
  const offset = (y * FRAME_WIDTH + x) * 3;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
}

function drawText(
  pixels: Buffer,
  text: string,
  y: number,
  scale: number,
  color: readonly [number, number, number],
): void {
  const normalized = text.toUpperCase();
  const width = normalized.length * 6 * scale - scale;
  const startX = Math.floor((FRAME_WIDTH - width) / 2);
  for (const [characterIndex, character] of [...normalized].entries()) {
    const rows = FONT_ROWS[character] ?? UNKNOWN_GLYPH;
    for (const [rowIndex, row] of rows.entries()) {
      for (let column = 0; column < 5; column += 1) {
        if ((row & (1 << (4 - column))) === 0) continue;
        for (let yOffset = 0; yOffset < scale; yOffset += 1) {
          for (let xOffset = 0; xOffset < scale; xOffset += 1) {
            setPixel(
              pixels,
              startX + (characterIndex * 6 + column) * scale + xOffset,
              y + rowIndex * scale + yOffset,
              color,
            );
          }
        }
      }
    }
  }
}

function eventDisplayLines(value: SparkExpressEvidenceEvent): readonly string[] | null {
  if (value.type === "recording-started") return ["QUALIFICATION STARTED"];
  if (value.type === "phase-started") {
    const display = PHASES[(value.phase ?? 1) - 1]?.display ?? "UNKNOWN PHASE";
    const wrapped = display
      .replace(
        "Verify the catalog-owned vLLM configuration",
        "Verify the catalog-owned|vLLM configuration",
      )
      .replace(
        "Test sandbox inference and egress policy",
        "Test sandbox inference|and egress policy",
      )
      .split("|");
    return [`PHASE ${value.phase} OF ${PHASES.length}`, ...wrapped];
  }
  if (value.type === "qualification-passed") return ["QUALIFICATION PASSED"];
  if (value.type === "qualification-failed") return ["QUALIFICATION FAILED"];
  return null;
}

function writeReplayFrame(
  framePath: string,
  value: SparkExpressEvidenceEvent,
  lines: readonly string[],
): void {
  const pixels = Buffer.alloc(FRAME_WIDTH * FRAME_HEIGHT * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    pixels[offset] = 11;
    pixels[offset + 1] = 16;
    pixels[offset + 2] = 32;
  }
  drawText(pixels, "NEMOCLAW SPARK EXPRESS", 72, 5, [241, 245, 249]);
  const bodyColor: readonly [number, number, number] =
    value.type === "qualification-passed"
      ? [114, 230, 165]
      : value.type === "qualification-failed"
        ? [255, 123, 123]
        : [248, 250, 252];
  const bodyStart = 290 - Math.max(0, lines.length - 1) * 36;
  for (const [index, line] of lines.entries()) {
    drawText(pixels, line, bodyStart + index * 72, 6, bodyColor);
  }
  drawText(
    pixels,
    `SANITIZED SEMANTIC REPLAY ${SPARK_EXPRESS_EVIDENCE_PLAYBACK_RATE}X`,
    610,
    3,
    [148, 163, 184],
  );
  drawText(pixels, "RAW COMMAND OUTPUT EXCLUDED", 650, 3, [148, 163, 184]);
  fs.writeFileSync(
    framePath,
    Buffer.concat([Buffer.from(`P6\n${FRAME_WIDTH} ${FRAME_HEIGHT}\n255\n`, "ascii"), pixels]),
    { mode: 0o600 },
  );
}

function concatPath(value: string): string {
  const resolved = path.resolve(value);
  if (/[\r\n']/u.test(resolved)) throw new Error("Spark Express frame path is not concat-safe");
  return resolved;
}

export function renderSparkExpressEvidenceReplay(
  timelinePath: string,
  framesDirectory: string,
  concatPathname: string,
  manifestPath: string,
): SparkExpressEvidenceManifest {
  const source = fs.readFileSync(timelinePath, "utf8");
  const events = readSparkExpressEvidenceTimeline(timelinePath);
  const final = events.at(-1);
  if (final?.type !== "qualification-passed" && final?.type !== "qualification-failed") {
    throw new Error("Spark Express evidence timeline is not finalized");
  }
  const observedDurationMs = final.atMs;
  const playbackDurationSeconds = Math.max(
    12,
    Math.ceil(observedDurationMs / 1_000 / SPARK_EXPRESS_EVIDENCE_PLAYBACK_RATE) + 5,
  );
  const displayEvents = events.filter((value) => eventDisplayLines(value) !== null);
  fs.mkdirSync(framesDirectory, { mode: 0o700 });
  const framePaths = displayEvents.map((value, index) => {
    const framePath = path.join(framesDirectory, `frame-${String(index).padStart(3, "0")}.ppm`);
    writeReplayFrame(framePath, value, eventDisplayLines(value) ?? []);
    return framePath;
  });
  const concatLines = ["ffconcat version 1.0"];
  for (const [index, framePath] of framePaths.entries()) {
    const current = displayEvents[index] as SparkExpressEvidenceEvent;
    const next = displayEvents[index + 1];
    const startSeconds = current.atMs / 1_000 / SPARK_EXPRESS_EVIDENCE_PLAYBACK_RATE;
    const endSeconds = next
      ? next.atMs / 1_000 / SPARK_EXPRESS_EVIDENCE_PLAYBACK_RATE
      : playbackDurationSeconds;
    concatLines.push(`file '${concatPath(framePath)}'`);
    concatLines.push(`duration ${Math.max(0.01, endSeconds - startSeconds).toFixed(6)}`);
  }
  concatLines.push(`file '${concatPath(framePaths.at(-1) as string)}'`);
  fs.writeFileSync(concatPathname, `${concatLines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  const manifest: SparkExpressEvidenceManifest = {
    version: 1,
    kind: "nemoclaw-spark-express-video-evidence",
    eventCount: events.length,
    observedDurationMs,
    playbackDurationSeconds,
    playbackRate: SPARK_EXPRESS_EVIDENCE_PLAYBACK_RATE,
    outcome: final.type === "qualification-passed" ? "passed" : "failed",
    timelineSha256: createHash("sha256").update(source).digest("hex"),
    contentBoundary: "sanitized-semantic-events-only",
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return manifest;
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export async function runSparkExpressEvidenceCli(args: string[]): Promise<void> {
  const [command, ...options] = args;
  if (command === "record") {
    await recordSparkExpressEvidence(option(options, "--output"));
    return;
  }
  if (command === "finalize") {
    const status = option(options, "--status");
    if (status !== "passed" && status !== "failed") throw new Error("invalid final status");
    finalizeSparkExpressEvidence(option(options, "--timeline"), status);
    return;
  }
  if (command === "render") {
    renderSparkExpressEvidenceReplay(
      option(options, "--timeline"),
      option(options, "--frames"),
      option(options, "--concat"),
      option(options, "--manifest"),
    );
    return;
  }
  throw new Error(`unsupported Spark Express evidence command ${JSON.stringify(command ?? "")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSparkExpressEvidenceCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
