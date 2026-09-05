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

import { expect, it } from "vitest";
import { OPENCLAW_SESSION_EVIDENCE_SCRIPT } from "../live/launch-agent-turn.ts";

type SessionRecords = Record<string, string[]>;

function message(role: "assistant" | "user", content = "nonempty"): string {
  return JSON.stringify({
    message: { content: [{ text: content, type: "text" }], role },
    type: "message",
  });
}

function emptyMessage(role: "assistant" | "user"): string {
  return JSON.stringify({ message: { content: [], role }, type: "message" });
}

function writeSessionRecords(
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

function withOwnedFixtureFile<T>(
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

function runEvidenceFixture(input: {
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

function runBaselineMutationFixture(mutation: "invalid" | "removed" | "rewritten" | "truncated") {
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

it("qualifies two ordered structured turns without comparing message content (#9160)", () => {
  const { baseline, baselineKeys, baselineMode, baselineNlink, baselineUid, qualification } =
    runEvidenceFixture({
      after: {
        "session-a": [
          message("user", "first arbitrary input"),
          message("assistant", "first arbitrary response"),
          message("user", "different second input"),
          message("assistant", "different second response"),
        ],
      },
      expectedTurns: 2,
    });

  expect(baseline.status).toBe(0);
  expect(baselineKeys).toEqual(["schemaVersion", "sessions"]);
  expect(baselineMode).toBe(0o600);
  expect(baselineNlink).toBe(1);
  expect(baselineUid).toBe(process.getuid?.());
  expect(qualification.status).toBe(0);
});

it("keeps a partial structured turn pending (#9160)", () => {
  const { baseline, qualification } = runEvidenceFixture({
    after: { "session-a": [message("user")] },
    expectedTurns: 1,
  });

  expect(baseline.status).toBe(0);
  expect(qualification.status).toBe(1);
});

it("does not qualify structured turns recorded before the baseline (#9160)", () => {
  const { baseline, qualification } = runEvidenceFixture({
    before: { "session-a": [message("user"), message("assistant")] },
    after: {},
    expectedTurns: 1,
  });

  expect(baseline.status).toBe(0);
  expect(qualification.status).toBe(1);
});

it.each([
  { "session-a": [message("assistant"), message("user")] },
  { "session-a": [message("user"), message("user"), message("assistant")] },
  { "session-a": [message("user"), message("assistant"), message("assistant")] },
  { "session-a": [message("user"), "not-json", message("assistant")] },
  { "session-a": [emptyMessage("user"), message("assistant")] },
  { "session-a": [message("user"), message("assistant")], "session-b": [message("user")] },
] as SessionRecords[])(
  "rejects malformed, empty, duplicated, extra, out-of-order, or cross-session records [case %#] (#9160)",
  (after) => {
    const { baseline, qualification } = runEvidenceFixture({ after, expectedTurns: 1 });
    expect(baseline.status).toBe(0);
    expect(qualification.status).toBe(2);
  },
);

it("rejects an unterminated appended session record (#9160)", () => {
  const { baseline, qualification } = runEvidenceFixture({
    after: {
      "session-a": [
        message("user"),
        message("assistant"),
        message("user"),
        message("assistant"),
        message("user"),
      ],
    },
    afterFinalNewline: false,
    expectedTurns: 2,
  });

  expect(baseline.status).toBe(0);
  expect(qualification.status).toBe(2);
});

it.each(["invalid", "removed", "rewritten", "truncated"] as const)(
  "rejects an invalid baseline or a removed, rewritten, or truncated session [case %#] (#9160)",
  (mutation) => {
    const { baseline, qualification } = runBaselineMutationFixture(mutation);
    expect(baseline.status).toBe(0);
    expect(qualification.status).toBe(2);
  },
);
