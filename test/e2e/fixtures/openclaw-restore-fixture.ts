// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type OpenClawRestoreScenario = "legacy" | "retired-telegram";

export const OPENCLAW_RESTORE_SUITE_TIMEOUT_MS = 45 * 60_000;

/** Both sequential scenarios share one deadline, starting with the first scenario. */
export function createOpenClawRestoreDeadline(timeoutMs: number, now = () => performance.now()) {
  let deadline: number | undefined;
  return () => (deadline ??= now() + timeoutMs);
}

/** Synthetic native inputs, shared by the sandbox writer and archive verifier. */
export function openClawRestoreFixture(marker: string, stateRoot = "/sandbox/.openclaw") {
  const sessionId = `${marker}-replay`;
  const sessionKey = `agent:main:${sessionId}`;
  const update = {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `Preserve ${marker} through both migration bridges.` },
  };
  const event = {
    seq: 1,
    at: 1788105600000,
    sessionId,
    sessionKey,
    runId: "legacy-restore-run",
    update,
  };
  const sticker = {
    fileId: "fixture-file",
    fileUniqueId: marker,
    description: "preserve restored sticker",
    cachedAt: "2026-09-01T00:00:00.000Z",
  };
  const encode = (value: unknown) => `${JSON.stringify(value)}\n`;
  return {
    sessionId,
    sessionKey,
    update,
    sticker,
    legacyFiles: {
      "acp/event-ledger.json": encode({
        version: 1,
        sessions: {
          [sessionId]: {
            sessionId,
            sessionKey,
            cwd: stateRoot,
            complete: true,
            createdAt: event.at,
            updatedAt: event.at,
            nextSeq: 2,
            events: [event],
          },
        },
      }),
      "telegram/sticker-cache.json": encode({ version: 1, stickers: { [marker]: sticker } }),
      "telegram/thread-bindings-default.json": encode({ version: 1, bindings: [] }),
    },
    refusedFiles: {
      "telegram/thread-bindings-unmigrated.json": encode({
        version: 1,
        bindings: [{ chatId: "123", fixture: marker }],
      }),
    },
  };
}

// Execute inside the disposable sandbox. Preparation requires the production
// backup-quiesce handshake; it never invokes or substitutes a migration runner.
// Tests supply private filesystem roots to exercise this exact program locally.
export const OPENCLAW_RESTORE_NATIVE_PROGRAM = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const input = JSON.parse(process.argv[1]);
const { mode, scenario, stateRoot, readyPath, startupLog, marker, fixture } = input;
assert.match(marker, /^[a-z0-9-]{1,90}$/);
assert.ok(['legacy', 'retired-telegram'].includes(scenario));
const state = fs.lstatSync(stateRoot);
assert.ok(state.isDirectory() && !state.isSymbolicLink());
assert.equal(state.uid, process.geteuid());
const configPath = path.join(stateRoot, 'openclaw.json');
function readPrivate(file, expected) {
  const s = fs.lstatSync(file);
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1);
  assert.equal(s.uid, state.uid);
  assert.equal(s.mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), expected);
}
function writeFiles(files) {
  for (const [relative, bytes] of Object.entries(files)) {
    assert.ok(!path.isAbsolute(relative) && !relative.split('/').includes('..'));
    const file = path.join(stateRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
  }
}
if (mode === 'prepare') {
  readPrivate(path.join(stateRoot, '.nemoclaw-post-upgrade-doctor'), 'nemoclaw-openclaw-backup-quiesce-v1\n');
  readPrivate(readyPath, 'nemoclaw-openclaw-post-upgrade-doctor-ready-v1\n');
  if (scenario === 'legacy') {
    const original = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(original.gateway && original.models && original.agents?.defaults?.model);
    // Keep the actual installed model route and gateway policy. The generated
    // 10.5 databases and writer metadata must not make 9.5/9.7 ineligible.
    const config = {
      gateway: original.gateway,
      models: original.models,
      agents: { defaults: {
        workspace: path.join(stateRoot, 'workspace'),
        model: original.agents.defaults.model,
        ...(original.agents.defaults.models ? { models: original.agents.defaults.models } : {}),
        silentReply: { group: 'allow', direct: 'allow' },
      } },
      surfaces: { telegram: { silentReply: { group: 'disallow', direct: 'disallow' } } },
    };
    // Keep renames on the native-home filesystem, including mounted volumes.
    const staging = fs.mkdtempSync(path.join(stateRoot, '.nemoclaw-e2e-restore-staging-'));
    const retained = new Set(['workspace', '.nemoclaw-post-upgrade-doctor', path.basename(staging)]);
    const moved = [];
    let staged = false;
    let prepared = false;
    try {
      for (const name of fs.readdirSync(stateRoot)) {
        if (retained.has(name)) continue;
        fs.renameSync(path.join(stateRoot, name), path.join(staging, name));
        moved.push(name);
      }
      staged = true;
      writeFiles({ 'openclaw.json': JSON.stringify(config) + '\n', ...fixture.legacyFiles });
      prepared = true;
    } finally {
      if (!prepared) {
        // Restore this fixture's original entries on a preparation failure.
        if (staged) {
          for (const name of fs.readdirSync(stateRoot)) {
            if (!retained.has(name)) fs.rmSync(path.join(stateRoot, name), { recursive: true, force: true });
          }
        }
        for (const name of moved) fs.renameSync(path.join(staging, name), path.join(stateRoot, name));
      }
      fs.rmSync(staging, { recursive: true, force: true });
    }
    assert.ok(!fs.existsSync(path.join(stateRoot, 'state')));
    assert.ok(!fs.existsSync(path.join(stateRoot, 'agents')));
  } else {
    const database = new DatabaseSync(path.join(stateRoot, 'state/openclaw.sqlite'), { readOnly: true });
    try { assert.equal(database.prepare('PRAGMA user_version').get().user_version, 20); }
    finally { database.close(); }
    writeFiles(fixture.refusedFiles);
  }
  console.log(JSON.stringify({ prepared: true, scenario }));
} else {
  assert.equal(mode, 'verify');
  assert.equal(scenario, 'legacy');
  const database = new DatabaseSync(path.join(stateRoot, 'state/openclaw.sqlite'), { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 20);
    const session = database.prepare('SELECT * FROM acp_replay_sessions WHERE session_id=?').get(fixture.sessionId);
    assert.equal(session?.session_key, fixture.sessionKey);
    assert.equal(session?.complete, 1);
    assert.equal(session?.next_seq, 2);
    const events = database.prepare('SELECT * FROM acp_replay_events WHERE session_id=? ORDER BY seq').all(fixture.sessionId);
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0].update_json), fixture.update);
    const sticker = database.prepare('SELECT value_json FROM plugin_state_entries WHERE plugin_id=? AND namespace=? AND entry_key=?').get('telegram', 'telegram.sticker-cache', marker);
    assert.deepEqual(JSON.parse(sticker?.value_json), fixture.sticker);
  } finally { database.close(); }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(config.agents.defaults.silentReply, { group: 'allow' });
  assert.deepEqual(config.surfaces.telegram.silentReply, { group: 'disallow' });
  for (const name of Object.keys(fixture.legacyFiles)) assert.ok(!fs.existsSync(path.join(stateRoot, name)));
  const archives = fs.readdirSync(path.join(stateRoot, 'telegram')).filter(name => name.startsWith('.nemoclaw-telegram-empty-') && name.endsWith('.migrated'));
  assert.equal(archives.length, 1);
  assert.equal(fs.readFileSync(path.join(stateRoot, 'telegram', archives[0], 'thread-bindings-default.json'), 'utf8'), fixture.legacyFiles['telegram/thread-bindings-default.json']);
  const logMetadata = fs.lstatSync(startupLog);
  assert.ok(logMetadata.isFile() && !logMetadata.isSymbolicLink() && logMetadata.size <= 1_048_576);
  const logs = fs.readFileSync(startupLog, 'utf8');
  for (const version of ['2026.9.5', '2026.9.7']) assert.ok(logs.includes('[migration] Preparing restored state with OpenClaw ' + version));
  console.log(JSON.stringify({ migrated: true, schema: 20, replayPreserved: true, stickerPreserved: true, bridges: ['2026.9.5', '2026.9.7'] }));
}
`;

// Run from the candidate checkout through tsx, with the same host environment
// as the actual CLI. Recovery inspection uses the production backup authority.
export const OPENCLAW_RESTORE_HOST_PROGRAM = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { listBackups } = require('./src/lib/state/sandbox.ts');
const input = JSON.parse(process.argv[1]);
if (input.mode === 'quiesce') {
  const { beginOpenClawBackupQuiesce } = require('./src/lib/actions/sandbox/process-recovery.ts');
  const result = await beginOpenClawBackupQuiesce(input.sandboxName, { gatewayName: input.gatewayName, workspace: 'default' });
  assert.ok(result.ok, 'production source quiesce failed');
  console.log(JSON.stringify(result));
} else if (input.mode === 'list') {
  console.log(JSON.stringify(listBackups(input.sandboxName).map(entry => entry.backupPath)));
} else if (input.mode === 'backup') {
  const fresh = listBackups(input.sandboxName).filter(entry => !input.before.includes(entry.backupPath));
  assert.equal(fresh.length, 1, 'expected exactly the backup created by this rebuild');
  const backup = fresh[0];
  assert.equal(backup.agentType, 'openclaw');
  assert.ok(backup.nativeState && backup.backupComplete !== false);
  const archive = path.join(backup.backupPath, backup.nativeState.archive);
  const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  assert.equal(digest, backup.nativeState.sha256, 'rebuild changed the original backup');
  const tarOptions = { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };
  const members = execFileSync('tar', ['-tf', archive], tarOptions).trim().split('\n');
  for (const [relative, bytes] of Object.entries(input.files)) {
    const matches = members.filter(name => name.replace(/^\.\//, '') === relative);
    assert.equal(matches.length, 1);
    assert.equal(execFileSync('tar', ['-xOf', archive, '--', matches[0]], tarOptions), bytes);
  }
  let transactionId = null;
  if (input.refused) {
    const recovery = JSON.parse(fs.readFileSync(path.join(backup.backupPath, '.nemoclaw-rebuild-recovery.json'), 'utf8'));
    assert.equal(recovery.phase, 'restore');
    transactionId = recovery.transactionId;
    const { findRebuildRecoveryBackup, readRebuildRecoveryRoute } = require('./src/lib/actions/sandbox/rebuild-recreate-journal.ts');
    const identity = { sandboxName: input.sandboxName, agentName: 'openclaw', transactionId };
    assert.equal(findRebuildRecoveryBackup(identity)?.backupPath, backup.backupPath);
    assert.equal(readRebuildRecoveryRoute(identity, backup.backupPath)?.gatewayName, input.gatewayName);
  }
  console.log(JSON.stringify({ backupPath: backup.backupPath, archiveSha256: digest, fixturePreserved: true, transactionId }));
} else {
  assert.equal(input.mode, 'refusal');
  const { createCliOpenShellSandboxLookup } = require('./src/lib/adapters/openshell/sandbox-observer-cli.ts');
  const { captureOpenshell } = require('./src/lib/adapters/openshell/runtime.ts');
  const target = { kind: 'named', gatewayName: input.gatewayName };
  const observation = await createCliOpenShellSandboxLookup({ capture: captureOpenshell })({ sandboxName: input.sandboxName, target, timeoutMs: 15_000 });
  assert.ok(observation.result.ok && observation.result.value.state === 'present');
  const state = observation.result.value.sandbox;
  assert.ok(state.phase === 'Stopped' || state.readiness === 'terminal', 'refused replacement is still active');
  assert.equal(typeof input.startupLog, 'string', 'missing native entrypoint output');
  assert.ok(input.startupLog.includes('[migration] OpenClaw 2026.9.7 retired Telegram state inspection failed;'), 'missing actual retired-state refusal evidence');
  console.log(JSON.stringify({ refused: true, phase: state.phase, logs: input.startupLog.split('\n') }));
}
`;
