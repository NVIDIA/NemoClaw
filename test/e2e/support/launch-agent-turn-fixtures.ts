// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "vitest";
import { OPENCLAW_SESSION_EVIDENCE_SCRIPT } from "../live/launch-agent-turn.ts";

export const PROCESS_EXIT_WAIT = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);
export type SessionRecords = Record<string, string[]>;
export type FixtureMode =
  | "cleanup-failure"
  | "delayed-input-attachment"
  | "delayed-recording"
  | "delayed-tui-ready"
  | "input-mode-timeout"
  | "invalid-order"
  | "late-extra"
  | "nonzero"
  | "nonzero-pty-cleanup-failure"
  | "pty-cleanup-failure"
  | "pty-cleanup-unknown-entry"
  | "pty-socket-invalid"
  | "pty-socket-permission"
  | "pty-response-identity"
  | "pty-socket-timeout"
  | "pty-path-unreadable"
  | "pty-termios-unavailable"
  | "recording-timeout"
  | "restored-canonical-timeout"
  | "valid";

export function message(role: "assistant" | "user", content = "nonempty"): string {
  return JSON.stringify({
    message: { content: [{ text: content, type: "text" }], role },
    type: "message",
  });
}

export function emptyMessage(role: "assistant" | "user"): string {
  return JSON.stringify({ message: { content: [], role }, type: "message" });
}

export function writeSessionRecords(
  root: string,
  sessions: SessionRecords,
  append: boolean,
  finalNewline = true,
): void {
  for (const [sessionId, records] of Object.entries(sessions)) {
    const filePath = join(root, `${sessionId}.jsonl`);
    const body = records.length > 0 ? `${records.join("\n")}${finalNewline ? "\n" : ""}` : "";
    const writeRecords = append ? appendFileSync : writeFileSync;
    writeRecords(filePath, body);
  }
}

export function withOwnedFixtureFile<T>(
  filePath: string,
  flags: number,
  action: (descriptor: number, stats: Stats) => T,
): T {
  const descriptor = openSync(filePath, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const stats = fstatSync(descriptor);
    expect([stats.isFile(), stats.uid, stats.mode & 0o777, stats.nlink]).toEqual([
      true,
      process.getuid?.(),
      0o600,
      1,
    ]);
    return action(descriptor, stats);
  } finally {
    closeSync(descriptor);
  }
}

export function runEvidenceFixture(input: {
  after: SessionRecords;
  afterFinalNewline?: boolean;
  before?: SessionRecords;
  expectedTurns: number;
}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-evidence-"));
  const runId = randomUUID().replaceAll("-", "");
  const baselinePath = `/tmp/nemoclaw-launch-session-${runId}.json`;
  const ptyMonitorRoot = `/tmp/nemoclaw-launch-turn-${runId}`;
  const sessionRoot = join(fixtureRoot, "sessions");
  mkdirSync(sessionRoot);
  try {
    writeSessionRecords(sessionRoot, input.before ?? {}, false);
    const baseline = spawnSync(
      process.execPath,
      [
        "-e",
        OPENCLAW_SESSION_EVIDENCE_SCRIPT,
        "baseline",
        sessionRoot,
        baselinePath,
        "",
        ptyMonitorRoot,
        runId,
      ],
      { encoding: "utf8" },
    );
    writeSessionRecords(sessionRoot, input.after, true, input.afterFinalNewline ?? true);
    const qualification = spawnSync(
      process.execPath,
      [
        "-e",
        OPENCLAW_SESSION_EVIDENCE_SCRIPT,
        "qualify",
        sessionRoot,
        baselinePath,
        String(input.expectedTurns),
        ptyMonitorRoot,
        runId,
      ],
      { encoding: "utf8" },
    );
    const baselineFile = withOwnedFixtureFile(
      baselinePath,
      constants.O_RDONLY,
      (descriptor, stats) => ({ body: readFileSync(descriptor, "utf8"), stats }),
    );
    return {
      baseline,
      baselineKeys: Object.keys(JSON.parse(baselineFile.body)).sort(),
      baselineMode: baselineFile.stats.mode & 0o777,
      baselineNlink: baselineFile.stats.nlink,
      baselineUid: baselineFile.stats.uid,
      qualification,
    };
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
    rmSync(baselinePath, { force: true });
    rmSync(`${baselinePath}.tmp`, { force: true });
    rmSync(ptyMonitorRoot, { force: true, recursive: true });
  }
}

export function runBaselineMutationFixture(
  mutation: "invalid" | "removed" | "rewritten" | "truncated",
) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-baseline-"));
  const runId = randomUUID().replaceAll("-", "");
  const baselinePath = `/tmp/nemoclaw-launch-session-${runId}.json`;
  const ptyMonitorRoot = `/tmp/nemoclaw-launch-turn-${runId}`;
  const sessionRoot = join(fixtureRoot, "sessions");
  const sessionPath = join(sessionRoot, "session-a.jsonl");
  mkdirSync(sessionRoot);
  writeSessionRecords(sessionRoot, { "session-a": [message("user"), message("assistant")] }, false);
  try {
    const baseline = spawnSync(
      process.execPath,
      [
        "-e",
        OPENCLAW_SESSION_EVIDENCE_SCRIPT,
        "baseline",
        sessionRoot,
        baselinePath,
        "",
        ptyMonitorRoot,
        runId,
      ],
      { encoding: "utf8" },
    );
    const applyMutation: Record<typeof mutation, () => void> = {
      invalid: () =>
        withOwnedFixtureFile(baselinePath, constants.O_WRONLY, (descriptor) => {
          ftruncateSync(descriptor, 0);
          writeFileSync(descriptor, "{}");
          fsyncSync(descriptor);
        }),
      removed: () => rmSync(sessionPath),
      rewritten: () =>
        writeFileSync(
          sessionPath,
          readFileSync(sessionPath, "utf8").replace("nonempty", "changed!"),
        ),
      truncated: () => writeFileSync(sessionPath, ""),
    };
    applyMutation[mutation]();
    const qualification = spawnSync(
      process.execPath,
      [
        "-e",
        OPENCLAW_SESSION_EVIDENCE_SCRIPT,
        "qualify",
        sessionRoot,
        baselinePath,
        "1",
        ptyMonitorRoot,
        runId,
      ],
      { encoding: "utf8" },
    );
    return { baseline, qualification };
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
    rmSync(baselinePath, { force: true });
    rmSync(`${baselinePath}.tmp`, { force: true });
    rmSync(ptyMonitorRoot, { force: true, recursive: true });
  }
}
