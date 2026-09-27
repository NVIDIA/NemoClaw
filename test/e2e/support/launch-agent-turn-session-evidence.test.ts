// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
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
import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";
import { OPENCLAW_SESSION_EVIDENCE_SCRIPT } from "../live/launch-agent-turn.ts";

type SessionRecords = Record<string, string[]>;

interface SqliteSessionRecord {
  eventJson: string;
  seq: number;
  sessionId: string;
}

function message(role: "assistant" | "user", content = "nonempty"): string {
  return JSON.stringify({
    message: { content: [{ text: content, type: "text" }], role },
    type: "message",
  });
}

function emptyMessage(role: "assistant" | "user"): string {
  return JSON.stringify({ message: { content: [], role }, type: "message" });
}

function providerUnavailableMessage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    message: {
      api: "openai-completions",
      content: [],
      errorCode: "503",
      errorMessage: "litellm.ServiceUnavailableError: upstream unavailable",
      model: "nvidia/model",
      provider: "inference",
      role: "assistant",
      stopReason: "error",
      ...overrides,
    },
    type: "message",
  });
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

function sqlitePathForSessionRoot(sessionRoot: string): string {
  return join(sessionRoot, "..", "agent", "openclaw-agent.sqlite");
}

function createSqliteSessionStore(sessionRoot: string, records: SqliteSessionRecord[]): string {
  const sqlitePath = sqlitePathForSessionRoot(sessionRoot);
  mkdirSync(join(sessionRoot, "..", "agent"), { recursive: true });
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec(`
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      ) STRICT
    `);
    const insert = database.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const record of records) {
      insert.run(record.sessionId, record.seq, record.eventJson, record.seq);
    }
  } finally {
    database.close();
  }
  chmodSync(sqlitePath, 0o600);
  return sqlitePath;
}

function appendSqliteSessionRecords(sqlitePath: string, records: SqliteSessionRecord[]): void {
  const database = new DatabaseSync(sqlitePath);
  try {
    const insert = database.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const record of records) {
      insert.run(record.sessionId, record.seq, record.eventJson, record.seq);
    }
  } finally {
    database.close();
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
  afterBaseline?: (sessionRoot: string) => void;
  afterFinalNewline?: boolean;
  before?: SessionRecords;
  expectedUserIdentifiers?: readonly [string, string];
  expectedTurns: number;
}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-evidence-"));
  const runId = randomUUID().replaceAll("-", "");
  const baselinePath = `/tmp/nemoclaw-launch-session-${runId}.json`;
  const ptyMonitorRoot = `/tmp/nemoclaw-launch-turn-${runId}`;
  const sessionRoot = join(fixtureRoot, "sessions");
  const expectedUserIdentifiers = input.expectedUserIdentifiers ?? ["", ""];
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
        ...expectedUserIdentifiers,
      ],
      { encoding: "utf8" },
    );
    writeSessionRecords(sessionRoot, input.after, true, input.afterFinalNewline ?? true);
    (input.afterBaseline ?? (() => undefined))(sessionRoot);
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
        ...expectedUserIdentifiers,
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

function runSqliteEvidenceFixture(input: {
  after: SqliteSessionRecord[];
  before?: SqliteSessionRecord[];
  expectedTurns: number;
}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-sqlite-evidence-"));
  const runId = randomUUID().replaceAll("-", "");
  const baselinePath = `/tmp/nemoclaw-launch-session-${runId}.json`;
  const ptyMonitorRoot = `/tmp/nemoclaw-launch-turn-${runId}`;
  const sessionRoot = join(fixtureRoot, "sessions");
  mkdirSync(sessionRoot);
  const sqlitePath = createSqliteSessionStore(sessionRoot, input.before ?? []);
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
      { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    appendSqliteSessionRecords(sqlitePath, input.after);
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
      { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    return {
      baseline,
      baselineDocument: JSON.parse(readFileSync(baselinePath, "utf8")) as {
        schemaVersion: number;
        sqlite: { dev: string; ino: string; sessions: unknown[] };
      },
      qualification,
      sqlitePath,
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
  expect(baselineKeys).toEqual(["schemaVersion", "sessions", "sqlite"]);
  expect(baselineMode).toBe(0o600);
  expect(baselineNlink).toBe(1);
  expect(baselineUid).toBe(process.getuid?.());
  expect(qualification.status).toBe(0);
});

it("qualifies ordered turns from the OpenClaw 2026.9.1 SQLite transcript store", () => {
  const { baseline, baselineDocument, qualification } = runSqliteEvidenceFixture({
    before: [
      { eventJson: message("user", "prior input"), seq: 1, sessionId: "session-a" },
      { eventJson: message("assistant", "prior response"), seq: 2, sessionId: "session-a" },
    ],
    after: [
      { eventJson: message("user", "first input"), seq: 3, sessionId: "session-a" },
      { eventJson: message("assistant", "first response"), seq: 4, sessionId: "session-a" },
      { eventJson: message("user", "second input"), seq: 5, sessionId: "session-a" },
      { eventJson: message("assistant", "second response"), seq: 6, sessionId: "session-a" },
    ],
    expectedTurns: 2,
  });

  expect(baseline.status).toBe(0);
  expect(baselineDocument.schemaVersion).toBe(2);
  expect(baselineDocument.sqlite.sessions).toHaveLength(1);
  expect(qualification.status, qualification.stderr).toBe(0);
});

it("identifies unsafe SQLite permissions without exposing transcript contents", () => {
  const { qualification } = runEvidenceFixture({
    after: {},
    afterBaseline: (sessionRoot) => chmodSync(createSqliteSessionStore(sessionRoot, []), 0o644),
    expectedTurns: 1,
  });
  expect(qualification.status).toBe(2);
  expect(qualification.stderr).toContain('"reason":"sqlite_session_store_invalid"');
  expect(qualification.stderr).toContain('"check":"metadata"');
  expect(qualification.stderr).toContain('"privateMode":false');
  expect(qualification.stderr).toContain('"ownerMatches":true');
  expect(qualification.stdout).toBe("");
  expect(qualification.stderr).not.toContain("openclaw-agent.sqlite");
});

it("distinguishes a missing transcript table from invalid SQLite permissions", () => {
  const { qualification } = runEvidenceFixture({
    after: {},
    afterBaseline: (sessionRoot) => {
      const database = new DatabaseSync(createSqliteSessionStore(sessionRoot, []));
      try {
        database.exec("DROP TABLE transcript_events");
      } finally {
        database.close();
      }
    },
    expectedTurns: 1,
  });
  expect(qualification.status).toBe(2);
  expect(qualification.stderr).toContain('"reason":"sqlite_session_store_invalid"');
  expect(qualification.stderr).toContain('"check":"transcript_table"');
  expect(qualification.stdout).toBe("");
  expect(qualification.stderr).not.toContain("openclaw-agent.sqlite");
});

it("rejects a SQLite transcript store that appears after a JSONL-only baseline", () => {
  const { baseline, qualification } = runEvidenceFixture({
    before: { "session-a": [message("user", "prior input")] },
    after: {},
    afterBaseline: (sessionRoot) =>
      createSqliteSessionStore(sessionRoot, [
        {
          eventJson: message("user", "new input"),
          seq: 1,
          sessionId: "session-b",
        },
        {
          eventJson: message("assistant", "new response"),
          seq: 2,
          sessionId: "session-b",
        },
      ]),
    expectedTurns: 1,
  });

  expect(baseline.status).toBe(0);
  expect(qualification.status, qualification.stderr).toBe(2);
});

it("accepts first-use SQLite only after an empty session baseline", () => {
  const firstIdentifier = "0123456789abcdef";
  const secondIdentifier = "fedcba9876543210";
  const { baseline, qualification } = runEvidenceFixture({
    before: { "session-a": [message("user", "prior input")] },
    after: {},
    afterBaseline: (sessionRoot) =>
      createSqliteSessionStore(sessionRoot, [
        {
          eventJson: message("user", `Request identifier: ${firstIdentifier}.`),
          seq: 1,
          sessionId: "session-b",
        },
        {
          eventJson: message("assistant", "new response"),
          seq: 2,
          sessionId: "session-b",
        },
      ]),
    expectedTurns: 1,
    expectedUserIdentifiers: [firstIdentifier, secondIdentifier],
  });

  expect(baseline.status).toBe(0);
  expect(qualification.status).toBe(2);
  expect(qualification.stderr).toContain('"reason":"sqlite_session_store_appeared"');

  const allowed = runEvidenceFixture({
    before: {},
    after: {},
    afterBaseline: (sessionRoot) =>
      createSqliteSessionStore(sessionRoot, [
        { eventJson: message("user", "first input"), seq: 1, sessionId: "session-a" },
        { eventJson: message("assistant", "first response"), seq: 2, sessionId: "session-a" },
        { eventJson: message("user", "second input"), seq: 3, sessionId: "session-a" },
        { eventJson: message("assistant", "second response"), seq: 4, sessionId: "session-a" },
      ]),
    expectedTurns: 2,
  });

  expect(allowed.baseline.status).toBe(0);
  expect(allowed.qualification.status, allowed.qualification.stderr).toBe(0);
});

it("keeps an incomplete SQLite-backed turn pending", () => {
  const { baseline, qualification } = runSqliteEvidenceFixture({
    after: [{ eventJson: message("user"), seq: 1, sessionId: "session-a" }],
    expectedTurns: 1,
  });

  expect(baseline.status).toBe(0);
  expect(qualification.status).toBe(1);
});

it("rejects a rewritten SQLite transcript prefix", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-sqlite-rewrite-"));
  const runId = randomUUID().replaceAll("-", "");
  const baselinePath = `/tmp/nemoclaw-launch-session-${runId}.json`;
  const ptyMonitorRoot = `/tmp/nemoclaw-launch-turn-${runId}`;
  const sessionRoot = join(fixtureRoot, "sessions");
  mkdirSync(sessionRoot);
  const sqlitePath = createSqliteSessionStore(sessionRoot, [
    { eventJson: message("user", "before"), seq: 1, sessionId: "session-a" },
  ]);
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
      { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    const database = new DatabaseSync(sqlitePath);
    try {
      database
        .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = ?")
        .run(message("user", "after"), "session-a", 1);
    } finally {
      database.close();
    }
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
      { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    expect(baseline.status).toBe(0);
    expect(qualification.status).toBe(2);
    expect(qualification.stderr).toContain('"reason":"session_rewritten"');
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
    rmSync(baselinePath, { force: true });
    rmSync(`${baselinePath}.tmp`, { force: true });
    rmSync(ptyMonitorRoot, { force: true, recursive: true });
  }
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
  { content: undefined, contentShape: "missing" },
  { content: null, contentShape: "null" },
  { content: {}, contentShape: "object-valued" },
])("rejects a provider error with $contentShape content (#10978)", ({ content }) => {
  const after = {
    "session-a": [message("user"), providerUnavailableMessage({ content })],
  };
  const { baseline, qualification } = runEvidenceFixture({ after, expectedTurns: 1 });

  expect(baseline.status).toBe(0);
  expect(qualification.status).toBe(2);
});

it("rejects a provider error when later messages are appended (#10978)", () => {
  const after = {
    "session-a": [message("user"), providerUnavailableMessage(), message("assistant")],
  };
  const { baseline, qualification } = runEvidenceFixture({ after, expectedTurns: 1 });

  expect(baseline.status).toBe(0);
  expect(qualification.status).toBe(2);
});

it.each<{ after: SessionRecords; status: number }>([
  { after: { "session-a": [message("assistant"), message("user")] }, status: 2 },
  {
    after: { "session-a": [message("user"), message("user"), message("assistant")] },
    status: 2,
  },
  {
    after: { "session-a": [message("user"), message("assistant"), message("assistant")] },
    status: 2,
  },
  { after: { "session-a": [message("user"), "not-json", message("assistant")] }, status: 2 },
  { after: { "session-a": [emptyMessage("user"), message("assistant")] }, status: 2 },
  {
    after: {
      "session-a": [message("user"), message("assistant")],
      "session-b": [message("user")],
    },
    status: 2,
  },
  {
    after: { "session-a": [message("user"), providerUnavailableMessage()] },
    status: 3,
  },
  {
    after: {
      "session-a": [message("user"), providerUnavailableMessage({ errorCode: "500" })],
    },
    status: 3,
  },
  {
    after: {
      "session-a": [
        message("user"),
        providerUnavailableMessage({
          errorMessage: "litellm.AuthenticationError: invalid API key",
        }),
      ],
    },
    status: 2,
  },
  {
    after: {
      "session-a": [
        message("user"),
        providerUnavailableMessage({
          errorMessage: "litellm.ServiceUnavailableError: network policy denied",
        }),
      ],
    },
    status: 2,
  },
  {
    after: {
      "session-a": [message("user"), providerUnavailableMessage({ errorCode: "400" })],
    },
    status: 2,
  },
])(
  "rejects invalid evidence or classifies a structured provider 5xx [case %#] (#9160, #10978)",
  ({ after, status }) => {
    const { baseline, qualification } = runEvidenceFixture({ after, expectedTurns: 1 });
    expect(baseline.status).toBe(0);
    expect(qualification.status).toBe(status);
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
