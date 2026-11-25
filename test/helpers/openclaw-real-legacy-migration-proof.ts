// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface LegacyMigrationProofOptions {
  home: string;
  nodeExecutable: string;
  runtime95: string;
  runtime97: string;
  targetRuntime: string;
  migrationRunner?: string;
}

export const LEGACY_MIGRATION_PROOF_OUTER_TIMEOUT_MS = 1_500_000;
// Leave time for the last child to exit and publish diagnostics before Docker
// or the package test terminates the proof and removes its private fixture.
export const LEGACY_MIGRATION_PROOF_TIMEOUT_MS = LEGACY_MIGRATION_PROOF_OUTER_TIMEOUT_MS - 60_000;

function snapshotFiles(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), "unexpected link in migration fixture");
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    result[path.relative(directory, file)] = createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex");
  }
  return result;
}

export function runLegacyMigrationProofCommand(
  options: LegacyMigrationProofOptions,
  args: string[],
  timeout: number,
  deadline: number,
): number | null {
  const remaining = Math.floor(deadline - performance.now());
  assert.ok(remaining > 0, "native migration proof exhausted its shared deadline");
  const home = path.join(options.home, "restored");
  const state = path.join(home, ".openclaw");
  const result = spawnSync(options.nodeExecutable, args, {
    encoding: "utf8",
    timeout: Math.min(timeout, remaining),
    killSignal: "SIGKILL",
    ...(process.platform !== "win32" ? { detached: true } : {}),
    maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      OPENCLAW_HOME: home,
      TMPDIR: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_PATH_BOOTSTRAPPED: "1",
      NPM_CONFIG_OFFLINE: "true",
      npm_config_offline: "true",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      npm_config_ignore_scripts: "true",
    },
  });
  if (
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" &&
    process.platform !== "win32" &&
    result.pid > 0
  ) {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  fs.writeFileSync(
    path.join(options.home, "last-native-command.log"),
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    { mode: 0o600 },
  );
  assert.equal(result.error, undefined, "native migration Doctor failed to finish");
  assert.equal(result.signal, null, "native migration Doctor was killed");
  return result.status;
}

function runDoctor(
  options: LegacyMigrationProofOptions,
  runtime: string,
  deadline: number,
): number | null {
  return runLegacyMigrationProofCommand(
    options,
    [path.join(runtime, "openclaw.mjs"), "doctor", "--fix", "--yes", "--non-interactive"],
    180_000,
    deadline,
  );
}

/** Exercise the intermediate CLI migrations on a copy of a JSON-only backup. */
export function proveRealLegacyMigrationBridges(options: LegacyMigrationProofOptions): void {
  const deadline = performance.now() + LEGACY_MIGRATION_PROOF_TIMEOUT_MS;
  try {
    proveLegacyMigrationWithinDeadline(options, deadline);
  } catch (error) {
    // These commands receive only the private synthetic home and fixed fixture
    // credentials. Never use this diagnostic path for a real restored home.
    const log = path.join(options.home, "last-native-command.log");
    try {
      if (fs.existsSync(log)) {
        process.stderr.write("Last synthetic migration command output (bounded tail):\n");
        process.stderr.write(fs.readFileSync(log).subarray(-16_384).toString("utf8") + "\n");
      }
    } catch {
      process.stderr.write("Synthetic migration command diagnostics could not be read.\n");
    }
    throw error;
  }
}

function proveLegacyMigrationWithinDeadline(
  options: LegacyMigrationProofOptions,
  deadline: number,
): void {
  const runtimes = [
    { root: options.runtime95, version: "2026.9.5", schema: 17 },
    { root: options.runtime97, version: "2026.9.7", schema: 19 },
    { root: options.targetRuntime, version: "2026.10.5", schema: 20 },
  ];
  for (const runtime of runtimes) {
    const manifest = JSON.parse(fs.readFileSync(path.join(runtime.root, "package.json"), "utf8"));
    assert.equal(manifest.name, "openclaw");
    assert.equal(manifest.version, runtime.version, "unexpected migration runtime");
  }
  const backup = path.join(options.home, "backup");
  const state = path.join(options.home, "restored", ".openclaw");
  assert.ok(!fs.existsSync(backup) && !fs.existsSync(state), "migration fixture already exists");
  const write = (name: string, value: unknown) => {
    const file = path.join(backup, name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  };
  write("openclaw.json", {
    gateway: { mode: "local", auth: { mode: "token", token: "migration-proof-fixture" } },
    agents: {
      defaults: {
        workspace: path.join(state, "workspace"),
        silentReply: { group: "allow", direct: "allow" },
      },
    },
    surfaces: { telegram: { silentReply: { group: "disallow", direct: "disallow" } } },
  });
  const sessionKey = "agent:main:legacy-migration";
  const event = {
    seq: 1,
    at: 1788105600000,
    sessionId: "legacy-migration",
    sessionKey,
    runId: "legacy-run",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Preserve replay through both migrations." },
    },
  };
  write("acp/event-ledger.json", {
    version: 1,
    sessions: {
      "legacy-migration": {
        sessionId: event.sessionId,
        sessionKey,
        cwd: state,
        complete: true,
        createdAt: event.at,
        updatedAt: event.at,
        nextSeq: 2,
        events: [event],
      },
    },
  });
  const sticker = {
    fileId: "fixture-file",
    fileUniqueId: "migration-sticker",
    description: "preserve sticker",
    cachedAt: "2026-09-01T00:00:00.000Z",
  };
  write("telegram/sticker-cache.json", { version: 1, stickers: { "migration-sticker": sticker } });
  write("telegram/thread-bindings-default.json", { version: 1, bindings: [] });
  const backupBefore = snapshotFiles(backup);
  fs.cpSync(backup, state, { recursive: true });
  const migrationRoot = path.join(options.home, "runtimes");
  for (const runtime of runtimes.slice(0, 2)) {
    const modules = path.join(migrationRoot, runtime.version, "node_modules");
    fs.mkdirSync(modules, { recursive: true });
    fs.symlinkSync(runtime.root, path.join(modules, "openclaw"), "dir");
  }
  const bridgeArgs = [
    options.migrationRunner ??
      path.resolve(import.meta.dirname, "../../scripts/lib/openclaw-legacy-migrations.mts"),
    "--run",
    options.targetRuntime,
    migrationRoot,
  ];
  assert.equal(
    runLegacyMigrationProofCommand(options, bridgeArgs, 1_320_000, deadline),
    0,
    "production migration runner failed",
  );
  let migratedRows: unknown;
  for (const runtime of runtimes.slice(1)) {
    if (runtime.version === "2026.10.5") {
      for (let pass = 1; pass <= 2; pass++) {
        const status = runDoctor(options, runtime.root, deadline);
        if (pass === 2)
          assert.equal(status, 0, `${runtime.version} Doctor did not finish migration`);
      }
    }
    const db = new DatabaseSync(path.join(state, "state", "openclaw.sqlite"), { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, runtime.schema);
      const session = db
        .prepare("SELECT * FROM acp_replay_sessions WHERE session_id=?")
        .get(event.sessionId);
      assert.equal(session?.session_key, sessionKey);
      assert.equal(session?.complete, 1);
      assert.equal(session?.next_seq, 2);
      const events = db
        .prepare("SELECT * FROM acp_replay_events WHERE session_id=? ORDER BY seq")
        .all(event.sessionId);
      assert.equal(events.length, 1, "lost or duplicated migrated replay event");
      assert.deepEqual(JSON.parse(String(events[0]?.update_json)), event.update);
      const cached = db
        .prepare(
          "SELECT * FROM plugin_state_entries WHERE plugin_id=? AND namespace=? AND entry_key=?",
        )
        .get("telegram", "telegram.sticker-cache", "migration-sticker");
      assert.deepEqual(JSON.parse(String(cached?.value_json)), sticker);
      const rows = JSON.parse(JSON.stringify({ session, events, cached }));
      if (migratedRows)
        assert.deepEqual(rows, migratedRows, "migration changed canonical data or timestamps");
      migratedRows = rows;
    } finally {
      db.close();
    }
    const config = JSON.parse(fs.readFileSync(path.join(state, "openclaw.json"), "utf8"));
    assert.deepEqual(config.agents.defaults.silentReply, { group: "allow" });
    assert.deepEqual(config.surfaces.telegram.silentReply, { group: "disallow" });
    assert.equal(config.gateway.auth.token, "migration-proof-fixture");
    for (const name of [
      "acp/event-ledger.json",
      "acp/event-ledger.json.doctor-import",
      "telegram/sticker-cache.json",
      "telegram/thread-bindings-default.json",
    ]) {
      assert.ok(
        !fs.existsSync(path.join(state, name)),
        `${runtime.version} retained unimported ${name}`,
      );
    }
    assert.deepEqual(snapshotFiles(backup), backupBefore, "migration changed original backup");
  }
  const emptyArchives = fs
    .readdirSync(path.join(state, "telegram"))
    .filter((name) => name.startsWith(".nemoclaw-telegram-empty-") && name.endsWith(".migrated"));
  assert.equal(emptyArchives.length, 1, "empty thread bindings were not archived");
  assert.deepEqual(
    fs.readFileSync(
      path.join(state, "telegram", emptyArchives[0]!, "thread-bindings-default.json"),
    ),
    fs.readFileSync(path.join(backup, "telegram/thread-bindings-default.json")),
  );
  // Neither intermediate runtime may downgrade the now-current shared database.
  const configBefore = fs.readFileSync(path.join(state, "openclaw.json"));
  const databaseBefore = snapshotFiles(path.join(state, "state"));
  assert.equal(
    runLegacyMigrationProofCommand(options, bridgeArgs, 1_320_000, deadline),
    0,
    "production runner rejected current state",
  );
  assert.deepEqual(snapshotFiles(path.join(state, "state")), databaseBefore);
  assert.deepEqual(fs.readFileSync(path.join(state, "openclaw.json")), configBefore);
  for (const runtime of runtimes.slice(0, 2)) {
    assert.notEqual(
      runDoctor(options, runtime.root, deadline),
      0,
      "intermediate Doctor accepted newer state",
    );
    assert.deepEqual(
      snapshotFiles(path.join(state, "state")),
      databaseBefore,
      "refused downgrade changed database bytes",
    );
    assert.deepEqual(
      fs.readFileSync(path.join(state, "openclaw.json")),
      configBefore,
      "refused downgrade changed config",
    );
    assert.deepEqual(
      snapshotFiles(backup),
      backupBefore,
      "refused downgrade changed original backup",
    );
  }
  // A newer database cannot make a retained, nonempty Telegram source safe.
  const retained = path.join(state, "telegram/thread-bindings-unmigrated.json");
  const retainedBytes = '{"version":1,"bindings":[{"chatId":"123"}]}\n';
  fs.writeFileSync(retained, retainedBytes);
  assert.notEqual(
    runLegacyMigrationProofCommand(options, bridgeArgs, 1_320_000, deadline),
    0,
    "production runner stranded retired Telegram data",
  );
  assert.equal(fs.readFileSync(retained, "utf8"), retainedBytes);
  assert.deepEqual(snapshotFiles(path.join(state, "state")), databaseBefore);
  assert.deepEqual(fs.readFileSync(path.join(state, "openclaw.json")), configBefore);
  assert.deepEqual(snapshotFiles(backup), backupBefore);
}
