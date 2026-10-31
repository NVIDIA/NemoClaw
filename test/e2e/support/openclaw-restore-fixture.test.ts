// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  OPENCLAW_RESTORE_NATIVE_PROGRAM,
  openClawRestoreFixture,
  type OpenClawRestoreScenario,
} from "../fixtures/openclaw-restore-fixture.ts";

let home: string;
let stateRoot: string;
let readyPath: string;
let startupLog: string;
let fixture: ReturnType<typeof openClawRestoreFixture>;
const marker = "restore-fixture-owned";
const originalConfig = {
  gateway: { mode: "local", port: 18_792, auth: { mode: "token", token: "synthetic-fixture" } },
  models: { providers: { fixture: { baseUrl: "http://inference.local/v1" } } },
  agents: { defaults: { model: { primary: "fixture/model" }, models: { "fixture/model": {} } } },
  meta: { lastTouchedVersion: "2026.10.5" },
};
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const statePath = (name: string) => path.join(stateRoot, name);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restore-fixture-test-"));
  stateRoot = path.join(home, ".openclaw");
  readyPath = path.join(home, "ready");
  startupLog = path.join(home, "startup.log");
  fs.mkdirSync(statePath("state"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(statePath("agents/main"), { recursive: true });
  fs.mkdirSync(statePath("workspace"));
  fs.writeFileSync(statePath("workspace/marker"), "workspace survives");
  fs.writeFileSync(statePath("agents/main/writer-metadata"), "2026.10.5");
  fs.writeFileSync(statePath("openclaw.json"), JSON.stringify(originalConfig), { mode: 0o600 });
  fs.writeFileSync(
    statePath(".nemoclaw-post-upgrade-doctor"),
    "nemoclaw-openclaw-backup-quiesce-v1\n",
    { mode: 0o600 },
  );
  fs.writeFileSync(readyPath, "nemoclaw-openclaw-post-upgrade-doctor-ready-v1\n", { mode: 0o600 });
  const database = new DatabaseSync(statePath("state/openclaw.sqlite"));
  database.exec(
    "PRAGMA user_version = 20; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('owned original state');",
  );
  database.close();
  fixture = openClawRestoreFixture(marker, stateRoot);
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function run(
  mode: "prepare" | "verify",
  scenario: OpenClawRestoreScenario,
  data: unknown = fixture,
) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      OPENCLAW_RESTORE_NATIVE_PROGRAM,
      JSON.stringify({
        mode,
        scenario,
        stateRoot,
        readyPath,
        startupLog,
        marker,
        fixture: data,
      }),
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home },
    },
  );
}

it("prepares JSON-only legacy state while retaining the installed route and workspace", () => {
  const result = run("prepare", "legacy");
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ prepared: true, scenario: "legacy" });
  const config = JSON.parse(fs.readFileSync(statePath("openclaw.json"), "utf8"));
  expect(config.gateway).toEqual(originalConfig.gateway);
  expect(config.models).toEqual(originalConfig.models);
  expect(config.agents.defaults.model).toEqual(originalConfig.agents.defaults.model);
  expect(config.meta).toBeUndefined();
  expect(fs.existsSync(statePath("state"))).toBe(false);
  expect(fs.existsSync(statePath("agents"))).toBe(false);
  expect(fs.readFileSync(statePath("workspace/marker"), "utf8")).toBe("workspace survives");
  expect(fs.readFileSync(statePath("acp/event-ledger.json"), "utf8")).toBe(
    fixture.legacyFiles["acp/event-ledger.json"],
  );
  expect(fs.readFileSync(statePath("telegram/sticker-cache.json"), "utf8")).toBe(
    fixture.legacyFiles["telegram/sticker-cache.json"],
  );
  expect(fs.readFileSync(statePath("telegram/thread-bindings-default.json"), "utf8")).toBe(
    fixture.legacyFiles["telegram/thread-bindings-default.json"],
  );
  expect(
    fs.readdirSync(stateRoot).filter((name) => name.startsWith(".nemoclaw-e2e-restore-staging-")),
  ).toEqual([]);
});

it("adds nonempty retired state without changing the current database or config", () => {
  const before = digest(statePath("state/openclaw.sqlite"));
  const config = digest(statePath("openclaw.json"));
  const result = run("prepare", "retired-telegram");
  expect(result.status, result.stderr).toBe(0);
  expect(digest(statePath("state/openclaw.sqlite"))).toBe(before);
  expect(digest(statePath("openclaw.json"))).toBe(config);
  expect(fs.readFileSync(statePath("telegram/thread-bindings-unmigrated.json"), "utf8")).toBe(
    fixture.refusedFiles["telegram/thread-bindings-unmigrated.json"],
  );
});

it.each([
  {
    name: "wrong maintenance authority",
    tamper: () =>
      fs.writeFileSync(
        statePath(".nemoclaw-post-upgrade-doctor"),
        "nemoclaw-openclaw-post-upgrade-doctor-v2\n",
      ),
  },
  { name: "non-private receipt", tamper: () => fs.chmodSync(readyPath, 0o644) },
  {
    name: "linked receipt",
    tamper: () => {
      fs.renameSync(readyPath, `${readyPath}.source`);
      fs.symlinkSync(`${readyPath}.source`, readyPath);
    },
  },
])("rejects $name before changing native state", ({ tamper }) => {
  const before = digest(statePath("state/openclaw.sqlite"));
  const config = digest(statePath("openclaw.json"));
  tamper();
  const result = run("prepare", "legacy");
  expect(result.status, result.stderr).toBe(1);
  expect(digest(statePath("state/openclaw.sqlite"))).toBe(before);
  expect(digest(statePath("openclaw.json"))).toBe(config);
  expect(fs.existsSync(statePath("acp"))).toBe(false);
});

it("restores the original entries if fixture writing fails after staging", () => {
  const before = digest(statePath("state/openclaw.sqlite"));
  const config = digest(statePath("openclaw.json"));
  const entries = fs.readdirSync(stateRoot).sort();
  const invalid = { ...fixture, legacyFiles: { ...fixture.legacyFiles, "../outside": "invalid" } };
  const result = run("prepare", "legacy", invalid);
  expect(result.status, result.stderr).toBe(1);
  expect(digest(statePath("state/openclaw.sqlite"))).toBe(before);
  expect(digest(statePath("openclaw.json"))).toBe(config);
  expect(fs.readdirSync(stateRoot).sort()).toEqual(entries);
  expect(fs.existsSync(path.join(home, "outside"))).toBe(false);
  expect(fs.readFileSync(statePath("workspace/marker"), "utf8")).toBe("workspace survives");
});

function seedMigratedOutput() {
  const database = new DatabaseSync(statePath("state/openclaw.sqlite"));
  database.exec(`
    CREATE TABLE acp_replay_sessions (session_id TEXT, session_key TEXT, complete INTEGER, next_seq INTEGER);
    CREATE TABLE acp_replay_events (session_id TEXT, seq INTEGER, update_json TEXT);
    CREATE TABLE plugin_state_entries (plugin_id TEXT, namespace TEXT, entry_key TEXT, value_json TEXT);
  `);
  database
    .prepare("INSERT INTO acp_replay_sessions VALUES (?,?,1,2)")
    .run(fixture.sessionId, fixture.sessionKey);
  database
    .prepare("INSERT INTO acp_replay_events VALUES (?,1,?)")
    .run(fixture.sessionId, JSON.stringify(fixture.update));
  database
    .prepare("INSERT INTO plugin_state_entries VALUES ('telegram','telegram.sticker-cache',?,?)")
    .run(marker, JSON.stringify(fixture.sticker));
  database.close();
  fs.writeFileSync(
    statePath("openclaw.json"),
    JSON.stringify({
      ...originalConfig,
      agents: { defaults: { ...originalConfig.agents.defaults, silentReply: { group: "allow" } } },
      surfaces: { telegram: { silentReply: { group: "disallow" } } },
    }),
  );
  const archived = statePath("telegram/.nemoclaw-telegram-empty-owned.migrated");
  fs.mkdirSync(archived, { recursive: true });
  fs.writeFileSync(
    path.join(archived, "thread-bindings-default.json"),
    fixture.legacyFiles["telegram/thread-bindings-default.json"],
  );
  fs.writeFileSync(
    startupLog,
    "[migration] Preparing restored state with OpenClaw 2026.9.5\n[migration] Preparing restored state with OpenClaw 2026.9.7\n",
  );
}

it("serializes verified native replay, sticker, config and bridge evidence", () => {
  seedMigratedOutput();
  const before = digest(statePath("state/openclaw.sqlite"));
  const result = run("verify", "legacy");
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    migrated: true,
    schema: 20,
    replayPreserved: true,
    stickerPreserved: true,
    bridges: ["2026.9.5", "2026.9.7"],
  });
  expect(digest(statePath("state/openclaw.sqlite"))).toBe(before);
});

it("rejects duplicated replay data even when both bridge messages are present", () => {
  seedMigratedOutput();
  const database = new DatabaseSync(statePath("state/openclaw.sqlite"));
  database.exec(
    "INSERT INTO acp_replay_events SELECT session_id,2,update_json FROM acp_replay_events",
  );
  database.close();
  const result = run("verify", "legacy");
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("2 !== 1");
});

it("rejects current state that lacks evidence that both legacy bridges ran", () => {
  seedMigratedOutput();
  fs.writeFileSync(startupLog, "[migration] Preparing restored state with OpenClaw 2026.9.7\n");
  const result = run("verify", "legacy");
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("logs.includes");
});
